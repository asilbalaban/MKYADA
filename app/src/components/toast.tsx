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

const KIND_STYLE: Record<ToastKind, { border: string; icon: ReactNode }> = {
  success: { border: "border-success-line", icon: <CheckCircle2 size={18} className="text-success shrink-0" /> },
  error: { border: "border-danger-line", icon: <XCircle size={18} className="text-danger shrink-0" /> },
  info: { border: "border-info-line", icon: <Info size={18} className="text-info shrink-0" /> },
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
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const s = KIND_STYLE[t.kind];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2.5 bg-panel border ${s.border} rounded-lg shadow-lg px-3 py-2.5`}
            >
              {s.icon}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-fg font-medium">{t.title}</p>
                {t.detail && (
                  <p className="text-xs text-fg-muted mt-0.5 break-words whitespace-pre-line">{t.detail}</p>
                )}
              </div>
              <button
                aria-label="Dismiss"
                className="text-fg-faint hover:text-fg shrink-0"
                onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
