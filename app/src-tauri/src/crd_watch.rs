//! Hold macro playback while someone is connected over Chrome Remote Desktop.
//!
//! A playing macro moves the mouse and types, so whoever connects from afar
//! can't control the computer while it runs. For as long as a session is open:
//! * a macro running at the moment of connecting is stopped (and remembered);
//! * any macro that starts during the session — the physical key, "Run again",
//!   a profile — is stopped the moment the keypad announces it (`play_start`).
//!
//! When the session ends, the macro that was interrupted by the connection is
//! pressed again (`{"t":"press"}`, proto v17), so a farming loop carries on.
//! Every stop goes through `remote::stop_playback(app, "remote-desktop")`, the
//! same path as the hotkey and the tray. The UI follows `remote-desktop:state`.
//!
//! How a session shows up (measured, no admin/root needed on either OS):
//! * Windows: the host service spawns `remoting_desktop.exe` only while a client
//!   is connected; idle, only `remoting_host.exe` runs.
//! * macOS: `remoting_me2me_host` runs as the user. Idle it holds only UDP
//!   sockets connected to Google's signalling servers (`…->x.x.x.x:443`).
//!   Connecting adds one more of those plus WebRTC candidate sockets that are
//!   bound but not connected; the candidates can close again a few seconds in,
//!   so the session counts as open until the extra :443 socket is gone too.
//!   Socket counts depend on the machine's interfaces — we compare against
//!   this machine's own idle state, never a fixed number.
//!
//! Turned off with `stopOnRemoteDesktop: false` in settings.json.

use crate::device::serial::{self, DeviceManager};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const POLL: Duration = Duration::from_secs(2);
const STORE_KEY: &str = "stopOnRemoteDesktop";

#[derive(Clone, Debug, PartialEq)]
struct Play {
    key: Option<i64>,
    layer: Option<String>,
}

#[derive(Default)]
struct Watch {
    /// a remote desktop session is open right now (and the feature is on)
    active: bool,
    /// what the keypad is playing, from play_start / play_done / hello
    playing: Option<Play>,
    /// the key play the connection interrupted — pressed again on disconnect
    resume: Option<Play>,
}

static WATCH: Mutex<Watch> = Mutex::new(Watch {
    active: false,
    playing: None,
    resume: None,
});

/// What the UI shows: whether playback is on hold, and which key will resume.
#[derive(Clone, Serialize)]
pub struct RdState {
    pub active: bool,
    pub resume_key: Option<i64>,
    pub resume_layer: Option<String>,
}

fn snapshot(w: &Watch) -> RdState {
    RdState {
        active: w.active,
        resume_key: w.resume.as_ref().and_then(|p| p.key),
        resume_layer: w.resume.as_ref().and_then(|p| p.layer.clone()),
    }
}

#[tauri::command]
pub fn remote_desktop_state() -> RdState {
    snapshot(&WATCH.lock().unwrap())
}

pub fn init(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("crd-watch".into())
        .spawn(move || {
            let mut probe = Probe::default();
            loop {
                if let Some(open) = probe.session_open() {
                    let on = open && enabled(&app);
                    let was = WATCH.lock().unwrap().active;
                    if on && !was {
                        connected(&app);
                    } else if !on && was {
                        disconnected(&app);
                    }
                }
                std::thread::sleep(POLL);
            }
        });
}

fn connected(app: &AppHandle) {
    let (st, stop) = {
        let mut w = WATCH.lock().unwrap();
        w.active = true;
        // only a numbered key can be pressed again later
        w.resume = w.playing.clone().filter(|p| p.key.is_some());
        (snapshot(&w), w.playing.is_some())
    };
    crate::dbg_log!("remote desktop connected; resume {:?}", st.resume_key);
    let _ = app.emit("remote-desktop:state", &st);
    if stop {
        crate::remote::stop_playback(app, "remote-desktop");
    }
}

fn disconnected(app: &AppHandle) {
    let (st, resume) = {
        let mut w = WATCH.lock().unwrap();
        w.active = false;
        let r = w.resume.take();
        (snapshot(&w), r)
    };
    crate::dbg_log!("remote desktop disconnected; resuming {resume:?}");
    let _ = app.emit("remote-desktop:state", &st);
    if let Some(p) = resume {
        let mut msg = json!({ "t": "press", "key": p.key });
        if let Some(l) = p.layer {
            msg["layer"] = json!(l);
        }
        let r = serial::send(&app.state::<DeviceManager>(), &msg);
        let _ = app.emit(
            "remote-desktop:resumed",
            json!({ "key": p.key, "ok": r.is_ok(), "error": r.err() }),
        );
    }
}

/// Called by the serial reader for every keypad message: keeps track of what
/// is playing and stops anything that starts while a session is open.
pub fn on_device_msg(app: &AppHandle, v: &Value) {
    let started = {
        let mut w = WATCH.lock().unwrap();
        match v.get("t").and_then(Value::as_str) {
            Some("play_start") => w.playing = Some(play_of(v)),
            Some("play_done") => w.playing = None,
            // a (re)connect reports a playback already running (proto v17)
            Some("hello") => w.playing = v.get("playing").filter(|p| p.is_object()).map(play_of),
            _ => return,
        }
        w.active && w.playing.is_some()
    };
    if started {
        crate::remote::stop_playback(app, "remote-desktop");
    }
}

