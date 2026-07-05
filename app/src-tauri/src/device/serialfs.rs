//! Serial file management (proto v3).
//!
//! When config.json sets `"usb_drive": false` the keypad hides its CIRCUITPY
//! drive from the host ("finished product" mode) and the app manages files
//! over the serial protocol instead: fs_list / fs_read / fs_write /
//! fs_delete, base64 payloads, one chunk in flight at a time. The frontend
//! keeps calling the same drive_* commands — it just passes the
//! `serial:<uid>` sentinel instead of a mount point, and lib.rs routes here.

use super::serial::{self, DeviceManager};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use std::sync::mpsc::Receiver;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// Drive-path sentinel the frontend passes instead of a mount point.
pub const PREFIX: &str = "serial:";

pub fn is_serial(drive: &str) -> bool {
    drive.starts_with(PREFIX)
}

/// fs responses belong to the in-flight operation, not the frontend event
/// stream — the serial reader thread uses this to route them.
pub fn is_fs_msg(v: &Value) -> bool {
    match v.get("t").and_then(Value::as_str) {
        Some("fs_chunk" | "fs_list") => true,
        Some("ok" | "err") => v
            .get("re")
            .and_then(Value::as_str)
            .is_some_and(|re| re.starts_with("fs_")),
        _ => false,
    }
}

/// One fs op at a time — the wire protocol has no request ids.
static OP: Mutex<()> = Mutex::new(());

/// Raw bytes per fs_write line (~4KB of base64 on the wire; the firmware's
/// line buffer takes 16KB).
const CHUNK: usize = 3072;
const TIMEOUT: Duration = Duration::from_secs(8);

/// An in-flight fs operation: holds the op lock and receives the routed
/// fs messages; the route is uninstalled again on drop.
struct Op<'a> {
    mgr: &'a DeviceManager,
    rx: Receiver<Value>,
    _lock: MutexGuard<'a, ()>,
}

impl<'a> Op<'a> {
    fn begin(mgr: &'a DeviceManager) -> Result<Self, String> {
        let lock = OP.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = std::sync::mpsc::channel();
        mgr.set_fs_route(Some(tx))?;
        Ok(Op { mgr, rx, _lock: lock })
    }

    fn send(&self, msg: &Value) -> Result<(), String> {
        serial::send(self.mgr, msg)
    }

    fn recv(&self) -> Result<Value, String> {
        self.rx.recv_timeout(TIMEOUT).map_err(|_| {
            "the keypad did not answer in time (is a macro playing?)".to_string()
        })
    }

    fn expect_ok(&self, re: &str) -> Result<Value, String> {
        let v = self.recv()?;
        match v.get("t").and_then(Value::as_str) {
            Some("ok") if v.get("re").and_then(Value::as_str) == Some(re) => Ok(v),
            Some("err") => Err(fs_err(&v)),
            _ => Err(format!("unexpected keypad reply: {v}")),
        }
    }
}

impl Drop for Op<'_> {
    fn drop(&mut self) {
        let _ = self.mgr.set_fs_route(None);
    }
}

fn fs_err(v: &Value) -> String {
    let code = v.get("code").and_then(Value::as_str).unwrap_or("error");
    let msg = v.get("msg").and_then(Value::as_str).unwrap_or("");
    match code {
        "readonly" => {
            "the keypad's filesystem is owned by its USB drive right now — use the drive, \
             or hide it in Settings first"
                .to_string()
        }
        "busy" => "the keypad is busy playing a macro — try again in a moment".to_string(),
        _ => format!("keypad fs error: {code} {msg}").trim().to_string(),
    }
}

/// Same guarantee as drive::safe_join: no escaping the keypad's filesystem.
fn rel(path: &str) -> Result<&str, String> {
    if path.split(['/', '\\']).any(|c| c == "..") {
        return Err(format!("invalid path: {path}"));
    }
    Ok(path.trim_start_matches('/'))
}

pub fn write_file(mgr: &DeviceManager, path: &str, bytes: &[u8]) -> Result<(), String> {
    let path = rel(path)?;
    let op = Op::begin(mgr)?;
    let chunks: Vec<&[u8]> = if bytes.is_empty() {
        vec![&[]]
    } else {
        bytes.chunks(CHUNK).collect()
    };
    let last = chunks.len() - 1;
    for (seq, chunk) in chunks.into_iter().enumerate() {
        op.send(&json!({
            "t": "fs_write", "path": path, "seq": seq,
            "data": B64.encode(chunk), "eof": seq == last,
        }))?;
        op.expect_ok("fs_write")?;
    }
    Ok(())
}

pub fn read_file(mgr: &DeviceManager, path: &str) -> Result<Vec<u8>, String> {
    let path = rel(path)?;
    let op = Op::begin(mgr)?;
    op.send(&json!({"t": "fs_read", "path": path}))?;
    let mut out = Vec::new();
    loop {
        let v = op.recv()?;
        match v.get("t").and_then(Value::as_str) {
            Some("fs_chunk") => {
                if let Some(data) = v.get("data").and_then(Value::as_str) {
                    if !data.is_empty() {
                        out.extend(B64.decode(data).map_err(|e| e.to_string())?);
                    }
                }
                if v.get("eof").and_then(Value::as_bool).unwrap_or(false) {
                    return Ok(out);
                }
                // flow control: the firmware sends the next chunk on our ack
                op.send(&json!({"t": "fs_ack"}))?;
            }
            Some("err") => return Err(fs_err(&v)),
            _ => {} // stale fs message from an aborted earlier op — keep waiting
        }
    }
}

pub fn delete_file(mgr: &DeviceManager, path: &str) -> Result<(), String> {
    let path = rel(path)?;
    let op = Op::begin(mgr)?;
    op.send(&json!({"t": "fs_delete", "path": path}))?;
    op.expect_ok("fs_delete").map(|_| ())
}

/// File names in a directory, matching drive::list_dir semantics
/// (files only, dotfiles skipped, missing directory = empty list).
pub fn list_dir(mgr: &DeviceManager, path: &str) -> Result<Vec<String>, String> {
    let path = rel(path)?;
    let op = Op::begin(mgr)?;
    op.send(&json!({"t": "fs_list", "path": path}))?;
    loop {
        let v = op.recv()?;
        match v.get("t").and_then(Value::as_str) {
            Some("fs_list") => {
                let names = v
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter(|e| !e.get("dir").and_then(Value::as_bool).unwrap_or(false))
                            .filter_map(|e| e.get("name").and_then(Value::as_str))
                            .filter(|n| !n.starts_with('.'))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                return Ok(names);
            }
            Some("err") if v.get("code").and_then(Value::as_str) == Some("not_found") => {
                return Ok(Vec::new());
            }
            Some("err") => return Err(fs_err(&v)),
            _ => {}
        }
    }
}
