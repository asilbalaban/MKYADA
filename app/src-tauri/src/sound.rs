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
    /// what a long hold does: "fade" | "restart" | "stop" (default).
    pub hold: Option<String>,
}

/// How long the key must be held (down→up) before the hold action, not a plain
/// tap-and-play, applies. Deliberately generous: users layer sounds with quick
/// taps and stray "slow taps" kept muting everything at 600ms.
const HOLD_MS: u128 = 1500;

static KEYS: Mutex<Option<HashMap<String, SoundKey>>> = Mutex::new(None);

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

/// Inspect a parsed device message and forward sound-key edges to the audio
/// thread, which owns the playback decision (it alone knows synchronously
/// whether anything is still playing):
///   * nothing playing + DOWN  → play IMMEDIATELY (instant feel);
///   * something playing + DOWN → defer to the release: a quick tap layers
///     the sound again, a long hold applies the key's hold action
///     (fade/restart/stop) — WITHOUT re-triggering the sound first.
///
/// This composes the two field reports: "basınca anında çalsın" (play on
/// press) and "durdurmak için basılı tutunca önce tekrar çalmasın" (no replay
/// on a hold meant to stop). Timer-free — every decision comes from real
/// edges, so a lagging up edge can never cut a tap off mid-play.
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

    let Some(tx) = tx() else { return };
    match edge {
        "down" => {
            let _ = tx.send(Cmd::KeyDown(id, entry));
        }
        "up" => {
            let _ = tx.send(Cmd::KeyUp(id));
        }
        _ => {}
    }
}

enum Cmd {
    Play(Vec<u8>),
    Stop,
    // fade every playing sound to silence over `ms`, then drop it
    Fade(u64),
    // sound-key edges: the audio thread decides play vs hold-action because
    // it alone knows synchronously whether sinks are still playing
    KeyDown(String, SoundKey),
    KeyUp(String),
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
            // sound keys currently held down: id -> (press time, deferred?).
            // deferred = something was playing at the press, so the decision
            // (tap = play again, hold = the key's hold action) waits for
            // the release instead of re-triggering the sound immediately.
            let mut down: HashMap<String, (Instant, bool, SoundKey)> = HashMap::new();
            let play_bytes = |sinks: &mut Vec<Sink>, handle: &rodio::OutputStreamHandle, path: &str| {
                match std::fs::read(path) {
                    Ok(bytes) => {
                        if let Ok(sink) = Sink::try_new(handle) {
                            match Decoder::new(Cursor::new(bytes)) {
                                Ok(dec) => {
                                    sink.append(dec);
                                    sinks.push(sink);
                                    crate::dbg_log!("audio: play {path}");
                                }
                                Err(e) => crate::dbg_log!("audio: undecodable {path}: {e}"),
                            }
                        }
                    }
                    Err(e) => crate::dbg_log!("audio: can't read {path}: {e}"),
                }
            };
            let stop_sinks = |sinks: &mut Vec<Sink>| {
                for s in sinks.iter() {
                    s.stop();
                }
                sinks.clear();
            };
            let fade_sinks = |sinks: &mut Vec<Sink>, ms: u64| {
                // rodio has no live fade; approximate with a short volume
                // ramp on this thread, then stop.
                let steps = 16u32;
                let dt = ms / u64::from(steps);
                for i in 0..steps {
                    let v = 1.0 - (i as f32 + 1.0) / steps as f32;
                    for s in sinks.iter() {
                        s.set_volume(v.max(0.0));
                    }
                    thread::sleep(std::time::Duration::from_millis(dt.max(1)));
                }
                stop_sinks(sinks);
            };
            let hold_action =
                |sinks: &mut Vec<Sink>, handle: &rodio::OutputStreamHandle, entry: &SoundKey| {
                    match entry.hold.as_deref() {
                        Some("fade") => fade_sinks(sinks, 600),
                        Some("restart") => {
                            stop_sinks(sinks);
                            play_bytes(sinks, handle, &entry.path);
                        }
                        _ => stop_sinks(sinks),
                    }
                };
            loop {
                // Wake periodically so a key held past HOLD_MS fires its hold
                // action right then — the user shouldn't wait for the release.
                let cmd = match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(c) => Some(c),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                sinks.retain(|s| !s.empty()); // reap finished sounds
                let held: Vec<String> = down
                    .iter()
                    .filter(|(_, (at, deferred, _))| *deferred && at.elapsed().as_millis() >= HOLD_MS)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in held {
                    if let Some((at, _, entry)) = down.remove(&id) {
                        crate::dbg_log!(
                            "audio: {id} hold({}ms) fires: {}",
                            at.elapsed().as_millis(),
                            entry.hold.as_deref().unwrap_or("stop")
                        );
                        hold_action(&mut sinks, &handle, &entry);
                    }
                }
                let Some(cmd) = cmd else { continue };
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
                    Cmd::Stop => stop_sinks(&mut sinks),
                    Cmd::Fade(ms) => fade_sinks(&mut sinks, ms),
                    Cmd::KeyDown(id, entry) => {
                        let playing = !sinks.is_empty();
                        if !playing {
                            play_bytes(&mut sinks, &handle, &entry.path);
                        } else {
                            crate::dbg_log!("audio: {id} down while playing — deferred");
                        }
                        down.insert(id, (Instant::now(), playing, entry));
                    }
                    Cmd::KeyUp(id) => {
                        // A hold that already fired removed the entry above.
                        let Some((at, deferred, entry)) = down.remove(&id) else {
                            continue;
                        };
                        if !deferred {
                            continue; // already played on the down edge
                        }
                        let ms = at.elapsed().as_millis();
                        if ms < HOLD_MS {
                            crate::dbg_log!("audio: {id} tap({ms}ms) while playing — layer");
                            play_bytes(&mut sinks, &handle, &entry.path);
                        } else {
                            // Release raced the 100ms sweep past the threshold.
                            crate::dbg_log!(
                                "audio: {id} hold({ms}ms) on release: {}",
                                entry.hold.as_deref().unwrap_or("stop")
                            );
                            hold_action(&mut sinks, &handle, &entry);
                        }
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
