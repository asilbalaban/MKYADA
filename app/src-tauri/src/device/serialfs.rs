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
use std::sync::atomic::{AtomicBool, Ordering};
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

/// User-requested abort of an in-flight write (issue #15): the UI's cancel
/// button flips this and the chunk loop checks it between chunks. Cleared
/// again when the next write begins. Deliberately NOT a transient error —
/// with_recovery must not retry a cancelled transfer.
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Error marker for a user-cancelled write; the frontend matches on it.
pub const CANCELLED: &str = "write cancelled";

pub fn request_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

pub fn clear_cancel() {
    CANCEL.store(false, Ordering::Relaxed);
}

pub fn cancel_requested() -> bool {
    CANCEL.load(Ordering::Relaxed)
}

/// Raw bytes per fs_write line (~4KB of base64 on the wire; the firmware's
/// line buffer takes 16KB).
const CHUNK: usize = 3072;
const TIMEOUT: Duration = Duration::from_secs(8);

/// A macro playing on the single-threaded firmware starves the serial link,
/// so a file write landing then either stalls at the OS layer (Windows
/// "os error 121") or waits out our reply timeout, and the firmware answers
/// "busy" outright. All three clear the moment playback stops — so mutating
/// ops stop playback first, then retry the whole transfer a few times.
const FS_ATTEMPTS: u32 = 5;
const RETRY_BACKOFF: Duration = Duration::from_millis(150);

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

/// Errors a lingering macro produces on the serial link — all transient,
/// gone once playback has actually stopped, so worth retrying.
fn is_transient(e: &str) -> bool {
    e.contains("os error 121") // Windows serial write stalled (device busy)
        || e.contains("did not answer in time") // our reply timeout
        || e.contains("busy playing a macro") // firmware's explicit busy reply
}

/// Stop any macro playing so the filesystem is actually free. Sending `stop`
/// is a no-op when nothing is playing (the firmware ignores it in the idle
/// loop), so this is safe to run before every mutating op. We don't block
/// waiting for it: the firmware stops within a poll tick and the retry below
/// absorbs the brief window while playback unwinds.
fn quiesce(mgr: &DeviceManager) {
    let _ = serial::send(mgr, &json!({"t": "stop"}));
}

/// Run a mutating fs op, first stopping playback, and retry the whole thing
/// on the transient errors a still-winding-down macro leaves behind.
fn with_recovery<T>(
    mgr: &DeviceManager,
    mut op: impl FnMut(&DeviceManager) -> Result<T, String>,
) -> Result<T, String> {
    let mut last = String::new();
    for attempt in 0..FS_ATTEMPTS {
        quiesce(mgr);
        if attempt > 0 {
            std::thread::sleep(RETRY_BACKOFF);
        }
        match op(mgr) {
            Ok(v) => return Ok(v),
            Err(e) if is_transient(&e) => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// `progress(written, total)` fires after every acknowledged chunk so the UI
/// can draw a real progress bar for multi-second transfers (a retry restarts
/// it from 0 — the bar simply starts over).
pub fn write_file(
    mgr: &DeviceManager,
    path: &str,
    bytes: &[u8],
    mut progress: impl FnMut(usize, usize),
) -> Result<(), String> {
    let path = rel(path)?;
    with_recovery(mgr, |mgr| write_once(mgr, path, bytes, &mut progress))
}

fn write_once(
    mgr: &DeviceManager,
    path: &str,
    bytes: &[u8],
    progress: &mut impl FnMut(usize, usize),
) -> Result<(), String> {
    let op = Op::begin(mgr)?;
    let total = bytes.len();
    let chunks: Vec<&[u8]> = if bytes.is_empty() {
        vec![&[]]
    } else {
        bytes.chunks(CHUNK).collect()
    };
    let last = chunks.len() - 1;
    progress(0, total);
    let mut written = 0;
    for (seq, chunk) in chunks.into_iter().enumerate() {
        if cancel_requested() {
            return Err(CANCELLED.to_string());
        }
        op.send(&json!({
            "t": "fs_write", "path": path, "seq": seq,
            "data": B64.encode(chunk), "eof": seq == last,
        }))?;
        op.expect_ok("fs_write")?;
        written += chunk.len();
        progress(written, total);
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
    with_recovery(mgr, |mgr| {
        let op = Op::begin(mgr)?;
        op.send(&json!({"t": "fs_delete", "path": path}))?;
        op.expect_ok("fs_delete").map(|_| ())
    })
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
