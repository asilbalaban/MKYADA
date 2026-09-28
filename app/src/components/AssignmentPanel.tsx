// The shared key-action editing block used by BOTH the Keys page and the
// per-app Profiles page: the action editor (what the key does, first), the
// appearance block (display name + screen icon), and the Revert / Save buttons. Keeping it in one component means anything
// added to how a key action is edited shows up in both places automatically
// (issue #23) — the two used to be coded separately and drifted apart.

import type { Assignment } from "../lib/types";
import { assignmentComplete, compileAssignment } from "../lib/macro-model";
import { AssignmentEditor } from "./AssignmentEditor";
import { IconPicker } from "./IconPicker";
import { Button, Field, Input } from "./ui";

export function AssignmentPanel({
  value,
  onChange,
  onSave,
  onRevert,
  dirty,
  saving = false,
  saveLabel = "Save",
  labelOnScreen = false,
  allowMenu = false,
  slotMode = false,
  builtinDesc,
  allowVariants = true,
  fwVersion,
  layerCount = 0,
}: {
  /** Effective assignment being edited (draft ?? current ?? { kind:"none" }). */
  value: Assignment;
  onChange: (a: Assignment) => void;
  onSave: () => void;
  onRevert: () => void;
  /** True while there are unsaved edits — gates Revert/Save. */
  dirty: boolean;
  saving?: boolean;
  /** Label of the primary save button ("Save to keypad" vs "Save"). */
  saveLabel?: string;
  /** Note that the display name also appears on the device's screen (Vision 6). */
  labelOnScreen?: boolean;
  // --- passthrough to AssignmentEditor ---
  allowMenu?: boolean;
  slotMode?: boolean;
  builtinDesc?: string;
  allowVariants?: boolean;
  fwVersion?: string;
  layerCount?: number;
}) {
  const showLabel = !["none", "nothing"].includes(value.kind);
  const autoName = compileAssignment({ ...value, label: undefined })?.name;
  const nameField = (
    <Field label="Display name" hint="Leave empty to use the automatic name.">
      <Input
        value={value.label ?? ""}
        placeholder={autoName ?? "Automatic"}
        maxLength={40}
        onChange={(e) => onChange({ ...value, label: e.target.value || undefined })}
      />
    </Field>
  );
  // Name + icon are how the key is *labelled* — the editor gives them their
  // own Appearance tab. On a screen model the icon picker frames the name
  // beside the real cell preview.
  const appearance = showLabel ? (
    <div className="flex flex-col gap-3">
      <p className="text-label text-fg-faint">
        How this {slotMode ? "control" : "key"} is labelled
        {labelOnScreen ? " on the keypad's screen and in the app" : " in the app"}
      </p>
      {labelOnScreen ? (
        <IconPicker
          value={value.icon}
          onChange={(icon) => onChange({ ...value, icon })}
          assignment={value}
          name={value.label?.trim() || autoName || "Key"}
          fwVersion={fwVersion}
          leading={nameField}
        />
      ) : (
        <div className="max-w-sm">{nameField}</div>
      )}
    </div>
  ) : null;
  return (
    <div className="flex flex-col gap-4">
      <AssignmentEditor
        value={value}
        onChange={onChange}
        allowMenu={allowMenu}
        slotMode={slotMode}
        builtinDesc={builtinDesc}
        allowVariants={allowVariants}
        fwVersion={fwVersion}
        layerCount={layerCount}
        appearance={appearance}
      />
      {/* Sticky: Save/Revert stay reachable on every tab and however long the
        * editor gets (the page scrolls in <main>). */}
      <div className="sticky bottom-0 z-10 -mb-5 flex items-center justify-end gap-2 border-t border-line bg-panel pb-5 pt-4">
        {dirty && <span className="mr-auto text-label text-fg-faint">Unsaved changes</span>}
        <Button onClick={onRevert} disabled={!dirty}>
          Revert
        </Button>
        <Button
          variant="primary"
          onClick={onSave}
          disabled={!dirty || !assignmentComplete(value)}
          loading={saving}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
