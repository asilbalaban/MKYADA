//! Serial transport to the keypad: port discovery, probing and a JSON-lines
//! connection. See docs/serial-protocol.md.
//!
//! The firmware exposes two CDC interfaces (console + data) with the same USB
//! product string, so discovery probes each candidate with `identify` and
//! keeps the one that answers `hello`.

use serde::Serialize;
use serde_json::Value;
use serialport::{SerialPort, SerialPortType};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const PRODUCT_MARKER: &str = "MKYADA";
const PROBE_TIMEOUT: Duration = Duration::from_millis(900);
/// I/O timeout on the live connection. Generous on purpose: the device's
/// USB-CDC RX buffer is small (~256B), so a ~4KB fs_write chunk drains over
/// many buffer-fill cycles. A brief device stall in that window — a
/// CircuitPython GC pause, a flash commit — must not blow the write into
/// Windows ERROR_SEM_TIMEOUT ("os error 121"). Writes run on background
/// threads so this never blocks the UI, and incoming data still arrives
/// instantly (the timeout only bounds *idle* waits).
const LIVE_TIMEOUT: Duration = Duration::from_millis(1000);
/// USB vendor IDs CircuitPython boards ship with (Adafruit, Raspberry Pi) —
/// used to order the probe fallback, not to exclude anything.
const KNOWN_VIDS: &[u16] = &[0x239A, 0x2E8A];

#[derive(Serialize, Clone)]
pub struct DeviceInfo {
    pub port: String,
    pub hello: Value,
}

/// Sink for fs_* responses while a serialfs operation is in flight; the
/// reader thread routes matching messages here instead of the frontend.
type FsRoute = Arc<Mutex<Option<std::sync::mpsc::Sender<Value>>>>;

pub struct Connection {
    pub port_name: String,
    writer: Box<dyn SerialPort>,
    stop: Arc<AtomicBool>,
    fs_route: FsRoute,
    /// A previous write failed partway, so bytes without a terminating newline
    /// may be sitting on the wire. The next send prepends a newline to close
    /// that dangling line before the device merges it with the new command.
    resync: bool,
}

#[derive(Default)]
pub struct DeviceManager(pub Mutex<Option<Connection>>);

impl DeviceManager {
    pub fn connected_port(&self) -> Option<String> {
        self.0.lock().unwrap().as_ref().map(|c| c.port_name.clone())
    }

    /// Install (or clear) the routing sink for fs_* responses.
    pub fn set_fs_route(
        &self,
        tx: Option<std::sync::mpsc::Sender<Value>>,
    ) -> Result<(), String> {
        let guard = self.0.lock().unwrap();
        let conn = guard.as_ref().ok_or("not connected")?;
        *conn.fs_route.lock().unwrap() = tx;
        Ok(())
    }
}

fn open(port: &str) -> Result<Box<dyn SerialPort>, String> {
    let mut sp = serialport::new(port, 115_200)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("{port}: {e}"))?;
    // CDC hosts conventionally assert DTR; some stacks hold data until it is.
    let _ = sp.write_data_terminal_ready(true);
    Ok(sp)
}

/// One USB serial port as the OS reports it.
struct UsbPort {
    name: String,
    vid: u16,
    product: String,
    /// USB iSerialNumber. CircuitPython puts the chip UID here — the same
    /// value boot_out.txt's `UID:` line carries and `hello` reports — so this
    /// is what ties a port to a particular board (and to its drive).
    serial: String,
}

/// Every USB serial port, with macOS's duplicate twins removed: it lists each
/// device as both /dev/cu.X (callout) and /dev/tty.X (dial-in), and both reach
/// the same board, so keeping both showed one keypad twice and broke
/// auto-connect.
fn usb_ports() -> Vec<UsbPort> {
    let Ok(ports) = serialport::available_ports() else {
        return Vec::new();
    };
    let usb: Vec<UsbPort> = ports
        .into_iter()
        .filter_map(|p| match p.port_type {
            SerialPortType::UsbPort(info) => Some(UsbPort {
                name: p.port_name,
                vid: info.vid,
                product: info.product.unwrap_or_default(),
                serial: info.serial_number.unwrap_or_default(),
            }),
            _ => None,
        })
        .collect();
    let cu_names: std::collections::HashSet<String> = usb
        .iter()
        .filter_map(|p| p.name.strip_prefix("/dev/cu.").map(str::to_string))
        .collect();
    usb.into_iter()
        .filter(|p| {
            p.name
                .strip_prefix("/dev/tty.")
                .is_none_or(|suffix| !cu_names.contains(suffix))
        })
        .collect()
}

