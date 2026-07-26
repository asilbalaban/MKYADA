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
    // route playback to a second output device too (None = off)
    Secondary(Option<String>),
}

static TX: OnceLock<Sender<Cmd>> = OnceLock::new();

/// Open a named output device (the Settings "also play into" pick). Called on
/// the audio thread only — OutputStream is !Send.
fn open_output(name: &str) -> Option<(OutputStream, rodio::OutputStreamHandle)> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let devs = match rodio::cpal::default_host().output_devices() {
        Ok(d) => d,
        Err(e) => {
            crate::dbg_log!("audio: can't list outputs: {e}");
            return None;
        }
    };
    for d in devs {
        if d.name().map(|n| n == name).unwrap_or(false) {
            match OutputStream::try_from_device(&d) {
                Ok(pair) => {
                    crate::dbg_log!("audio: secondary output open: {name}");
                    return Some(pair);
                }
                Err(e) => {
                    crate::dbg_log!("audio: can't open {name}: {e}");
                    return None;
                }
            }
        }
    }
    crate::dbg_log!("audio: secondary output not found: {name}");
    None
}

fn append_sound(sinks: &mut Vec<Sink>, handle: &rodio::OutputStreamHandle, bytes: Vec<u8>) {
    let Ok(sink) = Sink::try_new(handle) else { return };
    match Decoder::new(Cursor::new(bytes)) {
        Ok(dec) => {
            sink.append(dec);
            sinks.push(sink);
        }
        Err(e) => crate::dbg_log!("audio: undecodable: {e}"),
    }
}

/// Everything the audio thread plays into: the default output plus an optional
/// second device (a virtual output like BlackHole, so a stream or call hears
/// the soundboard while the speakers do too). Lives on the audio thread.
struct Outs {
    handle: rodio::OutputStreamHandle,
    sinks: Vec<Sink>,
    second: Option<(OutputStream, rodio::OutputStreamHandle)>,
    sinks2: Vec<Sink>,
}

impl Outs {
    fn playing(&self) -> bool {
        !self.sinks.is_empty() || !self.sinks2.is_empty()
    }

    fn reap(&mut self) {
        self.sinks.retain(|s| !s.empty());
        self.sinks2.retain(|s| !s.empty());
    }

    fn play_bytes(&mut self, bytes: Vec<u8>) {
        if let Some((_, h2)) = &self.second {
            append_sound(&mut self.sinks2, h2, bytes.clone());
        }
        append_sound(&mut self.sinks, &self.handle, bytes);
    }

    fn play_path(&mut self, path: &str) {
        match std::fs::read(path) {
            Ok(bytes) => {
                self.play_bytes(bytes);
                crate::dbg_log!("audio: play {path}");
            }
            Err(e) => crate::dbg_log!("audio: can't read {path}: {e}"),
        }
    }

    fn stop(&mut self) {
        for s in self.sinks.iter().chain(self.sinks2.iter()) {
            s.stop();
        }
        self.sinks.clear();
        self.sinks2.clear();
    }

    fn fade(&mut self, ms: u64) {
        // rodio has no live fade; approximate with a short volume ramp on
        // this thread, then stop.
        let steps = 16u32;
        let dt = ms / u64::from(steps);
        for i in 0..steps {
            let v = 1.0 - (i as f32 + 1.0) / steps as f32;
            for s in self.sinks.iter().chain(self.sinks2.iter()) {
                s.set_volume(v.max(0.0));
            }
            thread::sleep(std::time::Duration::from_millis(dt.max(1)));
        }
        self.stop();
    }

    fn hold_action(&mut self, entry: &SoundKey) {
        match entry.hold.as_deref() {
            Some("fade") => self.fade(600),
            Some("restart") => {
                self.stop();
                self.play_path(&entry.path);
            }
            _ => self.stop(),
        }
    }

    fn set_secondary(&mut self, name: Option<&str>) {
        for s in self.sinks2.iter() {
            s.stop();
        }
        self.sinks2.clear();
        self.second = name.and_then(open_output);
    }
}

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
            let mut o = Outs { handle, sinks: Vec::new(), second: None, sinks2: Vec::new() };
            // sound keys currently held down: id -> (press time, deferred?).
            // deferred = something was playing at the press, so the decision
            // (tap = play again, hold = the key's hold action) is made later
            // instead of re-triggering the sound immediately.
            let mut down: HashMap<String, (Instant, bool, SoundKey)> = HashMap::new();
            loop {
                // Wake periodically so a key held past HOLD_MS fires its hold
                // action right then — the user shouldn't wait for the release.
                let cmd = match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    Ok(c) => Some(c),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                o.reap(); // drop finished sounds
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
                        o.hold_action(&entry);
                    }
                }
                let Some(cmd) = cmd else { continue };
                match cmd {
                    Cmd::Play(bytes) => o.play_bytes(bytes),
                    Cmd::Stop => o.stop(),
                    Cmd::Fade(ms) => o.fade(ms),
                    Cmd::Secondary(name) => o.set_secondary(name.as_deref()),
                    Cmd::KeyDown(id, entry) => {
                        let playing = o.playing();
                        if !playing {
                            o.play_path(&entry.path);
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
                            o.play_path(&entry.path);
                        } else {
                            // Release raced the 100ms sweep past the threshold.
                            crate::dbg_log!(
                                "audio: {id} hold({ms}ms) on release: {}",
                                entry.hold.as_deref().unwrap_or("stop")
                            );
                            o.hold_action(&entry);
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

/// Names of every audio output device, for the Settings "also play into" pick.
pub fn outputs() -> Vec<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let mut v = Vec::new();
    if let Ok(devs) = rodio::cpal::default_host().output_devices() {
        for d in devs {
            if let Ok(n) = d.name() {
                v.push(n);
            }
        }
    }
    v
}

/// Also play every sound into this named output device (a virtual device like
/// BlackHole, so a stream/call hears the soundboard while the speakers do
/// too); None switches the second route off.
pub fn set_secondary(name: Option<String>) {
    crate::dbg_log!("audio: secondary output = {}", name.as_deref().unwrap_or("off"));
    if let Some(tx) = tx() {
        let _ = tx.send(Cmd::Secondary(name));
    }
}
