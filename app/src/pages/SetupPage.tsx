// Onboarding wizard: key count -> layer choice -> write config.json + reload.
// Ends with a live key test that doubles as a solder-joint check.

import { useEffect, useState } from "react";
import { Pencil, Usb } from "lucide-react";
import { useDevice } from "../lib/device";
import { useHostMode } from "../lib/focus";
import { useNav } from "../lib/nav";
import { ipc } from "../lib/ipc";
import { Button, Card, EmptyState, Field, Input, Select, Spinner, Stepper } from "../components/ui";
import { defaultConfig, macroSlots } from "../lib/macro-model";
import type { DeviceConfig } from "../lib/types";
import { MODEL_META, assignablePins, defaultPins, deviceModel } from "../lib/types";
import { Keypad } from "../components/Keypad";

export function SetupPage({ onDone }: { onDone: () => void }) {
  const { hello, drive, writeAndReload, send } = useDevice();
  const nav = useNav();
  const [cfg, setCfg] = useState<DeviceConfig>(() => {
    const c = defaultConfig();
    if (hello) c.key_count = hello.key_count;
    return c;
  });
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Already-configured keypads get a summary first; the wizard is opt-in.
  const [view, setView] = useState<"loading" | "summary" | "wizard">("loading");
  // Pin detection suspends key events on the firmware — pause the live key
  // test while it runs so the two features never fight over the keypad.
  const [pinDetecting, setPinDetecting] = useState(false);

  // Try to preload the device's existing config so re-running setup edits it.
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
    }));
  }, [hello]);

  // If the drive already holds a config, show the summary instead of the wizard.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!drive) {
        setView("wizard");
        return;
      }
      try {
        const stored = JSON.parse(await ipc.driveRead(drive.path, "config.json"));
        if (cancelled) return;
        setCfg((c) => ({ ...c, ...stored }));
        setView("summary");
      } catch {
        if (!cancelled) setView("wizard");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drive]);

  if (!hello) {
    return (
      <Card>
        <EmptyState
          icon={<Usb size={28} />}
          title="No keypad connected"
          description="Connect your MKYADA keypad to set up its keys and layers."
          action={
            <Button variant="primary" onClick={() => nav("devices")}>
              Go to Devices
            </Button>
          }
        />
      </Card>
    );
  }

  const model = deviceModel(hello);

  /** Stamp model invariants onto a config before writing: a known model is
   * written back (Vision 6 additionally pins layer_key to null — layers are
   * picked with the wheel). Unknown-model old firmware keeps the config's
   * existing fields untouched, so we never write a wrong model over it. */
  function withModelFields(c: DeviceConfig): DeviceConfig {
    if (!hello?.model) return c;
    return { ...c, model, ...(model === "vision6" ? { layer_key: null } : {}) };
  }

  async function save() {
    setSaving(true);
    setError("");
    const next = withModelFields(cfg);
    setCfg(next);
    try {
      await writeAndReload([
        { path: "config.json", content: JSON.stringify(next, null, 2) },
      ]);
      setStep(2);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (view === "loading") {
    return <p className="text-fg-muted text-sm">Reading the keypad's setup…</p>;
  }

  if (view === "summary") {
    const identity = cfg.key_map == null || cfg.key_map.every((v, i) => v === i + 1);
    return (
      <div className="flex flex-col gap-4 max-w-3xl mx-auto w-full">
        <Card
          title="This keypad is set up"
          actions={
            <Button
              variant="primary"
              onClick={() => {
                setStep(0);
                setView("wizard");
              }}
            >
              <Pencil size={14} aria-hidden /> Change setup
            </Button>
          }
        >
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm text-fg-muted max-w-md">
            <span>Model</span>
            <span className="text-fg">{MODEL_META[model].label}</span>
            <span>Keys</span>
            <span className="text-fg">{cfg.key_count}</span>
            <span>Layers</span>
            <span className="text-fg">
              {model === "vision6"
                ? `${cfg.layer_count} — picked with the wheel on the device`
                : cfg.layer_key
                  ? `Key ${cfg.layer_key} cycles ${cfg.layer_count} layers`
                  : "None — every key is a macro"}
            </span>
            <span>While a macro plays</span>
            <span className="text-fg">
              {cfg.busy_other === "switch"
                ? "Other keys interrupt and take over"
                : "Other keys are ignored"}
            </span>
            <span>Macro slots</span>
            <span className="text-fg">{macroSlots(cfg)}</span>
            <span>Screen (mouse macros)</span>
            <span className="text-fg">
              {cfg.screen.width} × {cfg.screen.height}
            </span>
            <span>Key order</span>
            <span className="text-fg">
              {identity ? "Default (GP0…GP5)" : `Remapped (${cfg.key_map!.join(" ")})`}
            </span>
          </div>
          <p className="text-xs text-fg-faint mt-3">
            Key assignments live on the Keys page — this only covers how the keypad itself is
            built.
          </p>
        </Card>

        <Card title="Live key test — press your physical keys">
          <div className="flex flex-col gap-4">
            {pinDetecting ? (
              <p className="text-sm text-fg-muted">
                Key test paused while pin detection is running below.
              </p>
            ) : (
              <>
                <p className="text-sm text-fg-muted">
                  Pressing a key should light it up below. If a key doesn't react, check its solder
                  joint.
                </p>
                <TestPad cfg={cfg} send={send} />
              </>
            )}
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => nav("keys")}>
                Assign keys
              </Button>
            </div>
          </div>
        </Card>

        <WiringPanel
          cfg={cfg}
          onDetectingChange={setPinDetecting}
          onApply={async (pins) => {
            const next = withModelFields({ ...cfg, pins });
            setCfg(next);
            await writeAndReload([
              { path: "config.json", content: JSON.stringify(next, null, 2) },
            ]);
          }}
        />

        <RemapPanel
          cfg={cfg}
          onApply={async (key_map) => {
            const next = { ...cfg, key_map };
            setCfg(next);
            await writeAndReload([
              { path: "config.json", content: JSON.stringify(next, null, 2) },
            ]);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl mx-auto w-full">
      <Stepper
        steps={["Keys & layers", "Review", "Test"]}
        current={step}
        onStepClick={(i) => setStep(i)}
      />

      {step === 0 && (
        <Card title="How is your keypad built?">
          <div className="flex flex-col gap-4">
            {model === "vision6" ? (
              <p className="text-sm text-fg-muted">
                {MODEL_META.vision6.label} — {cfg.key_count} macro keys, an encoder wheel and
                BACK/CONFIRM buttons. Every key is a macro key; layers are picked on the device
                screen.
              </p>
            ) : (
              <>
                <Field label="Number of soldered keys — GP0…GP(n-1), up to 20">
                  <Select
                    value={cfg.key_count}
                    onChange={(e) => {
                      const key_count = Number(e.target.value);
                      setCfg({
                        ...cfg,
                        key_count,
                        layer_key:
                          cfg.layer_key && cfg.layer_key > key_count ? null : cfg.layer_key,
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

                <Field label="Layer key — sacrifice one key to multiply the rest">
                  <Select
                    value={cfg.layer_key ?? ""}
                    onChange={(e) =>
                      setCfg({ ...cfg, layer_key: e.target.value ? Number(e.target.value) : null })
                    }
                  >
                    <option value="">No layers — every key is a macro</option>
                    {Array.from({ length: cfg.key_count }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        Key {n} switches layers
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}

            {(model === "vision6" || cfg.layer_key) && (
              <Field
                label={
                  model === "vision6"
                    ? "Layers — pick with the wheel on the device"
                    : "Layers — pressing the layer key cycles A → B → …"
                }
              >
                <Select
                  value={cfg.layer_count}
                  onChange={(e) => setCfg({ ...cfg, layer_count: Number(e.target.value) })}
                >
                  {(model === "vision6" ? [1, 2, 3, 4, 5, 6, 7, 8] : [2, 3, 4, 5, 6, 7, 8]).map(
                    (n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ),
                  )}
                </Select>
              </Field>
            )}

            <Field label="If another macro key is pressed while one is playing">
              <Select
                value={cfg.busy_other ?? "ignore"}
                onChange={(e) =>
                  setCfg({ ...cfg, busy_other: e.target.value as "ignore" | "switch" })
                }
              >
                <option value="ignore">Ignore it — finish the current macro</option>
                <option value="switch">Stop it and play the new key's macro</option>
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Screen width (mouse macros)">
                <Input
                  type="number"
                  value={cfg.screen.width}
                  onChange={(e) =>
                    setCfg({ ...cfg, screen: { ...cfg.screen, width: Number(e.target.value) } })
                  }
                />
              </Field>
              <Field label="Screen height">
                <Input
                  type="number"
                  value={cfg.screen.height}
                  onChange={(e) =>
                    setCfg({ ...cfg, screen: { ...cfg.screen, height: Number(e.target.value) } })
                  }
                />
              </Field>
            </div>

            <p className="text-sm text-fg-muted">
              This gives you <span className="text-accent font-semibold">{macroSlots(cfg)}</span>{" "}
              macro slot{macroSlots(cfg) === 1 ? "" : "s"}.
            </p>

            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setStep(1)}>
                Continue
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title="Review & write to device">
          <div className="flex flex-col gap-3 text-sm text-fg">
            <pre className="bg-panel2 border border-line rounded-lg p-3 text-xs overflow-x-auto">
              {JSON.stringify(withModelFields(cfg), null, 2)}
            </pre>
            {!drive && (
              <p className="text-warning text-xs">
                No CIRCUITPY drive found — cannot write the config. Check that the board's USB
                drive is mounted.
              </p>
            )}
            {error && <p className="text-danger text-xs">{error}</p>}
            <div className="flex justify-between">
              <Button onClick={() => setStep(0)}>Back</Button>
              <Button variant="primary" onClick={() => void save()} disabled={!drive} loading={saving}>
                {saving ? "Writing…" : "Write config.json"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && (
        <>
          <Card title="Live key test — press your physical keys">
            <div className="flex flex-col gap-4">
              {pinDetecting ? (
                <p className="text-sm text-fg-muted">
                  Key test paused while pin detection is running below.
                </p>
              ) : (
                <>
                  <p className="text-sm text-fg-muted">
                    Pressing a key should light it up below. If a key doesn't react, check its
                    solder joint (GP{"{n-1}"} and GND).
                  </p>
                  <TestPad cfg={cfg} send={send} />
                </>
              )}
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  onClick={() => {
                    void send({ t: "host_leave" });
                    onDone();
                  }}
                >
                  Finish — assign keys
                </Button>
              </div>
            </div>
          </Card>
          <WiringPanel
            cfg={cfg}
            onDetectingChange={setPinDetecting}
            onApply={async (pins) => {
              const next = withModelFields({ ...cfg, pins });
              setCfg(next);
              await writeAndReload([
                { path: "config.json", content: JSON.stringify(next, null, 2) },
              ]);
            }}
          />
          <RemapPanel
            cfg={cfg}
            onApply={async (key_map) => {
              const next = { ...cfg, key_map };
              setCfg(next);
              await writeAndReload([
                { path: "config.json", content: JSON.stringify(next, null, 2) },
              ]);
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Key wiring: which GPIO drives which key. Shows the effective pin per key
 * (config override, or the model's default order) and offers two ways to
 * change it: a per-pin dropdown, or Detect — the firmware's pin-detect mode
 * reports whichever pin gets grounded next. Saving writes the full `pins`
 * array into config.json; reset writes null (= model defaults).
 */
function WiringPanel({
  cfg,
  onApply,
  onDetectingChange,
}: {
  cfg: DeviceConfig;
  onApply: (pins: string[] | null) => Promise<void>;
  onDetectingChange: (active: boolean) => void;
}) {
  const { hello, send, onMsg } = useDevice();
  const model = deviceModel(hello);
  const supported = hello?.pins !== undefined;
  const defaults = defaultPins(model, cfg.key_count);
  const current =
    cfg.pins && cfg.pins.length === cfg.key_count ? cfg.pins : defaults;
  const currentKey = current.join(" ");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(current);
  const [detectKey, setDetectKey] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const options = assignablePins(model);

  // Re-sync the draft whenever the config's wiring changes underneath us
  // (a save landed, or another panel rewrote the config).
  useEffect(() => {
    setDraft(currentKey.split(" "));
  }, [currentKey]);

  // Detect mode: the firmware suspends key events, streams {"t":"pin"}
  // instead, and auto-stops after 120 s — we also stop it on any exit path.
  useEffect(() => {
    if (detectKey === null) return;
    onDetectingChange(true);
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
      onDetectingChange(false);
    };
  }, [detectKey, onMsg, send, onDetectingChange]);

  const dirty = draft.join(" ") !== currentKey;
  const dupes = [...new Set(draft.filter((p, i) => draft.indexOf(p) !== i))];

  async function apply(pins: string[] | null) {
    setApplying(true);
    try {
      await onApply(pins);
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card
      title="Key wiring (GPIO pins)"
      actions={
        supported && (
          <Button onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Change wiring"}</Button>
        )
      }
    >
      {!supported ? (
        <p className="text-warning text-xs">
          This firmware doesn't report key wiring — update the firmware on the drive first.
        </p>
      ) : !open ? (
        <p className="text-fg-muted text-xs">
          {cfg.pins == null ? "Default wiring" : "Custom wiring"} —{" "}
          <span className="font-mono text-fg">
            {current.map((p, i) => `${i + 1}:${p}`).join("  ")}
          </span>
        </p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg-muted text-xs">
            A key can sit on any free edge pin. Pick it here — or hit Detect and press that key
            (touch its wire to GND) so the keypad reports the pin itself.
          </p>
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 max-w-md">
            {draft.map((pin, i) => (
              <WiringRow
                key={i}
                index={i}
                pin={pin}
                draft={draft}
                options={options}
                detectKey={detectKey}
                onPin={(p) => setDraft(draft.map((v, j) => (j === i ? p : v)))}
                onDetect={(on) => setDetectKey(on ? i + 1 : null)}
              />
            ))}
          </div>
          {dupes.length > 0 && (
            <p className="text-warning text-xs">
              Each pin can drive only one key — {dupes.join(", ")} is picked twice.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              loading={applying}
              disabled={!dirty || dupes.length > 0 || detectKey !== null}
              onClick={() => void apply(draft)}
            >
              Save wiring
            </Button>
            {(cfg.pins != null || dirty) && (
              <Button
                loading={applying}
                disabled={detectKey !== null}
                onClick={() => void apply(null)}
              >
                Reset to default wiring
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/** One key's wiring row: pin dropdown (used pins marked) + Detect button. */
function WiringRow({
  index,
  pin,
  draft,
  options,
  detectKey,
  onPin,
  onDetect,
}: {
  index: number;
  pin: string;
  draft: string[];
  options: string[];
  detectKey: number | null;
  onPin: (pin: string) => void;
  onDetect: (on: boolean) => void;
}) {
  const detecting = detectKey === index + 1;
  return (
    <>
      <span className="text-fg text-xs">Key {index + 1}</span>
      <Select
        value={pin}
        disabled={detectKey !== null}
        onChange={(e) => onPin(e.target.value)}
      >
        {!options.includes(pin) && <option value={pin}>{pin}</option>}
        {options.map((o) => {
          const usedBy = draft.findIndex((p) => p === o);
          const used = usedBy !== -1 && usedBy !== index;
          return (
            <option key={o} value={o} disabled={used}>
              {o}
              {used ? ` — key ${usedBy + 1}` : ""}
            </option>
          );
        })}
      </Select>
      {detecting ? (
        <Button onClick={() => onDetect(false)}>
          <Spinner size={12} /> Press key {index + 1}… cancel
        </Button>
      ) : (
        <Button disabled={detectKey !== null} onClick={() => onDetect(true)}>
          Detect
        </Button>
      )}
    </>
  );
}

/**
 * Fix mismatched solder order: press the physical keys in the order they
 * should be numbered (top-left = 1, ...). Builds config.key_map so both the
 * app and standalone playback use the corrected numbering.
 */
function RemapPanel({
  cfg,
  onApply,
}: {
  cfg: DeviceConfig;
  onApply: (keyMap: number[]) => Promise<void>;
}) {
  const { hello, onBtn } = useDevice();
  const [active, setActive] = useState(false);
  const [order, setOrder] = useState<number[]>([]); // GPIO numbers in press order
  const supported = hello?.key_map !== undefined;
  const identity = Array.from({ length: cfg.key_count }, (_, i) => i + 1);
  const current = cfg.key_map ?? identity;
  const isIdentity = current.every((v, i) => v === i + 1);

  useEffect(() => {
    if (!active) return;
    return onBtn((e) => {
      if (e.edge !== "down") return;
      const phys = e.phys;
      if (!phys) return;
      setOrder((o) => (o.includes(phys) ? o : [...o, phys]));
    });
  }, [active, onBtn]);

  useEffect(() => {
    if (!active || order.length < cfg.key_count) return;
    // pressed 1st -> logical 1: key_map[gpio-1] = press position
    const map = Array<number>(cfg.key_count).fill(0);
    order.forEach((phys, idx) => {
      map[phys - 1] = idx + 1;
    });
    setActive(false);
    setOrder([]);
    void onApply(map);
  }, [order, active, cfg.key_count, onApply]);

  return (
    <Card title="Key order (remap)">
      <div className="flex flex-col gap-3 text-sm">
        {!supported ? (
          <p className="text-warning text-xs">
            This firmware doesn't support remapping — update the firmware on the drive first.
          </p>
        ) : active ? (
          <>
            <p className="text-fg">
              Press the physical key that should be{" "}
              <span className="text-accent font-bold text-lg">#{order.length + 1}</span> of{" "}
              {cfg.key_count} …
            </p>
            <p className="text-xs text-fg-faint">
              Pressed so far (GPIO order): {order.join(", ") || "—"}
            </p>
            <div>
              <Button onClick={() => { setActive(false); setOrder([]); }}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-fg-muted text-xs">
              Keys lighting up in the wrong order? Your solder order differs from GP0…GP5.
              Remap fixes the numbering everywhere — including standalone mode.
              {!isIdentity && (
                <> Current map (GP0…): <span className="font-mono text-fg">{current.join(" ")}</span></>
              )}
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => { setOrder([]); setActive(true); }}>
                Start remap — press keys in order
              </Button>
              {!isIdentity && (
                <Button onClick={() => void onApply(identity)}>Reset to default</Button>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function TestPad({ cfg, send }: { cfg: DeviceConfig; send: (m: Record<string, unknown>) => Promise<void> }) {
  // Host mode makes the firmware stream btn events instead of firing macros —
  // held only while the window is focused (issue #8).
  useHostMode(send);

  return <Keypad config={cfg} selected={null} onSelect={() => {}} />;
}
