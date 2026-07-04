// Small shared UI primitives (dark theme, Tailwind).

import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost" }) {
  const styles = {
    default: "bg-panel2 border border-line hover:border-accent/60",
    primary: "bg-accent-dim hover:bg-accent text-black font-semibold border border-transparent",
    danger: "bg-red-900/40 border border-red-700 hover:bg-red-900/70",
    ghost: "border border-transparent hover:bg-panel2",
  }[variant];
  return (
    <button
      className={`px-3 py-1.5 rounded-md text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none ${styles} ${className}`}
      {...props}
    />
  );
}

export function Card({ title, children, className = "", actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <div className={`bg-panel border border-line rounded-xl p-4 ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold tracking-wide text-slate-300">{title}</h2>
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
      className={`bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`bg-panel2 border border-line rounded-md px-2.5 py-1.5 text-sm outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "green" | "amber" | "red" | "blue" }) {
  const styles = {
    default: "bg-panel2 text-slate-300 border-line",
    green: "bg-green-900/40 text-green-300 border-green-800",
    amber: "bg-amber-900/40 text-amber-300 border-amber-800",
    red: "bg-red-900/40 text-red-300 border-red-800",
    blue: "bg-sky-900/40 text-sky-300 border-sky-800",
  }[tone];
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${styles}`}>{children}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-400 text-xs">{label}</span>
      {children}
    </label>
  );
}
