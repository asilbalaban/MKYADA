// Sound-effect playback for key actions: read the file through Rust, decode
// it in the webview. Object URLs are cached per path so repeated presses
// don't re-read the file from disk.

import { invoke } from "@tauri-apps/api/core";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aiff: "audio/aiff",
  aif: "audio/aiff",
};

export const SOUND_EXTENSIONS = Object.keys(MIME);

const cache = new Map<string, string>();
const playing = new Set<HTMLAudioElement>();

export async function playSound(path: string): Promise<void> {
  let url = cache.get(path);
  if (!url) {
    const buf = await invoke<ArrayBuffer>("read_local_bytes", { path });
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    url = URL.createObjectURL(new Blob([buf], { type: MIME[ext] ?? "audio/mpeg" }));
    cache.set(path, url);
  }
  // A fresh Audio per press so rapid presses overlap instead of restarting.
  const audio = new Audio(url);
  playing.add(audio);
  audio.addEventListener("ended", () => playing.delete(audio));
  await audio.play();
}

/** Silence every sound effect that is currently playing (hold-to-stop). */
export function stopAllSounds(): void {
  for (const audio of playing) audio.pause();
  playing.clear();
}

/** Ease every playing sound down to silence over `ms`, then stop it. */
export function fadeOutSounds(ms = 800): void {
  for (const audio of [...playing]) {
    playing.delete(audio); // a new press during the fade starts fresh
    const startVolume = audio.volume;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      audio.volume = startVolume * (1 - k);
      if (k < 1 && !audio.paused) requestAnimationFrame(step);
      else audio.pause();
    };
    requestAnimationFrame(step);
  }
}
