// Control: the app's home page. Every key on the keypad as a big tile you can
// run with a click, exactly like pressing it — built for people who reach the
// keypad's computer over Chrome Remote Desktop and can't touch the keys. The
// tile that is playing turns into its own Stop; the global PlaybackBar above
// the page stays the loud "something is running" strip.

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Ban,
  Check,
  CirclePlay,
  Keyboard,
  Layers,
  MonitorSmartphone,
  Pause,
  Play,
  Repeat,
  Square,
  SlidersHorizontal,
} from "lucide-react";
import { useDevice, type DeviceStatus } from "../lib/device";
import { usePlayback } from "../lib/playback-context";
import { accelParts, type PressGesture } from "../lib/playback";
import { useProfiles } from "../lib/profiles";
import { sequenceRuns } from "../lib/remote-actions";
import { keysCache, slotKey } from "../lib/keys-cache";
import { deviceName, displayName, onDevnamesChanged } from "../lib/devnames";
import { describeAssignment, effectiveLayers } from "../lib/macro-model";
import { kindMeta } from "../lib/kind-registry";
import { isMacPlatform, useStopHotkey } from "../lib/stop-hotkey";
import { useNav } from "../lib/nav";
import { LAYER_NAMES, MODEL_META, deviceModel, layerLabel } from "../lib/types";
import type { Assignment, DeviceConfig, Hello } from "../lib/types";
import { ActionIcon } from "../components/action-icons";
import { useToast } from "../components/toast";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  SegmentedControl,
  Spinner,
  Tooltip,
} from "../components/ui";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/** Vision 6 keys whose press opens a menu on the keypad's screen — the
 * firmware answers a remote press with `err unsupported` (ui.py
 * PRESS_MENU_KINDS). */
const MENU_KINDS = new Set<Assignment["kind"]>(["volume", "mic_level", "obs_center", "enc_module"]);

/** Short plays finish before a disabled look would even be readable — only
 * treat a play as "occupying the keypad" once it loops or lasts. */
const SETTLE_MS = 700;

const GESTURE_TEXT: Record<Exclude<PressGesture, "tap">, string> = {
  double: "Double press",
  hold: "Long press",
};

// ------------------------------------------------------------------ data ---

/** The shared keys snapshot for the connected keypad, kept live. */
function useKeysSnapshot(drivePath: string | undefined) {
  const [, setVersion] = useState(0);
  // The cache mutates snapshots in place, so a version bump re-renders us.
  useEffect(() => keysCache.onChange(() => setVersion((v) => v + 1)), []);
  return drivePath ? keysCache.get(drivePath) : undefined;
}

type TileState =
  | { run: true }
  | { run: false; reason: string; short: string; loading?: boolean };

/** Whether a key can be pressed from here, and if not, why. */
function tileState(
  a: Assignment | undefined,
  {
    vision6,
    loading,
    canPress,
    pressReason,
  }: { vision6: boolean; loading: boolean; canPress: boolean; pressReason: string | null },
): TileState {
  if (!a || a.kind === "none") {
    if (loading) return { run: false, reason: "Still loading from the keypad", short: "Loading…", loading: true };
    return { run: false, reason: "Nothing is assigned to this key", short: "Not assigned" };
  }
  if (!canPress) return { run: false, reason: pressReason ?? "Can't press keys right now", short: "Needs a firmware update" };
  const hasVariants = !!(a.variants?.double || a.variants?.hold);
  if (vision6 && MENU_KINDS.has(a.kind) && !hasVariants) {
    return {
      run: false,
      reason: "This key opens a menu on the keypad's screen, so it only works on the keypad itself",
      short: "Opens a keypad menu",
    };
  }
  if (!hasVariants && a.kind === "mic" && a.mode === "push_to_talk") {
    return { run: false, reason: "Push-to-talk needs the key held down on the keypad", short: "Hold on the keypad" };
  }
  // Computer-side kinds and multi actions run in the app when the keypad
  // reports the remote press (profiles.tsx · remote-actions.ts).
  return { run: true };
}

