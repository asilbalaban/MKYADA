// Always-on lightweight debug log for field diagnosis.
//
// The serial link's failure modes (silent drops, OOM stalls, wedges) are
// timing-dependent and invisible from the UI — every report so far needed the
// exact connect-time sequence to diagnose. So the app keeps a plain-text log
// of the link's life: connects, every fs op with duration and outcome, the
// sound-key map and each press decision. One line each, appended to
// ~/Library/Logs/MKYADA/debug.log (or the platform equivalent), rotated by
// size so it can stay on forever.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: Mutex<Option<File>> = Mutex::new(None);
const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn log_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    #[cfg(target_os = "macos")]
    let dir = home.join("Library/Logs/MKYADA");
    #[cfg(not(target_os = "macos"))]
    let dir = home.join(".mkyada/logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("debug.log"))
}

fn open_log() -> Option<File> {
    let path = log_path()?;
    // simple size rotation: keep one previous generation
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// Append one timestamped line; never fails, never blocks meaningfully.
pub fn dbg(msg: &str) {
    let mut guard = LOG.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = open_log();
    }
    if let Some(f) = guard.as_mut() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let secs = ts / 1000;
        let ms = ts % 1000;
        let _ = writeln!(f, "{secs}.{ms:03} {msg}");
    }
}

#[macro_export]
macro_rules! dbg_log {
    ($($arg:tt)*) => {
        $crate::debuglog::dbg(&format!($($arg)*))
    };
}
