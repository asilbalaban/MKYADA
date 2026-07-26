// In-process sound-effect playback for "Play sound" key actions.
//
// Every earlier approach failed for a different reason:
//   * webview HTMLAudio / Web Audio — WKWebView's decoder silently refused some
//     MP3s, so a valid file just never played.
//   * spawning `afplay` — a separate process can't read ~/Desktop / ~/Documents
//     / ~/Downloads under macOS privacy (TCC), even though this app can, so the
//     player started but had nothing to play.
//
// So we do everything inside this process, which holds the file-access grant:
// read the bytes, decode and play them via rodio (CoreAudio / WASAPI). No child
// process, no webview — the sound is heard whenever the app is running.
//
// rodio's OutputStream is !Send, so it lives on one dedicated audio thread; the
// rest of the app talks to it over a channel (Send-safe commands only).

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Instant;

use rodio::{Decoder, OutputStream, Sink};

// --- native trigger --------------------------------------------------------
//
// Sound key presses must fire even when the app is in the background, where the
// webview's JavaScript is suspended by the OS. So the app pushes a map of which
// keys are "play sound" keys (their file + hold behaviour) and the serial
// reader — a native thread that never sleeps — handles them directly. The
// webview still receives the event for its live view; playback just no longer
// depends on it being awake.

#[derive(Clone)]
pub struct SoundKey {
    pub path: String,
    /// what a ~half-second hold does: "fade" | "restart" | "stop" (default).
    pub hold: Option<String>,
}

/// How long the key must be held (down→up) before the hold action, not a plain
/// tap-and-play, applies. Matches the JS foreground path (SOUND_HOLD_STOP_MS).
const HOLD_MS: u128 = 400;

static KEYS: Mutex<Option<HashMap<String, SoundKey>>> = Mutex::new(None);
// When each sound key went down, so the up edge can measure the real hold time.
static DOWN: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Replace the whole set of sound keys (called by the app on connect and
/// whenever assignments / the active profile change). Key = "layer:keyNo",
/// e.g. "a:5".
pub fn set_keys(map: HashMap<String, SoundKey>) {
    let mut ids: Vec<&str> = map.keys().map(String::as_str).collect();
    ids.sort_unstable();
    crate::dbg_log!("sound map: {} keys [{}]", map.len(), ids.join(","));
    *lock(&KEYS) = Some(map);
}

/// Inspect a parsed device message and drive sound-key playback:
///   * DOWN — play immediately (instant feel) and remember the press time.
///   * UP   — if the key was held past `HOLD_MS`, apply its hold action
///            (fade / restart / stop) to whatever is playing.
///
/// The hold decision is made on the real up edge, from the down→up elapsed
/// time — NOT an independent timer. An earlier timer-based version fired the
/// fade on its own schedule and, when the up edge lagged in the background, cut
/// a plain tap off mid-play; measuring the actual gap can't misfire that way.
pub fn on_device_msg(v: &serde_json::Value) {
    if v.get("t").and_then(serde_json::Value::as_str) != Some("btn") {
        return;
    }
    let edge = v.get("edge").and_then(serde_json::Value::as_str).unwrap_or("");
    let Some(key) = v.get("key").and_then(serde_json::Value::as_i64) else {
        return;
    };
    let layer = v.get("layer").and_then(serde_json::Value::as_str).unwrap_or("a");
    let id = format!("{layer}:{key}");

    let entry = lock(&KEYS).as_ref().and_then(|m| m.get(&id).cloned());
    let Some(entry) = entry else {
        if edge == "down" {
            let n = lock(&KEYS).as_ref().map_or(0, HashMap::len);
            crate::dbg_log!("btn {id} down: not a sound key (map has {n})");
        }
        return;
    };

    match edge {
        "down" => {
            let r = play(&entry.path);
            crate::dbg_log!("btn {id} down: play {} -> {:?}", entry.path, r.as_ref().err());
            lock(&DOWN)
                .get_or_insert_with(HashMap::new)
                .insert(id, Instant::now());
        }
        "up" => {
            let held = lock(&DOWN)
                .as_mut()
                .and_then(|m| m.remove(&id))
                .map(|t| t.elapsed().as_millis());
            if let Some(ms) = held {
                if ms >= HOLD_MS {
                    match entry.hold.as_deref() {
                        Some("fade") => fade(600),
                        Some("restart") => {
                            stop_all();
                            let _ = play(&entry.path);
                        }
                        _ => stop_all(), // "stop" or unset
                    }
                }
            }
        }
        _ => {}
    }
}

enum Cmd {
    Play(Vec<u8>),
    Stop,
    // fade every playing sound to silence over `ms`, then drop it
    Fade(u64),
}

static TX: OnceLock<Sender<Cmd>> = OnceLock::new();

/// The audio thread's command channel, started on first use. Returns None only
/// if the default output device can't be opened (headless / no audio).
fn tx() -> Option<&'static Sender<Cmd>> {
    // OnceLock can't store "init failed", so we init eagerly and cache the
    // Sender; a dead audio thread just means commands go nowhere (harmless).
    Some(TX.get_or_init(|| {
        let (tx, rx) = channel::<Cmd>();
        thread::spawn(move || {
            let (_stream, handle) = match OutputStream::try_default() {
                Ok(pair) => pair,
                Err(_) => return, // no audio device — drain nothing, exit
            };
            let mut sinks: Vec<Sink> = Vec::new();
            for cmd in rx {
                sinks.retain(|s| !s.empty()); // reap finished sounds
                match cmd {
                    Cmd::Play(bytes) => {
                        if let Ok(sink) = Sink::try_new(&handle) {
                            match Decoder::new(Cursor::new(bytes)) {
                                Ok(dec) => {
                                    sink.append(dec);
                                    sinks.push(sink);
                                }
                                Err(_) => {} // undecodable file — skip
                            }
                        }
                    }
                    Cmd::Stop => {
                        for s in &sinks {
                            s.stop();
                        }
                        sinks.clear();
                    }
                    Cmd::Fade(ms) => {
                        // rodio has no live fade; approximate with a short
                        // volume ramp on this thread, then stop.
                        let steps = 16u32;
                        let dt = ms / steps as u64;
                        for i in 0..steps {
                            let v = 1.0 - (i as f32 + 1.0) / steps as f32;
                            for s in &sinks {
                                s.set_volume(v.max(0.0));
                            }
                            thread::sleep(std::time::Duration::from_millis(dt.max(1)));
                        }
                        for s in &sinks {
                            s.stop();
                        }
                        sinks.clear();
                    }
                }
            }
        });
        tx
    }))
}

/// Play a sound file. The app process reads it (it holds the folder grant) and
/// hands the bytes to the audio thread to decode + play. Returns an error the UI
/// can show — a read failure here is exactly what the editor's Test button
/// should report instead of failing silently.
pub fn play(path: &str) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("can't read the sound file: {e}"))?;
    match tx() {
        Some(tx) => tx
            .send(Cmd::Play(bytes))
            .map_err(|_| "the audio player stopped".to_string()),
        None => Err("no audio output device".to_string()),
    }
}

/// Stop every sound still playing (hold-to-stop / restart key actions).
pub fn stop_all() {
    if let Some(tx) = tx() {
        let _ = tx.send(Cmd::Stop);
    }
}

/// Fade every playing sound to silence over `ms`, then stop it.
pub fn fade(ms: u64) {
    if let Some(tx) = tx() {
        let _ = tx.send(Cmd::Fade(ms));
    }
}
