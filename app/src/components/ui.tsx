// Small shared UI primitives. Colors come from the semantic theme tokens in
// index.css (light/dark aware) — no raw palette classes here.

import {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from "react";
import { Check, LoaderCircle } from "lucide-react";

export function Button({
  variant = "default",
  className = "",
  loading = false,
  disabled,
  children,
  ref,
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
