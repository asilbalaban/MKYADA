// Designer-drawn icons for every assignable action and its sub-options.
// Black-on-white monoline PNGs (GPT Image 2, "action-first" family) live in
// assets/action-icons and are shown inside a small white chip so they read on
// both light and dark themes without recoloring.

import type { Assignment, MenuAction, MicMode } from "../lib/types";

// Vite turns each PNG into a served URL. Keyed by file basename ("single-key").
const RAW = import.meta.glob("../assets/action-icons/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const ICON_URL: Record<string, string> = {};
for (const [path, url] of Object.entries(RAW)) {
  const name = path.split("/").pop()!.replace(/\.png$/, "");
  ICON_URL[name] = url;
}

/** One action icon inside a white rounded chip. `name` is the SVG basename. */
export function ActionIcon({
  name,
  size = 48,
  className = "",
}: {
  name?: string;
  size?: number;
  className?: string;
}) {
  const url = name ? ICON_URL[name] : undefined;
  if (!url) {
    // keep layout stable when an option has no icon (e.g. the built-in default)
    return <span className={`inline-block shrink-0 ${className}`} style={{ width: size, height: size }} aria-hidden />;
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded bg-white ring-1 ring-black/10 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img src={url} alt="" width={size} height={size} className="block h-full w-full" />
    </span>
  );
}

// ── Slug maps: action/sub-option value → SVG basename ──────────────────────

export const KIND_ICON: Record<Assignment["kind"], string> = {
  none: "not-assigned",
  nothing: "do-nothing",
  keystroke: "single-key",
  combo: "key-combination",
  text: "type-text",
  media: "media-key",
  scroll: "mouse-scroll",
  menu: "device-menu",
  recorded: "recorded-macro",
  launch: "open-app",
  command: "run-command",
  sound: "play-sound",
  mic: "microphone",
  webhook: "webhook",
  sequence: "multi-action",
};

export const MEDIA_ICON: Record<string, string> = {
  play_pause: "media-play-pause",
  next_track: "media-next",
  prev_track: "media-prev",
  stop: "media-stop",
  mute: "media-mute",
  volume_up: "media-vol-up",
  volume_down: "media-vol-down",
  brightness_up: "media-brightness-up",
  brightness_down: "media-brightness-down",
};

export const MENU_ICON: Partial<Record<MenuAction, string>> = {
  left: "menu-left",
  right: "menu-right",
  confirm: "menu-confirm",
  back: "menu-back",
  home: "menu-layer-screen",
  settings: "menu-settings",
  grid: "menu-grid",
  layer_next: "menu-layer-next",
  layer_prev: "menu-layer-prev",
  // "default" / "none" render without an icon
};

export const MIC_ICON: Record<MicMode, string> = {
  toggle: "mic-toggle",
  mute: "mic-mute",
  unmute: "mic-unmute",
  push_to_talk: "mic-ptt",
};

export const SOUND_HOLD_ICON: Record<string, string> = {
  stop: "sound-stop",
  fade: "sound-fade",
  restart: "sound-restart",
};

export const HTTP_METHOD_ICON: Record<string, string> = {
  GET: "webhook-get",
  POST: "webhook-post",
  PUT: "webhook-put",
  PATCH: "webhook-patch",
  DELETE: "webhook-delete",
  HEAD: "webhook-head",
};
