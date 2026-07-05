// Per-key assignment form. Whatever the user picks compiles to a macro JSON
// file on the device ("everything is JSON").

import { useEffect, useState } from "react";
import { FolderOpen, Keyboard, Play, Volume2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { SOUND_EXTENSIONS, playSound } from "../lib/sound";
import { readTextFile } from "../lib/fs";
import type { Assignment, MacroFile, SoundHoldAction } from "../lib/types";
import {
  IS_MAC,
  MEDIA_USAGES,
  MODIFIERS,
  MODIFIER_CODE_TO_KEY,
  keyFromEvent,
  migrateMacro,
  modifierDisplay,
  modsFromEvent,
} from "../lib/macro-model";
import { displayKey, untypeableChars } from "../lib/layout";
import { Button, Field, Input, Select } from "./ui";

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
}: {
  value: Assignment;
  onChange: (a: Assignment) => void;
}) {
  const [importError, setImportError] = useState("");

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
        <Select
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
            else importMacro();
          }}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
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

      {value.kind === "recorded" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-fg inline-flex items-center gap-1"><Play size={13} aria-hidden /> {value.name}</span>
          <span className="text-fg-faint text-xs">({value.macro.events.length} events)</span>
          <Button onClick={importMacro}>Replace…</Button>
        </div>
      )}

      {value.kind !== "none" && value.kind !== "launch" && value.kind !== "command" && value.kind !== "sound" && (
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
        </div>
      )}

      {importError && <p className="text-danger text-xs">{importError}</p>}
    </div>
  );
}
