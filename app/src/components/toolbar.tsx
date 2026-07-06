// Illustrator/Photoshop-style toolbar building blocks: every control shows a
// small caption above its icon/field, and related controls sit inside a
// stroked group box so a dense bar stays legible. Shared by the Recorder page
// and the MacroEditor so page- and editor-owned groups look identical.

import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { Input } from "./ui";

/** A bordered cluster of related toolbar controls, with a caption on top. */
export function ToolGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 shrink-0">
      {label ? (
        <span className="text-[9px] uppercase tracking-wider text-fg-faint px-1 leading-none">
          {label}
        </span>
      ) : (
        <span className="h-[9px]" aria-hidden />
      )}
      <div className="flex items-stretch gap-0.5 border border-line rounded-lg p-1 bg-panel2/30">
        {children}
      </div>
    </div>
  );
}

/** Two-line tool button: caption on top, icon below. */
export function ToolButton({
  label,
  icon,
  tone = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: ReactNode;
  tone?: "default" | "primary" | "danger" | "active";
}) {
  const tones = {
    default: "text-fg border-transparent hover:bg-panel2",
    primary: "text-accent border-transparent hover:bg-accent/10",
    danger: "text-danger border-transparent hover:bg-danger-bg",
    active: "text-accent bg-accent/10 border-accent/40",
  }[tone];
  return (
    <button
      {...props}
      className={`h-11 w-12 flex flex-col items-center rounded-md border transition-colors disabled:opacity-40 disabled:pointer-events-none ${tones} ${className}`}
    >
      <span className="h-4 mb-0.5 flex items-center text-[10px] leading-none text-fg-faint">{label}</span>
      <span className="flex-1 flex items-center justify-center">{icon}</span>
    </button>
  );
}

/** Two-line captioned field wrapper: caption on top, control(s) below.
 *  The fixed-height caption row keeps captions aligned across every group.
 *  `align="start"` left-aligns the caption to the control's left edge. */
export function ToolField({
  label,
  align = "center",
  children,
}: {
  label: string;
  align?: "center" | "start";
  children: ReactNode;
}) {
  return (
    <div className={`h-11 flex flex-col px-1 ${align === "start" ? "items-start" : "items-center"}`}>
      <span className="h-4 mb-0.5 flex items-center text-[10px] leading-none text-fg-faint">{label}</span>
      <div className="flex-1 flex items-center gap-1">{children}</div>
    </div>
  );
}

/** A number/text input with a unit tucked inside its right edge (Bootstrap
 *  input-group style). The unit sits in the input's padding and is ignored by
 *  the field's centering, so the caption lines up over the input itself. */
export function ToolUnitInput({
  suffix,
  className = "",
  style,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { suffix: string }) {
  return (
    <div className="relative flex items-center">
      {/* Reserve right padding (inline style beats the base px-2.5) so the
          typed value always stops before the unit label. */}
      <Input {...props} className={className} style={{ paddingRight: "1.5rem", ...style }} />
      <span className="absolute right-2 inset-y-0 flex items-center text-sm text-fg-muted pointer-events-none">
        {suffix}
      </span>
    </div>
  );
}

/** Small inline action button (e.g. the ✓ next to a bulk-edit field). */
export function ToolMini({
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`h-7 w-7 flex items-center justify-center rounded-md border border-line bg-panel2 text-fg hover:border-accent/60 transition-colors ${className}`}
    >
      {children}
    </button>
  );
}
