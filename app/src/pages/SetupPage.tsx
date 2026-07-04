// Onboarding wizard: key count -> layer choice -> write config.json + reload.
// Ends with a live key test that doubles as a solder-joint check.

import { useEffect, useState } from "react";
import { useDevice } from "../lib/device";
import { Badge, Button, Card, Field, Input, Select } from "../components/ui";
import { defaultConfig, macroSlots } from "../lib/macro-model";
import type { DeviceConfig } from "../lib/types";
import { Keypad } from "../components/Keypad";

export function SetupPage({ onDone }: { onDone: () => void }) {
  const { hello, drive, writeAndReload, send } = useDevice();
  const [cfg, setCfg] = useState<DeviceConfig>(() => {
    const c = defaultConfig();
    if (hello) c.key_count = hello.key_count;
    return c;
  });
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Try to preload the device's existing config so re-running setup edits it.
  useEffect(() => {
    if (!hello) return;
    setCfg((c) => ({
      ...c,
      key_count: hello.key_count,
      layer_key: hello.layer_key,
      layer_count: hello.layer_count,
      layer_mode: hello.layer_mode,
    }));
  }, [hello]);

  if (!hello) {
    return <p className="text-slate-400">Connect a device first.</p>;
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

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <div className="flex gap-2 text-xs text-slate-500">
        {["Keys & layers", "Review", "Test"].map((s, i) => (
          <Badge key={s} tone={i === step ? "blue" : "default"}>
            {i + 1}. {s}
          </Badge>
        ))}
      </div>

      {step === 0 && (
        <Card title="How is your keypad built?">
          <div className="flex flex-col gap-4">
            <Field label="Number of soldered keys (GP0…GP5)">
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
                {[1, 2, 3, 4, 5, 6].map((n) => (
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

            <p className="text-sm text-slate-400">
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
          <div className="flex flex-col gap-3 text-sm text-slate-300">
            <pre className="bg-panel2 border border-line rounded-lg p-3 text-xs overflow-x-auto">
              {JSON.stringify(cfg, null, 2)}
            </pre>
            {!drive && (
              <p className="text-amber-400 text-xs">
                No CIRCUITPY drive found — cannot write the config. Check that the board's USB
                drive is mounted.
              </p>
            )}
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <div className="flex justify-between">
              <Button onClick={() => setStep(0)}>Back</Button>
              <Button variant="primary" onClick={() => void save()} disabled={saving || !drive}>
                {saving ? "Writing…" : "Write config.json"}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="Live key test — press your physical keys">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-slate-400">
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
      )}
    </div>
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
