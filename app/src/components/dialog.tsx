// In-app confirmation dialog — replaces the native ask() popup.
// Promise-style API so call sites stay one-liners:
//   const ok = await confirm({ title, message, confirmLabel });

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./ui";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm outside <ConfirmProvider>");
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  function close(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog opts={pending} onClose={close} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  opts,
  onClose,
}: {
  opts: ConfirmOptions;
  onClose: (ok: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    // Enter is handled natively by whichever button has focus (confirm by
    // default) — a window-level Enter handler would override a focused Cancel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={opts.title}
        className="bg-panel border border-line rounded-xl shadow-2xl w-[26rem] max-w-[90vw] p-5 flex flex-col gap-3"
      >
        <h2 className="text-base font-semibold text-fg">{opts.title}</h2>
        <p className="text-sm text-fg-muted whitespace-pre-line leading-relaxed">{opts.message}</p>
        <div className="flex justify-end gap-2 mt-2">
          <Button onClick={() => onClose(false)}>{opts.cancelLabel ?? "Cancel"}</Button>
          <Button
            ref={confirmRef}
            variant={opts.danger ? "danger" : "primary"}
            onClick={() => onClose(true)}
          >
            {opts.confirmLabel ?? "OK"}
          </Button>
        </div>
      </div>
    </div>
  );
}
