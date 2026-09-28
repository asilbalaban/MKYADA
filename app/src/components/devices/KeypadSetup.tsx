// How the connected keypad is built: the Devices page's Setup, Test keys and
// Fix wiring tabs. This used to be a separate Setup page (issue #42) with four
// tabs of its own; Wiring and Key order both fixed solder mistakes, so they are
// one "Fix wiring" flow now, and the wizard's review shows a readable summary
// instead of raw config.json.

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, CircleOff, Disc3, Pencil, Hand, Wrench } from "lucide-react";
import { useDevice } from "../../lib/device";
import { useTestMode } from "../../lib/focus";
import { ipc } from "../../lib/ipc";
import { defaultConfig, macroSlots } from "../../lib/macro-model";
import { keysCache } from "../../lib/keys-cache";
import type { DeviceConfig, Hello } from "../../lib/types";
import { MODEL_META, assignablePins, defaultPins, deviceModel } from "../../lib/types";
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Stepper } from "../ui";
import { Keypad } from "../Keypad";
import { TestModeBanner } from "../TestModeBanner";
import { useToast } from "../toast";

// Vision 6 nav-button slot names the firmware streams over serial (t:"btn"
// with a "slot") — index-aligned with a config `nav` pin list.
const NAV_SLOT_ORDER = ["psh", "back", "confirm"];
const NAV_NAMES = ["Wheel press", "Back", "Confirm"];
const NAV_DEFAULT = ["GP4", "GP5", "GP6"];

// ------------------------------------------------------------ config state ---

export type SetupState = "loading" | "configured" | "unconfigured";

/**
 * The keypad's config.json, held by the Devices page so the hero and every
 * tab agree on whether the keypad is set up. Hydrates from the keys loader's
 * cache when it has one (issue #44 / #45), else reads the drive; a keypad
 * with no config.json is "unconfigured" and gets the first-time wizard.
 */
export function useKeypadConfig() {
  const { hello, drive, onMsg } = useDevice();
  const [cfg, setCfg] = useState<DeviceConfig>(() => {
    const c = defaultConfig();
    if (hello) c.key_count = hello.key_count;
    return c;
  });
  const [state, setState] = useState<SetupState>("loading");

  // Carry the device's live settings so a config rewrite from here never
  // clobbers what the on-device menu / Settings page set (issue #27).
  useEffect(() => {
    if (!hello) return;
    setCfg((c) => ({
      ...c,
      key_count: hello.key_count,
      layer_key: hello.layer_key,
      layer_count: hello.layer_count,
      layer_mode: hello.layer_mode,
      key_map: hello.key_map ?? null,
      model: hello.model ?? c.model ?? null,
      ...(hello.show_layer !== undefined ? { show_layer: hello.show_layer } : {}),
      ...(hello.show_profile !== undefined ? { show_profile: hello.show_profile } : {}),
      ...(hello.nav !== undefined ? { nav: hello.nav } : {}),
      ...(hello.enc_swap !== undefined ? { enc_swap: hello.enc_swap } : {}),
      ...(typeof hello.timeout === "number" ? { timeout: hello.timeout } : {}),
    }));
  }, [hello]);

  // The device can change its own language (Settings > Language) — it then
  // rewrites config.json and announces the fresh config; mirror the field.
  useEffect(
    () =>
      onMsg((m) => {
        if (m.t === "config" && typeof (m as { lang?: unknown }).lang === "string") {
          setCfg((c) => ({ ...c, lang: (m as { lang: string }).lang }));
        }
      }),
    [onMsg],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!drive) {
        setState("unconfigured");
        return;
      }
      const snap = keysCache.get(drive.path);
      if (snap) {
        setCfg((c) => ({ ...c, ...snap.config }));
        setState("configured");
        return;
      }
      setState("loading");
      try {
        const stored = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
        if (cancelled) return;
        setCfg((c) => ({ ...c, ...stored }));
        setState("configured");
      } catch {
        if (!cancelled) setState("unconfigured");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drive]);

  return { cfg, setCfg, state, setState };
}

/** Stamp model invariants onto a config before writing: a known model is
 * written back (Vision 6 additionally pins layer_key to null — layers are
 * picked with the wheel). Unknown-model old firmware keeps the config's
 * existing fields untouched, so we never write a wrong model over it. */
function withModelFields(c: DeviceConfig, hello: Hello | null): DeviceConfig {
  if (!hello?.model) return c;
  const model = deviceModel(hello);
  return { ...c, model, ...(model === "vision6" ? { layer_key: null } : {}) };
}

