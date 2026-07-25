# Key actions

Every key — and on the Vision 6, every encoder/button slot — can carry one of
these actions. Assign them in the app under **Keys** (or per-app under
**Profiles**). Each key also has **tap / double-press / long-press** variants
and timing options (see [Key logic](#key-logic) below).

Two families:

- **Hardware (HID)** actions are played by the keypad itself as genuine USB
  keyboard/mouse input — they work **standalone**, with no app running, and are
  indistinguishable from your own typing (games and secure apps included).
- **Host** actions are performed by the desktop app while it's connected. The
  key still travels to the device as a carrier, but the effect (open an app,
  hit an HTTP API, switch an OBS scene) happens on your computer.

## Hardware (HID) actions — work standalone

| Action | What it does |
|---|---|
| **Keystroke** | A single key (with typematic repeat while held, like a real keyboard). |
| **Shortcut (combo)** | A chord such as `Ctrl+Shift+S` or `Cmd+Space`. |
| **Text snippet** | Types a block of text — signatures, boilerplate, prompts. |
| **Media key** | Consumer-control usages: Play/Pause, Mute, Volume, Brightness, etc. |
| **Mouse scroll** | Wheel up/down or horizontal pan, optionally with modifiers held (e.g. `Ctrl+wheel` to zoom, `Alt+wheel` in Illustrator). |
| **Recorded macro** | A recording from the [Recorder](macro-format.md): mouse paths, clicks and keystrokes replayed 1:1 as real HID. |
| **Device menu** *(Vision 6)* | Drive the OLED's own menu from a key — scroll ←/→, CONFIRM, BACK, open Home/Grid/Settings. |

## Host actions — need the app connected

| Action | What it does |
|---|---|
| **Launch** | Open an app, a file, or a URL. |
| **Run command** | Run a shell command line. |
| **Play sound** | Play an audio file; holding the key can stop, fade or restart it. |
| **Microphone** | Toggle / mute / unmute the system mic, or **push-to-talk** (unmute while held). |
| **Webhook** | Any HTTP request, curl-style — smart lights, Home Assistant, Discord/Telegram, your own API. |
| **OBS Studio** | Control OBS over obs-websocket: switch scene, start/stop record & stream, toggle mic / virtual cam / replay buffer, trigger a hotkey. |
| **Sequence** | Stream Deck-style multi-action: run several of the above in order, with delays between steps. |

## Layer & off actions — both models

| Action | What it does |
|---|---|
| **Go to layer X** | Jump straight to a specific layer (A–H). Works on the Core 6 too. |
| **Next / previous layer** | Step through layers. |
| **Do nothing** | Turn the input off — even overrides a Vision 6 control's built-in menu action. |

## Key logic

Each key resolves three gestures, all on the firmware (works standalone):

- **Tap** — the main action.
- **Double-press** — an alternative action within ~250 ms.
- **Long-press (hold)** — an alternative action after ~400 ms.

Plus per-action options: **repeat** (loop while held or a fixed number of
times), **on re-press** (a second press stops or restarts a running macro), and
**hold-to-repeat** for single keys. See [macro-format.md](macro-format.md) for
the exact JSON these compile to.
