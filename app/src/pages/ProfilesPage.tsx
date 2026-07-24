// Per-application profiles: key 1 = Save As in Photoshop, an inventory macro
// in Knight Online, and the device's own config everywhere else.

import { useState } from "react";
import { useDevice } from "../lib/device";
import { useProfiles } from "../lib/profiles";
import { ipc } from "../lib/ipc";
import type { Assignment, MenuAction, ModuleSlot, Profile } from "../lib/types";
import { MODULE_SLOTS, MODULE_SLOT_LABELS, deviceModel } from "../lib/types";
import {
  defaultConfig,
  describeAssignment,
  macroFileName,
  parseAssignment,
  parseDeviceMacro,
  slotFileName,
} from "../lib/macro-model";
import { AssignmentPanel } from "../components/AssignmentPanel";
import { Crosshair } from "lucide-react";
import { Badge, Button, Card, Field, Input } from "../components/ui";

/** Each module control's built-in grid action, so a fresh profile shows the
 * device's default behavior (e.g. BACK → open the layer screen) instead of
 * "not assigned" — the user overrides only what differs (issue #23). */
const SLOT_BUILTIN_ACTION: Record<ModuleSlot, MenuAction> = {
  "enc-cw": "right",
  "enc-ccw": "left",
  "btn-back": "home",
  "btn-confirm": "confirm",
  "btn-psh": "confirm",
};

/** Snapshot the device's current standalone assignments (numbered keys +
 * Vision 6 module controls, grid / layer A) so a new profile starts as a copy
 * of the default system instead of empty — otherwise its module controls are
 * dead while the profile holds host mode (issue #23). */
async function readDefaultKeys(drivePath: string): Promise<Record<string, Assignment>> {
  const out: Record<string, Assignment> = {};
  let config = defaultConfig();
  try {
    config = { ...config, ...JSON.parse(await ipc.driveRead(drivePath, "config.json")) };
  } catch {
    // no config yet — defaults are fine
  }
  const existing = new Set(await ipc.driveList(drivePath, "macros").catch(() => [] as string[]));
  const read = async (file: string): Promise<Assignment | null> => {
    if (!existing.has(file.split("/").pop()!)) return null; // built-in / unassigned
    try {
      return parseAssignment(parseDeviceMacro(await ipc.driveRead(drivePath, file)));
    } catch {
      return null;
    }
  };
  for (let k = 1; k <= config.key_count; k++) {
    if (config.layer_key === k) continue;
    const a = await read(macroFileName(k, 0));
    if (a) out[String(k)] = a;
  }
  if (deviceModel(config) === "vision6") {
    for (const s of MODULE_SLOTS) {
      // a custom grid macro wins; otherwise carry the built-in menu action
      out[s] = (await read(slotFileName(s, 0, "grid"))) ?? {
        kind: "menu",
        action: SLOT_BUILTIN_ACTION[s],
      };
    }
  }
  return out;
}