const isIdentityMap = (cfg: DeviceConfig) =>
  cfg.key_map == null || cfg.key_map.every((v, i) => v === i + 1);

/** Keys or module buttons moved off their standard pins. */
function customPins(cfg: DeviceConfig, hello: Hello | null): boolean {
  const nav = hello?.nav ?? cfg.nav;
  return cfg.pins != null || (!!nav && nav.join(" ") !== NAV_DEFAULT.join(" "));
}

/** "GP3" → "Pin 3". The GP name stays as secondary text where it helps. */
function pinLabel(p: string): string {
  return /^GP\d+$/.test(p) ? `Pin ${p.slice(2)}` : p;
}

// ---------------------------------------------------------------- summary ---

function SummaryGrid({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-10 gap-y-0 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5">
          <dt className="text-[13px] text-fg-faint">{k}</dt>
          <dd className="text-right text-sm text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function summaryRows(cfg: DeviceConfig, hello: Hello | null, withWiring: boolean): [string, ReactNode][] {
  const model = deviceModel(hello);
  const rows: [string, ReactNode][] = [
    ["Keys", model === "vision6" ? `${cfg.key_count} · plus wheel and buttons` : cfg.key_count],
    [
      "Layers",
      model === "vision6"
        ? `${cfg.layer_count} · picked with the wheel`
        : cfg.layer_key
          ? `${cfg.layer_count} · key ${cfg.layer_key} switches`
          : "None · every key runs a macro",
    ],
    ["Macro slots", macroSlots(cfg)],
    [
      "While a macro plays",
      cfg.busy_other === "switch" ? "A new key takes over" : "Other keys wait",
    ],
  ];
  if (model === "vision6") rows.push(["Keypad language", cfg.lang === "tr" ? "Türkçe" : "English"]);
  rows.push(["Screen size", `${cfg.screen.width} × ${cfg.screen.height} · for mouse macros`]);
  if (withWiring) {
    rows.push(["Pins", customPins(cfg, hello) ? "Custom" : "Standard"]);
    rows.push(["Key order", isIdentityMap(cfg) ? "Standard" : "Changed"]);
  }
  return rows;
}

// -------------------------------------------------------------- Setup tab ---

export function SetupTab({
  cfg,
  setCfg,
  state,
  setState,
  onSaved,
  onTest,
  onFixWiring,
}: {
  cfg: DeviceConfig;
  setCfg: (c: DeviceConfig) => void;
  state: SetupState;
  setState: (s: SetupState) => void;
  /** the config landed — the page moves on to Test keys */
  onSaved: () => void;
  onTest: () => void;
  onFixWiring: () => void;
}) {
  const { hello } = useDevice();
  const [editing, setEditing] = useState(false);

  if (state === "loading") {
    return (
      <Card>
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner size={14} /> Reading the keypad's setup…
        </p>
      </Card>
    );
  }

  if (state === "unconfigured" || editing) {
    return (
      <SetupWizard
        initial={cfg}
        firstTime={state === "unconfigured"}
        onCancel={state === "unconfigured" ? undefined : () => setEditing(false)}
        onSaved={(next) => {
          setCfg(next);
          setState("configured");
          setEditing(false);
          onSaved();
        }}
      />
    );
  }

  return (
    <Card
      title="How this keypad is built"
      description="Set once per keypad · key actions live on the Keys page"
      actions={
        <>
          <Button onClick={() => setEditing(true)}>
            <Pencil size={14} aria-hidden /> Change setup
          </Button>
          <Button onClick={onTest}>
            <Hand size={14} aria-hidden /> Test keys
          </Button>
        </>
      }
    >
      <SummaryGrid rows={summaryRows(cfg, hello, true)} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-fg-faint">
          Keys in the wrong order or not responding? Fix it without a soldering iron.
        </p>
        <Button variant="ghost" size="sm" onClick={onFixWiring}>
          <Wrench size={14} aria-hidden /> Fix wiring
        </Button>
      </div>
    </Card>
  );
}

function SetupWizard({
  initial,
  firstTime,
  onCancel,
  onSaved,
}: {
  initial: DeviceConfig;
  firstTime: boolean;
  onCancel?: () => void;
  onSaved: (cfg: DeviceConfig) => void;
}) {
  const { hello, drive, writeAndReload } = useDevice();
  // The wizard edits a draft; Cancel drops it, Save writes it.
  const [cfg, setCfg] = useState<DeviceConfig>(initial);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const model = deviceModel(hello);

  async function save() {
    setSaving(true);
    setError("");
    const next = withModelFields(cfg, hello);
    try {
      await writeAndReload([{ path: "config.json", content: JSON.stringify(next, null, 2) }]);
      onSaved(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const slots = macroSlots(cfg);

  return (
    <Card
      title={firstTime ? "Set up this keypad" : "Change setup"}
      description={
        firstTime
          ? "Tell the app how the keypad is built · takes a minute"
          : "Key actions stay as they are"
      }
      actions={
        <Stepper steps={["Keys & layers", "Review"]} current={step} onStepClick={(i) => setStep(i)} />
      }
    >
      {step === 0 && (
        <div className="flex flex-col gap-5">
          {model === "vision6" ? (
            <p className="text-sm text-fg-muted">
              {MODEL_META.vision6.label} · {cfg.key_count} macro keys, a wheel and Back / Confirm
              buttons. Every key runs a macro; layers are picked on the keypad screen.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Soldered keys" hint="Up to 20">
                <Select
                  value={cfg.key_count}
                  onChange={(e) => {
                    const key_count = Number(e.target.value);
                    setCfg({
                      ...cfg,
                      key_count,
                      layer_key: cfg.layer_key && cfg.layer_key > key_count ? null : cfg.layer_key,
                    });
                  }}
                >
                  {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Layer key" hint="Give up one key to multiply the rest">
                <Select
                  value={cfg.layer_key ?? ""}
                  onChange={(e) =>
                    setCfg({ ...cfg, layer_key: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">No layers · every key runs a macro</option>
                  {Array.from({ length: cfg.key_count }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      Key {n} switches layers
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {(model === "vision6" || cfg.layer_key) && (
              <Field
                label="Layers"
                hint={
                  model === "vision6"
                    ? "Picked with the wheel on the keypad"
                    : "The layer key cycles A → B → …"
                }
              >
                <Select
                  value={cfg.layer_count}
                  onChange={(e) => setCfg({ ...cfg, layer_count: Number(e.target.value) })}
                >
                  {(model === "vision6" ? [1, 2, 3, 4, 5, 6, 7, 8] : [2, 3, 4, 5, 6, 7, 8]).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <Field label="When a key is pressed during a macro">
              <Select
                value={cfg.busy_other ?? "ignore"}
                onChange={(e) => setCfg({ ...cfg, busy_other: e.target.value as "ignore" | "switch" })}
              >
                <option value="ignore">Ignore it · finish the current macro</option>
                <option value="switch">Stop and play the new key's macro</option>
              </Select>
            </Field>

            {model === "vision6" && (
              <Field label="Keypad language" hint="Also changeable on the keypad · Settings › Language">
                <Select value={cfg.lang ?? "en"} onChange={(e) => setCfg({ ...cfg, lang: e.target.value })}>
                  <option value="en">English</option>
                  <option value="tr">Türkçe</option>
                </Select>
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Screen width" hint="For mouse macros">
                <Input
                  type="number"
                  value={cfg.screen.width}
                  onChange={(e) => setCfg({ ...cfg, screen: { ...cfg.screen, width: Number(e.target.value) } })}
                />
              </Field>
              <Field label="Screen height">
                <Input
                  type="number"
                  value={cfg.screen.height}
                  onChange={(e) => setCfg({ ...cfg, screen: { ...cfg.screen, height: Number(e.target.value) } })}
                />
              </Field>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-sm text-fg-muted">
              <span className="font-strong text-accent">{slots}</span> macro slot{slots === 1 ? "" : "s"}
            </p>
            <div className="flex gap-2">
              {onCancel && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
              <Button variant="primary" onClick={() => setStep(1)}>
                Continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            Check the setup, then save it to the keypad. It restarts its keys for a moment.
          </p>
          <SummaryGrid rows={summaryRows(cfg, hello, false)} />
          {!drive && (
            <Alert tone="warning" title="Can't reach the keypad's storage">
              The setup can't be saved until the keypad's USB drive shows up. Try restarting the
              keypad from Troubleshoot.
            </Alert>
          )}
          {error && (
            <Alert tone="danger" title="Couldn't save the setup">
              {error}
            </Alert>
          )}
          <div className="flex justify-between gap-2 border-t border-line pt-4">
            <Button onClick={() => setStep(0)}>Back</Button>
            <div className="flex gap-2">
              {onCancel && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
              <Button variant="primary" onClick={() => void save()} disabled={!drive} loading={saving}>
                {saving ? "Saving…" : "Save to keypad"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------- Test keys tab ---

/**
 * While a test tab is open (and the app window focused), hold the keypad in
 * test mode on every model (issue #33): macro keys stop firing so wiring can
 * be checked without side effects. Losing focus or leaving the tab ends it.
 */
function TestModeHold() {
  const { send } = useDevice();
  useTestMode(send, "wiring");
  return <TestModeBanner what="wiring" />;
}

export function TestKeysTab({ cfg, onFixWiring }: { cfg: DeviceConfig; onFixWiring: () => void }) {
  const { hello } = useDevice();
  const isVision = deviceModel(hello) === "vision6";
  return (
    <>
      <TestModeHold />
      <Card
        title="Press each key on the keypad"
        description="Each press lights up here · a key that stays dark has a loose joint or a different pin"
        actions={
          <Button onClick={onFixWiring}>
            <Wrench size={14} aria-hidden /> Fix wiring
          </Button>
        }
      >
        <div className={isVision ? "grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]" : ""}>
          {/* No host mode here: since proto v2 the firmware streams btn events
              in standalone mode too, so presses light up while test mode keeps
              the macros from firing. */}
          <Keypad config={cfg} selected={null} onSelect={() => {}} />
          {isVision && <VisionControls />}
        </div>
      </Card>
    </>
  );
}


/**
 * Vision 6 live test for the wheel and its buttons (issue #24). Always live:
 * firmware ≥ 0.14.0 streams enc/nav events on every screen, so turning the
 * wheel or pressing a button lights the matching indicator.
 */
function VisionControls() {
  const { onMsg } = useDevice();
  const [down, setDown] = useState<Record<string, boolean>>({});
  const [wheel, setWheel] = useState(0);
  const [lastDir, setLastDir] = useState<"cw" | "ccw" | null>(null);

  useEffect(() => {
    return onMsg((m) => {
      if (m.t === "enc") {
        const d = typeof m.d === "number" ? m.d : 0;
        const n = typeof m.n === "number" ? m.n : 1;
        setWheel((w) => w + (d > 0 ? n : -n));
        setLastDir(d > 0 ? "cw" : "ccw");
      } else if (m.t === "btn" && typeof m.slot === "string") {
        setDown((s) => ({ ...s, [m.slot as string]: m.down === true }));
      }
    });
  }, [onMsg]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-0.5">
        <span className="font-strong text-fg">Wheel and buttons</span>
        <p className="text-[13px] text-fg-faint">Turn the wheel and press each button.</p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-control bg-raised px-3 py-2.5">
        <span className="flex items-center gap-2 text-fg">
          <Disc3 size={18} aria-hidden className={lastDir ? "text-accent" : "text-fg-faint"} />
          Wheel
        </span>
        <span className="tabular-nums text-fg-muted">
          {lastDir === "cw" ? "↻ clockwise" : lastDir === "ccw" ? "↺ counter-clockwise" : "Turn it…"}
          <span className="ml-2 text-fg">{wheel > 0 ? `+${wheel}` : wheel}</span>
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {NAV_SLOT_ORDER.map((slot, i) => (
          <div
            key={slot}
            className={`rounded-control px-2 py-3 text-center text-[13px] transition-colors duration-[120ms] ${
              down[slot] ? "bg-selected font-strong text-accent-ink" : "bg-raised text-fg-muted"
            }`}
          >
            {NAV_NAMES[i]}
          </div>
        ))}
      </div>
    </div>
  );
}

// -------------------------------------------------------- Fix wiring tab ---

/**
 * One place for both solder fixes. "Wrong order" is the common case and needs
 * no pin knowledge: press the controls in the order they should have. "Doesn't
 * respond" means the key sits on a pin the firmware isn't watching; the pin
 * table (with Detect) fixes that.
 */
export function FixWiringTab({
  cfg,
  setCfg,
}: {
  cfg: DeviceConfig;
  setCfg: (c: DeviceConfig) => void;
}) {
  const { hello, writeAndReload } = useDevice();
  const [open, setOpen] = useState<"order" | "pins" | null>(null);
  const isVision = deviceModel(hello) === "vision6";
  const orderSupported = hello?.key_map !== undefined;
  const pinsSupported = hello?.pins !== undefined;
  const identity = isIdentityMap(cfg);
  const pinsCustom = customPins(cfg, hello);

  async function writeConfig(next: DeviceConfig) {
    setCfg(next);
    await writeAndReload([{ path: "config.json", content: JSON.stringify(next, null, 2) }]);
  }

  return (
    <>
      <TestModeHold />
      <Card
        title="Fix wiring"
        description="For keys soldered in a different order or to a different pin · no soldering iron needed"
      >
        <div className="flex flex-col divide-y divide-line">
          <FixRow
            icon={ArrowLeftRight}
            title={isVision ? "Keys, buttons or wheel are mixed up" : "Keys work, but in the wrong order"}
            description={
              isVision
                ? "Press the keys in order, then Back, Confirm and the wheel, then turn the wheel right."
                : "Press the keys in the order they should be numbered."
            }
            status={identity ? "Standard order" : "Changed order"}
            custom={!identity}
            open={open === "order"}
            disabled={!orderSupported}
            disabledHint="Needs newer firmware · update it from Troubleshoot"
            onToggle={() => setOpen(open === "order" ? null : "order")}
            actionLabel="Fix order"
          >
            <RemapFlow
              cfg={cfg}
              onApply={(key_map) => writeConfig({ ...cfg, key_map })}
              onDone={() => setOpen(null)}
            />
          </FixRow>
          <FixRow
            icon={CircleOff}
            title={isVision ? "A key or button doesn't respond" : "A key doesn't respond"}
            description="Tell the keypad which pin each control is soldered to, or let it detect the pin."
            status={pinsCustom ? "Custom pins" : "Standard pins"}
            custom={pinsCustom}
            open={open === "pins"}
            disabled={!pinsSupported}
            disabledHint="Needs newer firmware · update it from Troubleshoot"
            onToggle={() => setOpen(open === "pins" ? null : "pins")}
            actionLabel="Choose pins"
          >
            <PinsEditor
              cfg={cfg}
              onApply={(pins) => writeConfig(withModelFields({ ...cfg, pins }, hello))}
            />
          </FixRow>
        </div>
      </Card>
    </>
  );
}

function FixRow({
  icon: Icon,
  title,
  description,
  status,
  custom,
  open,
  disabled,
  disabledHint,
  onToggle,
  actionLabel,
  children,
}: {
  icon: typeof Wrench;
  title: string;
  description: string;
  status: string;
  custom: boolean;
  open: boolean;
  disabled: boolean;
  disabledHint: string;
  onToggle: () => void;
  actionLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <Icon size={18} aria-hidden className="mt-px shrink-0 text-fg-faint" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2 text-sm font-strong text-fg">
              {title}
              <Badge tone={custom ? "blue" : "default"}>{status}</Badge>
            </span>
            <span className="text-[13px] leading-snug text-fg-faint">
              {disabled ? disabledHint : description}
            </span>
          </div>
        </div>
        <Button disabled={disabled} onClick={onToggle}>
          {open ? "Close" : actionLabel}
        </Button>
      </div>
      {open && !disabled && <div className="rounded-card bg-raised p-4 ml-[30px]">{children}</div>}
    </div>
  );
}

/**
 * Pin assignment: which board pin drives which control. Shows the effective
 * pin per key (config override, or the model's default order) and offers a
 * dropdown or Detect — the firmware's pin-detect mode reports whichever pin
 * gets grounded next. Saving writes the full `pins` array; reset writes null.
 */
function PinsEditor({
  cfg,
  onApply,
}: {
  cfg: DeviceConfig;
  onApply: (pins: string[] | null) => Promise<void>;
}) {
  const { hello, drive, send, disconnect, onMsg } = useDevice();
  const toast = useToast();
  const model = deviceModel(hello);
  const navSupported = model === "vision6" && Array.isArray(hello?.nav);
  const defaults = defaultPins(model, cfg.key_count);
  const current = cfg.pins && cfg.pins.length === cfg.key_count ? cfg.pins : defaults;
  const currentKey = current.join(" ");
  const curNav = hello?.nav && hello.nav.length === 3 ? hello.nav : NAV_DEFAULT;
  const curNavKey = curNav.join(" ");
  const [draft, setDraft] = useState<string[]>(current);
  const [navDraft, setNavDraft] = useState<string[]>(curNav);
  const [detectKey, setDetectKey] = useState<number | null>(null);
  const [navDetect, setNavDetect] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const options = assignablePins(model);
  const navOptions = [...curNav].sort();

  useEffect(() => {
    setDraft(currentKey.split(" "));
  }, [currentKey]);
  useEffect(() => {
    setNavDraft(curNavKey.split(" "));
  }, [curNavKey]);

  // Detect mode: the firmware suspends key events, streams {"t":"pin"}
  // instead, and auto-stops after 120 s — we also stop it on any exit path.
  useEffect(() => {
    if (detectKey === null) return;
    void send({ t: "pin_detect", on: true });
    const un = onMsg((m) => {
      if (m.t !== "pin" || m.down !== true) return;
      const pin = String((m as { pin?: string }).pin ?? "");
      if (!pin) return;
      setDraft((d) => d.map((p, i) => (i === detectKey - 1 ? pin : p)));
      setDetectKey(null);
    });
    return () => {
      un();
      void send({ t: "pin_detect", on: false });
    };
  }, [detectKey, onMsg, send]);

  // Button Detect: the nav pins are reserved so pin-detect can't watch them,
  // but the firmware streams the pressed button's slot live. Translate that
  // slot to its physical pin through the current mapping.
  useEffect(() => {
    if (navDetect === null) return;
    const cur = curNavKey.split(" ");
    return onMsg((m) => {
      if (m.t !== "btn" || typeof m.slot !== "string" || m.down !== true) return;
      const slotIdx = NAV_SLOT_ORDER.indexOf(m.slot);
      if (slotIdx < 0) return;
      const pin = cur[slotIdx];
      setNavDraft((d) => d.map((p, i) => (i === navDetect ? pin : p)));
      setNavDetect(null);
    });
  }, [navDetect, onMsg, curNavKey]);

  const keyDupes = [...new Set(draft.filter((p, i) => draft.indexOf(p) !== i))];
  const navDupes = [...new Set(navDraft.filter((p, i) => navDraft.indexOf(p) !== i))];
  const dupes = [...keyDupes, ...navDupes];
  const dirty = draft.join(" ") !== currentKey || (navSupported && navDraft.join(" ") !== curNavKey);
  const customNow = cfg.pins != null || curNavKey !== NAV_DEFAULT.join(" ");
  const detecting = detectKey !== null || navDetect !== null;

  // Nav/encoder pins are bound at boot, so on Vision we rewrite config.json
  // and hard-reset (a soft reload wouldn't rebind the buttons); Core 6 has no
  // nav, so its plain key-pin path stays.
  async function saveWiring(toDefault: boolean) {
    setApplying(true);
    try {
      const pins = toDefault || draft.join(" ") === defaults.join(" ") ? null : draft;
      if (navSupported) {
        if (!drive) return;
        const nav = toDefault || navDraft.join(" ") === NAV_DEFAULT.join(" ") ? null : navDraft;
        let stored: Record<string, unknown> = {};
        try {
          stored = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
        } catch {
          // fresh board — firmware defaults the rest
        }
        await ipc.driveWrite(drive.path, "config.json", JSON.stringify({ ...stored, pins, nav }, null, 2));
        await ipc.driveEject(drive.path).catch(() => {});
        await send({ t: "reset" }).catch(() => {});
        await disconnect().catch(() => {});
        toast.success("Keypad restarting", "Pins saved.");
      } else {
        await onApply(pins);
        toast.success("Pins saved");
      }
    } catch (e) {
      toast.error("Couldn't save the pins", String(e));
    } finally {
      setApplying(false);
    }
  }

  const pinOption = (o: string, usedBy: string | null) => (
    <option key={o} value={o} disabled={!!usedBy}>
      {pinLabel(o)} ({o}){usedBy ? ` · ${usedBy}` : ""}
    </option>
  );

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-[13px] text-fg-faint">
        Pick the pin for each control, or press Detect and then the key. Pin numbers match the
        GP labels on the board.
      </p>
      <div className="grid max-w-xl grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
        {draft.map((pin, i) => {
          const locked = detecting;
          return (
            <Fragment key={i}>
              <span className="text-fg">Key {i + 1}</span>
              <Select
                value={pin}
                disabled={locked}
                aria-label={`Pin for key ${i + 1}`}
                onChange={(e) => setDraft(draft.map((v, j) => (j === i ? e.target.value : v)))}
              >
                {!options.includes(pin) && pinOption(pin, null)}
                {options.map((o) => {
                  const usedBy = draft.findIndex((p) => p === o);
                  return pinOption(o, usedBy !== -1 && usedBy !== i ? `key ${usedBy + 1}` : null);
                })}
              </Select>
              {detectKey === i + 1 ? (
                <Button onClick={() => setDetectKey(null)}>
                  <Spinner size={12} /> Press key {i + 1}… Cancel
                </Button>
              ) : (
                <Button disabled={locked} onClick={() => setDetectKey(i + 1)}>
                  Detect
                </Button>
              )}
            </Fragment>
          );
        })}
        {navSupported &&
          navDraft.map((pin, i) => {
            const locked = detectKey !== null || (navDetect !== null && navDetect !== i);
            return (
              <Fragment key={`nav${i}`}>
                <span className="text-fg">{NAV_NAMES[i]}</span>
                <Select
                  value={pin}
                  disabled={locked || navDetect === i}
                  aria-label={`Pin for ${NAV_NAMES[i]}`}
                  onChange={(e) => setNavDraft(navDraft.map((v, j) => (j === i ? e.target.value : v)))}
                >
                  {navOptions.map((o) => {
                    const usedBy = navDraft.findIndex((p) => p === o);
                    return pinOption(o, usedBy !== -1 && usedBy !== i ? NAV_NAMES[usedBy] : null);
                  })}
                </Select>
                {navDetect === i ? (
                  <Button onClick={() => setNavDetect(null)}>
                    <Spinner size={12} /> Press {NAV_NAMES[i]}… Cancel
                  </Button>
                ) : (
                  <Button disabled={locked} onClick={() => setNavDetect(i)}>
                    Detect
                  </Button>
                )}
              </Fragment>
            );
          })}
      </div>
      {dupes.length > 0 && (
        <Alert tone="warning">
          Each pin can drive only one control · {dupes.map(pinLabel).join(", ")} is picked twice.
        </Alert>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={applying}
          disabled={!dirty || dupes.length > 0 || detecting}
          onClick={() => void saveWiring(false)}
        >
          Save pins
        </Button>
        {(customNow || dirty) && (
          <Button loading={applying} disabled={detecting} onClick={() => void saveWiring(true)}>
            Reset to standard pins
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Fix mismatched solder order by pressing the controls in the order/role they
 * should have. Core 6: press the physical keys in numbering order → key_map.
 * Vision 6 continues through the module controls — Back, Confirm, the wheel
 * press, then a right turn — so one flow corrects the key numbering, the
 * button wiring (nav) and a backwards wheel (enc_swap) together.
 */
function RemapFlow({
  cfg,
  onApply,
  onDone,
}: {
  cfg: DeviceConfig;
  onApply: (keyMap: number[]) => Promise<void>;
  onDone: () => void;
}) {
  const { hello, drive, send, disconnect, onBtn, onMsg } = useDevice();
  const toast = useToast();
  const isVision = deviceModel(hello) === "vision6";
  const [phase, setPhase] = useState<"idle" | "keys" | "back" | "confirm" | "psh" | "wheel" | "saving">(
    "idle",
  );
  const [order, setOrder] = useState<number[]>([]); // physical key numbers, press order
  const [navRoles, setNavRoles] = useState<Record<string, string>>({}); // role -> pin
  const identity = Array.from({ length: cfg.key_count }, (_, i) => i + 1);
  const isIdentity = isIdentityMap(cfg);
  const curNav = hello?.nav ?? NAV_DEFAULT;

  function reset() {
    setPhase("idle");
    setOrder([]);
    setNavRoles({});
  }

  async function finishKeysOnly(pressed: number[]) {
    const map = Array<number>(cfg.key_count).fill(0);
    pressed.forEach((phys, idx) => {
      map[phys - 1] = idx + 1;
    });
    setPhase("saving");
    try {
      await onApply(map);
      toast.success("Key order saved");
      onDone();
    } catch (e) {
      toast.error("Couldn't save the key order", String(e));
    } finally {
      reset();
    }
  }

  // Vision: write key_map + nav + enc_swap in one config rewrite, then hard
  // reset (nav/encoder pins are bound at boot, so a soft reload won't rebind).
  async function finishVision(roles: Record<string, string>, encSwap: boolean) {
    if (!drive) return;
    setPhase("saving");
    const map = Array<number>(cfg.key_count).fill(0);
    order.forEach((phys, idx) => {
      map[phys - 1] = idx + 1;
    });
    const nav = [roles.psh, roles.back, roles.confirm];
    try {
      let stored: Record<string, unknown> = {};
      try {
        stored = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
      } catch {
        // fresh board — firmware defaults the rest
      }
      await ipc.driveWrite(
        drive.path,
        "config.json",
        JSON.stringify({ ...stored, key_map: map, nav, enc_swap: encSwap }, null, 2),
      );
      await ipc.driveEject(drive.path).catch(() => {});
      await send({ t: "reset" }).catch(() => {});
      await disconnect().catch(() => {});
      toast.success("Keypad restarting", "Keys, buttons and wheel remapped.");
    } catch (e) {
      toast.error("Couldn't save the new order", String(e));
    } finally {
      reset();
    }
  }

  useEffect(() => {
    if (phase !== "keys") return;
    return onBtn((e) => {
      if (e.edge !== "down" || !e.phys) return;
      const phys = e.phys;
      setOrder((o) => (o.includes(phys) ? o : [...o, phys]));
    });
  }, [phase, onBtn]);

  useEffect(() => {
    if (phase !== "keys" || order.length < cfg.key_count) return;
    if (isVision) setPhase("back");
    else void finishKeysOnly(order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, phase, cfg.key_count, isVision]);

  // Button capture (back -> confirm -> psh): translate the reported slot to a
  // physical pin via the current mapping, ignoring a button already assigned.
  useEffect(() => {
    if (phase !== "back" && phase !== "confirm" && phase !== "psh") return;
    return onMsg((m) => {
      if (m.t !== "btn" || typeof m.slot !== "string" || m.down !== true) return;
      const slotIdx = NAV_SLOT_ORDER.indexOf(m.slot);
      if (slotIdx < 0) return;
      const pin = curNav[slotIdx];
      setNavRoles((r) => (Object.values(r).includes(pin) ? r : { ...r, [phase]: pin }));
    });
  }, [phase, onMsg, curNav]);

  useEffect(() => {
    if (phase === "back" && navRoles.back) setPhase("confirm");
    else if (phase === "confirm" && navRoles.confirm) setPhase("psh");
    else if (phase === "psh" && navRoles.psh) setPhase("wheel");
  }, [phase, navRoles]);

  // Wheel direction: the user turns right; d<0 means the encoder is wired
  // backwards relative to the current enc_swap, so flip it.
  useEffect(() => {
    if (phase !== "wheel") return;
    return onMsg((m) => {
      if (m.t !== "enc" || typeof m.d !== "number" || m.d === 0) return;
      const cur = hello?.enc_swap ?? false;
      void finishVision(navRoles, m.d < 0 ? !cur : cur);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, onMsg, navRoles, hello?.enc_swap]);

  if (phase === "saving") {
    return (
      <p className="flex items-center gap-2 text-sm text-fg">
        <Spinner size={14} /> Saving…
      </p>
    );
  }

  if (phase === "idle") {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-fg-muted">
          <li>Press Start.</li>
          <li>Press the key that should be key 1, then key 2, and so on.</li>
          {isVision && <li>Press Back, then Confirm, then press the wheel down.</li>}
          {isVision && <li>Turn the wheel to the right.</li>}
          <li>The new order is saved{isVision ? " and the keypad restarts" : ""}.</li>
        </ol>
        {!isIdentity && (
          <p className="text-[13px] text-fg-faint">
            Current order · <span className="tabular-nums text-fg">{cfg.key_map!.join(" ")}</span>
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={isVision && !drive}
            onClick={() => {
              setOrder([]);
              setNavRoles({});
              setPhase("keys");
            }}
          >
            Start
          </Button>
          {!isIdentity && (
            <Button
              onClick={() =>
                void onApply(identity)
                  .then(() => toast.success("Key order reset"))
                  .catch((e) => toast.error("Couldn't reset the key order", String(e)))
              }
            >
              Reset to standard order
            </Button>
          )}
        </div>
      </div>
    );
  }

  const prompt =
    phase === "keys"
      ? `Press the key that should be key ${order.length + 1} of ${cfg.key_count}`
      : phase === "back"
        ? "Press the button you want as Back"
        : phase === "confirm"
          ? "Press the button you want as Confirm"
          : phase === "psh"
            ? "Press the wheel down"
            : "Turn the wheel to the right";

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex items-center gap-2 text-title font-strong text-fg">
        <Spinner size={14} className="text-accent" /> {prompt}
      </p>
      {phase === "keys" ? (
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: cfg.key_count }, (_, i) => (
            <span
              key={i}
              className={`flex size-8 items-center justify-center rounded-control text-[13px] tabular-nums ${
                i < order.length ? "bg-selected font-strong text-accent-ink" : "bg-sunken text-fg-faint"
              }`}
            >
              {i + 1}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-fg-faint">Keys done · now the wheel and buttons.</p>
      )}
      <div>
        <Button onClick={reset}>Cancel</Button>
      </div>
    </div>
  );
}
