// Small shared UI primitives. Colors come from the semantic theme tokens in
// index.css (light/dark aware) — no raw palette classes here.

import {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { ActionIcon } from "./action-icons";

export function Button({
  variant = "default",
  className = "",
  loading = false,
  disabled,
  children,
  ref,
  // Default to a plain button, never a form-submit. An implicit type="submit"
  // made in-form action buttons (e.g. the webhook "remove header" trash) submit
  // the surrounding form on click — reverting the edit so the row appeared
  // undeletable. Callers that want a submit button pass type explicitly.
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const styles = {
    default: "bg-panel2 border border-line hover:border-accent/60 text-fg",
    primary: "bg-accent-dim hover:bg-accent text-accent-fg font-semibold border border-transparent",
    danger: "bg-danger-bg border border-danger-line text-danger hover:brightness-110",
    ghost: "border border-transparent hover:bg-panel2 text-fg",
  }[variant];
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none ${styles} ${className}`}
      {...props}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

export function Card({
  title,
  children,
  className = "",
  actions,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <div className={`bg-panel border border-line rounded-xl p-4 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold tracking-wide text-fg-muted">{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export type IconOption<V extends string> = {
  value: V;
  label: string;
  /** SVG basename in assets/action-icons; omit for a blank chip slot. */
  icon?: string;
  hint?: string;
  /** Optional group heading; a non-selectable header row is shown above the
   * first option of each new group (options must be pre-sorted by group). */
  group?: string;
};

/**
 * Dropdown that shows an icon beside every option — the native <select>/<option>
 * can't render custom art, so this is a small accessible listbox replacement.
 * Same visual language as <Select>; opens on click or ↓/↑, closes on Escape or
 * outside click.
 */
// Icon chip sizes for the action pickers. A quarter smaller than the sizes we
// shipped first: at 52/60 the artwork was the loudest thing in the row and the
// option list only fitted four entries on screen.
const ICON_TRIGGER = 39;
const ICON_OPTION = 45;

export function IconSelect<V extends string>({
  value,
  options,
  onChange,
  className = "",
  ariaLabel,
}: {
  value: V;
  options: IconOption<V>[];
  onChange: (v: V) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

  function move(delta: number) {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + delta + options.length) % options.length];
    if (next) onChange(next.value);
  }

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            open ? move(1) : setOpen(true);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            open ? move(-1) : setOpen(true);
          } else if ((e.key === "Enter" || e.key === " ") && open) {
            e.preventDefault();
            setOpen(false);
          }
        }}
        className="flex w-full items-center gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-sm text-fg outline-none focus:border-accent"
      >
        <ActionIcon name={current?.icon} size={ICON_TRIGGER} />
        <span className="truncate text-left">{current?.label}</span>
        <ChevronDown size={14} aria-hidden className="ml-auto shrink-0 text-fg-faint" />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-30 mt-1 max-h-72 w-full min-w-max overflow-auto rounded-md border border-line bg-panel p-1 shadow-lg"
        >
          {options.map((o, i) => {
            const sel = o.value === value;
            const newGroup = o.group && o.group !== options[i - 1]?.group;
            return (
              <li key={o.value} role="option" aria-selected={sel}>
                {newGroup && (
                  <div
                    role="presentation"
                    className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-faint"
                  >
                    {o.group}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm transition-colors ${
                    sel ? "bg-accent-dim text-accent-fg" : "text-fg hover:bg-panel2"
                  }`}
                >
                  <ActionIcon name={o.icon} size={ICON_OPTION} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.hint && <span className="text-xs text-fg-faint">{o.hint}</span>}
                  </span>
                  {sel && <Check size={14} aria-hidden className="ml-auto shrink-0 pl-2" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "green" | "amber" | "red" | "blue";
}) {
  const styles = {
    default: "bg-panel2 text-fg-muted border-line",
    green: "bg-success-bg text-success border-success-line",
    amber: "bg-warning-bg text-warning border-warning-line",
    red: "bg-danger-bg text-danger border-danger-line",
    blue: "bg-info-bg text-info border-info-line",
  }[tone];
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${styles}`}>
      {children}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-fg-muted text-xs">{label}</span>
      {children}
    </label>
  );
}

/**
 * Like {@link Field} but a plain <div> instead of a <label>. Use this for custom
 * controls such as {@link IconSelect} that carry their own aria-label and manage
 * their own popup: a wrapping <label> hijacks clicks inside the popup (the label
 * forwards activation to its associated control), which swallows the selection
 * and leaves the dropdown open. Native inputs keep {@link Field} for its label
 * association; custom listboxes must use this.
 */
export function ControlField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-fg-muted text-xs">{label}</span>
      {children}
    </div>
  );
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <LoaderCircle size={size} className={`animate-spin ${className}`} aria-label="Loading" />
  );
}

/** Friendly empty/guard state with an optional action button. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 py-12 px-6">
      {icon && <div className="text-fg-faint mb-1">{icon}</div>}
      <p className="text-fg font-medium">{title}</p>
      {description && <p className="text-sm text-fg-muted max-w-sm">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Wizard progress: numbered circles, check marks for done, past steps clickable. */
export function Stepper({
  steps,
  current,
  onStepClick,
}: {
  steps: string[];
  current: number;
  onStepClick?: (i: number) => void;
}) {
  return (
    <ol className="flex items-center gap-0" aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const clickable = done && onStepClick;
        return (
          <li key={label} className="flex items-center">
            {i > 0 && <span className={`w-8 h-px mx-2 ${done || active ? "bg-accent" : "bg-line"}`} />}
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onStepClick(i)}
              aria-current={active ? "step" : undefined}
              className={`flex items-center gap-2 text-xs disabled:cursor-default ${
                clickable ? "cursor-pointer hover:text-fg" : ""
              } ${active ? "text-fg font-semibold" : done ? "text-fg-muted" : "text-fg-faint"}`}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center border text-[11px] font-semibold ${
                  active
                    ? "bg-accent-dim text-accent-fg border-transparent"
                    : done
                      ? "bg-success-bg text-success border-success-line"
                      : "bg-panel2 border-line"
                }`}
              >
                {done ? <Check size={13} /> : i + 1}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