export function ProfilesPage() {
  const { hello, drive } = useDevice();
  const { profiles, foreground, activeProfile, enabled, setEnabled, saveProfiles } = useProfiles();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<number | ModuleSlot | null>(null);
  const [draft, setDraft] = useState<Assignment | null>(null);
  const [adding, setAdding] = useState(false);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;
  const keyCount = hello?.key_count ?? 6;
  const isVision = deviceModel(hello) === "vision6";
  // module controls (wheel + BACK/CONFIRM) are a Vision thing; keep them
  // visible for profiles that already carry slot overrides even when no
  // (or another) device is connected
  const showModules = isVision || MODULE_SLOTS.some((s) => selected?.keys[s]);

  async function addProfile() {
    const id = `p${Date.now().toString(36)}`;
    setAdding(true);
    // start as a copy of the device's current default setup, not empty
    const keys = drive ? await readDefaultKeys(drive.path).catch(() => ({})) : {};
    const p: Profile = {
      id,
      name: foreground.exe ? foreground.exe.replace(/\.exe$/i, "") : "New profile",
      match: { exe: foreground.exe, title_contains: null },
      keys,
    };
    await saveProfiles([...profiles, p]);
    setSelectedId(id);
    setAdding(false);
  }

  function updateSelected(patch: Partial<Profile>) {
    if (!selected) return;
    void saveProfiles(profiles.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)));
  }

  function removeSelected() {
    if (!selected) return;
    void saveProfiles(profiles.filter((p) => p.id !== selected.id));
    setSelectedId(null);
  }

  function saveKeyAssignment() {
    if (!selected || editKey === null || !draft) return;
    const keys = { ...selected.keys };
    if (draft.kind === "none") delete keys[String(editKey)];
    else keys[String(editKey)] = draft;
    updateSelected({ keys });
    setDraft(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Profile engine">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <Button variant={enabled ? "primary" : "default"} onClick={() => setEnabled(!enabled)}>
            {enabled ? "Enabled" : "Disabled"}
          </Button>
          <span className="text-fg-muted">
            Foreground: <span className="text-fg font-mono">{foreground.exe || "—"}</span>
          </span>
          {activeProfile ? (
            <Badge tone="green">active: {activeProfile.name}</Badge>
          ) : (
            <Badge>no match — device runs standalone config</Badge>
          )}
        </div>
        <p className="text-xs text-fg-faint mt-2">
          When the foreground app matches a profile, the keypad's presses are routed through
          this app and played back via the device (still hardware HID). Otherwise the device
          uses its own on-board key assignments.
        </p>
      </Card>

      <div className="grid grid-cols-[240px_1fr] gap-4 items-start">
        <Card
          title="Profiles"
          actions={
            <Button onClick={() => void addProfile()} loading={adding}>
              + Add
            </Button>
          }
        >
          {profiles.length === 0 ? (
            <p className="text-fg-faint text-xs">
              No profiles. Focus the target app, then click “+ Add” — the new profile starts as a
              copy of the keypad's current setup, ready to tweak.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {profiles.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      setSelectedId(p.id);
                      setEditKey(null);
                      setDraft(null);
                    }}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center justify-between
                      ${p.id === selectedId ? "bg-panel2 text-accent" : "text-fg hover:bg-panel2"}`}
                  >
                    <span>{p.name}</span>
                    {activeProfile?.id === p.id && <span className="text-success text-xs">●</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {selected ? (
          <Card
            title={`Profile: ${selected.name}`}
            actions={<Button variant="danger" onClick={removeSelected}>Delete</Button>}
          >
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Name">
                  <Input value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} />
                </Field>
                <Field label="Executable match">
                  <div className="flex gap-1">
                    <Input
                      value={selected.match.exe}
                      placeholder="KnightOnLine.exe"
                      onChange={(e) => updateSelected({ match: { ...selected.match, exe: e.target.value } })}
                    />
                    <Button title="Use current foreground app" aria-label="Use current foreground app"
                      onClick={() => updateSelected({ match: { ...selected.match, exe: foreground.exe } })}>
                      <Crosshair size={14} aria-hidden />
                    </Button>
                  </div>
                </Field>
                <Field label="Title contains (optional)">
                  <Input
                    value={selected.match.title_contains ?? ""}
                    onChange={(e) =>
                      updateSelected({
                        match: { ...selected.match, title_contains: e.target.value || null },
                      })
                    }
                  />
                </Field>
              </div>

              <div className="grid grid-cols-[1fr_1fr] gap-4 items-start">
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-fg-faint mb-1">Keys in this profile</p>
                  {Array.from({ length: keyCount }, (_, i) => i + 1).map((n) => {
                    const a = selected.keys[String(n)];
                    return (
                      <button
                        key={n}
                        onClick={() => {
                          setEditKey(n);
                          setDraft(null);
                        }}
                        className={`flex items-center justify-between px-3 py-2 rounded-md border text-sm
                          ${editKey === n ? "border-accent bg-panel2" : "border-line bg-panel2 hover:border-fg-faint"}`}
                      >
                        <span className="font-semibold text-fg">Key {n}</span>
                        <span className="text-xs text-fg-muted">
                          {a ? describeAssignment(a) : "device default"}
                        </span>
                      </button>
                    );
                  })}
                  {showModules && (
                    <>
                      <p className="text-xs text-fg-faint mt-3 mb-1">
                        Module controls (screen models)
                      </p>
                      {MODULE_SLOTS.map((s) => {
                        const a = selected.keys[s];
                        return (
                          <button
                            key={s}
                            onClick={() => {
                              setEditKey(s);
                              setDraft(null);
                            }}
                            className={`flex items-center justify-between px-3 py-2 rounded-md border text-sm
                              ${editKey === s ? "border-accent bg-panel2" : "border-line bg-panel2 hover:border-fg-faint"}`}
                          >
                            <span className="font-semibold text-fg">{MODULE_SLOT_LABELS[s]}</span>
                            <span className="text-xs text-fg-muted">
                              {a ? describeAssignment(a) : "no action in this profile"}
                            </span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>

                <div>
                  {editKey === null ? (
                    <p className="text-fg-faint text-sm">Select a key to override it in this profile.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs text-fg-faint">
                        {typeof editKey === "number"
                          ? `Key ${editKey} — unassigned keys fall back to the device's own config.`
                          : `${MODULE_SLOT_LABELS[editKey]} — only acts while this profile is active; e.g. set the wheel to zoom in Photoshop.`}
                      </p>
                      <AssignmentPanel
                        value={draft ?? selected.keys[String(editKey)] ?? { kind: "none" }}
                        onChange={setDraft}
                        onSave={saveKeyAssignment}
                        onRevert={() => setDraft(null)}
                        dirty={draft !== null}
                        // device-menu nav / on-screen name only exist on a screen model
                        allowMenu={isVision}
                        labelOnScreen={isVision}
                        // rotation has no press to double/hold on
                        allowVariants={typeof editKey === "number" || editKey.startsWith("btn-")}
                        fwVersion={hello?.fw}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ) : (
          <Card title="Per-app profiles">
            <p className="text-fg-faint text-sm">
              Select or add a profile. Example: key 1 types Ctrl+Shift+S in Photoshop but runs
              your inventory macro in Knight Online.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
