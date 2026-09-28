//! Stop a running macro the moment someone connects over Chrome Remote Desktop.
//!
//! A looping macro keeps moving the mouse and typing. Whoever connects to the
//! computer from afar would land in the middle of it, so the connection itself
//! stops playback (same path as the hotkey and the tray: `remote::stop_playback`,
//! source "remote-desktop").
//!
//! Only the *moment of connecting* counts (not-connected → connected). A session
//! that is already open when MKYADA starts, or a macro started from inside the
//! session, is left alone — people drive the keypad over remote desktop.
//!
//! How a session shows up (measured, no admin/root needed on either OS):
//! * Windows: the host service spawns `remoting_desktop.exe` only while a client
//!   is connected; idle, only `remoting_host.exe` runs.
//! * macOS: `remoting_me2me_host` runs as the user. Idle it holds only UDP
//!   sockets connected to Google's signalling servers (`…->x.x.x.x:443`); a
//!   session opens WebRTC candidate sockets that are bound but not connected.
//!   How many depends on the machine's network interfaces, so we test for
//!   "any", never a count.
//!
//! Turned off with `stopOnRemoteDesktop: false` in settings.json (read fresh on
//! every connection, like `runInBackground`).

use std::time::Duration;
use tauri::AppHandle;

const POLL: Duration = Duration::from_secs(2);
const STORE_KEY: &str = "stopOnRemoteDesktop";

pub fn init(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("crd-watch".into())
        .spawn(move || {
            // None until the first successful probe: a session already open at
            // launch is not a new connection.
            let mut was: Option<bool> = None;
            loop {
                if let Some(now) = session_active() {
                    if was == Some(false) && now {
                        crate::dbg_log!("remote desktop session connected");
                        if enabled(&app) {
                            crate::remote::stop_playback(&app, "remote-desktop");
                        }
                    } else if was == Some(true) && !now {
                        crate::dbg_log!("remote desktop session ended");
                    }
                    was = Some(now);
                }
                std::thread::sleep(POLL);
            }
        });
}

fn enabled(app: &AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;
    app.store("settings.json")
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Is a Chrome Remote Desktop client connected right now? None = can't tell
/// (the probe itself failed), which never counts as a change.
#[cfg(target_os = "windows")]
fn session_active() -> Option<bool> {
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
fn session_active() -> Option<bool> {
    // -c matches the (truncated) command name; -a ANDs it with -iUDP; -Fn
    // prints one `n<address>` line per socket. No CRD installed / no sockets
    // exits 1 with empty output, which is simply "no session".
    let out = std::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-iUDP", "-c", "remoting_me2me", "-Fn"])
        .output()
        .ok()?;
    Some(has_session_socket(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn session_active() -> Option<bool> {
    None
}

/// lsof -Fn output → does any UDP socket lack a remote end? Signalling sockets
/// read `n192.168.1.40:61003->172.217.112.4:443`; session candidates read
/// `n192.168.1.40:54884`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn has_session_socket(lsof_fn: &str) -> bool {
    lsof_fn
        .lines()
        .filter_map(|l| l.strip_prefix('n'))
        .any(|addr| !addr.contains("->"))
}

#[cfg(test)]
mod tests {
    use super::has_session_socket;

    #[test]
    fn idle_signalling_only() {
        let idle = "p20298\nf33\nn192.168.1.40:61003->172.217.112.4:443\n";
        assert!(!has_session_socket(idle));
        let connecting = "p20298\nf30\nn192.168.1.40:50874->172.217.115.4:443\nf33\nn192.168.1.40:61003->172.217.112.4:443\n";
        assert!(!has_session_socket(connecting));
        assert!(!has_session_socket(""));
    }

    #[test]
    fn session_candidates() {
        let live = "p20298\nf30\nn192.168.1.40:50874->172.217.115.4:443\nf31\nn192.168.1.40:54884\nf33\nn192.168.1.40:61003->172.217.112.4:443\nf34\nn192.168.1.40:53223\n";
        assert!(has_session_socket(live));
    }
}
