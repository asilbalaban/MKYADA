// Shared UI primitives in the Hezk Design System visual language, ported to
// our TS + Tailwind idiom. Every color, radius and weight comes from the theme
// tokens in index.css — no raw palette classes here.
//
// Hezk rules of thumb that these components encode:
// - Cards are flat cream (no border, no shadow); controls are white with a
//   stone-300 hairline, 6px radius; badges 4px; cards 8px.
// - Focus on a control = indigo border + 3px lavender ring (class hz-control).
// - Weights 520 / 560 / 600, never 700. Labels 12px, body 14px, titles 15px.
// - Motion 120–280ms on cubic-bezier(0.2, 0, 0, 1) (Tailwind ease-standard).
// - Height follows --hz-control-h (40px, 28px under data-hz-density="compact").

import {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Info,
  MoreHorizontal,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { ActionIcon } from "./action-icons";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ------------------------------------------------------------------ Button ---

export type ButtonVariant =
  | "default"
  | "secondary"
  | "primary"
  | "danger"
  | "danger-solid"
  | "ghost"
  | "accent"
  | "inverse";
export type ControlSize = "sm" | "md" | "lg";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  // Hezk "secondary": white control with a hairline.
  default:
    "bg-raised border-line-strong text-fg hover:bg-stone-50 active:bg-sunken",
  secondary:
    "bg-raised border-line-strong text-fg hover:bg-stone-50 active:bg-sunken",
  primary:
    "bg-accent border-transparent text-accent-fg hover:bg-accent-dim active:bg-accent-press",
  // Destructive but secondary ("Delete" in a card header) — Hezk danger-soft.
  danger:
    "bg-raised border-line-strong text-danger hover:bg-danger-bg hover:border-danger-line",
  // Destructive confirmation (dialog confirm) — Hezk danger.
  "danger-solid":
    "bg-danger-solid border-transparent text-cream hover:bg-danger active:bg-danger",
  ghost: "bg-transparent border-transparent text-fg hover:bg-hover active:bg-press",
  accent: "bg-lavender border-transparent text-charcoal hover:brightness-95",
  inverse: "bg-inverse border-transparent text-inverse-fg hover:bg-stone-600",
};

const BUTTON_SIZE: Record<ControlSize, string> = {
  sm: "h-control-sm px-3 text-[13px] gap-1.5",
  md: "h-[var(--hz-control-h)] px-[var(--hz-control-px)] text-[length:var(--hz-control-fs)] gap-2",
  lg: "h-12 px-5 text-[15px] gap-2",
};

export function Button({
  variant = "default",
  size = "md",
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
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "hz-control inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control border font-strong leading-none select-none",
        "transition-colors duration-[120ms] ease-standard",
        // Hezk disabled: stone-200 fill, faint text (a busy button keeps its look).
        loading
          ? "cursor-progress"
          : "disabled:cursor-not-allowed disabled:border-transparent disabled:bg-stone-200 disabled:text-fg-disabled",
        variant === "ghost" && !loading && "disabled:bg-transparent",
        BUTTON_SIZE[size],
        BUTTON_VARIANT[variant],
        className,
      )}
      {...props}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

/** Square icon-only button. `label` is required — it becomes the aria-label
 * and the hover title. */
