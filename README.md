# MKYADA

**M**acro **K**eyboard **Y**ou **A**lways **D**ream **A**bout — an open-source, DIY 6-key macro keypad built on the RP2040-Zero, with a cross-platform desktop configurator.

```
┌──────────────┐   serial (JSON-lines)    ┌───────────────┐    USB HID     ┌───────────┐
│  MKYADA App  │ ◄──────────────────────► │  RP2040-Zero  │ ─────────────► │  Your PC  │
│ (Tauri, W/M/L)│   CIRCUITPY drive (JSON) │   (firmware)  │  kbd + mouse   │  / game   │
└──────────────┘ ────────────────────────► └───────────────┘                └───────────┘
```

## Why MKYADA?

Unlike most DIY macro pads that just remap keys, MKYADA plays back **full recorded macros — mouse movements, clicks, and keystrokes — as real hardware HID input** from the device itself. Software macro tools inject input at the OS level and often don't work inside games; MKYADA's input is indistinguishable from a physical keyboard and mouse because, electrically, that's what it is.

- **Works standalone** — no app needed. Drop `key1.json` onto the board's USB drive and press the key.
- **Everything is JSON** — even a simple Ctrl+A binding is a tiny macro file. Copy it to another board and it behaves identically.
- **Layers** — dedicate one key as a layer switch: 4 keys become 3×3 = 9 macros (`key1.json`, `key1-b.json`, `key1-c.json`).
- **Per-app profiles** — with the desktop app running, key 1 can be *Save As* in Photoshop and an inventory macro in your game.
- **Record & edit** — record keyboard + mouse, edit every event, set speed / repeat / loop-until-pressed-again.
- **Build your own** — solder 6 switches to an RP2040-Zero, print the case, flash the firmware. Full docs in [hardware/](hardware/) and [docs/](docs/).

## Repository layout

| Path | What it is |
|---|---|
| [app/](app/) | Desktop configurator (Tauri v2 — Windows/macOS/Linux) |
| [firmware/](firmware/) | CircuitPython firmware for the RP2040-Zero |
| [hardware/](hardware/) | Wiring & soldering guide, 3D-printable case files |
| [docs/](docs/) | Macro format, serial protocol, firmware install guide |
| [community-macros/](community-macros/) | Macro gallery — contributions welcome via PR |

## Quick start

1. Flash CircuitPython to your RP2040-Zero, copy the contents of the firmware release zip to the `CIRCUITPY` drive — see [docs/firmware-install.md](docs/firmware-install.md).
2. Install the MKYADA app from the [latest release](https://github.com/asilbalaban/MKYADA/releases/latest) and follow the onboarding wizard, **or** just copy macro JSON files (`macros/key1.json` …) onto the drive by hand.
3. Press a key.

> **macOS:** the app is not notarized, so the first launch is blocked with
> *"Apple could not verify MKYADA…"*. Clear the quarantine flag once and open
> it normally:
>
> ```sh
> xattr -cr /Applications/MKYADA.app
> ```
>
> (Alternative: System Settings → Privacy & Security → **Open Anyway**.
> Details in [docs/macos-install.md](docs/macos-install.md).)

## Status

**v0.1.1** — firmware verified on real hardware; desktop app with onboarding, key
assignments, macro recorder/editor and per-app profiles. CI builds a Windows
installer and a macOS universal DMG (see [docs/macos-install.md](docs/macos-install.md)
for Gatekeeper + permission setup — the app guides you through it on first
launch); Linux packages coming next. The app checks GitHub for new releases on
launch.

> **Note:** automating input in online games may violate their Terms of Service. You are responsible for how you use this device.

---

## Türkçe

**MKYADA** (Macro Keyboard You Always Dream About), RP2040-Zero üzerine kurulu, açık kaynak, kendin-yap 6 tuşlu bir makro klavyedir ve çok platformlu bir masaüstü yapılandırma uygulamasıyla gelir.

Çoğu DIY makro pad sadece tuş atar; MKYADA ise kaydedilmiş **mouse hareketleri + tıklamalar + tuş vuruşlarını gerçek donanım HID girdisi olarak** kartın kendisinden oynatır. Yazılımsal makro araçları girdiyi işletim sistemi seviyesinde enjekte ettiği için oyunlarda çoğu zaman çalışmaz; MKYADA'nın girdisi elektriksel olarak gerçek bir klavye/mouse olduğundan ayırt edilemez.

- **Uygulamasız çalışır** — `key1.json` dosyasını kartın USB sürücüsüne at, tuşa bas.
- **Her şey JSON** — basit bir Ctrl+A ataması bile küçük bir makro dosyasıdır; başka karta kopyalayınca aynı davranır.
- **Layer desteği** — bir tuşu layer anahtarı yap: 4 tuş → 3×3 = 9 makro.
- **Uygulamaya özel profiller** — masaüstü uygulaması açıkken tuş 1 Photoshop'ta *Save As*, oyunda envanter makrosu olabilir.
- **Kaydet & düzenle** — klavye + mouse kaydı, event bazında düzenleme, hız / tekrar / tuşla-durdurulana-kadar-döngü.
- **Kendin yap** — 6 switch'i RP2040-Zero'ya lehimle, kutuyu 3D yazıcıda bas, firmware'i yükle. Dökümantasyon: [hardware/](hardware/) ve [docs/](docs/).

Kurulum: RP2040-Zero'ya CircuitPython yükleyin, firmware release zip içeriğini `CIRCUITPY` sürücüsüne kopyalayın ([docs/firmware-install.md](docs/firmware-install.md)), uygulamayı [son sürümden](https://github.com/asilbalaban/MKYADA/releases/latest) kurun veya JSON dosyalarını elle sürücüye atın.

> **Not:** Çevrimiçi oyunlarda girdi otomasyonu oyunun kullanım koşullarını ihlal edebilir. Cihazı nasıl kullandığınızın sorumluluğu size aittir.