/// Ports worth probing for a keypad.
///
/// Preferred: USB product string mentions MKYADA (macOS/Linux report the real
/// string). Windows instead reports the usbser.sys friendly name ("USB Serial
/// Device"), so when nothing matches by name we fall back to EVERY USB serial
/// port — known CircuitPython vendor IDs first. probe() keeps only ports that
/// actually answer `identify` with `hello`, so the fallback stays safe.
pub fn candidate_ports() -> Vec<String> {
    let usb = usb_ports();
    let by_name: Vec<String> = usb
        .iter()
        .filter(|p| p.product.contains(PRODUCT_MARKER))
        .map(|p| p.name.clone())
        .collect();
    if !by_name.is_empty() {
        return by_name;
    }

    let (mut known, rest): (Vec<_>, Vec<_>) =
        usb.into_iter().partition(|p| KNOWN_VIDS.contains(&p.vid));
    known.extend(rest);
    known.into_iter().map(|p| p.name).collect()
}

/// Hard-reset a board by typing `microcontroller.reset()` into its
/// CircuitPython REPL. `uid` is the board's CircuitPython UID (DriveInfo.uid,
/// i.e. boot_out.txt's `UID:` line), which doubles as its USB serial number.
///
/// This is the last step of provisioning a blank board. CircuitPython picks up
/// everything the app copies onto a fresh CIRCUITPY drive by itself —
/// everything except boot.py, which runs on a HARD reset only and is what
/// enables the data CDC channel the app talks over. So a just-provisioned
/// board keeps running the USB layout stock CircuitPython came up with and
/// stays invisible to the app until it is power-cycled. Driving the reset in
/// over the REPL console (the one interface stock CircuitPython does expose)
/// is that power cycle, without the user touching the cable.
pub fn repl_reset(uid: &str) -> Result<(), String> {
    let want = uid.trim().to_lowercase();
    let ports = usb_ports();
    let mut target = ports
        .iter()
        .find(|p| !want.is_empty() && p.serial.to_lowercase() == want)
        .map(|p| p.name.clone());
    if target.is_none() {
        // Windows can report a usbser.sys port with no serial number at all.
        // Fall back to CircuitPython-VID ports that do NOT answer `identify` —
        // a board already speaking the protocol has its data channel and needs
        // none of this. Only when exactly one is left: better to fall back to
        // "unplug and replug it" than to reset somebody else's board.
        let mut fresh = ports
            .iter()
            .filter(|p| KNOWN_VIDS.contains(&p.vid))
            .map(|p| p.name.clone())
            .filter(|n| probe(n).is_none());
        target = match (fresh.next(), fresh.next()) {
            (Some(only), None) => Some(only),
            _ => None,
        };
    }
    let port = target.ok_or("could not find the board's serial console")?;
    let mut sp = open(&port)?;
    // Twice: the first Ctrl-C breaks out of whatever code.py is running, the
    // second lands on a bare >>> even if the first raced an auto-reload.
    for _ in 0..2 {
        sp.write_all(b"\x03").map_err(|e| format!("{port}: {e}"))?;
        sp.flush().ok();
        std::thread::sleep(Duration::from_millis(250));
    }
    // Not error-checked: the board drops off the bus the instant it resets, so
    // a failed write here is as likely to mean success as failure. The caller
    // decides by waiting for the keypad to come back.
    let _ = sp.write_all(b"\r\nimport microcontroller; microcontroller.reset()\r\n");
    sp.flush().ok();
    Ok(())
}

