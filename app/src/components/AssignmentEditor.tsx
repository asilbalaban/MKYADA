// Per-key assignment form. Whatever the user picks compiles to a macro JSON
// file on the device ("everything is JSON").

import { ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, FolderOpen, Keyboard, Mic, Play, Plus, Send, Trash2, Volume2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { SOUND_EXTENSIONS, playSound } from "../lib/sound";
import { readTextFile } from "../lib/fs";
import type { Assignment, AssignmentVariants, MacroFile, MicMode, ObsAction, SequenceStep, SoundHoldAction } from "../lib/types";
import {
  IS_MAC,
  MEDIA_USAGES,
  MIC_MODE_LABELS,
  MODIFIERS,
  MODIFIER_CODE_TO_KEY,
  OBS_ACTION_LABELS,
  SCROLL_DEFAULT_AMOUNT,
  compileAssignment,
  describeAssignment,
  holdRepeatDefault,
  keyFromEvent,
  kindRequiresHost,
  migrateMacro,
  modifierDisplay,
  modsFromEvent,
  obsActionToRequest,
  sequenceIsPureHid,
  stepIsHid,
} from "../lib/macro-model";
import { displayKey, untypeableChars } from "../lib/layout";
import { allKinds, categoryLabel, wheelPreview, wheelSpec } from "../lib/kind-registry";
import { OledPreview } from "./OledPreview";
import { Badge, Button, ControlField, Field, IconSelect, Input, Select } from "./ui";
import type { IconOption } from "./ui";
import {
  HTTP_METHOD_ICON,
  MEDIA_ICON,
  MENU_ICON,
  MIC_ICON,
  SOUND_HOLD_ICON,
} from "./action-icons";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

const SCROLL_DIRS = [
  { dir: "up" as const, label: "Up", icon: <ArrowUp size={14} aria-hidden /> },
  { dir: "down" as const, label: "Down", icon: <ArrowDown size={14} aria-hidden /> },
  { dir: "left" as const, label: "Left", icon: <ArrowLeft size={14} aria-hidden /> },
  { dir: "right" as const, label: "Right", icon: <ArrowRight size={14} aria-hidden /> },
];

/**
 * "Press the key you want" capture control — replaces the 60-option dropdown.
 * With `withMods`, modifiers held during the press are captured too, so the
 * user just performs the shortcut (e.g. hold Ctrl+Shift, press S).
 */
export function KeyCapture({
  value,
  withMods = false,
  captureModifiers = false,
  onCapture,
}: {
  value: string;
  withMods?: boolean;
  /** Accept a bare modifier press as the key itself (macro row editing). */
  captureModifiers?: boolean;
  onCapture: (key: string, mods: string[]) => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const key =
        keyFromEvent(e) ?? (captureModifiers ? MODIFIER_CODE_TO_KEY[e.code] ?? null : null);
      if (!key) return; // bare modifier press — keep waiting for the real key
      onCapture(key, withMods ? modsFromEvent(e) : []);
      setArmed(false);
    };
    const disarm = () => setArmed(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", disarm);
    };
  }, [armed, onCapture, withMods]);

  return (
    <button
      type="button"
      onClick={() => setArmed(!armed)}
      aria-label={armed ? "Listening — press the key to assign" : "Set key"}
      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors self-start
        ${armed
          ? "border-accent bg-accent/10 text-accent"
          : "border-line border-dashed bg-panel2 text-fg hover:border-accent/60"}`}
    >
      <Keyboard size={14} aria-hidden className={armed ? "animate-pulse" : ""} />
      {armed ? (
        withMods ? "Press the shortcut now — hold the modifiers, hit the key…" : "Press the key now…"
      ) : (
        <>
          {value ? (
            <span className="font-mono font-semibold uppercase">{value}</span>
          ) : (
            "Set key"
          )}
          <span className="text-fg-faint text-xs font-normal">click, then press a key</span>
        </>
      )}
    </button>
  );
}

export function AssignmentEditor({
  value,
  onChange,
  nested = false,
  allowMenu = false,
  slotMode = false,
  builtinDesc,
  allowVariants = true,
  fwVersion,
  layerCount = 0,
}: {
  value: Assignment;
  onChange: (a: Assignment) => void;
  /** Rendering a sequence step or key-logic variant: no nesting, no
   * behavior options, no key logic of its own. */
  nested?: boolean;
  /** Offer the device-menu action (only meaningful on a screen model;
   * passed through to key-logic variants, never into sequence steps). */
  allowMenu?: boolean;
  /** Editing a Vision 6 module control (wheel / nav button) rather than a
   * key: "none" reads as "keep the built-in menu action", key logic is
   * offered even on a built-in tap (hold/double over the default), and
   * the device-only hold-to-repeat option is hidden (issue #19). */
  slotMode?: boolean;
  /** What this control's built-in action concretely does in the edited
   * context (e.g. "moves the selection left") — shown instead of the
   * abstract "Built-in menu action" label so the choice reads as a real
   * operation. Slot mode only. */
  builtinDesc?: string;
  /** Key-logic variants make sense for things that are pressed — false for
   * encoder rotation slots. */
  allowVariants?: boolean;
  /** Connected keypad's firmware version — used to warn when key logic
   * needs a firmware update (variants shipped with 0.3.0). */
  fwVersion?: string;
  /** How many layers this device has — offers "Go to layer A..X" device-menu
   * actions for exactly the layers that exist (0 = don't offer them). */
  layerCount?: number;
}) {
  const [importError, setImportError] = useState("");
  // Action kinds, grouped by category (from the registry). On a module slot,
  // "Not assigned" reads as "keep the control's built-in action" — the concrete
  // built-in is pre-selected under Device menu, so this is just the
  // fall-back-to-firmware choice (issue #26).
  const kindOptions: IconOption<Assignment["kind"]>[] = allKinds()
    .filter(
      (k) =>
        (k.id !== "sequence" || !nested) &&
        // menu nav is device-only; callers opt in (never inside a sequence)
        (k.id !== "menu" || allowMenu) &&
        // a true off switch only matters where "none" means the built-in
        // action (module slots) — on keys, "Not assigned" already is nothing
        // (but keep it listed if the current value somehow carries it)
        (k.id !== "nothing" || slotMode || value.kind === "nothing"),
    )
    .map((k) => ({
      value: k.id,
      label: k.id === "none" && slotMode ? "Keep built-in action" : k.label,
      icon: k.icon,
      group: categoryLabel(k.category),
    }));
  const hasVariants = !!(value.variants?.double || value.variants?.hold);
  // The collapsible "Behavior & key logic" section: playback behavior applies
  // to standalone HID kinds; key logic (double/hold) applies wherever there's a
  // press to gesture on. Collapsed by default with a one-line summary so the
  // editor stays uncluttered for the common case (issue: wheel-menu redesign).
  const showBehavior =
    value.kind !== "none" && value.kind !== "nothing" && !kindRequiresHost(value.kind);
  const showKeyLogic = allowVariants && (value.kind !== "none" || slotMode);
  const summaryParts: string[] = [];
  if (value.variants?.double) summaryParts.push(`double: ${describeAssignment(value.variants.double)}`);
  if (value.variants?.hold) summaryParts.push(`hold: ${describeAssignment(value.variants.hold)}`);
  if (value.behavior?.on_repress === "restart") summaryParts.push("restart on re-press");
  if (showBehavior && !hasVariants && !slotMode) {
    const rep = value.behavior?.hold_repeat ?? holdRepeatDefault(value.kind);
    if (rep) summaryParts.push("repeat while held");
  }
  const behaviorSummary = summaryParts.length ? summaryParts.join(" · ") : "Default";

  async function importMacro() {
    setImportError("");
    const file = await open({ filters: [{ name: "Macro JSON", extensions: ["json"] }] });
    if (!file) return;
    try {
      const raw = await readTextFile(file as string);
      const parsed = JSON.parse(raw) as MacroFile;
      if (parsed.format !== "mkyada-macro" && parsed.format !== "asil-macro") {
        throw new Error(`unknown format: ${parsed.format}`);
      }
      const macro = migrateMacro(parsed);
      const name = macro.name ?? (file as string).split(/[\\/]/).pop() ?? "macro";
      onChange({ kind: "recorded", name, macro });
    } catch (e) {
      setImportError(String(e));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ControlField label="Action type">
        <div className="flex flex-col gap-2">
          <IconSelect
            className="w-full"
            ariaLabel="Action type"
            value={value.kind}
            options={kindOptions}
            onChange={(kind) => {
              if (kind === "none") onChange({ kind: "none" });
              else if (kind === "nothing") onChange({ kind: "nothing" });
              else if (kind === "keystroke") onChange({ kind: "keystroke", key: "" });
              else if (kind === "combo") onChange({ kind: "combo", mods: [], key: "" });
              else if (kind === "text") onChange({ kind: "text", text: "" });
              else if (kind === "media") onChange({ kind: "media", usage: "play_pause" });
              else if (kind === "volume") onChange({ kind: "volume" });
              else if (kind === "mic_level") onChange({ kind: "mic_level" });
              else if (kind === "scroll") onChange({ kind: "scroll", dir: "up" });
              else if (kind === "menu") onChange({ kind: "menu", action: "confirm" });
              else if (kind === "launch") onChange({ kind: "launch", target: "" });
              else if (kind === "command") onChange({ kind: "command", command: "" });
              else if (kind === "sound") onChange({ kind: "sound", file: "" });
              else if (kind === "mic") onChange({ kind: "mic", mode: "toggle" });
              else if (kind === "webhook") onChange({ kind: "webhook", url: "" });
              else if (kind === "obs") onChange({ kind: "obs", action: "setScene", sceneName: "" });
              else if (kind === "sequence")
                onChange({ kind: "sequence", steps: [{ a: { kind: "keystroke", key: "" }, delayMs: 0 }] });
              else importMacro();
            }}
          />
          {value.kind !== "none" && value.kind !== "nothing" && value.kind !== "sequence" && (
            kindRequiresHost(value.kind) ? (
              <Badge tone="amber">needs the MKYADA app running on this computer</Badge>
            ) : (
              <Badge tone="green">works standalone — no app needed</Badge>
            )
          )}
        </div>
      </ControlField>

      {value.kind === "nothing" && (
        <p className="text-xs text-fg-faint">
          This control is turned off — pressing or turning it does nothing at all, not even
          the built-in menu navigation.
        </p>
      )}

      {value.kind === "keystroke" && (
        <Field label="Key">
          <KeyCapture
            value={displayKey(value.key)}
            onCapture={(key) => onChange({ ...value, key })}
          />
        </Field>
      )}

      {value.kind === "combo" && (
        <>
          <Field label="Shortcut">
            <KeyCapture
              value={
                value.key
                  ? [...value.mods.map(modifierDisplay), displayKey(value.key).toUpperCase()].join(" + ")
                  : ""
              }
              withMods
              onCapture={(key, mods) =>
                onChange({ ...value, key, mods: mods.length ? mods : value.mods })
              }
            />
          </Field>
          <Field label="Modifiers (tap to adjust)">
            <div className="flex gap-2">
              {MODIFIERS.map((m) => (
                <Button
                  key={m}
                  variant={value.mods.includes(m) ? "primary" : "default"}
                  title={m === "WIN" ? "Windows key / macOS Command — same key on the keypad" : undefined}
                  onClick={() =>
                    onChange({
                      ...value,
                      mods: value.mods.includes(m)
                        ? value.mods.filter((x) => x !== m)
                        : [...value.mods, m],
                    })
                  }
                >
                  {modifierDisplay(m)}
                </Button>
              ))}
            </div>
          </Field>
        </>
      )}

      {value.kind === "text" && (
        <Field label="Text to type">
          <Input
            value={value.text}
            placeholder="e.g. your@email.com"
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
          {(() => {
            const bad = untypeableChars(value.text);
            return bad.length > 0 ? (
              <p className="text-warning text-xs mt-1">
                The keypad can't type these characters on your keyboard layout
                (they need an input method): {bad.join(" ")} — they will be skipped.
              </p>
            ) : null;
          })()}
        </Field>
      )}

      {value.kind === "media" && (
        <ControlField label="Media action">
          <IconSelect
            ariaLabel="Media action"
            value={value.usage}
            options={MEDIA_USAGES.map((u) => ({ value: u, label: u.replace(/_/g, " "), icon: MEDIA_ICON[u] }))}
            onChange={(usage) => onChange({ ...value, usage })}
          />
        </ControlField>
      )}

      {value.kind === "volume" && (
        <p className="text-xs text-fg-faint">
          Pressing the key mutes/unmutes the computer (works standalone). On a Vision 6, turn
          the wheel to this key and press to open a volume slider — the exact percentage needs
          the MKYADA app running; without it the wheel just nudges the volume up and down.
        </p>
      )}

      {value.kind === "mic_level" && (
        <p className="text-xs text-fg-faint">
          Pressing the key on a Vision 6 opens a microphone input-level slider — turn the wheel to
          set the recording gain. Needs the MKYADA app running (there's no standalone mic-gain control).
        </p>
      )}

      {value.kind === "scroll" && (
        <>
          <Field label="Direction">
            <div className="flex gap-2">
              {SCROLL_DIRS.map((d) => (
                <Button
                  key={d.dir}
                  variant={value.dir === d.dir ? "primary" : "default"}
                  onClick={() => onChange({ ...value, dir: d.dir })}
                >
                  {d.icon} {d.label}
                </Button>
              ))}
            </div>
          </Field>
          <Field label="Amount (wheel ticks per press)">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={20}
                className="w-20"
                value={value.amount ?? SCROLL_DEFAULT_AMOUNT}
                onChange={(e) =>
                  onChange({
                    ...value,
                    amount: Math.max(1, Math.min(20, Number(e.target.value) || SCROLL_DEFAULT_AMOUNT)),
                  })
                }
              />
              <span className="text-xs text-fg-faint">1–20 notches</span>
            </div>
          </Field>
          <Field label="Hold modifiers (optional — e.g. Alt to zoom in Illustrator)">
            <div className="flex gap-2">
              {MODIFIERS.map((m) => {
                const on = (value.mods ?? []).includes(m);
                return (
                  <Button
                    key={m}
                    variant={on ? "primary" : "default"}
                    title={m === "WIN" ? "Windows key / macOS Command" : undefined}
                    onClick={() =>
                      onChange({
                        ...value,
                        mods: on
                          ? (value.mods ?? []).filter((x) => x !== m)
                          : [...(value.mods ?? []), m],
                      })
                    }
                  >
                    {modifierDisplay(m)}
                  </Button>
                );
              })}
            </div>
          </Field>
          {(value.dir === "left" || value.dir === "right") && (
            <p className="text-xs text-fg-faint">
              Horizontal scroll uses the mouse's pan channel — most apps that
              support side-scrolling (timelines, wide canvases) pick it up.
            </p>
          )}
        </>
      )}

      {value.kind === "menu" && (
        <ControlField label="Device menu action">
          <IconSelect
            ariaLabel="Device menu action"
            value={value.action}
            options={[
              { value: "left", label: "Scroll menu ← (encoder left)", icon: MENU_ICON.left },
              { value: "right", label: "Scroll menu → (encoder right)", icon: MENU_ICON.right },
              // back before confirm, prev before next: the "go back / go
              // down" half of a pair always reads first, as on the device
              { value: "back", label: "Back", icon: MENU_ICON.back },
              { value: "confirm", label: "Confirm (encoder press)", icon: MENU_ICON.confirm },
              { value: "home", label: "Open the layer screen", icon: MENU_ICON.home },
              { value: "settings", label: "Open the settings menu", icon: MENU_ICON.settings },
              { value: "grid", label: "Open the key grid", icon: MENU_ICON.grid },
              { value: "layer_prev", label: "Switch to the previous layer", icon: MENU_ICON.layer_prev },
              { value: "layer_next", label: "Switch to the next layer", icon: MENU_ICON.layer_next },
              // absolute "go to layer X" — one row per layer that exists
              ...Array.from({ length: Math.min(Math.max(layerCount, 0), 8) }, (_, i) => {
                const a = `layer_${"abcdefgh"[i]}` as typeof value.action;
                return { value: a, label: `Go to layer ${"ABCDEFGH"[i]}`, icon: MENU_ICON[a] };
              }),
              { value: "select", label: "Toggle select mode", icon: MENU_ICON.select },
              // legacy configs only: new slots carry the concrete built-in
              // action directly, so the abstract "default" row is gone (issue #26)
              ...(value.action === "default"
                ? [{
                    value: "default" as const,
                    label: builtinDesc
                      ? `This control's built-in action (${builtinDesc})`
                      : "This control's built-in action",
                  }]
                : []),
            ] satisfies IconOption<typeof value.action>[]}
            onChange={(action) => onChange({ ...value, action })}
          />
          <p className="text-xs text-fg-faint mt-1">
            {slotMode
              ? `Drives the on-screen navigation, whatever else is customized${
                  builtinDesc ? ` — built-in here: ${builtinDesc}` : ""
                }.`
              : "Lets a normal key drive the on-screen menu, just like the wheel and the CONFIRM / BACK buttons. Only does something on a screen model."}
          </p>
        </ControlField>
      )}

      {value.kind === "launch" && (
        <Field label="URL or file/app path">
          <div className="flex gap-2">
            <Input
              className="flex-1"
              value={value.target}
              placeholder={IS_MAC ? "https://… or /Applications/Google Chrome.app" : "https://… or C:\\Program Files\\…\\app.exe"}
              onChange={(e) => onChange({ ...value, target: e.target.value })}
            />
            <Button
              onClick={async () => {
                const picked = await open({
                  defaultPath: IS_MAC ? "/Applications" : undefined,
                  title: "Choose an app or file to open",
                });
                if (picked) onChange({ ...value, target: picked as string });
              }}
            >
              <FolderOpen size={14} aria-hidden /> Browse…
            </Button>
          </div>
          <p className="text-fg-faint text-xs mt-1">
            Pressing the key opens this on the computer. Works while the MKYADA app is
            running (also minimized) — the keypad alone can't open apps.
          </p>
        </Field>
      )}

      {value.kind === "command" && (
        <Field label="Terminal command">
          <Input
            value={value.command}
            placeholder={IS_MAC ? 'e.g. say "hello" or open ~/Downloads' : "e.g. explorer.exe %USERPROFILE%\\Downloads"}
            onChange={(e) => onChange({ ...value, command: e.target.value })}
          />
          <p className="text-fg-faint text-xs mt-1">
            Runs {IS_MAC ? "in your shell" : "via cmd"} on this computer when the key is
            pressed. Works while the MKYADA app is running (also minimized).
          </p>
        </Field>
      )}

      {value.kind === "sound" && (
        <Field label="Sound file">
          <div className="flex gap-2 items-center">
            <Input
              className="flex-1"
              value={value.file}
              placeholder="e.g. ~/Sounds/applause.mp3"
              onChange={(e) => onChange({ ...value, file: e.target.value })}
            />
            <Button
              onClick={async () => {
                const picked = await open({
                  filters: [{ name: "Audio", extensions: SOUND_EXTENSIONS }],
                  title: "Choose a sound file",
                });
                if (picked) onChange({ ...value, file: picked as string });
              }}
            >
              <FolderOpen size={14} aria-hidden /> Browse…
            </Button>
            <Button
              disabled={!value.file}
              title="Preview the sound"
              onClick={() => void playSound(value.file).catch((e) => setImportError(String(e)))}
            >
              <Volume2 size={14} aria-hidden /> Play
            </Button>
          </div>
          <p className="text-fg-faint text-xs mt-1">
            Tap the key to play it on this computer's speakers — sounds can overlap.
            Works while the MKYADA app is running (also minimized).
          </p>
        </Field>
      )}

      {value.kind === "sound" && (
        <ControlField label="Holding the key for 1 second">
          <IconSelect
            ariaLabel="Holding the key for 1 second"
            value={value.holdAction ?? "stop"}
            options={[
              { value: "stop", label: "Stops all playing sounds", icon: SOUND_HOLD_ICON.stop },
              { value: "fade", label: "Fades all playing sounds out", icon: SOUND_HOLD_ICON.fade },
              { value: "restart", label: "Restarts this sound from the top", icon: SOUND_HOLD_ICON.restart },
            ] satisfies IconOption<SoundHoldAction>[]}
            onChange={(holdAction) => onChange({ ...value, holdAction })}
          />
        </ControlField>
      )}

      {value.kind === "mic" && (
        <ControlField label="What the key does">
          <IconSelect
            ariaLabel="What the key does"
            value={value.mode ?? "toggle"}
            options={(Object.keys(MIC_MODE_LABELS) as MicMode[]).map((m) => ({
              value: m,
              label: MIC_MODE_LABELS[m],
              icon: MIC_ICON[m],
            }))}
            onChange={(mode) => onChange({ ...value, mode })}
          />
          <p className="text-fg-faint text-xs mt-1 inline-flex items-start gap-1.5">
            <Mic size={13} aria-hidden className="mt-0.5 shrink-0" />
            {value.mode === "push_to_talk"
              ? "Unmutes while the key is held down, mutes again the instant you let go."
              : "Controls the computer's default microphone. Works while the MKYADA app is running (also minimized)."}
          </p>
        </ControlField>
      )}

      {value.kind === "webhook" && <WebhookFields value={value} onChange={onChange} />}

      {value.kind === "obs" && <ObsFields value={value} onChange={onChange} />}

      {value.kind === "recorded" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-fg inline-flex items-center gap-1"><Play size={13} aria-hidden /> {value.name}</span>
          <span className="text-fg-faint text-xs">({value.macro.events.length} events)</span>
          <Button onClick={importMacro}>Replace…</Button>
        </div>
      )}

      {value.kind === "sequence" && (
        <SequenceEditor value={value.steps} onChange={(steps) => onChange({ ...value, steps })} />
      )}

      {!nested && !slotMode && allowMenu && value.kind !== "none" && value.kind !== "nothing" && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-xs font-semibold text-fg-muted">
            Wheel menu — what turning the wheel to this key and pressing shows on screen
          </span>
          <div className="flex items-start gap-3">
            <OledPreview preview={wheelPreview(value)} />
            <div className="flex min-w-0 flex-col gap-1 text-xs">
              <p className="text-fg-muted">{wheelSpec(value.kind).summary}</p>
              {wheelSpec(value.kind).standaloneFallback && (
                <p className="text-fg-faint">{wheelSpec(value.kind).standaloneFallback}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {!nested && (showBehavior || showKeyLogic) && (
        <Collapsible title="Behavior & key logic" summary={behaviorSummary}>
          {showBehavior && (
            <div className="flex flex-wrap gap-3">
              <Field label="Press again while playing">
                <Select
                  value={value.behavior?.on_repress ?? "stop"}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      behavior: {
                        ...value.behavior,
                        on_repress: e.target.value as "stop" | "restart",
                      },
                    })
                  }
                >
                  <option value="stop">Stop the macro</option>
                  <option value="restart">Restart it from the top</option>
                </Select>
              </Field>
              {!hasVariants && !slotMode && (
                <Field label="While the key is held down">
                  <Select
                    value={(value.behavior?.hold_repeat ?? holdRepeatDefault(value.kind)) ? "repeat" : "once"}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        behavior: { ...value.behavior, hold_repeat: e.target.value === "repeat" },
                      })
                    }
                  >
                    <option value="once">Play once</option>
                    <option value="repeat">Repeat — like holding a letter key</option>
                  </Select>
                </Field>
              )}
            </div>
          )}

          {showKeyLogic && (
            <div className={`flex flex-col gap-3${showBehavior ? " border-t border-line pt-3" : ""}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-fg-muted">
                  Key logic — extra actions on the same {slotMode ? "control" : "key"}
                </span>
                {hasVariants && fwVersion && !fwSupportsVariants(fwVersion, slotMode) && (
                  <Badge tone="amber">
                    needs firmware {slotMode ? "0.9.0" : "0.3.0"} — update on the Devices page
                  </Badge>
                )}
              </div>
              {slotMode && value.kind === "none" && (
                <p className="text-xs text-fg-faint">
                  The tap keeps its built-in menu action — only the gestures below are customized.
                </p>
              )}
              <VariantSlot
                label="Double press"
                hint="A quick tap then waits a moment before firing — only when this is set."
                value={value.variants?.double}
                allowMenu={allowMenu}
                layerCount={layerCount}
                onChange={(v) => onChange({ ...value, variants: setVariant(value.variants, "double", v) })}
              />
              <VariantSlot
                label="Long press (hold)"
                hint="Fires after holding the key ~0.4 s. Replaces the hold-to-repeat option."
                value={value.variants?.hold}
                allowMenu={allowMenu}
                layerCount={layerCount}
                onChange={(v) => onChange({ ...value, variants: setVariant(value.variants, "hold", v) })}
              />
            </div>
          )}
        </Collapsible>
      )}

      {importError && <p className="text-danger text-xs">{importError}</p>}
    </div>
  );
}

/** Webhook request editor: method + URL + free-form headers + body — the
 * whole request is user-defined, curl-style (smart lights, Discord,
 * Home Assistant…). The desktop app fires it when the key is pressed. */
function WebhookFields({
  value,
  onChange,
}: {
  value: Extract<Assignment, { kind: "webhook" }>;
  onChange: (a: Assignment) => void;
}) {
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  // Header rows carry a stable id so a React key never reuses a deleted row's
  // DOM. With index keys, removing a row made the *next* row visually inherit
  // the deleted one's box — it looked like the inputs "emptied" and a phantom
  // row stayed, so the list couldn't be cleared to zero. The parent stays the
  // source of truth for {name,value}; the id is view-only.
  const nextId = useRef(0);
  const [rows, setRows] = useState<{ id: number; name: string; value: string }[]>(() =>
    (value.headers ?? []).map((h) => ({ id: nextId.current++, ...h })),
  );
  const externKey = JSON.stringify(value.headers ?? []);
  const rowsKey = JSON.stringify(rows.map(({ name, value: v }) => ({ name, value: v })));
  // Re-seed rows only when a *different* assignment loads (selection / undo
  // swaps the array), never on our own keystroke echoes — that would clobber
  // the edit in progress.
  useEffect(() => {
    if (externKey !== rowsKey) {
      setRows((value.headers ?? []).map((h) => ({ id: nextId.current++, ...h })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externKey]);

  function commit(next: { id: number; name: string; value: string }[]) {
    setRows(next);
    onChange({ ...value, headers: next.map(({ name, value: v }) => ({ name, value: v })) });
  }

  async function sendTest() {
    setTest(null);
    try {
      const status = await invoke<number>("http_request", {
        url: value.url,
        method: value.method ?? null,
        headers: value.headers ?? null,
        body: value.body ?? null,
      });
      setTest({ ok: true, text: `Worked — the server answered HTTP ${status}.` });
    } catch (e) {
      setTest({ ok: false, text: String(e) });
    }
  }

  return (
    <>
      <ControlField label="Request">
        <div className="flex gap-2">
          <IconSelect
            className="w-40"
            ariaLabel="HTTP method"
            value={value.method ?? "GET"}
            options={HTTP_METHODS.map((m) => ({ value: m, label: m, icon: HTTP_METHOD_ICON[m] }))}
            onChange={(method) =>
              onChange({
                ...value,
                ...(method === "GET" ? { method: undefined } : { method }),
              })
            }
          />
          <Input
            className="flex-1"
            aria-label="Webhook URL"
            value={value.url}
            placeholder="https://discord.com/api/webhooks/… or http://homeassistant.local:8123/api/…"
            onChange={(e) => onChange({ ...value, url: e.target.value })}
          />
        </div>
        <p className="text-fg-faint text-xs mt-1">
          Pressing the key sends this request from the computer — turn on a light, post to
          Discord/Telegram, anything with an HTTP API. Works while the MKYADA app is running
          (also minimized).
        </p>
      </ControlField>

      <Field label="Headers">
        <div className="flex flex-col gap-2">
          {rows.map((h, i) => (
            <div key={h.id} className="flex gap-2">
              <Input
                className="w-44"
                value={h.name}
                placeholder="Content-Type"
                onChange={(e) => commit(rows.map((r, k) => (k === i ? { ...r, name: e.target.value } : r)))}
              />
              <Input
                className="flex-1"
                value={h.value}
                placeholder="application/json"
                onChange={(e) => commit(rows.map((r, k) => (k === i ? { ...r, value: e.target.value } : r)))}
              />
              <Button
                variant="danger"
                title="Remove header"
                onClick={() => commit(rows.filter((_, k) => k !== i))}
              >
                <Trash2 size={13} aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            className="self-start"
            onClick={() => commit([...rows, { id: nextId.current++, name: "", value: "" }])}
          >
            <Plus size={14} aria-hidden /> Add header
          </Button>
        </div>
      </Field>

      <Field label="Body (optional)">
        <textarea
          rows={3}
          value={value.body ?? ""}
          placeholder='{"content": "Key pressed!"}'
          onChange={(e) => onChange({ ...value, body: e.target.value || undefined })}
          className="w-full rounded-md border border-line bg-panel2 px-3 py-2 text-sm font-mono text-fg
            placeholder:text-fg-faint focus:outline-none focus:border-accent"
        />
        <p className="text-fg-faint text-xs mt-1">
          Sent as-is. For JSON, add a <span className="font-mono">Content-Type: application/json</span> header.
        </p>
      </Field>

      <div className="flex items-center gap-2">
        <Button disabled={!value.url} onClick={() => void sendTest()}>
          <Send size={14} aria-hidden /> Send test request
        </Button>
        {test && (
          <span className={`text-xs ${test.ok ? "text-success" : "text-danger"}`}>{test.text}</span>
        )}
      </div>
    </>
  );
}

function ObsFields({
  value,
  onChange,
}: {
  value: Extract<Assignment, { kind: "obs" }>;
  onChange: (a: Assignment) => void;
}) {
  const [scenes, setScenes] = useState<string[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  // Best-effort: if OBS is connected, offer live scene / input names as
  // suggestions. When it isn't, the fields stay free-text so keys can still be
  // configured offline.
  useEffect(() => {
    void invoke<{ scenes?: { sceneName: string }[] }>("obs_request", {
      requestType: "GetSceneList",
      requestData: {},
    })
      .then((r) => setScenes((r.scenes ?? []).map((s) => s.sceneName)))
      .catch(() => {});
    void invoke<{ inputs?: { inputName: string }[] }>("obs_request", {
      requestType: "GetInputList",
      requestData: {},
    })
      .then((r) => setInputs((r.inputs ?? []).map((i) => i.inputName)))
      .catch(() => {});
  }, []);

  async function sendTest() {
    setTest(null);
    try {
      const { requestType, requestData } = obsActionToRequest(value);
      await invoke("obs_action", { requestType, requestData });
      setTest({ ok: true, text: "Sent to OBS." });
    } catch (e) {
      setTest({ ok: false, text: String(e) });
    }
  }

  return (
    <>
      <ControlField label="OBS action">
        <Select
          className="w-full"
          aria-label="OBS action"
          value={value.action}
          onChange={(e) => onChange({ ...value, action: e.target.value as ObsAction })}
        >
          {(Object.keys(OBS_ACTION_LABELS) as ObsAction[]).map((a) => (
            <option key={a} value={a}>
              {OBS_ACTION_LABELS[a]}
            </option>
          ))}
        </Select>
      </ControlField>

      {value.action === "setScene" && (
        <Field label="Scene">
          <Input
            list="obs-scene-list"
            value={value.sceneName ?? ""}
            placeholder="Scene name"
            onChange={(e) => onChange({ ...value, sceneName: e.target.value })}
          />
        </Field>
      )}

      {value.action === "micToggle" && (
        <Field label="Audio input (mic)">
          <Input
            list="obs-input-list"
            value={value.inputName ?? ""}
            placeholder="e.g. Mic/Aux"
            onChange={(e) => onChange({ ...value, inputName: e.target.value })}
          />
        </Field>
      )}

      {value.action === "sourceToggle" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Scene">
            <Input
              list="obs-scene-list"
              value={value.sourceScene ?? ""}
              placeholder="Scene holding the source"
              onChange={(e) => onChange({ ...value, sourceScene: e.target.value })}
            />
          </Field>
          <Field label="Source">
            <Input
              value={value.sourceName ?? ""}
              placeholder="Source name"
              onChange={(e) => onChange({ ...value, sourceName: e.target.value })}
            />
          </Field>
        </div>
      )}

      {value.action === "hotkey" && (
        <Field label="OBS hotkey name">
          <Input
            value={value.hotkeyName ?? ""}
            placeholder="e.g. OBSBasic.StartRecording"
            onChange={(e) => onChange({ ...value, hotkeyName: e.target.value })}
          />
        </Field>
      )}

      {/* suggestion sources, populated when OBS is connected */}
      <datalist id="obs-scene-list">
        {scenes.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <datalist id="obs-input-list">
        {inputs.map((i) => (
          <option key={i} value={i} />
        ))}
      </datalist>

      <p className="text-fg-faint text-xs">
        Runs while the MKYADA app is connected to OBS (Settings → OBS Studio). The
        keypad screen can show the live scene / REC / LIVE status.
      </p>

      <div className="flex items-center gap-2">
        <Button onClick={() => void sendTest()}>
          <Send size={14} aria-hidden /> Test in OBS
        </Button>
        {test && (
          <span className={`text-xs ${test.ok ? "text-success" : "text-danger"}`}>{test.text}</span>
        )}
      </div>
    </>
  );
}

/** Bordered, collapsed-by-default section with a title and a one-line summary
 * of what's inside — used to fold the advanced Behavior / key-logic controls
 * away so the editor reads cleanly for the common case. */
function Collapsible({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={`shrink-0 text-fg-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-xs font-semibold text-fg-muted">{title}</span>
        {!open && summary && (
          <span className="ml-1 min-w-0 flex-1 truncate text-xs text-fg-faint">{summary}</span>
        )}
      </button>
      {open && <div className="mt-3 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function setVariant(
  variants: AssignmentVariants | undefined,
  which: "double" | "hold",
  v: Assignment | undefined,
): AssignmentVariants | undefined {
  const next = { ...variants };
  if (v) next[which] = v;
  else delete next[which];
  return next.double || next.hold ? next : undefined;
}

/** Firmware resolves key-logic variants since 0.3.0; on module slots
 * (wheel / nav buttons) the Ui-side resolver shipped with 0.9.0. */
function fwSupportsVariants(fw: string, slot = false): boolean {
  const [maj = 0, min = 0] = fw.split(".").map((n) => parseInt(n) || 0);
  return maj > 0 || min >= (slot ? 9 : 3);
}

function VariantSlot({
  label,
  hint,
  value,
  allowMenu = false,
  layerCount = 0,
  onChange,
}: {
  label: string;
  hint: string;
  value?: Assignment;
  /** Offer device-menu actions inside this variant (Vision 6). */
  allowMenu?: boolean;
  /** Layer count for the "Go to layer X" device-menu actions. */
  layerCount?: number;
  onChange: (a: Assignment | undefined) => void;
}) {
  if (!value) {
    return (
      <Button className="self-start" onClick={() => onChange({ kind: "keystroke", key: "" })}>
        <Plus size={14} aria-hidden /> Add {label.toLowerCase()} action
      </Button>
    );
  }
  return (
    <div className="rounded-md border border-line bg-panel2 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-fg-muted">
          {label} · {describeAssignment(value)}
        </span>
        <Button variant="danger" className="ml-auto" onClick={() => onChange(undefined)} title={`Remove ${label.toLowerCase()} action`}>
          <Trash2 size={13} aria-hidden />
        </Button>
      </div>
      <AssignmentEditor nested allowMenu={allowMenu} layerCount={layerCount} value={value} onChange={onChange} />
      <p className="text-xs text-fg-faint">{hint}</p>
    </div>
  );
}

/** Step list of a multi-action sequence: reorder, per-step editor, delay
 * after each step, plus an honest standalone/app-required badge and the
 * device size budget (pure-HID sequences compile into one macro file). */
function SequenceEditor({
  value,
  onChange,
}: {
  value: SequenceStep[];
  onChange: (steps: SequenceStep[]) => void;
}) {
  const pure = sequenceIsPureHid(value);
  const hostSteps = value
    .map((s, i) => (stepIsHid(s) ? null : i + 1))
    .filter((n): n is number => n !== null);

  function updateStep(i: number, step: SequenceStep) {
    const next = [...value];
    next[i] = step;
    onChange(next);
  }

  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  // device budget: pure sequences become one macro file on the keypad
  const compiled = pure ? compileAssignment({ kind: "sequence", steps: value }) : null;
  const bytes = compiled ? JSON.stringify(compiled).length : 0;
  const overBudget = compiled ? compiled.events.length > 2000 || bytes > 120 * 1024 : false;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {pure ? (
          <Badge tone="green">runs on the keypad — works standalone</Badge>
        ) : (
          <Badge tone="amber">
            step {hostSteps.join(", ")} need{hostSteps.length === 1 ? "s" : ""} the MKYADA app running
          </Badge>
        )}
        {compiled && (
          <span className={`text-xs ${overBudget ? "text-danger" : "text-fg-faint"}`}>
            {compiled.events.length} events · {(bytes / 1024).toFixed(1)} KB
            {overBudget && " — too big for the keypad, trim some steps"}
          </span>
        )}
      </div>

      {value.map((step, i) => (
        <div key={i} className="rounded-md border border-line bg-panel2 p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-fg-muted">
              Step {i + 1} · {describeAssignment(step.a)}
            </span>
            <div className="ml-auto flex gap-1">
              <Button onClick={() => moveStep(i, -1)} disabled={i === 0} title="Move up">
                <ArrowUp size={13} aria-hidden />
              </Button>
              <Button onClick={() => moveStep(i, 1)} disabled={i === value.length - 1} title="Move down">
                <ArrowDown size={13} aria-hidden />
              </Button>
              <Button
                variant="danger"
                onClick={() => onChange(value.filter((_, k) => k !== i))}
                title="Delete step"
              >
                <Trash2 size={13} aria-hidden />
              </Button>
            </div>
          </div>
          <AssignmentEditor nested value={step.a} onChange={(a) => updateStep(i, { ...step, a })} />
          {i < value.length - 1 && (
            <Field label="Wait before the next step (ms)">
              <Input
                type="number" min="0" step="50" className="w-28"
                value={step.delayMs}
                onChange={(e) =>
                  updateStep(i, { ...step, delayMs: Math.max(0, parseInt(e.target.value) || 0) })
                }
              />
            </Field>
          )}
        </div>
      ))}

      <Button
        className="self-start"
        onClick={() => onChange([...value, { a: { kind: "keystroke", key: "" }, delayMs: 0 }])}
      >
        <Plus size={14} aria-hidden /> Add step
      </Button>
    </div>
  );
}
