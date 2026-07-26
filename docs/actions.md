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
| **System volume level** | Pressing the key mutes/unmutes (standalone). On a Vision 6, the wheel opens an absolute volume slider — the exact percentage needs the app running (see [Wheel menu](#wheel-menu-vision-6)). |
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
| **Microphone level** | Pressing the key opens a mic input-gain slider on the Vision 6 (needs the app; no standalone mic-gain control). |
| **Webhook** | Any HTTP request, curl-style — smart lights, Home Assistant, Discord/Telegram, your own API. |
| **OBS Studio** | Control OBS over obs-websocket: switch scene, start/stop record & stream, toggle mic / virtual cam / replay buffer, trigger a hotkey. |
| **Sequence** | Stream Deck-style multi-action: run several of the above in order, with delays between steps. |

## Layer & off actions — both models

| Action | What it does |
|---|---|
| **Go to layer X** | Jump straight to a specific layer (A–H). Works on the Core 6 too. |
| **Next / previous layer** | Step through layers. |
| **Do nothing** | Turn the input off — even overrides a Vision 6 control's built-in menu action. |

## Wheel menu (Vision 6)

On the Vision 6, turning the wheel selects a key and **pressing it opens a menu
that fits the key's action** — not always the speed editor. The menu uses one
consistent gesture grammar:

- **Turn** — browse the options (or, on a slider, adjust the value live).
- **Short press** — use the highlighted option now (fire the key / switch the
  scene / do the mic action) — once.
- **Long press (hold)** — reassign the key to the highlighted option. For local
  kinds (media…) the device rewrites the key itself, so it works standalone.
  Menus that support this show a **`hold: assign`** hint on the bottom bar, so
  the gesture is discoverable rather than hidden.
- **Back** — leave the menu.

Pressing a key *physically* still just runs its action — except **slider kinds**
(volume, mic level), where a press opens the slider directly (a bare "mute" is a
poor default for a volume key).

| Action | Turn | Short press | Long press |
|---|---|---|---|
| Recorded macro / Text | Adjust playback/typing speed | Save the speed | — |
| Keystroke / Shortcut | Fire the key repeatedly | Fire once | — |
| Media key | Browse every media key | Use the highlighted one | Reassign the key to it |
| **System volume level** | Set the % (slider) | Confirm & close | — *(press the key = open this)* |
| **Microphone level** | Set the input gain (slider) | Confirm & close | — *(press the key = open this)* |
| Mouse scroll | Scroll in the assigned direction | One step | — |
| OBS · switch scene | Browse scenes (live one marked) | **Switch OBS live** | **Reassign** the key to that scene |
| OBS · record/stream/cam/replay | — | Toggle it live (status shown) | — |
| Microphone (mute) | Browse toggle / mute / unmute | Do it now | Reassign the key to that mode |
| Webhook / Command / Launch / Sound | — | Run it (result shown) | — |
| Device menu (layer / nav) | Browse next/prev layer, jump to a layer, Home/Grid/Settings | Run the highlighted one | Reassign the key to it |
| Sequence | — | Run it | — |

Host actions (OBS, mic, webhook…) show an **"app required"** reminder when the
MKYADA app isn't connected. The app also shows a live mini-OLED preview of this
menu in the key editor and a full reference under **Settings → Keypad → Wheel menu**, and
pushes the live system volume so a volume key shows its **%** right on the grid.

## Key logic

Each key resolves three gestures, all on the firmware (works standalone):

- **Tap** — the main action.
- **Double-press** — an alternative action within ~250 ms.
- **Long-press (hold)** — an alternative action after ~400 ms.

Plus per-action options: **repeat** (loop while held or a fixed number of
times), **on re-press** (a second press stops or restarts a running macro), and
**hold-to-repeat** for single keys. See [macro-format.md](macro-format.md) for
the exact JSON these compile to.
