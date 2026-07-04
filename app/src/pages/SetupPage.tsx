// Onboarding wizard: key count -> layer choice -> write config.json + reload.
// Ends with a live key test that doubles as a solder-joint check.

import { useEffect, useState } from "react";
import { Pencil, Usb } from "lucide-react";
import { useDevice } from "../lib/device";
import { useNav } from "../lib/nav";
import { ipc } from "../lib/ipc";
import { Button, Card, EmptyState, Field, Input, Select, Stepper } from "../components/ui";
import { defaultConfig, macroSlots } from "../lib/macro-model";
import type { DeviceConfig } from "../lib/types";
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

  async function save() {
    setSaving(true);
    setError("");
    try {
      await writeAndReload([
        { path: "config.json", content: JSON.stringify(cfg, null, 2) },
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
            <span>Keys</span>
            <span className="text-fg">{cfg.key_count}</span>
            <span>Layers</span>
            <span className="text-fg">
              {cfg.layer_key
                ? `Key ${cfg.layer_key} switches ${cfg.layer_count} layers (${cfg.layer_mode})`
                : "None — every key is a macro"}
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
            <p className="text-sm text-fg-muted">
              Pressing a key should light it up below. If a key doesn't react, check its solder
              joint.
            </p>
            <TestPad cfg={cfg} send={send} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => nav("keys")}>
                Assign keys
              </Button>
            </div>
          </div>
        </Card>

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
            <Field label="Number of soldered keys — GP0…GP(n-1), up to 20">
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

            {cfg.layer_key && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Layers">
                  <Select
                    value={cfg.layer_count}
                    onChange={(e) => setCfg({ ...cfg, layer_count: Number(e.target.value) })}
                  >
                    {[2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Mode">
                  <Select
                    value={cfg.layer_mode}
                    onChange={(e) =>
                      setCfg({ ...cfg, layer_mode: e.target.value as "toggle" | "hold" })
                    }
                  >
                    <option value="toggle">Toggle — press cycles A → B → …</option>
                    <option value="hold">Hold — layer B while held (2 layers)</option>
                  </Select>
                </Field>
              </div>
            )}

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
              {JSON.stringify(cfg, null, 2)}
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
              <p className="text-sm text-fg-muted">
                Pressing a key should light it up below. If a key doesn't react, check its solder
                joint (GP{"{n-1}"} and GND).
              </p>
              <TestPad cfg={cfg} send={send} />
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
  // Host mode makes the firmware stream btn events instead of firing macros.
  useEffect(() => {
    void send({ t: "host_enter" });
    const ping = setInterval(() => void send({ t: "ping" }), 2000);
    return () => {
      clearInterval(ping);
      void send({ t: "host_leave" });
    };
  }, [send]);

  return <Keypad config={cfg} selected={null} onSelect={() => {}} />;
}