fn play_of(v: &Value) -> Play {
    Play {
        key: v.get("key").and_then(Value::as_i64),
        layer: v.get("layer").and_then(Value::as_str).map(str::to_string),
    }
}

fn enabled(app: &AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;
    app.store("settings.json")
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Per-OS session probe. None = can't tell (the probe itself failed), which
/// never counts as a change.
#[derive(Default)]
struct Probe {
    /// macOS: signalling sockets seen while idle (this machine's baseline)
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    idle_signalling: Option<usize>,
    /// macOS: candidates were seen and the extra signalling socket is still up
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    latched: bool,
}

impl Probe {
    #[cfg(target_os = "windows")]
    fn session_open(&mut self) -> Option<bool> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut found = false;
            let mut more = Process32FirstW(snap, &mut entry).is_ok();
            while more {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case("remoting_desktop.exe") {
                    found = true;
                    break;
                }
                more = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
            Some(found)
        }
    }

    #[cfg(target_os = "macos")]
    fn session_open(&mut self) -> Option<bool> {
        // -c matches the (truncated) command name; -a ANDs it with -iUDP; -Fn
        // prints one `n<address>` line per socket. No CRD installed / no
        // sockets exits 1 with empty output, which is simply "no session".
        let out = std::process::Command::new("/usr/sbin/lsof")
            .args(["-nP", "-a", "-iUDP", "-c", "remoting_me2me", "-Fn"])
            .output()
            .ok()?;
        let s = UdpSockets::parse(&String::from_utf8_lossy(&out.stdout));
        Some(self.step(s))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    fn session_open(&mut self) -> Option<bool> {
        None
    }

    /// macOS decision from one lsof sample (pure, unit-tested).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn step(&mut self, s: UdpSockets) -> bool {
        if s.candidates > 0 {
            self.latched = true;
        } else if self.latched {
            // candidates may close mid-session; the session's extra
            // signalling socket stays until the client disconnects
            let base = self.idle_signalling.unwrap_or(1);
            if s.signalling <= base {
                self.latched = false;
            }
        }
        if !self.latched {
            // idle: learn this machine's baseline (the lowest seen)
            self.idle_signalling = Some(
                self.idle_signalling
                    .map_or(s.signalling, |b| b.min(s.signalling)),
            );
        }
        self.latched
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Default, Clone, Copy)]
struct UdpSockets {
    /// connected to a remote end (`a->b`): signalling
    signalling: usize,
    /// bound but unconnected: WebRTC session candidates
    candidates: usize,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl UdpSockets {
    /// lsof -Fn output. Signalling reads `n192.168.1.40:61003->172.217.112.4:443`,
    /// a session candidate `n192.168.1.40:54884`.
    fn parse(lsof_fn: &str) -> Self {
        let mut s = Self::default();
        for addr in lsof_fn.lines().filter_map(|l| l.strip_prefix('n')) {
            if addr.contains("->") {
                s.signalling += 1;
            } else {
                s.candidates += 1;
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDLE: &str = "p20298\nf33\nn192.168.1.40:61003->172.217.112.4:443\n";
    const CONNECTING: &str = "p20298\nf30\nn192.168.1.40:50874->172.217.115.4:443\nf33\nn192.168.1.40:61003->172.217.112.4:443\n";
    const LIVE: &str = "p20298\nf30\nn192.168.1.40:50874->172.217.115.4:443\nf31\nn192.168.1.40:54884\nf33\nn192.168.1.40:61003->172.217.112.4:443\nf34\nn192.168.1.40:53223\n";

    #[test]
    fn parses_lsof() {
        let s = UdpSockets::parse(LIVE);
        assert_eq!((s.signalling, s.candidates), (2, 2));
        let s = UdpSockets::parse("");
        assert_eq!((s.signalling, s.candidates), (0, 0));
    }

    /// The measured macOS timeline: idle, signalling, candidates, candidates
    /// gone (still connected), extra socket gone (disconnected).
    #[test]
    fn mac_session_spans_candidate_gap() {
        let mut p = Probe::default();
        assert!(!p.step(UdpSockets::parse(IDLE)));
        assert!(!p.step(UdpSockets::parse(CONNECTING)));
        assert!(p.step(UdpSockets::parse(LIVE)));
        assert!(p.step(UdpSockets::parse(CONNECTING)));
        assert!(!p.step(UdpSockets::parse(IDLE)));
        assert!(!p.step(UdpSockets::parse(CONNECTING)));
    }

    #[test]
    fn mac_session_open_at_launch() {
        let mut p = Probe::default();
        assert!(p.step(UdpSockets::parse(LIVE)));
        // no idle baseline yet: assume one signalling socket
        assert!(p.step(UdpSockets::parse(CONNECTING)));
        assert!(!p.step(UdpSockets::parse(IDLE)));
    }
}
