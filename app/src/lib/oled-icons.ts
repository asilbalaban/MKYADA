// The MKYADA icon family. GENERATED — do not edit.
//
// Source:    icons/src/icons.txt
// Generator: node scripts/build-icons.mjs
//
// 270 icons, 21 categories, 2160 bytes of pixels.
// Layout: 8 bytes per icon, one per row, bit 7 = leftmost pixel —
// byte for byte what firmware/mkyada/icons.py ships to the board.
//
// A macro picks an icon by NAME, never by index: names are permanent, so
// extending or reordering the set cannot repoint an existing macro at a
// different picture. An unknown name returns null and the caller falls
// back to the action family's default.

/** Category label -> the icon names in it, in source order. */
export const ICON_CATEGORIES: readonly (readonly [string, readonly string[]])[] = [
  ["navigasyon", ["arrow-up", "arrow-down", "arrow-left", "arrow-right", "chevron-up", "chevron-down", "chevron-left", "chevron-right", "home", "back", "refresh", "external", "expand", "collapse"]],
  ["medya", ["play", "pause", "stop", "record", "next", "prev", "forward", "rewind", "shuffle", "repeat", "repeat-one", "eject", "volume", "mute", "volume-up", "volume-down"]],
  ["ses", ["mic", "mic-off", "headphones", "speaker", "wave", "note", "music", "equalizer", "metronome", "podcast"]],
  ["video ve yayın", ["camera", "webcam", "film", "clapper", "live", "broadcast", "scene", "monitor", "screen-share", "tv", "stream"]],
  ["düzenleme", ["copy", "paste", "cut", "undo", "redo", "save", "trash", "duplicate", "select-all", "replace", "new", "open", "rename", "edit"]],
  ["metin", ["bold", "italic", "underline", "strikethrough", "align-left", "align-center", "align-right", "list", "indent", "quote", "link", "code", "text"]],
  ["dosya", ["file", "folder", "folder-open", "archive", "download", "upload", "cloud", "cloud-up", "cloud-down", "print", "disk"]],
  ["sistem", ["power", "restart", "sleep", "settings", "wrench", "tools", "cpu", "memory", "usb", "battery", "plug", "bug", "terminal", "database", "server"]],
  ["ağ", ["globe", "wifi", "signal", "share", "send", "mail", "chat", "bell", "at", "user", "users"]],
  ["durum", ["check", "cross", "warning", "info", "question", "plus", "minus", "star", "heart", "flag", "lock", "unlock", "eye", "eye-off", "shield", "tag"]],
  ["zaman", ["clock", "timer", "alarm", "calendar", "hourglass", "history"]],
  ["pencere ve düzen", ["window", "windows", "tabs", "split", "layout", "grid", "layers", "pin", "minimize", "maximize", "close", "fullscreen"]],
  ["grafik ve tasarım", ["brush", "pen", "pencil", "eraser", "palette", "crop", "zoom-in", "zoom-out", "move", "rotate", "ruler", "shapes"]],
  ["oyun ve akış", ["gamepad", "dice", "target", "trophy", "rocket", "lightning", "fire", "sparkle"]],
  ["çeşitli", ["search", "filter", "sort", "bookmark", "key", "gift", "coffee", "bulb", "magnet", "map-pin", "calculator", "chart", "percent", "hash", "keyboard", "mouse", "scroll-v", "scroll-h", "sequence", "webhook", "macro"]],
  ["profil ve ekran", ["brightness-low", "brightness-high", "contrast", "screen-lock", "profile-switch", "cube", "bezier", "workspace"]],
  ["3d ve cad", ["sketch", "extrude", "revolve", "fillet", "chamfer", "split-body", "view-top", "view-front", "view-side", "view-iso", "hide-body", "show-body", "measure-dist", "measure-angle", "constraint", "origin"]],
  ["vektorel cizim", ["pen-tool", "select-arrow", "select-direct", "node-add", "node-remove", "path-union", "path-subtract", "path-intersect", "path-exclude", "align-l", "align-c", "align-r", "align-t", "align-b", "distribute-h", "distribute-v", "layer-lock", "mask", "artboard"]],
  ["pencere ve sistem", ["clipboard", "clipboard-history", "snap-left", "snap-right", "snap-max", "task-manager", "app-switch", "always-on-top", "screen-record"]],
  ["3d baski", ["printer-3d", "preheat", "auto-home", "bed-level", "filament", "nozzle", "fan", "print-pause"]],
  ["eglence ve retro", ["ghost", "pacman", "invader", "invader2", "alien", "skull", "robot", "mushroom", "sword", "coin", "bomb", "ufo", "cat", "smiley", "joystick", "arcade", "tetromino", "crown", "potion", "chest"]],
];

