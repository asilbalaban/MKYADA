// Undo/redo for editor state: a bounded past/present/future stack behind a
// useState-like API. Destructive editor operations (RDP simplify, resample,
// bulk delete…) become one history entry each, so Ctrl+Z always steps back
// exactly one user action.

import { useCallback, useRef, useState } from "react";

const LIMIT = 100;

export interface History<T> {
  present: T;
  canUndo: boolean;
  canRedo: boolean;
  /** Push a new state (one undo step). */
  set: (next: T) => void;
  undo: () => void;
  redo: () => void;
  /** Replace everything — for loading a new document. Clears both stacks. */
  reset: (next: T) => void;
}

export function useHistory<T>(initial: T): History<T> {
  const [present, setPresent] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  // present lives in a ref too so set/undo/redo callbacks stay stable
  const current = useRef<T>(initial);

  const set = useCallback((next: T) => {
    if (Object.is(next, current.current)) return;
    past.current.push(current.current);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    current.current = next;
    setPresent(next);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(current.current);
    current.current = prev;
    setPresent(prev);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(current.current);
    current.current = next;
    setPresent(next);
  }, []);

  const reset = useCallback((next: T) => {
    past.current = [];
    future.current = [];
    current.current = next;
    setPresent(next);
  }, []);

  return {
    present,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    set,
    undo,
    redo,
    reset,
  };
}

/** True when a keydown is the platform's undo (⌘Z / Ctrl+Z) or redo
 * (⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y) chord, unless typing in a text field —
 * inputs keep their native text undo. */
export function undoRedoFromEvent(e: KeyboardEvent): "undo" | "redo" | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return null;
}