/** describeAssignment without its leading glyph ("▶ ", "↗ ", "$ " …): the
 * tile already shows the kind's icon. */
function describe(a: Assignment): string {
  return describeAssignment(a).replace(/^(?:▶|↗|\$|♪|🎤|⇄|◉|◎|⧉)\s+/u, "");
}

/** Kind label + the auto description when the user gave the key a name. */
function secondaryText(a: Assignment): string {
  const kind = kindMeta(a.kind).label;
  if (!a.label?.trim()) return kind;
  const auto = describe({ ...a, label: undefined });
  return auto && auto !== a.label.trim() ? `${kind} · ${auto}` : kind;
}

const STATUS_TEXT: Record<DeviceStatus, string> = {
  disconnected: "Not connected",
  connected: "Connected",
  busy: "Connected · macro playing",
  transfer: "Transferring data…",
  reloading: "Reloading…",
  unresponsive: "Not responding",
};

const STATUS_DOT: Record<DeviceStatus, string> = {
  disconnected: "bg-stone-350",
  connected: "bg-success-solid",
  busy: "bg-success-solid",
  transfer: "bg-accent",
  reloading: "bg-warning-solid",
  unresponsive: "bg-danger-solid",
};

// ------------------------------------------------------------------ page ---

export function ControlPage() {
  const nav = useNav();
  const { hello, port, drive, layer: deviceLayer, status } = useDevice();
  const { activeProfile } = useProfiles();
  const { playing, canPress, pressDisabledReason, remoteHold, cancelResume, stopPlayback, pressKey } =
    usePlayback();
  const toast = useToast();
  const hotkey = useStopHotkey();
  const snap = useKeysSnapshot(drive?.path);
  const seqIds = useSyncExternalStore(sequenceRuns.subscribe, sequenceRuns.running);
  const [nickname, setNickname] = useState("");
  const [viewLayer, setViewLayer] = useState<number>(0);
  const [pending, setPending] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!hello) return setNickname("");
    const load = () => void deviceName(hello.uid).then(setNickname);
    load();
    return onDevnamesChanged(load);
  }, [hello]);

  // Follow the keypad: when its layer changes (the layer key, the wheel, a
  // remote "Next layer"), show that layer.
  const deviceLayerIdx = Math.max(0, LAYER_NAMES.indexOf(deviceLayer));
  useEffect(() => setViewLayer(deviceLayerIdx), [deviceLayerIdx]);

  // re-render once a play has lasted long enough to count as occupying
  const startedAt = playing?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    const left = startedAt + SETTLE_MS - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [startedAt]);

  // "Done" check on a tile whose press played too briefly to show as playing
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  if (!port || !hello) {
    return (
      <Card>
        <EmptyState
          icon={<Keyboard size={26} aria-hidden />}
          title="No keypad connected"
          description="Plug in your MKYADA keypad. Once it's connected, every key shows up here and you can run it with a click."
          action={
            <Button variant="primary" onClick={() => nav("devices")}>
              Go to Devices
            </Button>
          }
        />
      </Card>
    );
  }

  if (hello.mode === "rescue") {
    return (
      <Alert
        tone="danger"
        title="The keypad needs a repair"
        actions={
          <Button variant="primary" size="sm" onClick={() => nav("devices")}>
            Go to Devices
          </Button>
        }
      >
        Its firmware didn't start, so keys can't be run from here. Devices can repair it.
      </Alert>
    );
  }

  const cfg: Pick<DeviceConfig, "key_count" | "layer_key" | "layer_count" | "model" | "busy_other"> &
    Partial<DeviceConfig> = snap?.config ?? { ...helloConfig(hello) };
  const model = deviceModel(cfg.model ? cfg : hello);
  const vision6 = model === "vision6";
  const layers = effectiveLayers({ ...cfg, model });
  const names = cfg.layer_names ?? hello.layer_names ?? null;
  const profile = activeProfile;
  const view = Math.min(viewLayer, layers - 1);
  const viewLetter = LAYER_NAMES[view];
  const cols = cfg.key_count <= 3 ? cfg.key_count : cfg.key_count <= 6 ? 3 : cfg.key_count === 9 ? 3 : cfg.key_count <= 12 ? 4 : 5;

  const settled = !!playing && (playing.loop || Date.now() - playing.startedAt >= SETTLE_MS);
  const busyOther = cfg.busy_other ?? "ignore";
  const layerName = (i: number) => names?.[i]?.trim() || null;
  const layerText = (i: number) => (layerName(i) ? `Layer ${layerLabel(i)} · ${layerName(i)}` : `Layer ${layerLabel(i)}`);

  /** Is this tile the one the keypad is playing (or a multi action of it
   * the app is running — its steps play as keyless part files)? */
  function isPlaying(n: number): boolean {
    for (const id of seqIds) {
      if (id === `${n}:${viewLetter}` || (profile && id.startsWith(`${n}:`))) return true;
    }
    if (!playing || playing.key !== n) return false;
    if (profile || playing.layer === null) return true; // profile files have no layer
    return playing.layer === viewLetter;
  }

  const playingElsewhere =
    settled && playing && playing.key !== null && !profile && playing.layer && playing.layer !== viewLetter
      ? LAYER_NAMES.indexOf(playing.layer)
      : -1;

  async function run(n: number, gesture: PressGesture = "tap", immediate = false) {
    const id = `${n}:${gesture}`;
    const stopping = isPlaying(n);
    setPending(id);
    try {
      if (stopping) {
        await stopPlayback();
      } else {
        await pressKey(n, { layer: profile ? null : view, gesture, immediate });
        setFlash(id);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(stopping ? "Couldn't stop the macro" : `Couldn't run key ${n}`, msg);
    } finally {
      setPending((p) => (p === id ? null : p));
    }
  }

  const hint = hotkey?.registered && hotkey.accel ? accelParts(hotkey.accel, isMacPlatform()) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- header: which keypad, its state, the layer / profile in force */}
      <Card bodyClassName="flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-card bg-selected text-accent">
            <CirclePlay size={22} aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="m-0 truncate text-h3 font-semibold tracking-tight text-fg">
              {displayName(nickname, hello.uid)}
            </h1>
            <span className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-fg-faint">
              <span className="inline-flex items-center gap-1.5 text-fg-muted">
                <span aria-hidden className={cx("size-2 rounded-full", STATUS_DOT[status])} />
                {STATUS_TEXT[status]}
              </span>
              <span aria-hidden>·</span>
              <span>{MODEL_META[model].label}</span>
              {layers > 1 && !profile && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    Keypad on <span className="font-medium text-fg-muted">{layerText(deviceLayerIdx)}</span>
                  </span>
                </>
              )}
            </span>
          </div>
        </div>

        {profile ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <SlidersHorizontal size={16} aria-hidden className="shrink-0 text-fg-faint" />
            <span className="text-[13px] text-fg-muted">Profile</span>
            <Badge tone="green" dot>
              {profile.name}
            </Badge>
            <Tooltip
              side="bottom"
              content={`${profile.name} is in front, so the keypad runs that profile's keys. Layers don't apply while it's active.`}
            >
              <span className="text-label text-fg-faint underline decoration-dotted underline-offset-2">
                Why these keys?
              </span>
            </Tooltip>
          </div>
        ) : (
          layers > 1 && (
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
                <Layers size={16} aria-hidden className="text-fg-faint" />
                Showing
              </span>
              <SegmentedControl
                ariaLabel="Layer to show and run"
                value={String(view)}
                options={Array.from({ length: layers }, (_, i) => ({
                  value: String(i),
                  title: i === deviceLayerIdx ? `${layerText(i)} · the keypad is on this layer` : layerText(i),
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      {layerName(i) ? (
                        <>
                          <span className="tabular-nums">{layerLabel(i)}</span>
                          <span className="font-normal text-fg-faint">·</span>
                          {layerName(i)}
                        </>
                      ) : (
                        `Layer ${layerLabel(i)}`
                      )}
                      {i === deviceLayerIdx && (
                        <span aria-label="(active on the keypad)" className="size-1.5 rounded-full bg-success-solid" />
                      )}
                    </span>
                  ),
                }))}
                onChange={(v) => setViewLayer(Number(v))}
              />
            </div>
          )
        )}
      </Card>

      {!canPress && (
        <Alert
          tone="warning"
          title="Update the keypad's firmware to run keys from here"
          actions={
            <Button variant="primary" size="sm" onClick={() => nav("devices")}>
              Go to Devices
            </Button>
          }
        >
          Firmware v{hello.fw} can't take key presses from the app yet. Stopping a running macro still
          works.
        </Alert>
      )}

      {playingElsewhere >= 0 && (
        <Alert
          tone="info"
          icon={<Repeat size={18} aria-hidden />}
          title={`Key ${playing!.key} on ${layerText(playingElsewhere)} is ${playing!.loop ? "looping" : "playing"}`}
          actions={
            <Button size="sm" onClick={() => setViewLayer(playingElsewhere)}>
              Show it
            </Button>
          }
        />
      )}

      {/* ---- the keys, in the keypad's own arrangement */}
      <div
        role="group"
        aria-label="Keypad keys"
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: cfg.key_count }, (_, i) => i + 1).map((n) => {
          const isLayerKey = cfg.layer_key === n;
          const a: Assignment | undefined = profile
            ? profile.keys[String(n)]
            : snap?.assignments.get(slotKey(n, view));
          const loading = !profile && !snap?.complete;
          if (isLayerKey) {
            const next = (deviceLayerIdx + 1) % Math.max(1, cfg.layer_count);
            return (
              <KeyTile
                key={n}
                n={n}
                title="Next layer"
                subtitle={`Layer key · switches the keypad to ${layerText(next)}`}
                icon={<Layers size={22} aria-hidden className="text-accent" />}
                state={
                  !canPress
                    ? { run: false, reason: pressDisabledReason ?? "", short: "Needs a firmware update" }
                    : { run: true }
                }
                runLabel="Switch layer"
                playing={false}
                loop={false}
                busy={pending === `${n}:tap`}
                done={flash === `${n}:tap`}
                onRun={() => void run(n, "tap", true)}
              />
            );
          }
          const state = tileState(a, {
            vision6,
            loading,
            canPress,
            pressReason: pressDisabledReason,
          });
          const me = isPlaying(n);
          // waiting for the remote desktop session to end (interrupted by it,
          // or picked with Run during it)
          const paused =
            !me &&
            remoteHold?.resumeKey === n &&
            (!!profile || remoteHold.resumeLayer === null || remoteHold.resumeLayer === viewLetter);
          // The keypad runs one macro at a time: with another one occupying
          // it, busy_other decides whether a press is refused or takes over.
          const blocked = state.run && settled && !me && busyOther === "ignore";
          const finalState: TileState = blocked
            ? {
                run: false,
                reason: `Stop ${playing?.key ? `key ${playing.key}` : "the running macro"} first · the keypad plays one macro at a time`,
                short: playing?.key ? `Stop key ${playing.key} first` : "Stop the macro first",
              }
            : state;
          const hasA = !!a && a.kind !== "none";
          return (
            <KeyTile
              key={n}
              n={n}
              title={hasA ? describe(a) : "Not assigned"}
              subtitle={hasA ? secondaryText(a) : undefined}
              icon={hasA ? <ActionIcon name={kindMeta(a.kind).icon} size={40} /> : undefined}
              state={finalState}
              runLabel={
                remoteHold
                  ? "Run after remote session"
                  : settled && !me && busyOther === "switch"
                    ? "Switch to this"
                    : "Run"
              }
              playing={me}
              paused={paused}
              loop={me && !!playing?.loop}
              busy={pending === `${n}:tap`}
              done={flash === `${n}:tap` && !me}
              onRun={() =>
                paused
                  ? void cancelResume().catch((e) =>
                      toast.error("Couldn't stop the macro", e instanceof Error ? e.message : String(e)),
                    )
                  : void run(n)
              }
              variants={
                hasA && finalState.run && !me
                  ? (["double", "hold"] as const)
                      .filter((g) => a.variants?.[g])
                      .map((g) => ({
                        gesture: g,
                        label: GESTURE_TEXT[g],
                        detail: describe(a.variants![g]!),
                        busy: pending === `${n}:${g}`,
                        done: flash === `${n}:${g}`,
                        onRun: () => void run(n, g),
                      }))
                  : []
              }
            />
          );
        })}
      </div>

      {/* ---- how it works, in one line */}
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-fg-faint">
        <MonitorSmartphone size={15} aria-hidden className="mr-0.5 shrink-0" />
        Click a key to run it, click it again to stop.
        {hint ? (
          <>
            <span aria-hidden>·</span>
            {hint.map((p, i) => (
              <kbd
                key={i}
                className="rounded-badge border border-line-strong bg-raised px-1.5 py-0.5 font-sans text-[11px] text-fg-muted"
              >
                {p}
              </kbd>
            ))}
            <span>stops a running macro from anywhere, even with this window hidden.</span>
          </>
        ) : (
          <>
            <span aria-hidden>·</span>
            <span>Set a stop hotkey in Settings to stop macros with the window hidden.</span>
          </>
        )}
      </p>
    </div>
  );
}