/// Send `identify` and wait briefly for a `hello`. Filters out the CDC
/// console interface, which never replies with JSON.
pub fn probe(port: &str) -> Option<Value> {
    let mut sp = open(port).ok()?;
    sp.write_all(b"{\"t\":\"identify\"}\n").ok()?;
    sp.flush().ok();
    let mut reader = BufReader::new(sp);
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut line = Vec::new();
    while Instant::now() < deadline {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {
                if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                    if v.get("t").and_then(Value::as_str) == Some("hello") {
                        return Some(v);
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => break,
        }
    }
    None
}

/// Probe every candidate port (skipping an already-open connection).
/// Results are deduplicated by board UID — if two ports reach the same
/// board, only the first responder is kept.
pub fn scan(skip: Option<&str>) -> Vec<DeviceInfo> {
    let mut seen_uids = std::collections::HashSet::new();
    candidate_ports()
        .into_iter()
        .filter(|p| Some(p.as_str()) != skip)
        .filter_map(|p| probe(&p).map(|hello| DeviceInfo { port: p, hello }))
        .filter(|d| {
            match d.hello.get("uid").and_then(Value::as_str) {
                Some(uid) => seen_uids.insert(uid.to_lowercase()),
                None => true,
            }
        })
        .collect()
}

/// Open a connection and stream every incoming JSON line to the frontend as a
/// `device:msg` event. Emits `device:disconnected` when the port drops.
pub fn connect(app: AppHandle, mgr: &DeviceManager, port: &str) -> Result<(), String> {
    disconnect(mgr);
    // Reopening the SAME port (self-heal "software replug"): the old reader
    // thread may hold the file for up to its read timeout before it notices
    // the stop flag, and macOS enforces an exclusive lock — an immediate open
    // then fails and used to strand the app "connected" to nothing. Give the
    // old reader time to actually release the port.
    let mut sp = match open(port) {
        Ok(sp) => sp,
        Err(first) => {
            let mut last = first;
            let mut opened = None;
            for _ in 0..25 {
                std::thread::sleep(Duration::from_millis(120));
                match open(port) {
                    Ok(sp) => {
                        opened = Some(sp);
                        break;
                    }
                    Err(e) => last = e,
                }
            }
            match opened {
                Some(sp) => sp,
                None => {
                    // Truly can't open: make sure the frontend knows it is NOT
                    // connected (the old connection is gone), so auto-connect
                    // can take over instead of waiting forever.
                    crate::dbg_log!("connect {port}: open failed after retries: {last}");
                    let _ = app.emit("device:disconnected", port);
                    return Err(last);
                }
            }
        }
    };
    let mut writer = sp.try_clone().map_err(|e| e.to_string())?;
    // Lengthen both handles from open()'s short probe timeout: writes need the
    // headroom (see LIVE_TIMEOUT), and reads only wake from idle on it — data
    // still arrives instantly. Set both so it holds whether or not the cloned
    // handle shares the underlying timeout.
    let _ = sp.set_timeout(LIVE_TIMEOUT);
    let _ = writer.set_timeout(LIVE_TIMEOUT);
    let stop = Arc::new(AtomicBool::new(false));
    let fs_route: FsRoute = Arc::new(Mutex::new(None));
    let conn = Connection {
        port_name: port.to_string(),
        writer,
        stop: stop.clone(),
        fs_route: fs_route.clone(),
        resync: false,
    };
    *mgr.0.lock().unwrap() = Some(conn);
    // A fresh keypad starts outside test mode; the open page re-enters it on
    // mount. Without this reset a disconnect while the Keys page was up left
    // the flag stuck and sound keys stayed mute for the rest of the session.
    TEST_MODE.store(false, std::sync::atomic::Ordering::Relaxed);

    let port_name = port.to_string();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(sp);
        let mut line = Vec::new();
        #[cfg(windows)]
        let mut timeouts: u32 = 0;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => {
                    // EOF: device unplugged on some platforms
                    crate::dbg_log!("reader {port_name}: EOF -> disconnected");
                    let _ = app.emit("device:disconnected", &port_name);
                    break;
                }
                Ok(_) => {
                    #[cfg(windows)]
                    {
                        timeouts = 0;
                    }
                    if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                        // Play "sound" keys natively from this always-awake
                        // thread — the webview that would otherwise trigger them
                        // is suspended when the app is in the background.
                        crate::sound::on_device_msg(&v);
                        // The board names the biggest fs_write chunk its heap
                        // can hold in one contiguous block (fw 0.19.1+).
                        if v.get("t").and_then(Value::as_str) == Some("hello") {
                            super::serialfs::note_hello(&v);
                        }
                        // fs_* responses belong to the serialfs op that asked
                        // for them; everything else streams to the frontend.
                        let routed = super::serialfs::is_fs_msg(&v)
                            && fs_route
                                .lock()
                                .unwrap()
                                .as_ref()
                                .is_some_and(|tx| tx.send(v.clone()).is_ok());
                        if !routed {
                            let _ = app.emit("device:msg", &v);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // macOS quirk: reads on an unplugged/reset device keep
                    // timing out forever instead of erroring, so the app
                    // would show "connected" to a dead port. The /dev node
                    // disappears on removal — use that as the drop signal.
                    #[cfg(unix)]
                    if !std::path::Path::new(&port_name).exists() {
                        crate::dbg_log!("reader {port_name}: /dev node gone -> disconnected");
                        let _ = app.emit("device:disconnected", &port_name);
                        break;
                    }
                    // Windows has the same quirk with usbser.sys, but no
                    // /dev node to watch — ask the OS port list (~1×/s at
                    // the 1 s read timeout) whether the COM port is gone.
                    // Without this the app stayed "connected" to a dead
                    // port forever and never rescanned (issue #3).
                    #[cfg(windows)]
                    {
                        timeouts += 1;
                        if timeouts >= 1 {
                            timeouts = 0;
                            let gone = serialport::available_ports()
                                .map(|ps| ps.iter().all(|p| p.port_name != port_name))
                                .unwrap_or(false);
                            if gone {
                                let _ = app.emit("device:disconnected", &port_name);
                                break;
                            }
                        }
                    }
                    continue;
                }
                Err(e) => {
                    crate::dbg_log!("reader {port_name}: read err {e} -> disconnected");
                    let _ = app.emit("device:disconnected", &port_name);
                    break;
                }
            }
        }
        crate::dbg_log!("reader {port_name}: exit (stop={})", stop.load(Ordering::Relaxed));
        // Drop the dead connection from the manager (unless a newer one
        // already replaced it) so send() fails fast with "not connected"
        // instead of writing into a void.
        use tauri::Manager;
        let mgr = app.state::<DeviceManager>();
        let mut guard = mgr.0.lock().unwrap();
        if guard.as_ref().is_some_and(|c| Arc::ptr_eq(&c.stop, &stop)) {
            guard.take();
        }
    });
    Ok(())
}