export function IconButton({
  label,
  variant = "ghost",
  size = "md",
  className = "",
  children,
  type = "button",
  ref,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  variant?: "ghost" | "secondary" | "danger";
  size?: ControlSize;
  ref?: Ref<HTMLButtonElement>;
}) {
  const box = {
    sm: "size-control-sm",
    md: "size-[var(--hz-control-h)]",
    lg: "size-12",
  }[size];
  const tone = {
    ghost: "border-transparent bg-transparent text-fg-muted hover:bg-hover hover:text-fg",
    secondary: "border-line-strong bg-raised text-fg hover:bg-stone-50",
    danger: "border-transparent bg-transparent text-fg-muted hover:bg-danger-bg hover:text-danger",
  }[variant];
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "hz-control inline-flex shrink-0 items-center justify-center rounded-control border p-0",
        "transition-colors duration-[120ms] ease-standard",
        "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-fg-disabled",
        box,
        tone,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// -------------------------------------------------------------------- Card ---

/** Flat cream card (Hezk Card). With a title or actions it gets a header row
 * separated by a hairline; the body carries the padding. `tone="white"` for a
 * raised card on a cream area. */
export function Card({
  title,
  description,
  children,
  className = "",
  bodyClassName = "",
  actions,
  tone = "cream",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  actions?: ReactNode;
  tone?: "cream" | "white";
}) {
  return (
    <section
      className={cx(
        "min-w-0 rounded-card text-fg",
        tone === "white" ? "bg-raised" : "bg-panel",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className="m-0 text-title font-semibold tracking-normal text-fg">{title}</h2>}
            {description && <p className="text-label text-fg-faint">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

// ------------------------------------------------------------ Input/Select ---

const CONTROL =
  "hz-control h-[var(--hz-control-h)] min-w-0 rounded-control border border-line-strong bg-raised px-[var(--hz-input-px)] text-[length:var(--hz-control-fs)] text-fg outline-none " +
  "transition-[border-color,box-shadow] duration-[120ms] ease-standard placeholder:text-fg-disabled " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-fg-faint [&[readonly]]:bg-stone-50";

export function Input({ invalid, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      aria-invalid={invalid || undefined}
      {...props}
      className={cx(CONTROL, invalid && "border-danger-solid", props.className)}
    />
  );
}

/** Multi-line text input with the same control look. */
export function Textarea({
  invalid,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      {...props}
      className={cx(
        CONTROL,
        "h-auto min-h-20 py-2.5 leading-relaxed",
        invalid && "border-danger-solid",
        props.className,
      )}
    />
  );
}

// Chevron for the native select, drawn in stone-500.
const SELECT_CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2377736B' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        backgroundImage: SELECT_CHEVRON,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
        backgroundSize: "16px",
        ...props.style,
      }}
      className={cx(CONTROL, "cursor-pointer appearance-none pr-9", props.className)}
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
  size = "md",
}: {
  value: V;
  options: IconOption<V>[];
  onChange: (v: V) => void;
  className?: string;
  ariaLabel?: string;
  /** "lg" is the headline picker (the Keys page's action type): a bigger
   * chip, title-size label and the option's hint under it. */
  size?: "md" | "lg";
}) {
  const [open, setOpen] = useState(false);
  const lg = size === "lg";
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
        className={cx(
          "hz-control flex w-full items-center rounded-control border bg-raised text-fg outline-none",
          lg ? "gap-3 py-1.5 pl-1.5 pr-4 text-title" : "gap-2.5 py-1 pl-1 pr-3 text-sm",
          "transition-[border-color,box-shadow] duration-[120ms] ease-standard",
          open ? "border-accent shadow-ring" : "border-line-strong",
        )}
      >
        <ActionIcon name={current?.icon} size={lg ? ICON_OPTION : ICON_TRIGGER} />
        <span className="flex min-w-0 flex-col text-left">
          <span className={cx("truncate", lg && "font-strong")}>{current?.label}</span>
          {lg && (current?.hint ?? current?.group) && (
            <span className="truncate text-label text-fg-faint">{current?.hint ?? current?.group}</span>
          )}
        </span>
        <ChevronDown size={lg ? 18 : 16} aria-hidden className="ml-auto shrink-0 text-fg-faint" />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-30 mt-1 max-h-72 w-full min-w-max overflow-auto rounded-card bg-raised p-1.5 shadow-float ring-1 ring-line animate-[hz-fade-in_120ms_cubic-bezier(0.2,0,0,1)]"
        >
          {options.map((o, i) => {
            const sel = o.value === value;
            const newGroup = o.group && o.group !== options[i - 1]?.group;
            return (
              <li key={o.value} role="option" aria-selected={sel}>
                {newGroup && (
                  <div
                    role="presentation"
                    className="px-2 pb-1 pt-2.5 text-label font-medium tracking-label text-fg-faint [font-stretch:90%]"
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
                  className={cx(
                    "flex w-full items-center gap-2.5 rounded-control px-1.5 py-1 text-left text-sm transition-colors",
                    sel ? "bg-selected text-accent-ink" : "text-fg hover:bg-hover",
                  )}
                >
                  <ActionIcon name={o.icon} size={ICON_OPTION} />
                  <span className="flex min-w-0 flex-col">
                    <span className={cx("truncate", sel && "font-strong")}>{o.label}</span>
                    {o.hint && <span className="text-xs text-fg-faint">{o.hint}</span>}
                  </span>
                  {sel && <Check size={16} aria-hidden className="ml-auto shrink-0 pl-2 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- Badge ---

export type BadgeTone =
  | "default"
  | "green"
  | "amber"
  | "red"
  | "blue"
  | "accent"
  | "solid"
  | "dark";

/** Hezk Badge: 22px, 4px radius, 12px label type, tint + ink, no border.
 * `blue` is the brand (indigo) tint. `dot` prefixes a small status dot. */
export function Badge({
  children,
  tone = "default",
  dot = false,
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
}) {
  const styles = {
    default: "bg-sunken text-fg-muted",
    green: "bg-success-bg text-success",
    amber: "bg-warning-bg text-warning",
    red: "bg-danger-bg text-danger",
    blue: "bg-selected text-accent-ink",
    accent: "bg-lavender text-night",
    solid: "bg-accent text-accent-fg",
    dark: "bg-inverse text-inverse-fg",
  }[tone];
  return (
    <span
      className={cx(
        "inline-flex h-[22px] max-w-full items-center gap-1.5 whitespace-nowrap rounded-badge px-2 text-label font-strong tracking-label tabular-nums [font-stretch:90%]",
        styles,
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

// ------------------------------------------------------------------- Field ---

const LABEL = "text-label font-medium tracking-label text-fg [font-stretch:90%]";

/** Hezk Field: label (12px) over the control, optional hint or error below. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className={LABEL}>{label}</span>
      {children}
      {error ? (
        <span className="text-label text-danger">{error}</span>
      ) : hint ? (
        <span className="text-label text-fg-faint">{hint}</span>
      ) : null}
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
export function ControlField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className={LABEL}>{label}</span>
      {children}
      {hint && <span className="text-label text-fg-faint">{hint}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ Switch ---

/** Hezk Switch: 38×22 pill, indigo when on. A real role="switch" button, so
 * Space/Enter toggle it. Pass `label` for a visible label to its right, or
 * `aria-label` when the label lives elsewhere (e.g. a {@link SettingRow}). */
export function Switch({
  checked,
  onChange,
  disabled = false,
  loading = false,
  label,
  className = "",
  ...aria
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  label?: ReactNode;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  id?: string;
}) {
  const off = disabled || loading;
  const track = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={loading || undefined}
      disabled={off}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-[180ms] ease-standard",
        "focus-visible:shadow-ring focus-visible:outline-none",
        checked ? "bg-accent" : "bg-stone-300",
        off ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        !label && className,
      )}
      {...aria}
    >
      <span
        aria-hidden
        className={cx(
          "absolute left-0.5 top-0.5 flex size-[18px] items-center justify-center rounded-full bg-raised shadow-sm transition-transform duration-[180ms] ease-standard",
          checked && "translate-x-4",
        )}
      >
        {loading && <Spinner size={10} className="text-fg-faint" />}
      </span>
    </button>
  );
  if (!label) return track;
  return (
    <label
      className={cx(
        "inline-flex items-center gap-2.5 text-sm text-fg",
        off ? "cursor-not-allowed text-fg-disabled" : "cursor-pointer",
        className,
      )}
    >
      {track}
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- Checkbox ---

/** Native checkbox in brand color with its label (Hezk Checkbox). */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cx(
        "inline-flex items-start gap-2.5 text-sm",
        disabled ? "cursor-not-allowed text-fg-disabled" : "cursor-pointer text-fg",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-[inherit]"
      />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {description && <span className="text-label text-fg-faint">{description}</span>}
      </span>
    </label>
  );
}

// -------------------------------------------------------- SegmentedControl ---

export type SegmentOption<V extends string> = {
  value: V;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
  title?: string;
};

/** Hezk SegmentedControl: stone rail, the chosen segment is a white chip.
 * One-of-N choice with few options (2–5). Arrow keys move the choice. */
export function SegmentedControl<V extends string>({
  value,
  options,
  onChange,
  size = "md",
  ariaLabel,
  className = "",
}: {
  value: V;
  options: SegmentOption<V>[];
  onChange: (v: V) => void;
  size?: "sm" | "md";
  ariaLabel: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function step(from: number, delta: number) {
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const j = (from + delta * k + n) % n;
      if (!options[j].disabled) {
        onChange(options[j].value);
        refs.current[j]?.focus();
        return;
      }
    }
  }
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx("inline-flex max-w-full gap-0.5 overflow-x-auto rounded-card bg-sunken p-[3px]", className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                step(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                step(i, -1);
              }
            }}
            className={cx(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 transition-colors duration-[120ms] ease-standard",
              size === "sm" ? "h-7 text-xs" : "h-[34px] text-[13px]",
              on
                ? "bg-raised font-strong text-fg shadow-sm"
                : "text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:text-fg-disabled",
            )}
          >
            {Icon && <Icon size={15} aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- Tooltip ---

/** Hover/focus tooltip (Hezk Tooltip: charcoal chip, cream 12px text). Pure
 * CSS, so it needs no portal; keep the content short. */
export function Tooltip({
  content,
  children,
  side = "top",
  className = "",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}) {
  return (
    <span className={cx("group/tt relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cx(
          "pointer-events-none absolute left-1/2 z-40 w-max max-w-64 -translate-x-1/2 rounded-control bg-inverse px-2 py-1 text-label leading-snug text-inverse-fg opacity-0 shadow-float",
          "transition-opacity duration-[120ms] ease-standard group-hover/tt:opacity-100 group-hover/tt:delay-300 group-focus-within/tt:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {content}
      </span>
    </span>
  );
}

// ------------------------------------------------------------ OverflowMenu ---

export type MenuItem = {
  label: string;
  icon?: ReactNode;
  /** Second line under the label: what the item does, or why it's disabled. */
  hint?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
};

/** "More actions" button (IconButton + MoreHorizontal) that opens a small
 * popover menu anchored under its right edge. Closes on pick, Escape, or a
 * click outside; arrow keys move between items. */
export function OverflowMenu({
  items,
  label = "More actions",
  size = "sm",
  variant = "secondary",
}: {
  items: MenuItem[];
  label?: string;
  size?: ControlSize;
  variant?: "ghost" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    // land on the first enabled item so the keyboard can go straight on
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
    els[next].focus();
  }

  return (
    <div ref={wrap} className="relative inline-flex">
      <IconButton
        ref={trigger}
        label={label}
        size={size}
        variant={variant}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={16} aria-hidden />
      </IconButton>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-40 mt-1.5 flex w-72 flex-col gap-px rounded-card border border-line bg-raised p-1 shadow-float animate-[hz-fade-in_120ms_var(--ease-standard)]"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cx(
                "flex w-full items-start gap-2.5 rounded-control px-2.5 py-2 text-left outline-none",
                "transition-colors duration-[120ms] ease-standard",
                "hover:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed disabled:hover:bg-transparent",
              )}
            >
              {it.icon && (
                <span className={cx("mt-0.5 flex shrink-0", it.disabled ? "text-fg-disabled" : "text-fg-muted")}>
                  {it.icon}
                </span>
              )}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cx("text-[13px] font-strong", it.disabled ? "text-fg-disabled" : "text-fg")}>
                  {it.label}
                </span>
                {it.hint && <span className="text-label leading-snug text-fg-faint">{it.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- Alert ---

export type AlertTone = "info" | "success" | "warning" | "danger";

const ALERT_TONE: Record<AlertTone, { box: string; ink: string; icon: LucideIcon }> = {
  info: { box: "bg-info-bg", ink: "text-info", icon: Info },
  success: { box: "bg-success-bg", ink: "text-success", icon: CheckCircle2 },
  warning: { box: "bg-warning-bg", ink: "text-warning", icon: AlertTriangle },
  danger: { box: "bg-danger-bg", ink: "text-danger", icon: XCircle },
};

/** Inline notice (Hezk Alert): tinted box, colored icon, title + text, actions
 * on the right. `icon` replaces the tone's default glyph (e.g. a Spinner). */
export function Alert({
  tone = "info",
  title,
  children,
  icon,
  actions,
  className = "",
  role,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  const t = ALERT_TONE[tone];
  const Icon = t.icon;
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cx("flex items-start gap-3 rounded-card px-4 py-3 text-sm leading-snug", t.box, className)}
    >
      <span className={cx("mt-px flex shrink-0", t.ink)}>{icon ?? <Icon size={18} aria-hidden />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <p className="font-semibold text-fg">{title}</p>}
        {children && <div className="text-fg-muted">{children}</div>}
      </div>
      {actions && <div className="-my-1 flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------- ProgressBar ---

/** Hezk ProgressBar: 6px pill track, indigo fill. `value` 0..max. */
export function ProgressBar({
  value,
  max = 100,
  className = "",
  label,
}: {
  value: number;
  max?: number;
  className?: string;
  label?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cx("h-1.5 overflow-hidden rounded-full bg-sunken", className)}
    >
      <span
        className="block h-full rounded-full bg-accent transition-[width] duration-[280ms] ease-standard"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// -------------------------------------------------------------- SettingRow ---

/** A setting: title + one-line explanation on the left, its control on the
 * right. Rows stack inside a Card with hairlines between them. */
export function SettingRow({
  title,
  description,
  control,
  icon: Icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 gap-3">
        {Icon && <Icon size={18} aria-hidden className="mt-px shrink-0 text-fg-faint" />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-strong text-fg">{title}</span>
          {description && <span className="text-[13px] leading-snug text-fg-faint">{description}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

// ----------------------------------------------------------------- Spinner ---

/** Hezk Loader: a 2px ring in currentColor with a gap. */
export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Loading"
      className={cx(
        "inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent [animation-duration:800ms]",
        className,
      )}
      style={{ width: size, height: size, borderWidth: size <= 12 ? 1.5 : 2 }}
    />
  );
}

// -------------------------------------------------------------- EmptyState ---

/** Friendly empty/guard state (Hezk EmptyState) with an optional action. */
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
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon && (
        <div className="mb-1 flex size-14 items-center justify-center rounded-[12px] bg-selected text-accent">
          {icon}
        </div>
      )}
      <p className="text-[17px] font-strong text-fg">{title}</p>
      {description && (
        <p className="max-w-sm text-sm leading-normal text-fg-faint [text-wrap:pretty]">{description}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// -------------------------------------------------------------------- Tabs ---

export type Tab = {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Small state marker after the label (a dot, "Off", a count). */
  badge?: ReactNode;
};

/**
 * A page split into sections: a Hezk underline tab row over the active
 * section's panel. Shared by Settings and Setup — both are long pages whose
 * cards fall into groups, and scrolling past everything to reach one card is
 * the thing this replaces. `idPrefix` namespaces the ARIA ids
 * (`<prefix>-tab-<id>` for the tab, `<prefix>-<id>` for its panel).
 */
export function Tabs({
  idPrefix,
  label,
  tabs,
  value,
  onChange,
  children,
  size = "md",
}: {
  idPrefix: string;
  label: string;
  tabs: readonly Tab[];
  value: string;
  onChange: (id: string) => void;
  children: ReactNode;
  /** "sm": tighter row for tabs inside a card (the key editor). */
  size?: "md" | "sm";
}) {
  const sm = size === "sm";
  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        className={cx("flex overflow-x-auto border-b border-line", sm ? "gap-4" : "gap-6")}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const i = tabs.findIndex((t) => t.id === value);
          const n = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
          onChange(n.id);
          document.getElementById(`${idPrefix}-tab-${n.id}`)?.focus();
        }}
      >
        {tabs.map((t) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`${idPrefix}-${t.id}`}
              id={`${idPrefix}-tab-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cx(
                "-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 transition-colors duration-[120ms] ease-standard",
                sm ? "h-10 text-[13px]" : "h-11 text-sm",
                on
                  ? "border-accent font-semibold text-fg"
                  : "border-transparent text-fg-faint hover:text-fg",
              )}
            >
              {t.icon && <t.icon size={16} aria-hidden className={on ? "text-accent" : ""} />}
              {t.label}
              {t.badge}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${idPrefix}-${value}`}
        aria-labelledby={`${idPrefix}-tab-${value}`}
        className="flex flex-col gap-4"
      >
        {children}
      </div>
    </>
  );
}

// ----------------------------------------------------------------- Stepper ---

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
    <ol className="flex flex-wrap items-center gap-y-2" aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const clickable = done && onStepClick;
        return (
          <li key={label} className="flex items-center">
            {i > 0 && <span aria-hidden className={cx("mx-3 h-px w-6", done || active ? "bg-accent" : "bg-line-strong")} />}
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onStepClick(i)}
              aria-current={active ? "step" : undefined}
              className={cx(
                "flex items-center gap-2 rounded-control text-[13px] disabled:cursor-default",
                clickable && "cursor-pointer hover:text-fg",
                active ? "font-semibold text-fg" : done ? "text-fg-muted" : "text-fg-faint",
              )}
            >
              <span
                className={cx(
                  "flex size-6 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
                  active
                    ? "bg-accent text-accent-fg"
                    : done
                      ? "bg-success-bg text-success"
                      : "bg-sunken text-fg-faint",
                )}
              >
                {done ? <Check size={13} strokeWidth={2.5} /> : i + 1}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
