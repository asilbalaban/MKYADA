// Onboarding wizard: key count -> layer choice -> write config.json + reload.
// Ends with a live key test that doubles as a solder-joint check.

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Cable, ChevronLeft, ClipboardList, Disc3, Hand, ListOrdered, Pencil, Usb } from "lucide-react";
import { useDevice } from "../lib/device";
import { useTestMode } from "../lib/focus";
import { TestModeBanner } from "../components/TestModeBanner";
import { useNav } from "../lib/nav";
import { ipc } from "../lib/ipc";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Stepper,
  Tabs,
  type Tab,
} from "../components/ui";
import { defaultConfig, macroSlots } from "../lib/macro-model";
import type { DeviceConfig } from "../lib/types";
import { MODEL_META, assignablePins, defaultPins, deviceModel } from "../lib/types";
import { Keypad } from "../components/Keypad";
import { useToast } from "../components/toast";

/** A configured keypad's Setup, split the same way Settings is: what it *is*,
 *  then the three things you'd come here to do to it. The four cards used to
 *  be one scroll, so the wiring panel — the reason people open Setup twice —
 *  sat below a summary they'd already read. */
const TABS: Tab[] = [
  { id: "overview", label: "Overview", icon: ClipboardList },
  { id: "test", label: "Test", icon: Hand },
  { id: "wiring", label: "Wiring", icon: Cable },
  { id: "order", label: "Key order", icon: ListOrdered },
];

/** Setup is opened from a button on Devices instead of the sidebar (issue #42),
 *  so no nav item is highlighted while it's open — it carries its own way back. */
function BackToDevices() {
  const nav = useNav();
  return (
    <div className="-mb-1">
      <Button variant="ghost" onClick={() => nav("devices")}>
        <ChevronLeft size={14} aria-hidden /> Devices
      </Button>
    </div>
  );
}

