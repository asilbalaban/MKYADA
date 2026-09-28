//! Foreground-application watcher for per-app profiles.
//!
//! Polls the active window every 500 ms and emits `foreground:changed`
//! with the executable name and window title whenever either changes, plus
//! `self: true` when the window belongs to MKYADA itself — the profile engine
//! then keeps the last profile instead of clearing it (someone using the
//! Control page means to drive the app they came from).

use active_win_pos_rs::get_active_window;
use serde_json::json;
use std::sync::Once;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static WATCHER: Once = Once::new();
const POLL: Duration = Duration::from_millis(500);

pub fn ensure_watcher(app: AppHandle) {
    WATCHER.call_once(move || {
        std::thread::spawn(move || {
            let mut last = String::new();
            loop {
                let (exe, title, own) = match get_active_window() {
                    Ok(w) => {
                        let exe = w
                            .process_path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        (exe, w.title, is_own_process(w.process_id, std::process::id()))
                    }
                    Err(_) => (String::new(), String::new(), false),
                };
                let key = format!("{exe}\u{0}{title}\u{0}{own}");
                if key != last {
                    last = key;
                    let _ = app.emit(
                        "foreground:changed",
                        json!({"exe": exe, "title": title, "self": own}),
                    );
                }
                std::thread::sleep(POLL);
            }
        });
    });
}

/// Whether the foreground window's process is this app (the main window or
/// the overlay — both live in our process). pid 0 means "unknown".
fn is_own_process(window_pid: u64, own_pid: u32) -> bool {
    window_pid != 0 && window_pid == u64::from(own_pid)
}

#[cfg(test)]
mod tests {
    use super::is_own_process;

    #[test]
    fn own_process_is_recognised() {
        assert!(is_own_process(4242, 4242));
    }

    #[test]
    fn other_or_unknown_process_is_not_self() {
        assert!(!is_own_process(4243, 4242));
        assert!(!is_own_process(0, 0));
    }
}
