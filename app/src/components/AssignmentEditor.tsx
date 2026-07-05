// Per-key assignment form. Whatever the user picks compiles to a macro JSON
// file on the device ("everything is JSON").

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FolderOpen, Keyboard, Mic, Play, Plus, Trash2, Volume2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { SOUND_EXTENSIONS, playSound } from "../lib/sound";
import { readTextFile } from "../lib/fs";
import type { Assignment, AssignmentVariants, MacroFile, MicMode, SequenceStep, SoundHoldAction } from "../lib/types";
import {
  IS_MAC,
  MEDIA_USAGES,
  MIC_MODE_LABELS,
  MODIFIERS,
  MODIFIER_CODE_TO_KEY,
  compileAssignment,
  describeAssignment,
  keyFromEvent,
  kindRequiresHost,
  migrateMacro,
  modifierDisplay,
  modsFromEvent,
  sequenceIsPureHid,
  stepIsHid,
} from "../lib/macro-model";
import { displayKey, untypeableChars } from "../lib/layout";
import { Badge, Button, Field, Input, Select } from "./ui";

const KINDS: { value: Assignment["kind"]; label: string }[] = [
  { value: "none", label: "Not assigned" },
  { value: "keystroke", label: "Single key" },
  { value: "combo", label: "Key combination" },
  { value: "text", label: "Type text" },
  { value: "media", label: "Media key" },
  { value: "recorded", label: "Recorded macro (JSON)" },
  { value: "launch", label: "Open app / file / URL" },
  { value: "command", label: "Run terminal command" },
  { value: "sound", label: "Play a sound" },
  { value: "mic", label: "Mute/unmute microphone" },
  { value: "sequence", label: "Multi action (sequence)" },
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
  fwVersion,
}: {
  value: Assignment;
  onChange: (a: Assignment) => void;
  /** Rendering a sequence step or key-logic variant: no nesting, no
   * behavior options, no key logic of its own. */
  nested?: boolean;
  /** Connected keypad's firmware version — used to warn when key logic
   * needs a firmware update (variants shipped with 0.3.0). */
  fwVersion?: string;
}) {
  const [importError, setImportError] = useState("");
  const kinds = nested ? KINDS.filter((k) => k.value !== "sequence") : KINDS;
  const hasVariants = !!(value.variants?.double || value.variants?.hold);

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
      <Field label="Action type">
        <div className="flex items-center gap-2 flex-wrap">
          <Select
            className="flex-1 min-w-[12rem]"
            value={value.kind}
            onChange={(e) => {
              const kind = e.target.value as Assignment["kind"];
              if (kind === "none") onChange({ kind: "none" });
              else if (kind === "keystroke") onChange({ kind: "keystroke", key: "" });
              else if (kind === "combo") onChange({ kind: "combo", mods: [], key: "" });
              else if (kind === "text") onChange({ kind: "text", text: "" });
              else if (kind === "media") onChange({ kind: "media", usage: "play_pause" });
              else if (kind === "launch") onChange({ kind: "launch", target: "" });
              else if (kind === "command") onChange({ kind: "command", command: "" });
              else if (kind === "sound") onChange({ kind: "sound", file: "" });
              else if (kind === "mic") onChange({ kind: "mic", mode: "toggle" });
              else if (kind === "sequence")
                onChange({ kind: "sequence", steps: [{ a: { kind: "keystroke", key: "" }, delayMs: 0 }] });
              else importMacro();
            }}
          >
            {kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          {value.kind !== "none" && value.kind !== "sequence" && (
            kindRequiresHost(value.kind) ? (
              <Badge tone="amber">needs the MKYADA app running on this computer</Badge>
            ) : (
              <Badge tone="green">works standalone — no app needed</Badge>
            )
          )}
        </div>
      </Field>

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
        <Field label="Media action">
          <Select value={value.usage} onChange={(e) => onChange({ ...value, usage: e.target.value })}>
            {MEDIA_USAGES.map((u) => (
              <option key={u} value={u}>
                {u.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
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
        <Field label="Holding the key for half a second">
          <Select
            value={value.holdAction ?? "stop"}
            onChange={(e) => onChange({ ...value, holdAction: e.target.value as SoundHoldAction })}
          >
            <option value="stop">Stops all playing sounds</option>
            <option value="fade">Fades all playing sounds out</option>
            <option value="restart">Restarts this sound from the top</option>
          </Select>
        </Field>
      )}

      {value.kind === "mic" && (
        <Field label="What the key does">
          <Select
            value={value.mode ?? "toggle"}
            onChange={(e) => onChange({ ...value, mode: e.target.value as MicMode })}
          >
            {(Object.keys(MIC_MODE_LABELS) as MicMode[]).map((m) => (
              <option key={m} value={m}>
                {MIC_MODE_LABELS[m]}
              </option>
            ))}
          </Select>
          <p className="text-fg-faint text-xs mt-1 inline-flex items-start gap-1.5">
            <Mic size={13} aria-hidden className="mt-0.5 shrink-0" />
            {value.mode === "push_to_talk"
              ? "Unmutes while the key is held down, mutes again the instant you let go."
              : "Controls the computer's default microphone. Works while the MKYADA app is running (also minimized)."}
          </p>
        </Field>
      )}

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

      {!nested && value.kind !== "none" && value.kind !== "launch" && value.kind !== "command" && value.kind !== "sound" && value.kind !== "mic" && (
        <div className="flex flex-wrap gap-3 border-t border-line pt-3">
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
          {!hasVariants && (
            <Field label="While the key is held down">
              <Select
                value={value.behavior?.hold_repeat ? "repeat" : "once"}
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

      {!nested && value.kind !== "none" && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-fg-muted">
              Key logic — extra actions on the same key
            </span>
            {hasVariants && fwVersion && !fwSupportsVariants(fwVersion) && (
              <Badge tone="amber">needs firmware 0.3.0 — update on the Devices page</Badge>
            )}
          </div>
          <VariantSlot
            label="Double press"
            hint="A quick tap then waits a moment before firing — only when this is set."
            value={value.variants?.double}
            onChange={(v) => onChange({ ...value, variants: setVariant(value.variants, "double", v) })}
          />
          <VariantSlot
            label="Long press (hold)"
            hint="Fires after holding the key ~0.4 s. Replaces the hold-to-repeat option."
            value={value.variants?.hold}
            onChange={(v) => onChange({ ...value, variants: setVariant(value.variants, "hold", v) })}
          />
        </div>
      )}

      {importError && <p className="text-danger text-xs">{importError}</p>}
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

/** Firmware resolves key-logic variants since 0.3.0. */
function fwSupportsVariants(fw: string): boolean {
  const [maj = 0, min = 0] = fw.split(".").map((n) => parseInt(n) || 0);
  return maj > 0 || min >= 3;
}

function VariantSlot({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value?: Assignment;
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
      <AssignmentEditor nested value={value} onChange={onChange} />
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