export function SetupPage({ onDone }: { onDone: () => void }) {
  const { hello, drive, writeAndReload, send, onMsg } = useDevice();
  const nav = useNav();
  const [cfg, setCfg] = useState<DeviceConfig>(() => {
    const c = defaultConfig();
    if (hello) c.key_count = hello.key_count;
    return c;
  });
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Already-configured keypads get the tabbed view; the wizard is opt-in.
  const [view, setView] = useState<"loading" | "tabs" | "wizard">("loading");
  const [tab, setTab] = useState<string>(TABS[0].id);

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
      // carry the device's current settings so a config rewrite from Setup
      // never clobbers what the on-device menu / Settings page set (issue #27)
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

  // If the drive already holds a config, show the tabs instead of the wizard.
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
        setView("tabs");
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
      // The config landed — the wizard's job is done. Hand over to the tabs on
      // Test, which is what the wizard's old third step was.
      setView("tabs");
      setTab("test");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (view === "loading") {
    return <p className="text-fg-muted text-sm">Reading the keypad's setup…</p>;
  }

  if (view === "tabs") {
    const identity = cfg.key_map == null || cfg.key_map.every((v, i) => v === i + 1);
    const overview = (
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
          {model === "vision6" && (
            <>
              <span>Language</span>
              <span className="text-fg">{cfg.lang === "tr" ? "Türkçe" : "English"}</span>
            </>
          )}
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
          Key assignments live on the Keys page — this only covers how the keypad itself is built.
        </p>
      </Card>
    );

    const test = (
      <Card title="Live key test — press your physical keys">
        <div className="flex flex-col gap-4">
          <TestCardNotice send={send} />
          <p className="text-sm text-fg-muted">
            Pressing a key should light it up below. If a key doesn't react, check its solder joint
            — or fix its wiring on the Wiring tab.
          </p>
          <TestPad cfg={cfg} send={send} />
          {model === "vision6" && <VisionControls />}
          <div className="flex justify-end">
            <Button variant="primary" onClick={onDone}>
              Assign keys
            </Button>
          </div>
        </div>
      </Card>
    );

    // Both hardware tabs are worked by pressing physical keys, so each holds
    // the keypad in test mode for as long as it's the open tab — otherwise a
    // press during a detect or a remap would fire its macro (issue #33).
    const wiring = (
      <>
        <TestCardNotice send={send} />
        <WiringPanel
          cfg={cfg}
          onApply={async (pins) => {
            const next = withModelFields({ ...cfg, pins });
            setCfg(next);
            await writeAndReload([
              { path: "config.json", content: JSON.stringify(next, null, 2) },
            ]);
          }}
        />
      </>
    );

    const order = (
      <>
        <TestCardNotice send={send} />
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
    );

    const bodies: Record<string, ReactNode> = { overview, test, wiring, order };

    return (
      <div className="flex flex-col gap-4 max-w-3xl mx-auto w-full">
        <BackToDevices />
        <Tabs idPrefix="setup" label="Setup sections" tabs={TABS} value={tab} onChange={setTab}>
          {bodies[tab] ?? overview}
        </Tabs>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl mx-auto w-full">
      <BackToDevices />
      {/* Two steps, not three: writing the config drops the user into the
          tabs on Test, which is where the old third step lived. */}
      <Stepper steps={["Keys & layers", "Review"]} current={step} onStepClick={(i) => setStep(i)} />

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

            {model === "vision6" && (
              <Field label="Device language — also changeable on the device (Settings > Language)">
                <Select
                  value={cfg.lang ?? "en"}
                  onChange={(e) => setCfg({ ...cfg, lang: e.target.value })}
                >
                  <option value="en">English</option>
                  <option value="tr">Türkçe</option>
                </Select>
              </Field>
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
const NAV_DEFAULT = ["GP4", "GP5", "GP6"];
const NAV_ROLES = ["PSH (wheel press)", "BACK", "CONFIRM"];

function WiringPanel({
  cfg,
  onApply,
}: {
  cfg: DeviceConfig;
  onApply: (pins: string[] | null) => Promise<void>;
}) {
  const { hello, drive, send, disconnect, onMsg } = useDevice();
  const toast = useToast();
  const model = deviceModel(hello);
  const isVision = model === "vision6";
  const supported = hello?.pins !== undefined;
  // nav wiring is a Vision-only extra section in the same panel (firmware
  // ≥ 0.14.0 reports it)
  const navSupported = isVision && Array.isArray(hello?.nav);
  const defaults = defaultPins(model, cfg.key_count);
  const current =
    cfg.pins && cfg.pins.length === cfg.key_count ? cfg.pins : defaults;
  const currentKey = current.join(" ");
  const curNav = hello?.nav && hello.nav.length === 3 ? hello.nav : NAV_DEFAULT;
  const curNavKey = curNav.join(" ");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(current);
  const [navDraft, setNavDraft] = useState<string[]>(curNav);
  const [detectKey, setDetectKey] = useState<number | null>(null);
  const [navDetect, setNavDetect] = useState<number | null>(null); // nav role index
  const [applying, setApplying] = useState(false);
  const options = assignablePins(model);
  const navOptions = [...curNav].sort();

  // Re-sync drafts whenever the config's wiring changes underneath us (a save
  // landed, or another panel rewrote the config).
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

  // Nav-button Detect: no pin_detect needed — the nav pins are reserved so the
  // wiring wizard can't watch them, but the firmware streams the pressed
  // button's slot live (like the keys' btn events). Translate that slot to its
  // physical pin through the current mapping and drop it into the role's row.
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
  const keyDirty = draft.join(" ") !== currentKey;
  const navDirty = navSupported && navDraft.join(" ") !== curNavKey;
  const dirty = keyDirty || navDirty;
  const customNow = cfg.pins != null || curNavKey !== NAV_DEFAULT.join(" ");

  // Write the whole wiring at once. Nav/encoder pins are bound at boot, so on
  // Vision we rewrite config.json and hard-reset (a soft reload wouldn't
  // rebind the buttons); Core 6 has no nav, so its plain key-pin path stays.
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
        await ipc.driveWrite(
          drive.path,
          "config.json",
          JSON.stringify({ ...stored, pins, nav }, null, 2),
        );
        await ipc.driveEject(drive.path).catch(() => {});
        await send({ t: "reset" }).catch(() => {});
        await disconnect().catch(() => {});
        toast.success("Keypad restarting", "Wiring saved.");
      } else {
        await onApply(pins);
      }
    } catch (e) {
      toast.error("Could not save the wiring", String(e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card
      title="Wiring (GPIO pins)"
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
          {navSupported && (
            <>
              {" · "}
              <span className="font-mono text-fg">
                {NAV_ROLES.map((r, i) => `${r.split(" ")[0]}:${curNav[i]}`).join("  ")}
              </span>
            </>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg-muted text-xs">
            Which GPIO drives each control. Pick it here — or, for a key, hit Detect and press it
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
                busy={navDetect !== null}
                onPin={(p) => setDraft(draft.map((v, j) => (j === i ? p : v)))}
                onDetect={(on) => setDetectKey(on ? i + 1 : null)}
              />
            ))}
            {navSupported &&
              navDraft.map((pin, i) => {
                const locked = detectKey !== null || (navDetect !== null && navDetect !== i);
                return (
                  <Fragment key={`nav${i}`}>
                    <span className="text-fg text-xs">{NAV_ROLES[i]}</span>
                    <Select
                      value={pin}
                      disabled={locked || navDetect === i}
                      onChange={(e) =>
                        setNavDraft(navDraft.map((v, j) => (j === i ? e.target.value : v)))
                      }
                    >
                      {navOptions.map((o) => {
                        const usedBy = navDraft.findIndex((p) => p === o);
                        const used = usedBy !== -1 && usedBy !== i;
                        return (
                          <option key={o} value={o} disabled={used}>
                            {o}
                            {used ? ` — ${NAV_ROLES[usedBy].split(" ")[0]}` : ""}
                          </option>
                        );
                      })}
                    </Select>
                    {navDetect === i ? (
                      <Button onClick={() => setNavDetect(null)}>
                        <Spinner size={12} /> Press {NAV_ROLES[i].split(" ")[0]}… cancel
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
            <p className="text-warning text-xs">
              Each pin can drive only one control — {dupes.join(", ")} is picked twice.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              loading={applying}
              disabled={!dirty || dupes.length > 0 || detectKey !== null || navDetect !== null}
              onClick={() => void saveWiring(false)}
            >
              Save wiring
            </Button>
            {(customNow || dirty) && (
              <Button
                loading={applying}
                disabled={detectKey !== null || navDetect !== null}
                onClick={() => void saveWiring(true)}
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
  busy = false,
  onPin,
  onDetect,
}: {
  index: number;
  pin: string;
  draft: string[];
  options: string[];
  detectKey: number | null;
  /** another detect (e.g. a nav row) is running — lock this row too */
  busy?: boolean;
  onPin: (pin: string) => void;
  onDetect: (on: boolean) => void;
}) {
  const detecting = detectKey === index + 1;
  const locked = detectKey !== null || busy;
  return (
    <>
      <span className="text-fg text-xs">Key {index + 1}</span>
      <Select value={pin} disabled={locked} onChange={(e) => onPin(e.target.value)}>
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
        <Button disabled={locked} onClick={() => onDetect(true)}>
          Detect
        </Button>
      )}
    </>
  );
}

// Nav slot names in the firmware's NAV_SLOT order (index-aligned with a
// config `nav` pin list: [PSH, BACK, CONFIRM]).
const NAV_SLOT_ORDER = ["psh", "back", "confirm"];

/**
 * Fix mismatched solder order by pressing the controls in the order/role they
 * should have. Core 6: press the physical keys in numbering order → key_map.
 * Vision 6 continues past the keys through the module controls — press BACK,
 * press CONFIRM, press the wheel (PSH), then turn the wheel right — so one flow
 * corrects the key numbering, the BACK/CONFIRM/PSH wiring (nav) and a
 * backwards-wired wheel (enc_swap) together, exactly like the keys' own remap.
 */
function RemapPanel({
  cfg,
  onApply,
}: {
  cfg: DeviceConfig;
  onApply: (keyMap: number[]) => Promise<void>;
}) {
  const { hello, drive, send, disconnect, onBtn, onMsg } = useDevice();
  const toast = useToast();
  const isVision = deviceModel(hello) === "vision6";
  const supported = hello?.key_map !== undefined;
  const [phase, setPhase] = useState<
    "idle" | "keys" | "back" | "confirm" | "psh" | "wheel" | "saving"
  >("idle");
  const [order, setOrder] = useState<number[]>([]); // key GPIO numbers, press order
  const [navRoles, setNavRoles] = useState<Record<string, string>>({}); // role -> pin
  const identity = Array.from({ length: cfg.key_count }, (_, i) => i + 1);
  const current = cfg.key_map ?? identity;
  const isIdentity = current.every((v, i) => v === i + 1);
  const active = phase !== "idle";
  const curNav = hello?.nav ?? ["GP4", "GP5", "GP6"];

  function cancel() {
    setPhase("idle");
    setOrder([]);
    setNavRoles({});
  }

  async function finishKeysOnly(pressed: number[]) {
    const map = Array<number>(cfg.key_count).fill(0);
    pressed.forEach((phys, idx) => {
      map[phys - 1] = idx + 1;
    });
    cancel();
    await onApply(map);
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
      toast.error("Could not save the remap", String(e));
    } finally {
      cancel();
    }
  }

  // Key press capture.
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

  // Nav button capture (back -> confirm -> psh): translate the reported slot to
  // a physical pin via the current mapping, ignoring a button already assigned.
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

  // Advance nav phases once the current role has a pin.
  useEffect(() => {
    if (phase === "back" && navRoles.back) setPhase("confirm");
    else if (phase === "confirm" && navRoles.confirm) setPhase("psh");
    else if (phase === "psh" && navRoles.psh) setPhase("wheel");
  }, [phase, navRoles]);

  // Wheel direction: user turns right; d<0 means the encoder is wired backwards
  // relative to the current enc_swap, so flip it.
  useEffect(() => {
    if (phase !== "wheel") return;
    return onMsg((m) => {
      if (m.t !== "enc" || typeof m.d !== "number" || m.d === 0) return;
      const cur = hello?.enc_swap ?? false;
      void finishVision(navRoles, m.d < 0 ? !cur : cur);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, onMsg, navRoles, hello?.enc_swap]);

  const prompt =
    phase === "keys"
      ? `Press the physical key that should be #${order.length + 1} of ${cfg.key_count}…`
      : phase === "back"
        ? "Press the button you want as BACK…"
        : phase === "confirm"
          ? "Press the button you want as CONFIRM…"
          : phase === "psh"
            ? "Press the wheel down (PSH)…"
            : phase === "wheel"
              ? "Turn the wheel to the RIGHT (clockwise)…"
              : "";

  return (
    <Card title="Order & wiring (remap)">
      <div className="flex flex-col gap-3 text-sm">
        {!supported ? (
          <p className="text-warning text-xs">
            This firmware doesn't support remapping — update the firmware on the drive first.
          </p>
        ) : phase === "saving" ? (
          <p className="flex items-center gap-2 text-fg">
            <Spinner size={14} /> Saving & restarting…
          </p>
        ) : active ? (
          <>
            <p className="text-fg">{prompt}</p>
            {phase === "keys" && (
              <p className="text-xs text-fg-faint">
                Pressed so far (GPIO order): {order.join(", ") || "—"}
              </p>
            )}
            {isVision && phase !== "keys" && (
              <p className="text-xs text-fg-faint">Keys done · now the module controls.</p>
            )}
            <div>
              <Button onClick={cancel}>Cancel</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-fg-muted text-xs">
              {isVision
                ? "Controls reacting wrong? Remap them by use: press the keys in order, then BACK, CONFIRM, the wheel press, and turn the wheel right. Fixes key numbering, the BACK/CONFIRM/PSH wiring and a backwards wheel — standalone too."
                : "Keys lighting up in the wrong order? Your solder order differs from GP0…GP5. Remap fixes the numbering everywhere — including standalone mode."}
              {!isIdentity && (
                <>
                  {" "}
                  Current key map (GP0…): <span className="font-mono text-fg">{current.join(" ")}</span>
                </>
              )}
            </p>
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
                {isVision ? "Start remap — keys, buttons & wheel" : "Start remap — press keys in order"}
              </Button>
              {!isIdentity && (
                <Button onClick={() => void onApply(identity)}>Reset key order</Button>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function TestPad({ cfg }: { cfg: DeviceConfig; send: (m: Record<string, unknown>) => Promise<void> }) {
  // No host mode here: since proto v2 the firmware streams btn events in
  // standalone mode too, so presses light up AND the macros still fire —
  // the keypad keeps working on every screen.
  return <Keypad config={cfg} selected={null} onSelect={() => {}} />;
}

/**
 * While a Live-key-test card is open (and the app window focused), hold the
 * keypad in test mode on EVERY model (issue #33): macro keys stop firing so
 * wiring can be checked without side effects. On Vision 6 the screen shows the
 * pressed key + its pin; Core 6 has no screen, so the banner explains it in the
 * app. Losing focus leaves test mode at once (so a backgrounded app still runs
 * macros); leaving the tab does too. The mount lives at the TOP of the panel so
 * the banner sits above whatever asks you to press a key.
 */
function TestCardNotice({ send }: { send: (m: Record<string, unknown>) => Promise<void> }) {
  useTestMode(send, "wiring");
  return <TestModeBanner what="wiring" />;
}

// Vision 6 nav-button slot names the firmware streams over serial (t:"btn"
// with a "slot", in host mode) — index-aligned with the on-screen tester.
const NAV_TESTS: { slot: string; label: string }[] = [
  { slot: "psh", label: "PSH (wheel press)" },
  { slot: "back", label: "BACK" },
  { slot: "confirm", label: "CONFIRM" },
];

/**
 * Vision 6 live test for the wheel and the PSH/BACK/CONFIRM buttons (issue
 * #24). Always live, exactly like the key TestPad above: firmware ≥ 0.14.0
 * streams enc/nav events on every screen (not just host mode), so turning the
 * wheel or pressing a button lights the matching indicator with no "start
 * test" step. The controls still drive the on-screen menu; the app just watches.
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
    <div className="flex flex-col gap-3 text-sm border-t border-line pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-fg font-medium">Wheel &amp; buttons</span>
        <p className="text-fg-muted text-xs">
          Turn the wheel and press PSH / BACK / CONFIRM — each lights up here. If a control
          doesn't react, check its solder joint.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel2 px-3 py-2">
        <span className="flex items-center gap-2 text-fg">
          <Disc3 size={18} aria-hidden className={lastDir ? "text-accent" : "text-fg-faint"} />
          Wheel
        </span>
        <span className="tabular-nums text-fg-muted">
          {lastDir === "cw" ? "↻ clockwise" : lastDir === "ccw" ? "↺ counter-clockwise" : "turn it…"}
          <span className="ml-2 text-fg">{wheel > 0 ? `+${wheel}` : wheel}</span>
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {NAV_TESTS.map((b) => (
          <div
            key={b.slot}
            className={`rounded-lg border px-2 py-3 text-center text-xs transition-colors ${
              down[b.slot]
                ? "border-accent bg-accent/15 text-accent font-medium"
                : "border-line bg-panel2 text-fg-muted"
            }`}
          >
            {b.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Vision 6 nav-button remap (issue #24), shown inside the wiring panel next to
 * the key wiring: when BACK and CONFIRM were soldered to each other's GPIO the
 * live test reports them swapped. This writes a `nav` pin-order override into
 * config.json and restarts the keypad so the firmware rebinds the buttons —
 * fixing a wrong solder joint without a soldering iron.
 */
