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
use std::collections::HashMap;
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

/// Raw bytes per fs_write line. base64 inflates this by 4/3 plus the JSON
/// envelope, and the firmware must hold the WHOLE line in RAM to parse it.
/// The old 9KB chunks (~12KB lines) fit the line buffer (MAX_LINE 16KB) but
/// MemoryError'd the Vision 6, whose display stack fragments the RP2040
/// heap — a 12KB contiguous allocation routinely fails there mid-upload.
/// 2KB (~2.7KB lines) is what the display model digests when its heap is
/// healthy; the extra round-trips cost little (stop-and-wait acks are ~ms on
/// CDC). `write_file` halves this down to MIN_CHUNK when a transfer fails,
/// so a fragmented heap costs round-trips instead of the whole save.
const CHUNK: usize = 2048;
/// Floor for the adaptive halving above: a 512B chunk is a ~700B line, small
/// enough to land in the gaps a churned RP2040 heap still has. Below that the
/// round-trip count stops being worth it — the device is wedged, not busy.
const MIN_CHUNK: usize = 512;

/// What the connected board said it can digest (`hello.fs_chunk`, fw 0.19.1+).
/// The display model answers 1024: measured, 2048 fails outright on its
/// fragmented heap. Firmware without the field keeps the CHUNK default.
static DEV_CHUNK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(CHUNK);

/// Called by the serial reader for every `hello`.
pub fn note_hello(hello: &Value) {
    let n = hello
        .get("fs_chunk")
        .and_then(Value::as_u64)
        .map_or(CHUNK, |v| (v as usize).clamp(MIN_CHUNK, CHUNK));
    DEV_CHUNK.store(n, std::sync::atomic::Ordering::Relaxed);
    crate::dbg_log!("device fs_chunk: {n}");
}
const TIMEOUT: Duration = Duration::from_secs(8);

/// A macro playing on the single-threaded firmware starves the serial link,
/// so a file write landing then either stalls at the OS layer (Windows
/// "os error 121") or waits out our reply timeout, and the firmware answers
/// "busy" outright. All three clear the moment playback stops — so mutating
/// ops stop playback first, then retry the whole transfer a few times.
const FS_ATTEMPTS: u32 = 5;
const RETRY_BACKOFF: Duration = Duration::from_millis(150);

/// A pure reply *timeout* (as opposed to a recoverable "oom"/"crc") almost
/// always means the link is wedged, not that the firmware is mid-GC — and each
/// retry costs a full TIMEOUT of dead air. Retrying it the full FS_ATTEMPTS
/// times held the sole `OP` lock for ~40s, during which the Keys page (and
/// every other fs op) could read nothing — the "data transfer failed at startup,
/// only a replug fixes it" report. Cap timeouts hard so the failure surfaces
/// fast, letting the frontend's self-heal reopen the port.
const FS_TIMEOUT_ATTEMPTS: u32 = 2;

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
        BUSY.store(true, std::sync::atomic::Ordering::SeqCst);
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
        BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
        // the link is ours again: deliver whatever we held back
        for msg in take_deferred() {
            crate::dbg_log!("replay deferred {msg}");
            let _ = serial::send(self.mgr, &msg);
        }
        let _ = self.mgr.set_fs_route(None);
    }
}

/// True while a file transfer holds the link. The keypad's USB receive FIFO is
/// a few hundred bytes and it only drains once per main-loop pass — so a status
/// push landing mid-transfer (each one makes the device repaint for 100-300ms)
/// overflows the FIFO and TRUNCATES the chunk line that follows. That read as
/// "the keypad did not answer in time" and failed every recorded-macro save.
/// `serial::send` drops cosmetic messages while this is set.
pub static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Latest deferred message per type, re-sent once the transfer finishes.
/// Holding them back is safe; FORGETTING them is not. A recording started from
/// a key ON THE DEVICE pushed its `rec:true` label inside the 480ms macro read
/// that same key press triggers — dropped and never re-sent, the band only
/// learned about it at the next scene change ("(R) shows if I start recording
/// in OBS, but not from the keypad").
static PENDING: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

/// Remember a message held back by `serial::send` (latest of each type wins).
pub fn defer(msg: &Value) {
    if let Some(t) = msg.get("t").and_then(Value::as_str) {
        let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(HashMap::new)
            .insert(t.to_string(), msg.clone());
    }
}

fn take_deferred() -> Vec<Value> {
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    g.take().map(|m| m.into_values().collect()).unwrap_or_default()
}