/** The config fields this page needs, from the hello while config.json is
 * still being read. */
function helloConfig(h: Hello) {
  return {
    key_count: h.key_count,
    layer_key: h.layer_key,
    layer_count: h.layer_count,
    model: h.model ?? null,
    busy_other: "ignore" as const,
    layer_names: h.layer_names ?? null,
  };
}

// ------------------------------------------------------------------ tile ---

interface VariantAction {
  gesture: PressGesture;
  label: string;
  detail: string;
  busy: boolean;
  done: boolean;
  onRun: () => void;
}

function KeyTile({
  n,
  title,
  subtitle,
  icon,
  state,
  runLabel,
  playing: live,
  paused = false,
  loop,
  busy,
  done,
  onRun,
  variants = [],
}: {
  n: number;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  state: TileState;
  runLabel: string;
  playing: boolean;
  /** plays when the remote desktop session ends — offers Stop too */
  paused?: boolean;
  loop: boolean;
  busy: boolean;
  done: boolean;
  onRun: () => void;
  variants?: VariantAction[];
}) {
  // A key waiting for the remote desktop session to end looks and acts like a
  // playing one: its button is Stop (don't play it after all).
  const playing = live || paused;
  const enabled = playing || state.run;
  const face = (
    <button
      type="button"
      disabled={!enabled || busy}
      onClick={onRun}
      aria-label={
        paused
          ? `Stop key ${n} · ${title} · waiting for the remote desktop session to end`
          : playing
            ? `Stop key ${n} · ${title}`
            : `${runLabel} · key ${n} · ${title}`
      }
      aria-pressed={playing}
      className={cx(
        "group/tile flex min-h-[216px] w-full flex-1 flex-col gap-4 rounded-card p-4 text-left outline-none",
        "transition-[background-color,box-shadow] duration-[120ms] ease-standard focus-visible:shadow-ring",
        enabled && !busy && "cursor-pointer",
        !enabled && "cursor-not-allowed",
        busy && "cursor-progress",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={cx(
            "flex size-9 items-center justify-center rounded-control text-title font-semibold tabular-nums",
            playing ? "bg-accent text-accent-fg" : enabled ? "bg-sunken text-fg" : "bg-sunken text-fg-disabled",
          )}
        >
          {n}
        </span>
        {paused ? (
          <Badge tone="amber">
            <span className="inline-flex items-center gap-1">
              <Pause size={12} aria-hidden /> Plays after remote session
            </span>
          </Badge>
        ) : playing ? (
          <Badge tone="solid">
            <span className="inline-flex items-center gap-1">
              {loop ? <Repeat size={12} aria-hidden /> : <Play size={12} aria-hidden />}
              {loop ? "Looping" : "Playing"}
            </span>
          </Badge>
        ) : done ? (
          <Badge tone="green">
            <span className="inline-flex items-center gap-1">
              <Check size={12} aria-hidden /> Sent
            </span>
          </Badge>
        ) : null}
      </div>

      <div className="flex min-h-12 items-center gap-3.5">
        {icon ? (
          <span className={cx("flex size-12 shrink-0 items-center justify-center", !enabled && "opacity-45")}>{icon}</span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={cx("truncate text-[17px] font-semibold leading-tight", enabled ? "text-fg" : "text-fg-faint")}>
            {title}
          </span>
          {subtitle && <span className="line-clamp-2 text-[13px] leading-snug text-fg-faint">{subtitle}</span>}
        </div>
      </div>

      {enabled ? (
        <span
          className={cx(
            "mt-auto inline-flex h-11 w-full items-center justify-center gap-2 rounded-control border text-sm font-strong",
            "transition-colors duration-[120ms] ease-standard",
            playing
              ? "border-transparent bg-danger-solid text-cream group-hover/tile:bg-danger"
              : "border-line-strong bg-raised text-fg group-hover/tile:border-accent group-hover/tile:text-accent-ink",
          )}
        >
          {busy ? (
            <Spinner size={14} />
          ) : playing ? (
            <Square size={13} fill="currentColor" aria-hidden />
          ) : (
            <Play size={14} aria-hidden />
          )}
          {playing ? "Stop" : runLabel}
        </span>
      ) : (
        // Why it can't run, where the Run button would be.
        <span className="mt-auto inline-flex h-11 w-full items-center justify-center gap-2 rounded-control bg-sunken px-3 text-[13px] text-fg-faint">
          {!state.run && state.loading ? <Spinner size={13} /> : <Ban size={14} aria-hidden className="shrink-0" />}
          <span className="truncate">{state.run ? "" : state.short}</span>
        </span>
      )}
    </button>
  );

  return (
    <div
      className={cx(
        "flex min-w-0 flex-col rounded-card border transition-[border-color,background-color,box-shadow] duration-[120ms] ease-standard",
        playing
          ? "border-accent bg-selected shadow-ring"
          : enabled
            ? "border-line bg-panel hover:border-line-strong hover:bg-raised"
            : "border-line bg-panel",
      )}
    >
      {enabled ? (
        face
      ) : (
        <Tooltip content={state.run ? "" : state.reason} className="flex w-full flex-1">
          {face}
        </Tooltip>
      )}
      {variants.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-line p-2">
          {variants.map((v) => (
            <Button
              key={v.gesture}
              size="sm"
              variant="ghost"
              loading={v.busy}
              title={`${v.label} · ${v.detail}`}
              aria-label={`${v.label} · key ${n} · ${v.detail}`}
              onClick={v.onRun}
              className="w-full justify-start"
            >
              {v.done ? (
                <Check size={14} aria-hidden className="text-success" />
              ) : v.busy ? null : (
                <Play size={13} aria-hidden className="text-fg-faint" />
              )}
              <span>{v.label}</span>
              <span className="ml-auto min-w-0 truncate font-normal text-fg-faint">{v.detail}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
