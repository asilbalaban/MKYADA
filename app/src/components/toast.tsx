// In-app toast notifications — replaces blocking native message() dialogs.
// Stacked bottom-right, auto-dismissing, announced to screen readers.

import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastApi {
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast outside <ToastProvider>");
  return api;
}

// Hezk Toast: charcoal chip, cream text, the kind shows only in the icon.
const KIND_ICON: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 size={18} aria-hidden className="text-success-on-dark shrink-0" />,
  error: <XCircle size={18} aria-hidden className="text-danger-on-dark shrink-0" />,
  info: <Info size={18} aria-hidden className="text-lavender shrink-0" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastKind, title: string, detail?: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, kind, title, detail }]);
    // errors linger a bit longer so the detail can be read
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4000);
  }, []);

  const api: ToastApi = {
    success: useCallback((t: string, d?: string) => push("success", t, d), [push]),
    error: useCallback((t: string, d?: string) => push("error", t, d), [push]),
    info: useCallback((t: string, d?: string) => push("info", t, d), [push]),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 w-[min(400px,calc(100vw-32px))] pointer-events-none"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full items-start gap-3 rounded-card bg-inverse py-3 pl-4 pr-2 text-inverse-fg shadow-overlay animate-[hz-fade-in_180ms_cubic-bezier(0.2,0,0,1)]"
          >
            <span className="mt-px">{KIND_ICON[t.kind]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-strong">{t.title}</p>
              {t.detail && (
                <p className="mt-0.5 whitespace-pre-line break-words text-[13px] leading-snug text-inverse-muted">
                  {t.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="-my-0.5 flex size-6 shrink-0 items-center justify-center rounded-badge text-inverse-muted transition-colors hover:bg-inverse-line hover:text-inverse-fg"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
