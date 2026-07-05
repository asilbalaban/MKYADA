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
/// USB vendor IDs CircuitPython boards ship with (Adafruit, Raspberry Pi) —
/// used to order the probe fallback, not to exclude anything.
const KNOWN_VIDS: &[u16] = &[0x239A, 0x2E8A];

#[derive(Serialize, Clone)]
pub struct DeviceInfo {
    pub port: String,
    pub hello: Value,
}

pub struct Connection {
    pub port_name: String,
    writer: Box<dyn SerialPort>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct DeviceManager(pub Mutex<Option<Connection>>);

impl DeviceManager {
    pub fn connected_port(&self) -> Option<String> {
        self.0.lock().unwrap().as_ref().map(|c| c.port_name.clone())
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

/// Ports worth probing for a keypad.
///
/// Preferred: USB product string mentions MKYADA (macOS/Linux report the real
/// string). Windows instead reports the usbser.sys friendly name ("USB Serial
/// Device"), so when nothing matches by name we fall back to EVERY USB serial
/// port — known CircuitPython vendor IDs first. probe() keeps only ports that
/// actually answer `identify` with `hello`, so the fallback stays safe.
pub fn candidate_ports() -> Vec<String> {
    let Ok(ports) = serialport::available_ports() else {
        return Vec::new();
    };
    let usb: Vec<(String, u16, String)> = ports
        .into_iter()
        .filter_map(|p| match p.port_type {
            SerialPortType::UsbPort(info) => Some((
                p.port_name,
                info.vid,
                info.product.unwrap_or_default(),
            )),
            _ => None,
        })
        .collect();

    // macOS lists every serial device twice: /dev/cu.X (callout) and
    // /dev/tty.X (dial-in). Both reach the same board, so keep only the cu.
    // twin — otherwise one keypad shows up as two and breaks auto-connect.
    let cu_names: std::collections::HashSet<String> = usb
        .iter()
        .filter_map(|(name, _, _)| name.strip_prefix("/dev/cu.").map(str::to_string))
        .collect();
    let usb: Vec<(String, u16, String)> = usb
        .into_iter()
        .filter(|(name, _, _)| {
            name.strip_prefix("/dev/tty.")
                .is_none_or(|suffix| !cu_names.contains(suffix))
        })
        .collect();

    let by_name: Vec<String> = usb
        .iter()
        .filter(|(_, _, product)| product.contains(PRODUCT_MARKER))
        .map(|(name, _, _)| name.clone())
        .collect();
    if !by_name.is_empty() {
        return by_name;
    }

    let (mut known, rest): (Vec<_>, Vec<_>) =
        usb.into_iter().partition(|(_, vid, _)| KNOWN_VIDS.contains(vid));
    known.extend(rest);
    known.into_iter().map(|(name, _, _)| name).collect()
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
    let sp = open(port)?;
    let writer = sp.try_clone().map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let conn = Connection {
        port_name: port.to_string(),
        writer,
        stop: stop.clone(),
    };
    *mgr.0.lock().unwrap() = Some(conn);

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
                    let _ = app.emit("device:disconnected", &port_name);
                    break;
                }
                Ok(_) => {
                    #[cfg(windows)]
                    {
                        timeouts = 0;
                    }
                    if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                        let _ = app.emit("device:msg", &v);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // macOS quirk: reads on an unplugged/reset device keep
                    // timing out forever instead of erroring, so the app
                    // would show "connected" to a dead port. The /dev node
                    // disappears on removal — use that as the drop signal.
                    #[cfg(unix)]
                    if !std::path::Path::new(&port_name).exists() {
                        let _ = app.emit("device:disconnected", &port_name);
                        break;
                    }
                    // Windows has the same quirk with usbser.sys, but no
                    // /dev node to watch — ask the OS port list (~1×/s at
                    // the 100 ms read timeout) whether the COM port is gone.
                    // Without this the app stayed "connected" to a dead
                    // port forever and never rescanned (issue #3).
                    #[cfg(windows)]
                    {
                        timeouts += 1;
                        if timeouts >= 10 {
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
                Err(_) => {
                    let _ = app.emit("device:disconnected", &port_name);
                    break;
                }
            }
        }
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

pub fn send(mgr: &DeviceManager, msg: &Value) -> Result<(), String> {
    let mut guard = mgr.0.lock().unwrap();
    let conn = guard.as_mut().ok_or("not connected")?;
    let mut data = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    data.push(b'\n');
    conn.writer.write_all(&data).map_err(|e| e.to_string())?;
    conn.writer.flush().ok();
    Ok(())
}

pub fn disconnect(mgr: &DeviceManager) {
    if let Some(conn) = mgr.0.lock().unwrap().take() {
        conn.stop.store(true, Ordering::Relaxed);
    }
}