/// True while the app holds the keypad in test mode (Keys / Setup pages).
/// Tracked here because it's the app's own outgoing `test_enter`/`test_leave`
/// that defines it, and both the sound player and the action runner have to
/// honour it — a key being edited must not also fire (issue #40).
static TEST_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn test_mode() -> bool {
    TEST_MODE.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn send(mgr: &DeviceManager, msg: &Value) -> Result<(), String> {
    match msg.get("t").and_then(Value::as_str) {
        Some("test_enter") => TEST_MODE.store(true, std::sync::atomic::Ordering::Relaxed),
        Some("test_leave") => TEST_MODE.store(false, std::sync::atomic::Ordering::Relaxed),
        _ => {}
    }
    // Hold back status pushes while a file transfer owns the link. The keypad's
    // USB receive FIFO is a few hundred bytes and only drains once per main-loop
    // pass; every one of these makes it repaint (100-300ms), and a chunk landing
    // in that window loses bytes off the middle of the line. Measured: the
    // device logged a 1024-byte chunk arriving as 642 bytes of base64, then
    // dropped the next line entirely — which the app saw only as "the keypad did
    // not answer in time", i.e. every recorded-macro save failing.
    // The band's whole state in one line: this is what separates "the app
    // never pushed it" from "the keypad ignored it" when (R)/(L) or the scene
    // name look stale — the question that cost a whole session to answer once.
    if msg.get("t").and_then(Value::as_str) == Some("label") {
        crate::dbg_log!(
            "label -> rec={} live={} text={} busy={}",
            msg.get("rec").and_then(Value::as_bool).unwrap_or(false),
            msg.get("live").and_then(Value::as_bool).unwrap_or(false),
            msg.get("text").and_then(Value::as_str).unwrap_or(""),
            super::serialfs::BUSY.load(std::sync::atomic::Ordering::SeqCst)
        );
    }
    if super::serialfs::BUSY.load(std::sync::atomic::Ordering::SeqCst)
        && super::serialfs::is_cosmetic(msg)
    {
        // held back, NOT forgotten — the op re-sends it on completion
        super::serialfs::defer(msg);
        return Ok(());
    }
    let mut guard = mgr.0.lock().unwrap();
    let conn = guard.as_mut().ok_or("not connected")?;
    let mut data = Vec::new();
    // Close any partial line a previous failed write left dangling, so this
    // command lands on a fresh line (the device skips the resulting empty one).
    if conn.resync {
        data.push(b'\n');
        conn.resync = false;
    }
    data.extend(serde_json::to_vec(msg).map_err(|e| e.to_string())?);
    data.push(b'\n');
    if let Err(e) = conn.writer.write_all(&data) {
        // Bytes may have gone out without the terminating newline; mark the
        // stream so the next send resyncs before the device merges lines.
        conn.resync = true;
        return Err(e.to_string());
    }
    conn.writer.flush().ok();
    Ok(())
}

pub fn disconnect(mgr: &DeviceManager) {
    if let Some(conn) = mgr.0.lock().unwrap().take() {
        conn.stop.store(true, Ordering::Relaxed);
    }
}
