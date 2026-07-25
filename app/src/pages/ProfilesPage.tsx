// Per-application profiles: key 1 = Save As in Photoshop, an inventory macro
// in Knight Online, and the device's own config everywhere else.

import { useState } from "react";
import { useDevice } from "../lib/device";
import { useProfiles } from "../lib/profiles";
import { ipc } from "../lib/ipc";
import type { Assignment, ModuleSlot, Profile } from "../lib/types";
import { MODULE_SLOTS, MODULE_SLOT_LABELS, deviceModel } from "../lib/types";
import {
  defaultConfig,
  describeAssignment,
  isSlotBuiltin,
  macroFileName,
  parseAssignment,
  parseDeviceMacro,
  slotEditValue,
  SLOT_BUILTIN_ACTION,
} from "../lib/macro-model";
import { AssignmentPanel } from "../components/AssignmentPanel";
import { Crosshair } from "lucide-react";
import { Badge, Button, Card, Field, Input } from "../components/ui";

/** What each module control does by default (grid context) — shown when a
 * profile doesn't override it, mirroring the Keys page. Module controls keep
 * their built-in behavior under a profile (the device falls back for slots),
 * so a left-alone wheel/button navigates and speed-edits exactly as standalone. */
const SLOT_BUILTINS: Record<ModuleSlot, string> = {
  "enc-cw": "moves the selection right",
  "enc-ccw": "moves the selection left",
  "btn-back": "opens the layer screen",
  "btn-confirm": "opens the selected key's speed editor",
  "btn-psh": "speed editor / select mode",
};

/** Snapshot the device's standalone numbered-key assignments so a new profile
 * starts as a full copy of the keypad's own setup (issue #23). The profile is
 * then an independent config: a key it doesn't carry does nothing (no fallback
 * to global), so the user clears the ones this app shouldn't have and keeps the
 * rest as copied. Module controls aren't copied — they fall back to built-in. */
async function copyGlobalKeys(drivePath: string): Promise<Record<string, Assignment>> {
  const out: Record<string, Assignment> = {};
  let config = defaultConfig();
  try {
    config = { ...config, ...JSON.parse(await ipc.driveRead(drivePath, "config.json")) };
  } catch {
    // no config yet — defaults are fine
  }
  const existing = new Set(await ipc.driveList(drivePath, "macros").catch(() => [] as string[]));
  for (let k = 1; k <= config.key_count; k++) {
    if (config.layer_key === k) continue;
    const file = macroFileName(k, 0);
    if (!existing.has(file.split("/").pop()!)) continue; // globally unassigned
    try {
      out[String(k)] = parseAssignment(parseDeviceMacro(await ipc.driveRead(drivePath, file)));
    } catch {
      // unreadable — leave it out (unassigned in the profile)
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
    // A new profile is a full copy of the keypad's own key setup; you then
    // clear or change only what should differ for this app (issue #23).
    const keys = drive ? await copyGlobalKeys(drive.path).catch(() => ({})) : {};
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
    // A module control left on its concrete built-in action is the same as not
    // overriding it: store the "none" marker (not the concrete action) so
    // saveProfiles compiles it to null and DELETES any copied file, leaving the
    // device to run its native navigation under this profile (issue #26).
    // Storing "none" — rather than dropping the key — is what triggers that
    // delete; just removing it from the map would leave a stale override file
    // behind and it would keep firing (issue #23).
    const store: Assignment =
      typeof editKey !== "number" && isSlotBuiltin(draft, SLOT_BUILTIN_ACTION[editKey])
        ? { kind: "none" }
        : draft;
    const keys = { ...selected.keys, [String(editKey)]: store };
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
          When the foreground app matches a profile, the keypad runs that profile's config —
          natively, on the device, so the wheel, nav buttons and speed editor all keep working.
          A new profile is a full copy of the keypad's own key setup; a key you clear does nothing
          for this app (it doesn't fall back to the global assignment).
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
              No profiles. Focus the target app, then click “+ Add”. A new profile copies the
              keypad's own key setup — clear the keys this app shouldn't have, change the rest.
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
                          {a && a.kind !== "none" ? describeAssignment(a) : "not assigned"}
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
                              {a && a.kind !== "none"
                                ? describeAssignment(a)
                                : `Built-in: ${SLOT_BUILTINS[s]}`}
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
                          ? `Key ${editKey} — set to “Not assigned”, it does nothing for this app (it does NOT fall back to the global key).`
                          : `${MODULE_SLOT_LABELS[editKey]} — left on “Built-in” it keeps ${SLOT_BUILTINS[editKey]} while this profile is active; override it e.g. to zoom the wheel in Photoshop.`}
                      </p>
                      <AssignmentPanel
                        value={
                          draft ??
                          (typeof editKey !== "number"
                            ? slotEditValue(selected.keys[String(editKey)], SLOT_BUILTIN_ACTION[editKey])
                            : selected.keys[String(editKey)] ?? { kind: "none" })
                        }
                        onChange={setDraft}
                        onSave={saveKeyAssignment}
                        onRevert={() => setDraft(null)}
                        dirty={draft !== null}
                        // device-menu nav / on-screen name only exist on a screen model
                        allowMenu={isVision}
                        labelOnScreen={isVision}
                        // module controls keep their built-in action when unset
                        // (the device runs it natively), like the Keys page
                        slotMode={typeof editKey !== "number"}
                        builtinDesc={typeof editKey !== "number" ? SLOT_BUILTINS[editKey] : undefined}
                        // rotation has no press to double/hold on
                        allowVariants={typeof editKey === "number" || editKey.startsWith("btn-")}
                        fwVersion={hello?.fw}
                        // offer "Go to layer X" only for the layers this device has
                        layerCount={hello?.layer_count ?? 0}
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
