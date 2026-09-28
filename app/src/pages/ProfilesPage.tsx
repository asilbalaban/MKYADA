// Per-application profiles: key 1 = Save As in Photoshop, an inventory macro
// in Knight Online, and the device's own config everywhere else.

import { useState } from "react";
import { AppWindow, Crosshair, MousePointerClick, Plus, Trash2 } from "lucide-react";
import { useDevice } from "../lib/device";
import { useProfiles } from "../lib/profiles";
import { ipc } from "../lib/ipc";
import type { Assignment, ModuleSlot, Profile } from "../lib/types";
import { MODULE_SLOTS, MODULE_SLOT_LABELS, deviceModel } from "../lib/types";
import {
  defaultConfig,
  describeSlotAssignment,
  isSlotBuiltin,
  macroFileName,
  parseAssignment,
  parseDeviceMacro,
  slotEditValue,
  SLOT_BUILTIN_ACTION,
  SLOT_BUILTINS,
} from "../lib/macro-model";
import { AssignmentPanel } from "../components/AssignmentPanel";
import { Keypad } from "../components/Keypad";
import { useConfirm } from "../components/dialog";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  SettingRow,
  Switch,
  Tooltip,
} from "../components/ui";

const FIELD_LABEL = "text-label font-medium tracking-label text-fg [font-stretch:90%]";

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
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<number | ModuleSlot | null>(null);
  const [draft, setDraft] = useState<Assignment | null>(null);
  const [adding, setAdding] = useState(false);

  const selected = profiles.find((p) => p.id === selectedId) ?? null;
  const keyCount = hello?.key_count ?? 6;
  const isVision = deviceModel(hello) === "vision6";
  // core6 has no wheel or nav buttons: never offer module controls there,
  // even for a profile that carries slot overrides from a Vision 6
  const isCore = !!hello && deviceModel(hello) === "core6";
  // module controls (wheel + BACK/CONFIRM) are a Vision thing; keep them
  // visible for profiles that already carry slot overrides when no device is
  // connected
  const showModules =
    isVision || (!isCore && MODULE_SLOTS.some((s) => selected?.keys[s]));
  // The Keypad grid only needs the shape: key count and the layer key (which
  // still switches layers under a profile, so it isn't assignable here).
  const padConfig = { ...defaultConfig(), key_count: keyCount, layer_key: hello?.layer_key ?? null };

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
    setEditKey(null);
    setDraft(null);
    setAdding(false);
  }

  function updateSelected(patch: Partial<Profile>) {
    if (!selected) return;
    void saveProfiles(profiles.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)));
  }

  async function removeSelected() {
    if (!selected) return;
    const ok = await confirm({
      title: `Delete “${selected.name}”?`,
      message: drive
        ? "The keypad stops switching to it for this app and its key files are removed from the keypad. Your global keys stay as they are."
        : "The keypad stops switching to it for this app. Its key files are removed from the keypad the next time it connects. Your global keys stay as they are.",
      confirmLabel: "Delete profile",
      danger: true,
    });
    if (!ok) return;
    void saveProfiles(profiles.filter((p) => p.id !== selected.id));
    setSelectedId(null);
    setEditKey(null);
    setDraft(null);
  }

  function pickKey(k: number | ModuleSlot) {
    setEditKey(k);
    setDraft(null);
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

  // What the keypad grid shows: this profile's own keys (a cleared key is empty).
  const padAssignments = new Map<number, Assignment>();
  if (selected) {
    for (let k = 1; k <= keyCount; k++) {
      const a = selected.keys[String(k)];
      if (a && a.kind !== "none") padAssignments.set(k, a);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SettingRow
          icon={AppWindow}
          title="Switch keys per app"
          description={
            <>
              In front ·{" "}
              <span className="font-mono text-fg-muted">{foreground.exe || "none"}</span>
            </>
          }
          control={
            <>
              {enabled &&
                (activeProfile ? (
                  <Badge tone="green" dot>
                    Active · {activeProfile.name}
                  </Badge>
                ) : (
                  <Badge>No match · global keys</Badge>
                ))}
              <Switch checked={enabled} onChange={setEnabled} aria-label="Switch keys per app" />
            </>
          }
        />
      </Card>

      <div className="grid grid-cols-[360px_minmax(0,1fr)] 2xl:grid-cols-[420px_minmax(0,1fr)] gap-4 items-start">
        <div className="flex flex-col gap-4">
          <Card
            title="Profiles"
            actions={
              <Tooltip side="bottom" content="New profile for the app in front · starts as a copy of your keys">
                <Button size="sm" onClick={() => void addProfile()} loading={adding}>
                  <Plus size={14} aria-hidden /> Add
                </Button>
              </Tooltip>
            }
            bodyClassName={profiles.length ? "p-2" : undefined}
          >
            {profiles.length === 0 ? (
              <p className="text-sm text-fg-faint">
                No profiles yet. Bring the app to the front, then Add.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {profiles.map((p) => {
                  const on = p.id === selectedId;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          setSelectedId(p.id);
                          setEditKey(null);
                          setDraft(null);
                        }}
                        className={`flex w-full items-center gap-3 rounded-control px-3 py-2 text-left transition-colors duration-[120ms] ease-standard
                          ${on ? "bg-selected" : "hover:bg-hover"}`}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className={`truncate text-sm ${on ? "font-strong text-accent-ink" : "text-fg"}`}>
                            {p.name}
                          </span>
                          <span className="truncate font-mono text-label text-fg-faint">
                            {p.match.exe || "no app set"}
                            {p.match.title_contains ? ` · “${p.match.title_contains}”` : ""}
                          </span>
                        </span>
                        {activeProfile?.id === p.id && (
                          <Badge tone="green" dot className="shrink-0">
                            Active
                          </Badge>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {selected && (
            <Card title="Keys" description={`In ${selected.name}`}>
              <Keypad
                config={padConfig}
                selected={typeof editKey === "number" ? editKey : null}
                onSelect={(n) => {
                  if (padConfig.layer_key === n) return;
                  pickKey(n);
                }}
                assignments={padAssignments}
              />
              {showModules && (
                <div className="mt-5 flex flex-col gap-2.5 border-t border-line pt-4">
                  <span className={FIELD_LABEL}>Module controls</span>
                  <div className="grid grid-cols-2 gap-2">
                    {MODULE_SLOTS.map((s, i) => {
                      const a = selected.keys[s];
                      const custom = a && a.kind !== "none";
                      const isSel = editKey === s;
                      const odd = MODULE_SLOTS.length % 2 === 1 && i === MODULE_SLOTS.length - 1;
                      return (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={isSel}
                          onClick={() => pickKey(s)}
                          className={`hz-control relative min-w-0 rounded-card border px-3 py-2.5 flex flex-col items-start gap-0.5 text-left transition-[background-color,border-color,box-shadow] duration-[120ms] ease-standard
                            ${odd ? "col-span-2" : ""}
                            ${isSel ? "border-accent bg-selected shadow-ring" : "border-line-strong bg-raised hover:border-stone-350"}`}
                        >
                          <span className="text-[13px] font-strong text-fg">{MODULE_SLOT_LABELS[s]}</span>
                          <span className="text-label text-fg-muted leading-tight line-clamp-2">
                            {custom ? (
                              describeSlotAssignment(a)
                            ) : (
                              <span className="text-fg-faint">Built-in · {SLOT_BUILTINS.grid[s]}</span>
                            )}
                          </span>
                          {custom && (
                            <span
                              aria-hidden
                              title="Customized"
                              className="absolute top-2 right-2 size-1.5 rounded-full bg-accent"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <Alert tone="info" className="mt-4">
                A profile is a full copy of your keys. A cleared key does nothing in this app · it
                doesn't fall back to the global key.
                {showModules && " Module controls left on Built-in keep their normal behavior."}
              </Alert>
            </Card>
          )}
        </div>

        {selected ? (
          <div className="flex flex-col gap-4">
            <Card
              title={selected.name || "Untitled profile"}
              description="Used while this app is in front"
              actions={
                <Button size="sm" variant="danger" onClick={() => void removeSelected()}>
                  <Trash2 size={14} aria-hidden /> Delete
                </Button>
              }
            >
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
                <Field label="Name">
                  <Input value={selected.name} onChange={(e) => updateSelected({ name: e.target.value })} />
                </Field>
                <Field label="App">
                  <div className="flex gap-1.5">
                    <Input
                      className="flex-1"
                      value={selected.match.exe}
                      placeholder="KnightOnLine.exe"
                      onChange={(e) => updateSelected({ match: { ...selected.match, exe: e.target.value } })}
                    />
                    <IconButton
                      variant="secondary"
                      label="Use the app in front"
                      onClick={() => updateSelected({ match: { ...selected.match, exe: foreground.exe } })}
                    >
                      <Crosshair size={16} aria-hidden />
                    </IconButton>
                  </div>
                </Field>
                <Field label="Window title contains" hint="Optional">
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
            </Card>

            <Card
              title={
                editKey === null
                  ? "Select a key"
                  : typeof editKey === "number"
                    ? `Key ${editKey}`
                    : MODULE_SLOT_LABELS[editKey]
              }
              description={
                editKey !== null && typeof editKey !== "number"
                  ? `Key grid · Built-in here: ${SLOT_BUILTINS.grid[editKey]}`
                  : undefined
              }
            >
              {editKey === null ? (
                <EmptyState
                  icon={<MousePointerClick size={28} aria-hidden />}
                  title="Pick a key"
                  description="Click a key on the left to choose what it does in this app."
                />
              ) : (
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
                  builtinDesc={typeof editKey !== "number" ? SLOT_BUILTINS.grid[editKey] : undefined}
                  // rotation has no press to double/hold on
                  allowVariants={typeof editKey === "number" || editKey.startsWith("btn-")}
                  fwVersion={hello?.fw}
                  // offer "Go to layer X" only for the layers this device has
                  layerCount={hello?.layer_count ?? 0}
                />
              )}
            </Card>
          </div>
        ) : (
          <Card>
            <EmptyState
              icon={<AppWindow size={28} aria-hidden />}
              title={profiles.length ? "Pick a profile" : "Give an app its own keys"}
              description="Example: key 1 saves in Photoshop but runs your inventory macro in Knight Online."
              action={
                profiles.length ? undefined : (
                  <Button variant="primary" onClick={() => void addProfile()} loading={adding}>
                    <Plus size={14} aria-hidden /> Add profile
                  </Button>
                )
              }
            />
          </Card>
        )}
      </div>
    </div>
  );
}