/** Every icon name, in source order. */
export const ICON_NAMES: readonly string[] = [
  "arrow-up", "arrow-down", "arrow-left", "arrow-right", "chevron-up", "chevron-down",
  "chevron-left", "chevron-right", "home", "back", "refresh", "external", "expand", "collapse",
  "play", "pause", "stop", "record", "next", "prev", "forward", "rewind", "shuffle", "repeat",
  "repeat-one", "eject", "volume", "mute", "volume-up", "volume-down", "mic", "mic-off",
  "headphones", "speaker", "wave", "note", "music", "equalizer", "metronome", "podcast",
  "camera", "webcam", "film", "clapper", "live", "broadcast", "scene", "monitor",
  "screen-share", "tv", "stream", "copy", "paste", "cut", "undo", "redo", "save", "trash",
  "duplicate", "select-all", "replace", "new", "open", "rename", "edit", "bold", "italic",
  "underline", "strikethrough", "align-left", "align-center", "align-right", "list", "indent",
  "quote", "link", "code", "text", "file", "folder", "folder-open", "archive", "download",
  "upload", "cloud", "cloud-up", "cloud-down", "print", "disk", "power", "restart", "sleep",
  "settings", "wrench", "tools", "cpu", "memory", "usb", "battery", "plug", "bug", "terminal",
  "database", "server", "globe", "wifi", "signal", "share", "send", "mail", "chat", "bell",
  "at", "user", "users", "check", "cross", "warning", "info", "question", "plus", "minus",
  "star", "heart", "flag", "lock", "unlock", "eye", "eye-off", "shield", "tag", "clock",
  "timer", "alarm", "calendar", "hourglass", "history", "window", "windows", "tabs", "split",
  "layout", "grid", "layers", "pin", "minimize", "maximize", "close", "fullscreen", "brush",
  "pen", "pencil", "eraser", "palette", "crop", "zoom-in", "zoom-out", "move", "rotate",
  "ruler", "shapes", "gamepad", "dice", "target", "trophy", "rocket", "lightning", "fire",
  "sparkle", "search", "filter", "sort", "bookmark", "key", "gift", "coffee", "bulb", "magnet",
  "map-pin", "calculator", "chart", "percent", "hash", "keyboard", "mouse", "scroll-v",
  "scroll-h", "sequence", "webhook", "macro", "brightness-low", "brightness-high", "contrast",
  "screen-lock", "profile-switch", "cube", "bezier", "workspace", "sketch", "extrude",
  "revolve", "fillet", "chamfer", "split-body", "view-top", "view-front", "view-side",
  "view-iso", "hide-body", "show-body", "measure-dist", "measure-angle", "constraint", "origin",
  "pen-tool", "select-arrow", "select-direct", "node-add", "node-remove", "path-union",
  "path-subtract", "path-intersect", "path-exclude", "align-l", "align-c", "align-r", "align-t",
  "align-b", "distribute-h", "distribute-v", "layer-lock", "mask", "artboard", "clipboard",
  "clipboard-history", "snap-left", "snap-right", "snap-max", "task-manager", "app-switch",
  "always-on-top", "screen-record", "printer-3d", "preheat", "auto-home", "bed-level",
  "filament", "nozzle", "fan", "print-pause", "ghost", "pacman", "invader", "invader2", "alien",
  "skull", "robot", "mushroom", "sword", "coin", "bomb", "ufo", "cat", "smiley", "joystick",
  "arcade", "tetromino", "crown", "potion", "chest",
];

