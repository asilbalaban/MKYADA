//! Foreground-application watcher for per-app profiles.
//!
//! Polls the active window every 500 ms and emits `foreground:changed`
//! with the executable name and window title whenever either changes.

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
                let (exe, title) = match get_active_window() {
                    Ok(w) => {
                        let exe = w
                            .process_path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        (exe, w.title)
                    }
                    Err(_) => (String::new(), String::new()),
                };
                let key = format!("{exe}\u{0}{title}");
                if key != last {
                    last = key;
                    let _ = app.emit("foreground:changed", json!({"exe": exe, "title": title}));
                }
                std::thread::sleep(POLL);
            }
        });
    });
}
