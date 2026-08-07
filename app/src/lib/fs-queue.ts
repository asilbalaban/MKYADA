// Two-priority gate in front of the drive ops (issue #44).
//
// The Rust side runs ONE fs op at a time behind a global mutex (the wire
// protocol has no request ids), so during the connect-time background load a
// user-initiated read — Setup opening config.json, a key save, a backup —
// used to queue behind up to ~90 macro reads and feel like a hang.
//
// Every ipc.drive* call now passes through this gate: UI-initiated ops are
// high priority, the background keys loader is low. The loader yields between
// files, so the worst case for the UI drops from "the rest of the load" to
// "the one file currently in flight". Ordering within a priority is FIFO.
//
// No re-entrancy: a queued job must never await another queued job from
// inside itself (that would deadlock the single active slot). All callers
// sequence their drive ops with await at the call site, which keeps every
// job a single Rust invoke.

type Priority = "ui" | "bg";

interface Job {
  run: () => void;
}

const queues: Record<Priority, Job[]> = { ui: [], bg: [] };
let active = false;

function pump(): void {
  if (active) return;
  const job = queues.ui.shift() ?? queues.bg.shift();
  if (!job) return;
  active = true;
  job.run();
}

/** Run `fn` when the drive link is free, UI ops before background ones. */
export function fsEnqueue<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[priority].push({
      run: () => {
        fn().then(resolve, reject).finally(() => {
          active = false;
          pump();
        });
      },
    });
    pump();
  });
}