// One hex string rather than an array of arrays: it keeps this generated
// file diffable per icon and costs one decode at module load.
const PIX_HEX =
  "183c7eff18181800181818ff7e3c1800103070ff70301000080c0eff0e0c080000183c66" +
  "c30000000000c3663c1800000c18306030180c0030180c060c183000183c66c3dbdbdb00" +
  "002060fe632303003e63c0c0c3663c087f434549d1b08ff0e7818100008181e7007e4242" +
  "42427e00c0f0fcfffcf0c0006666666666666600007e7e7e7e7e7e003c7effffffff7e3c" +
  "c3e3f3fbf3e3c300c3c7cfdfcfc7c30088cceeffeecc8800113377ff7733110083452911" +
  "294583007ec3c0c3fd0f0d007ec3c8d8fc0f0d00183c7eff00ffff0008183af2f23a1808" +
  "081a3af2f438180808183af5f53a1808001838f0f0381800383838baba827c10393a38b2" +
  "a5857d123c7ec3c3dbdbdb007e425a425a5a427e002476f7f77624000f09080808387830" +
  "3f212121e7f7630000a5b5b5b6b6a60018183c246642ff003c425a423c183c0000f88a8c" +
  "8c8af8003c4299bd99423c18ffa5ff81ffa5ff0055aaff818181ff0000327a79797a3200" +
  "02020a0a2a2aaaaaf8888f89f9090f00ff818181ff183c00ff99bd9981ff183c2418ff81" +
  "8181ff00ff81b1bdb181ff187c445e5272121e003c5ac3dbc3dbc37ec34224183c66663c" +
  "2060fe6323030e0004067fc6c4c07000ffc3c3c381bdbdff3cff007e5a5a7e007c44445f" +
  "5171111fdb008181818100db78849e9272121e007c4642424a5e4a7e00e09f8181427e00" +
  "7c46424e5c48407c070f1d3870c000ff78444478444478003e0c0c181830f80066666666" +
  "663c00ff3c66603806663c78ff00f800ff00f800ff007e00ff007e00ff001f00ff001f00" +
  "9f009f009f009f00c767e7c700ff00ff66666622440000003e63c10083c67c002263c180" +
  "80c16322ffe7181818183c007c46424242427e00e09f81818181ff00e09f81ff42241800" +
  "ff81ff998181ff0018181899fe7c381010387cfe99181818003c42c181817f00183c5ad9" +
  "81817f00003c42c199bd6d183c24ff8181ff3c3cff81bda5bd8185ff18185adbc3c37e00" +
  "3e63c2c0c3663c087c0c183764fa020724bd7e66667ebd24070f1d70e0c08000c76f3a18" +
  "2c46c3005affbdc3c3bdff5affaaaaaaaaff4242183c18185a5a7a0e00fd85bdbd85fd00" +
  "2424ff81817e1818bd7e7effff7ebd81ff81a191a181bdff7ec37ec37ec37e00ffa3ff00" +
  "ffa3ff003c5a99ff995a3c00003c42992418000003030f0f3f3fffff07053d42819e90f0" +
  "80e0f8fef8e08000ffc3a5998181ff007e8181817e306000183c424242ff00183c429da5" +
  "a59c403e3c42423c7e81810066999966fd858500010386ccec7c3810c3e77e3c3c7ee7c3" +
  "1824245a5a9981ff1818003818183c003c4283060c0c000c181818ffff181800000000ff" +
  "ff0000001818fe7c386cc60066ffffff7e3c1800c0dededec0c0c0003c4242ffdbc3ff00" +
  "3c4240ffdbc3ff00003c429999423c00033d439ab2443cc07ec3c3c3663c18007fc1a191" +
  "898583ff3c4289898e81423c247ec3cbcbc37e00c37e99999d817ec342ff81a981a9ff00" +
  "ff422418182442ff3e63d3ddc3663c08ffff81818181ff00efef81bfa1e1213fe7998181" +
  "8181ff00ff9999999999ff00ff81ff999999ff00cccc00cccc00cccc183c7eff007e3c18" +
  "18183c7e7e3c18180000000000ffff00ffffc3c3c3c3ffff7ec3a59999a5c37ee7819918" +
  "189981e7070f1d3878783800070f1d3870e0c08003070e1c3870e0c0070d1b366c687800" +
  "3c5ac399a5c37c1c3030ff3033330f037c92ba927c0c06037c82ba827c0c0603183c66db" +
  "db663c183c66c3c2c0663c40ffa981a981a9ff003c42818181817e007ea5e781a5e7817e" +
  "ff81b1818d81ff003c4299bd99423c00ffbdbd7e3c183c7e183c5a5a7e5ac3810e1c387c" +
  "0c183060081c3a766e4e6c3810387cfe7c3810007c8282827c0c0603ff7e3c1818181800" +
  "2672f826222622007e424242425a66003c429999423c0c0f247eff819999ff0000fc8586" +
  "868578ff3c4281995a3c183cc3c3c3c3c37e00003c429999423c1808ff81ffa981a9ff00" +
  "00030f3fff00ff00c1c20408102043832424ff24ff242400ff81ab81b581ff003c5a9981" +
  "8181423c183c660000663c18002466c3c3662400dfc000dfc000dfc0fc8485878584fc00" +
  "bdc3bd81bdc3bd0000003c7e7e3c000018813c66663c81183c7af9f9f9f97a3cff99a5bd" +
  "9981ff3c3f21e19f8181ff003f43c2868484fc00c0c0301c06030300ffa1a1a1a1a1ff00" +
  "ff83868d99b1ff00183c7e18ff8181ff10362321212336103f4181818181ff001f3161c1" +
  "8181ff00e7a5a5a5a5a5e700ffffff818181ff00ff81bdbdbd81ff00ff8787878787ff00" +
  "1824428181422418e7810081810081e77effffffffff7e008181a5ffa581810080809884" +
  "8281ff003c427e7e00ff0000808080808698b0ff387c6c7c38101000c0e0f0f8fce0b00c" +
  "c0a09088849ca0203c243c00187e18003c243c00007e0000fc84878181e1213ffc84849e" +
  "90f00000fc84bdbdbd3d013ffc84a5a5a525213f80be80b880be8000107c1038107c1000" +
  "017d011d017d0100ffdadad8d8c0c000c0c0d8d8dadaff009999999999999900ff0000ff" +
  "0000ff003c427e00183c7efff5f2f5f2f5f2f50042bd3c3c3c3cbd423c5ac3c3c3c3c37e" +
  "3c5ac3dbd3dec37efff1f1f1f1f1f1ffff8f8f8f8f8f8fffff81bdbdbdbd81ffff818595" +
  "a5a5ff00f88888fb09090f0018183cff818181ffff8199bd9981ff18ff81bd81c3423c18" +
  "1818242424667e3c82c6aa10aac6820000030f3fff003c663c4299bd99423c0f7e427e3c" +
  "3c1818083c64c4999123263cff81b5b5b581ff003c7edbffffffffb63c7ef8f0f0f87e3c" +
  "24183c66ffbd8142183c7edbff245aa53c7edbff7e2442817effdbdbff7e5a5a187ebddb" +
  "ff7e42663c7edbff7e3c243c03060c1830f830503c7edbdbdbdb7e3c060c3c7effff7e3c" +
  "3c42ffaa7e24428181c3ffa5ff997e3c3c7edbffbdc37e3c183c18187effff7eff81bdbd" +
  "81dbff81c0c0c0c0f0f0000099dbffffff7e7e00423c24247effff7e7ec3ffdbffc3ff00";

