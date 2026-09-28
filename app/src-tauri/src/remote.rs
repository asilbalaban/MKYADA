//! Remote control: stop a running macro without touching the keypad.
//!
//! People reach the keypad's computer over Chrome Remote Desktop, so a looping
//! macro (`settings.repeat: 0`, stopped by pressing the key again) would leave
//! them locked out — they can't press anything physical. Two ways out that work
//! with the window hidden in the tray, both sending `{"t":"stop"}` straight from
//! Rust:
//!
//! * a system-wide hotkey (default Ctrl+Alt+Shift+S — no Win/Cmd, which remote
//!   desktop clients keep for the local machine), configurable and persisted as
//!   `stopHotkey` in settings.json ("" = off);
//! * the tray menu's "Stop playback".
//!
//! Each attempt emits `playback:stop-request` so the UI can confirm it.

use crate::device::serial::{self, DeviceManager};
use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Shift+S";
const STORE_KEY: &str = "stopHotkey";

/// What the Settings card shows: the accelerator in force (as the user wrote
/// it) and why registering it failed, if it did.
#[derive(Clone, Serialize, Default)]
pub struct HotkeyStatus {
    pub accel: String,
    pub default: String,
    pub registered: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct HotkeyState(Mutex<HotkeyStatus>);

/// Send `stop` to the connected keypad and tell the UI (source = "hotkey" |
/// "tray"). Never fails loudly: there may simply be no keypad.
pub fn stop_playback(app: &AppHandle, source: &str) {
    // a deliberate stop also drops a macro paused for remote desktop
    if source != "remote-desktop" {
        crate::crd_watch::cancel_resume(app);
    }
    let mgr = app.state::<DeviceManager>();
    let r = serial::send(&mgr, &json!({"t": "stop"}));
    crate::dbg_log!("stop playback ({source}): {:?}", r.as_ref().err());
    let _ = app.emit(
        "playback:stop-request",
        json!({ "source": source, "ok": r.is_ok(), "error": r.err() }),
    );
}

/// The global-shortcut plugin's handler. Only one shortcut is ever registered
/// (ours), so any press is the stop hotkey; key-up is ignored.
pub fn on_shortcut(app: &AppHandle, _s: &Shortcut, state: ShortcutState) {
    if state == ShortcutState::Pressed {
        stop_playback(app, "hotkey");
    }
}

fn stored_accel(app: &AppHandle) -> String {
    use tauri_plugin_store::StoreExt;
    app.store("settings.json")
        .ok()
        .and_then(|s| s.get(STORE_KEY))
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_string())
}

/// Validate an accelerator without registering it. Rejects a bare key: a
/// system-wide hotkey without modifiers would swallow that key everywhere.
pub fn parse(accel: &str) -> Result<Shortcut, String> {
    let s: Shortcut = accel
        .parse()
        .map_err(|e| format!("Not a valid shortcut: {e}"))?;
    if s.mods.is_empty() {
        return Err("Add at least one modifier (Ctrl, Alt, Shift)".into());
    }
    Ok(s)
}

/// Swap the registered hotkey. The old one is released first; if the new one
/// can't be registered (another app owns it) nothing is left registered and
/// the error is kept for the UI.
fn apply(app: &AppHandle, accel: &str) -> HotkeyStatus {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut st = HotkeyStatus {
        accel: accel.to_string(),
        default: DEFAULT_HOTKEY.to_string(),
        registered: false,
        error: None,
    };
    if !accel.is_empty() {
        match parse(accel).and_then(|s| gs.register(s).map_err(|e| e.to_string())) {
            Ok(()) => st.registered = true,
            Err(e) => st.error = Some(e),
        }
    }
    crate::dbg_log!("stop hotkey {accel:?}: {:?}", st.error);
    *app.state::<HotkeyState>().0.lock().unwrap() = st.clone();
    st
}

/// Startup: register whatever the settings store holds (default when unset).
pub fn init(app: &AppHandle) {
    app.manage(HotkeyState::default());
    let accel = stored_accel(app);
    apply(app, &accel);
}

#[tauri::command]
pub fn stop_hotkey_status(state: State<HotkeyState>) -> HotkeyStatus {
    state.0.lock().unwrap().clone()
}

/// Change the stop hotkey ("" turns it off). A shortcut that doesn't parse is
/// refused without touching the current one; one that parses but can't be
/// registered is still saved (so it retries next launch) and reported.
#[tauri::command]
pub fn stop_hotkey_set(app: AppHandle, accel: String) -> Result<HotkeyStatus, String> {
    use tauri_plugin_store::StoreExt;
    let accel = accel.trim().to_string();
    if !accel.is_empty() {
        parse(&accel)?;
    }
    let st = apply(&app, &accel);
    if let Ok(s) = app.store("settings.json") {
        s.set(STORE_KEY, json!(accel));
        let _ = s.save();
    }
    Ok(st)
}

#[tauri::command]
pub fn stop_playback_now(app: AppHandle) {
    stop_playback(&app, "app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_hotkey_parses() {
        let s = parse(DEFAULT_HOTKEY).unwrap();
        assert!(s.mods.contains(tauri_plugin_global_shortcut::Modifiers::CONTROL));
        assert!(s.mods.contains(tauri_plugin_global_shortcut::Modifiers::ALT));
        assert!(s.mods.contains(tauri_plugin_global_shortcut::Modifiers::SHIFT));
    }

    #[test]
    fn rejects_bare_keys_and_garbage() {
        assert!(parse("S").is_err());
        assert!(parse("Ctrl+Nope").is_err());
        assert!(parse("Ctrl+Alt+F9").is_ok());
    }
}
