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
    serialport::new(port, 115_200)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| format!("{port}: {e}"))
}

/// Ports whose USB product string mentions MKYADA.
pub fn candidate_ports() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(ports) = serialport::available_ports() {
        for p in ports {
            if let SerialPortType::UsbPort(info) = &p.port_type {
                let product = info.product.as_deref().unwrap_or("");
                if product.contains(PRODUCT_MARKER) {
                    out.push(p.port_name.clone());
                }
            }
        }
    }
    out
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
pub fn scan(skip: Option<&str>) -> Vec<DeviceInfo> {
    candidate_ports()
        .into_iter()
        .filter(|p| Some(p.as_str()) != skip)
        .filter_map(|p| probe(&p).map(|hello| DeviceInfo { port: p, hello }))
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
                    if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                        let _ = app.emit("device:msg", &v);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => {
                    let _ = app.emit("device:disconnected", &port_name);
                    break;
                }
            }
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