/// Message types safe to defer while a transfer owns the link: all of them are
/// either re-asserted on a timer (profile, sysvol) or purely cosmetic and
/// refreshed by the next change (label). Nothing here carries user intent.
pub fn is_cosmetic(v: &Value) -> bool {
    matches!(
        v.get("t").and_then(Value::as_str),
        Some("label" | "sysvol" | "profile" | "hostinfo")
    )
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

/// CRC32 (IEEE) — end-to-end integrity check for fs_write/fs_read since
/// proto v7. Tiny table-driven implementation instead of a crate dep.
fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, e) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *e = c;
        }
        t
    });
    let mut c = !0u32;
    for &b in bytes {
        c = table[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
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
        || e.contains("oom") // screen model briefly out of contiguous heap —
        // it gc's and the retry lands (a big recorded macro read on vision6)
        || e.contains("crc") // a corrupted transfer (line noise, dropped
        // bytes) — the .part was discarded, a clean retry usually lands
}

/// Stop any macro playing so the filesystem is actually free. Sending `stop`
/// is a no-op when nothing is playing (the firmware ignores it in the idle
/// loop), so this is safe to run before every mutating op. We don't block
/// waiting for it: the firmware stops within a poll tick and the retry below
/// absorbs the brief window while playback unwinds.
fn quiesce(mgr: &DeviceManager) {
    let _ = serial::send(mgr, &json!({"t": "stop"}));
}

/// Retry an fs op on the transient errors a still-winding-down macro leaves
/// behind. `stop_playback` sends a `stop` before each attempt — correct for
/// MUTATING ops (a playing macro locks the filesystem), but it must be FALSE
/// for reads: the app reads a key's macro on every key press (to run any
/// host-side action), and stopping playback there would abort the very macro
/// the press just started — silently killing every standalone key while the
/// app is connected. Reads still retry (e.g. on a screen model's transient
/// "oom"); they just never stop playback to do it.
fn with_recovery<T>(
    mgr: &DeviceManager,
    stop_playback: bool,
    mut op: impl FnMut(&DeviceManager) -> Result<T, String>,
) -> Result<T, String> {
    let mut last = String::new();
    let mut timeouts = 0u32;
    for attempt in 0..FS_ATTEMPTS {
        if stop_playback {
            quiesce(mgr);
        }
        if attempt > 0 {
            // grows per attempt: an OOM'd device needs breathing room to
            // gc/compact — immediate retries just found the same full heap
            RETRY_BACKOFF
                .checked_mul(attempt)
                .map(std::thread::sleep)
                .unwrap_or_default();
        }
        match op(mgr) {
            Ok(v) => return Ok(v),
            Err(e) if is_transient(&e) => {
                crate::dbg_log!("fs attempt {attempt}: transient {e}");
                // A wedged link (reply timeout) won't recover by waiting — bail
                // early so the whole op can't hold the link for ~40s.
                if e.contains("did not answer in time") {
                    timeouts += 1;
                    if timeouts >= FS_TIMEOUT_ATTEMPTS {
                        return Err(e);
                    }
                }
                last = e;
            }
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
    // Adaptive chunk size, mirroring the device-side fs_read. A chunk reaches
    // the keypad as ONE base64 line that its heap must hold in a single
    // CONTIGUOUS block — and CircuitPython never compacts, so a fragmented
    // heap can refuse 1.4KB while reporting 13KB free. Big chunks stay the
    // default (fewer round-trips, which matters most on Windows where each
    // one costs more); a transient failure halves them and starts over rather
    // than failing the save.
    let mut size = DEV_CHUNK.load(std::sync::atomic::Ordering::Relaxed);
    loop {
        let r = with_recovery(mgr, true, |mgr| {
            write_once(mgr, path, bytes, size, &mut progress)
        });
        match r {
            Ok(()) => return Ok(()),
            Err(e) if size > MIN_CHUNK && is_transient(&e) => {
                size /= 2;
                crate::dbg_log!("write {path}: {e} -> retrying with {size}B chunks");
            }
            Err(e) => return Err(e),
        }
    }
}

fn write_once(
    mgr: &DeviceManager,
    path: &str,
    bytes: &[u8],
    chunk_size: usize,
    progress: &mut impl FnMut(usize, usize),
) -> Result<(), String> {
    let op = Op::begin(mgr)?;
    let total = bytes.len();
    let chunks: Vec<&[u8]> = if bytes.is_empty() {
        vec![&[]]
    } else {
        bytes.chunks(chunk_size).collect()
    };
    let last = chunks.len() - 1;
    progress(0, total);
    // Stop-and-wait: one chunk in flight, ack before the next. Pipelining a
    // window here (tried in 0.11.2) floods the device's ~256B RX buffer while
    // the firmware is blocked writing a chunk to flash, stalling the host write
    // past LIVE_TIMEOUT ("os error 121") — and with no wire resync the retry
    // spirals. Safe pipelining needs firmware-side flow control; until then the
    // 9KB chunk (fewer round-trips) is the whole win.
    let mut written = 0;
    let file_crc = crc32(bytes);
    for (seq, chunk) in chunks.into_iter().enumerate() {
        if cancel_requested() {
            return Err(CANCELLED.to_string());
        }
        let eof = seq == last;
        let mut msg = json!({
            "t": "fs_write", "path": path, "seq": seq,
            "data": B64.encode(chunk), "eof": eof,
        });
        if eof {
            // proto v7: the firmware verifies the whole file's CRC32 before
            // the atomic rename — a corrupted transfer never lands. Older
            // firmware ignores the extra field.
            msg["crc"] = json!(file_crc);
        }
        op.send(&msg)?;
        let reply = op.expect_ok("fs_write")?;
        if eof {
            if let Some(dev) = reply.get("crc").and_then(Value::as_u64) {
                if dev != u64::from(file_crc) {
                    return Err("crc mismatch".to_string());
                }
            }
        }
        written += chunk.len();
        progress(written, total);
    }
    Ok(())
}

pub fn read_file(mgr: &DeviceManager, path: &str) -> Result<Vec<u8>, String> {
    read_file_with_progress(mgr, path, |_| {})
}

/// Like `read_file`, but reporting bytes-received per chunk — what feeds the
/// backup/restore progress UI (issue #43). The device doesn't announce a
/// file's size up front, so the callback carries only the running byte count.
pub fn read_file_with_progress(
    mgr: &DeviceManager,
    path: &str,
    progress: impl Fn(usize),
) -> Result<Vec<u8>, String> {
    let path = rel(path)?;
    // Retry the whole read on transient errors: on a screen model a big
    // recorded macro can momentarily exhaust the fragmented heap ("oom"),
    // and the device recovers on the next attempt. Without this the read
    // fails and the app would show the key as unassigned.
    with_recovery(mgr, false, |mgr| read_once(mgr, path, &progress))
}

fn read_once(
    mgr: &DeviceManager,
    path: &str,
    progress: &impl Fn(usize),
) -> Result<Vec<u8>, String> {
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
                        progress(out.len());
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
    with_recovery(mgr, true, |mgr| {
        let op = Op::begin(mgr)?;
        op.send(&json!({"t": "fs_delete", "path": path}))?;
        op.expect_ok("fs_delete").map(|_| ())
    })
}

/// File names in a directory, matching drive::list_dir semantics
/// (files only, dotfiles skipped, missing directory = empty list).
pub fn list_dir(mgr: &DeviceManager, path: &str) -> Result<Vec<String>, String> {
    Ok(list_entries(mgr, path)?
        .into_iter()
        .filter(|e| !e.dir)
        .map(|e| e.name)
        .collect())
}

/// Directory entries with sizes and subdirectories intact — what the repair
/// diagnosis needs to tell a stale module from a current one.
pub fn list_entries(mgr: &DeviceManager, path: &str) -> Result<Vec<super::Entry>, String> {
    let path = rel(path)?;
    // Big directories can OOM the reply on the device — retry like reads do
    // (never stopping playback), though pagination makes it rare.
    with_recovery(mgr, false, |mgr| list_once(mgr, path))
}

fn list_once(mgr: &DeviceManager, path: &str) -> Result<Vec<super::Entry>, String> {
    let op = Op::begin(mgr)?;
    op.send(&json!({"t": "fs_list", "path": path}))?;
    // Firmware ≥ 0.18.1 paginates big directories: each page carries
    // "more": true until the final one. A single un-flagged reply (older
    // firmware, small dirs) is simply the first-and-last page.
    let mut out: Vec<super::Entry> = Vec::new();
    loop {
        let v = op.recv()?;
        match v.get("t").and_then(Value::as_str) {
            Some("fs_list") => {
                if let Some(entries) = v.get("entries").and_then(Value::as_array) {
                    for e in entries {
                        let Some(name) = e.get("name").and_then(Value::as_str) else {
                            continue;
                        };
                        if name.starts_with('.') {
                            continue;
                        }
                        out.push(super::Entry {
                            name: name.to_string(),
                            size: e.get("size").and_then(Value::as_u64).unwrap_or(0),
                            dir: e.get("dir").and_then(Value::as_bool).unwrap_or(false),
                        });
                    }
                }
                if !v.get("more").and_then(Value::as_bool).unwrap_or(false) {
                    return Ok(out);
                }
            }
            Some("err") if v.get("code").and_then(Value::as_str) == Some("not_found") => {
                return Ok(Vec::new());
            }
            Some("err") => return Err(fs_err(&v)),
            _ => {}
        }
    }
}
