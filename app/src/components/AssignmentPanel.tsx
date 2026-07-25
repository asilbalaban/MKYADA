// The shared key-action editing block used by BOTH the Keys page and the
// per-app Profiles page: the action editor, the optional display-name field,
// and the Revert / Save buttons. Keeping it in one component means anything
// added to how a key action is edited shows up in both places automatically
// (issue #23) — the two used to be coded separately and drifted apart.

import type { Assignment } from "../lib/types";
import { assignmentComplete, compileAssignment } from "../lib/macro-model";
import { AssignmentEditor } from "./AssignmentEditor";
import { Button, Input } from "./ui";

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
      />
      {showLabel && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-fg-muted">
            Display name{labelOnScreen ? " — shown on the keypad's screen" : ""}
          </span>
          <Input
            value={value.label ?? ""}
            placeholder={compileAssignment({ ...value, label: undefined })?.name ?? "Automatic"}
            maxLength={40}
            onChange={(e) => onChange({ ...value, label: e.target.value || undefined })}
          />
          <span className="text-[11px] text-fg-faint">Leave empty to use the automatic name.</span>
        </label>
      )}
      <div className="flex justify-end gap-2">
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
