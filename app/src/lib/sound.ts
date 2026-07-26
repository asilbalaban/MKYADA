// Sound-effect playback for key actions. Playback happens natively in Rust
// (afplay on macOS, MediaPlayer on Windows, ffplay on Linux) — not in the
// webview. WKWebView's Web Audio / HTMLAudio path decoded some MP3s silently to
// nothing, so a valid file just never played; handing the file to the OS's own
// player is reliable for every common format. Overlap is free (each play is its
// own process) and hold-to-stop kills whatever is still playing.

import { invoke } from "@tauri-apps/api/core";

// Extensions the file picker offers. The native players handle far more, but
// these are the common effect formats we advertise.
export const SOUND_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "aiff", "aif"];

/** Play a sound file. Rejects (with the OS error) if the file can't be played,
 * so the editor's Test button can surface the reason instead of failing mute. */
export async function playSound(path: string): Promise<void> {
  await invoke("sound_play", { path });
}

/** Stop every sound effect currently playing (hold-to-stop / restart). */
export function stopAllSounds(): void {
  void invoke("sound_stop").catch(() => {});
}

/** Ease every playing sound down to silence over `ms`, then stop (hold-to-fade
 * action). Done on the audio thread in Rust. */
export function fadeOutSounds(ms = 800): void {
  void invoke("sound_fade", { ms }).catch(() => {});
}