const PIX = new Uint8Array(PIX_HEX.length / 2);
for (let i = 0; i < PIX.length; i++) {
  PIX[i] = parseInt(PIX_HEX.slice(i * 2, i * 2 + 2), 16);
}

const IDX = new Map<string, number>(ICON_NAMES.map((n, i) => [n, i]));

/** A hand-drawn icon: the eight rows carried inline instead of named.
 *  Same syntax the firmware decodes in icons.py get(). */
export const CUSTOM_ICON_PREFIX = "px:";

/** Pack eight row bytes into the `px:` name a macro can store. */
export function packCustomIcon(rows: ArrayLike<number>): string {
  let h = "";
  for (let i = 0; i < 8; i++) {
    h += ((rows[i] ?? 0) & 0xff).toString(16).padStart(2, "0");
  }
  return CUSTOM_ICON_PREFIX + h;
}

/** The 8 packed rows for `name`, or null if the set does not have it.
 *  A `px:` name is decoded rather than looked up — see icons.py get(). */
export function iconBytes(name: string | null | undefined): Uint8Array | null {
  if (!name) return null;
  if (name.startsWith(CUSTOM_ICON_PREFIX)) {
    const h = name.slice(CUSTOM_ICON_PREFIX.length);
    if (!/^[0-9a-fA-F]{16}$/.test(h)) return null;
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return b;
  }
  const i = IDX.get(name);
  if (i === undefined) return null;
  return PIX.subarray(i * 8, i * 8 + 8);
}
