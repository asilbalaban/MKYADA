// Per-key assignment form. Whatever the user picks compiles to a macro JSON
// file on the device ("everything is JSON").

import { useState } from "react";
import { Play } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "../lib/fs";
import type { Assignment, MacroFile } from "../lib/types";
import { MEDIA_USAGES, MODIFIERS, SPECIAL_KEYS, migrateMacro, modifierDisplay } from "../lib/macro-model";
import { Button, Field, Input, Select } from "./ui";

const KINDS: { value: Assignment["kind"]; label: string; launchOnly?: boolean }[] = [
  { value: "none", label: "Not assigned" },
  { value: "keystroke", label: "Single key" },
  { value: "combo", label: "Key combination" },
  { value: "text", label: "Type text" },
  { value: "media", label: "Media key" },
  { value: "recorded", label: "Recorded macro (JSON)" },
  { value: "launch", label: "Open app / URL (app running only)", launchOnly: true },
];

const ALL_KEYS = [..."abcdefghijklmnopqrstuvwxyz0123456789", ...SPECIAL_KEYS];

export function AssignmentEditor({
  value,
  onChange,
  allowLaunch = false,
}: {
  value: Assignment;
  onChange: (a: Assignment) => void;
  /** "Open app/URL" needs the desktop app running — only offered in profiles. */
  allowLaunch?: boolean;
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
            else if (kind === "keystroke") onChange({ kind: "keystroke", key: "a" });
            else if (kind === "combo") onChange({ kind: "combo", mods: ["CTRL"], key: "a" });
            else if (kind === "text") onChange({ kind: "text", text: "" });
            else if (kind === "media") onChange({ kind: "media", usage: "play_pause" });
            else if (kind === "launch") onChange({ kind: "launch", target: "" });
            else importMacro();
          }}
        >
          {KINDS.filter((k) => allowLaunch || !k.launchOnly).map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
      </Field>

      {value.kind === "keystroke" && (
        <Field label="Key">
          <Select value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })}>
            {ALL_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {value.kind === "combo" && (
        <>
          <Field label="Modifiers">
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
          <Field label="Key">
            <Select value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })}>
              {ALL_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      {value.kind === "text" && (
        <Field label="Text to type (US layout)">
          <Input
            value={value.text}
            placeholder="e.g. your@email.com"
            onChange={(e) => onChange({ ...value, text: e.target.value })}
          />
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
          <Input
            value={value.target}
            placeholder="https://… or C:\\Program Files\\…\\app.exe"
            onChange={(e) => onChange({ ...value, target: e.target.value })}
          />
        </Field>
      )}

      {value.kind === "recorded" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-fg inline-flex items-center gap-1"><Play size={13} aria-hidden /> {value.name}</span>
          <span className="text-fg-faint text-xs">({value.macro.events.length} events)</span>
          <Button onClick={importMacro}>Replace…</Button>
        </div>
      )}

      {importError && <p className="text-danger text-xs">{importError}</p>}
    </div>
  );
}
