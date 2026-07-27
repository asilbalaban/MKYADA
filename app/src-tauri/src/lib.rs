pub mod debuglog;
mod device;
mod layout;
mod obs;
#[cfg(target_os = "windows")]
mod overlay_win;
mod permissions;
mod player;
mod profiles;
mod recorder;
mod sound;
mod updater;
mod vars;
mod volume;

use device::bootloader;
use device::drive::{self, DriveInfo};
use device::serial::{self, DeviceInfo, DeviceManager};
use device::serialfs;
use player::Preview;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Last time the editor proved it's alive while the overlay is up
/// (via `overlay:ping` / `overlay:data` events). The overlay is a fullscreen
/// topmost window — if the editor stops vouching for it, tear it down from
/// the Rust side even when the overlay webview itself is dead/blank.
struct OverlayLiveness(Arc<Mutex<Instant>>);

/// Last time the overlay's OWN webview proved it's alive (via `overlay:alive`).
/// Distinct from `OverlayLiveness` (which the editor emits): this proves the
/// overlay's JS is actually running, so a dead/hung overlay can be force-hidden
/// before it becomes an inescapable black full-screen trap.
struct OverlayAlive(Arc<Mutex<Instant>>);

/// Bring the main window back from the tray / a second launch / a dock click.
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// System tray: the app keeps running key actions and per-app profiles with
/// the window closed, so it needs a visible handle to come back / quit from.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Open MKYADA", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(
        app,
        "pause",
        "Pause key actions",
        true,
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit MKYADA", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &pause,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let pause_handle = pause.clone();
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("MKYADA")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "pause" => {
                let paused = pause_handle.is_checked().unwrap_or(false);
                // profiles.tsx listens and stops answering key presses
                let _ = app.emit("host:paused", paused);
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Whether closing the window should hide to the tray instead of quitting.
/// Read fresh from the settings store each time so the toggle applies
/// immediately, no restart.
fn run_in_background(app: &AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;
    app.store("settings.json")
        .ok()
        .and_then(|s| s.get("runInBackground"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

#[tauri::command]
fn scan_devices(mgr: State<DeviceManager>) -> Vec<DeviceInfo> {
    serial::scan(mgr.connected_port().as_deref())
}

#[tauri::command]
fn connect_device(app: AppHandle, mgr: State<DeviceManager>, port: String) -> Result<(), String> {
    let r = serial::connect(app, &mgr, &port);
    dbg_log!("connect {port}: {:?}", r.as_ref().err());
    r
}

#[tauri::command]
fn disconnect_device(mgr: State<DeviceManager>) {
    dbg_log!("disconnect (ui)");
    serial::disconnect(&mgr);
}

#[tauri::command]
fn device_send(mgr: State<DeviceManager>, msg: Value) -> Result<(), String> {
    serial::send(&mgr, &msg)
}

#[tauri::command]
fn connected_port(mgr: State<DeviceManager>) -> Option<String> {
    mgr.connected_port()
}

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    drive::list_drives()
}

/// Live device-link state for the sidebar status indicator (issue #16):
/// "transfer" when a drive operation starts, then one terminal state when it
/// finishes — "idle", "busy" (firmware answered busy) or "unresponsive"
/// (reply timeout / stalled serial write).
fn emit_status(app: &AppHandle, state: &str) {
    let _ = app.emit("device:status", state);
}

fn emit_result_status<T>(app: &AppHandle, r: &Result<T, String>) {
    match r {
        Err(e) if e.contains("did not answer in time") || e.contains("os error 121") => {
            emit_status(app, "unresponsive")
        }
        Err(e) if e.contains("busy") => emit_status(app, "busy"),
        _ => emit_status(app, "idle"),
    }
}

/// Write to the keypad. `drive` is either a CIRCUITPY mount point or the
/// `serial:<uid>` sentinel (USB drive hidden — files travel over serial).
/// If a real drive is read-only (FAT dirty bit on macOS, or the firmware
/// holding the filesystem — the usual case on Windows), restart the keypad
/// over serial and retry once it re-mounts: the cross-platform equivalent
/// of unplug/replug. Async so the up-to-25s recovery never blocks the main
/// thread.
#[tauri::command]
async fn drive_write(
    app: AppHandle,
    drive: String,
    path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app, "transfer");
        let r = write_to_device(&app, &drive, &path, &content);
        emit_result_status(&app, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Route a file write to the mounted drive or the serial fs protocol.
/// Serial writes stream `drive:progress` events per acknowledged chunk —
/// large macros take seconds and the UI shows a progress bar (issue #10).
/// Mounted-drive writes are a single fast fs call; no progress to report.
fn write_to_device(app: &AppHandle, drive: &str, rel: &str, content: &str) -> Result<(), String> {
    write_to_device_bytes(app, drive, rel, content.as_bytes())
}

/// Byte-level variant for content that isn't guaranteed UTF-8 (BDF fonts,
/// vendored libraries). The serial path is binary-safe already (base64);
/// drive writes route through drive::write_file_bytes.
fn write_to_device_bytes(
    app: &AppHandle,
    drive: &str,
    rel: &str,
    content: &[u8],
) -> Result<(), String> {
    // a cancel request belongs to the previous transfer, not this one
    serialfs::clear_cancel();
    dbg_log!("write {rel} {}b", content.len());
    if serialfs::is_serial(drive) {
        let mgr = app.state::<DeviceManager>();
        serialfs::write_file(&mgr, rel, content, |written, total| {
            let _ = app.emit(
                "drive:progress",
                serde_json::json!({ "file": rel, "written": written, "total": total }),
            );
        })
    } else {
        drive_write_recovering(app, drive, rel, content)
    }
}

/// Quick retries for a busy-drive write (Windows semaphore timeout, os error
/// 121) before falling back to the heavy reset. Once playback is stopped the
/// board frees the USB link within a couple hundred ms.
const DRIVE_BUSY_RETRIES: u32 = 6;

fn drive_write_recovering(
    app: &AppHandle,
    drive: &str,
    rel: &str,
    content: &[u8],
) -> Result<(), String> {
    let err = match drive::write_file_bytes(drive, rel, content) {
        Ok(()) => return Ok(()),
        // The board was busy servicing playback so the USB write timed out
        // (os error 121). Stop any macro and retry — the drive-path analog of
        // the serial fs quiesce+retry. Only if it stays busy do we escalate to
        // the reset recovery below.
        Err(e) if e.starts_with(drive::BUSY_MARKER) => {
            let mgr = app.state::<DeviceManager>();
            let _ = serial::send(&mgr, &serde_json::json!({"t": "stop"}));
            let mut last = e;
            for _ in 0..DRIVE_BUSY_RETRIES {
                if serialfs::cancel_requested() {
                    return Err(serialfs::CANCELLED.to_string());
                }
                std::thread::sleep(Duration::from_millis(300));
                match drive::write_file_bytes(drive, rel, content) {
                    Ok(()) => return Ok(()),
                    // still busy, or the stalled write left the volume
                    // read-only — keep trying, then fall through to the reset
                    Err(e)
                        if e.starts_with(drive::BUSY_MARKER)
                            || e.starts_with(drive::READONLY_MARKER) =>
                    {
                        last = e
                    }
                    Err(e) => return Err(e),
                }
            }
            last
        }
        Err(e) if e.starts_with(drive::READONLY_MARKER) => e,
        Err(e) => return Err(e),
    };
    let human = err
        .trim_start_matches(drive::READONLY_MARKER)
        .trim_start_matches(drive::BUSY_MARKER)
        .trim()
        .to_string();
    // Remember which board owns this mount so we can find the drive again
    // after the reset (the mount point can change).
    let uid = drive::uid_of(drive);
    let mgr = app.state::<DeviceManager>();
    // Clean unmount first so the FAT dirty bit doesn't survive the reset.
    let _ = drive::eject(drive);
    if serial::send(&mgr, &serde_json::json!({"t": "reset"})).is_err() {
        return Err(format!(
            "{human} Restart the keypad from the Devices page (or unplug and replug it), then save again."
        ));
    }
    // The reset drops the serial port; the reader thread notices, emits
    // device:disconnected, and the frontend reconnects on its own.
    let deadline = Instant::now() + Duration::from_secs(25);
    let mut last = human;
    while Instant::now() < deadline {
        if serialfs::cancel_requested() {
            return Err(serialfs::CANCELLED.to_string());
        }
        std::thread::sleep(Duration::from_millis(1500));
        let target = match &uid {
            Some(uid) => drive::list_drives()
                .into_iter()
                .find(|d| &d.uid == uid)
                .map(|d| d.path),
            None => Some(drive.to_string()),
        };
        let Some(target) = target else { continue };
        match drive::write_file_bytes(&target, rel, content) {
            Ok(()) => return Ok(()),
            // mid-mount or still read-only — keep polling until the deadline
            Err(e) => last = e,
        }
    }
    Err(format!(
        "{} The keypad was restarted but its drive didn't come back writable — unplug and replug it.",
        last.trim_start_matches(drive::READONLY_MARKER)
            .trim_start_matches(drive::BUSY_MARKER)
            .trim()
    ))
}

/// Abort the in-flight keypad write (issue #15). The chunk loop notices the
/// flag between chunks and the write command rejects with the CANCELLED
/// marker; the frontend then removes the half-written file.
#[tauri::command]
fn drive_write_cancel() {
    serialfs::request_cancel();
}

#[tauri::command]
async fn drive_read(app: AppHandle, drive: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app, "transfer");
        let t0 = Instant::now();
        let r = if serialfs::is_serial(&drive) {
            let mgr = app.state::<DeviceManager>();
            serialfs::read_file(&mgr, &path)
                .and_then(|bytes| String::from_utf8(bytes).map_err(|e| e.to_string()))
        } else {
            drive::read_file(&drive, &path)
        };
        match &r {
            Ok(s) => dbg_log!("read {path} ok {}b {}ms", s.len(), t0.elapsed().as_millis()),
            Err(e) => dbg_log!("read {path} ERR {e} {}ms", t0.elapsed().as_millis()),
        }
        emit_result_status(&app, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn drive_delete(app: AppHandle, drive: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app, "transfer");
        let r = if serialfs::is_serial(&drive) {
            let mgr = app.state::<DeviceManager>();
            serialfs::delete_file(&mgr, &path)
        } else {
            drive::delete_file(&drive, &path)
        };
        emit_result_status(&app, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn drive_list(app: AppHandle, drive: String, path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app, "transfer");
        let t0 = Instant::now();
        let r = if serialfs::is_serial(&drive) {
            let mgr = app.state::<DeviceManager>();
            serialfs::list_dir(&mgr, &path)
        } else {
            drive::list_dir(&drive, &path)
        };
        match &r {
            Ok(names) => dbg_log!("list {path} ok {} files {}ms", names.len(), t0.elapsed().as_millis()),
            Err(e) => dbg_log!("list {path} ERR {e} {}ms", t0.elapsed().as_millis()),
        }
        emit_result_status(&app, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Frontend debug tracing into the same debug.log (loader progress etc.).
#[tauri::command]
fn debug_log(msg: String) {
    dbg_log!("[ui] {msg}");
}

/// Cleanly unmount the drive before a device reset, so the next mount
/// doesn't come up read-only (macOS FAT dirty-bit behavior). A hidden
/// drive has nothing mounted — nothing to do.
#[tauri::command]
fn drive_eject(drive: String) -> Result<(), String> {
    if serialfs::is_serial(&drive) {
        return Ok(());
    }
    drive::eject(&drive)
}

/// `open`/`start` don't go through a shell, so expand a leading `~/` for
/// hand-typed paths.
fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return format!("{}/{rest}", home.to_string_lossy());
        }
    }
    p.to_string()
}

/// Open an app, file or URL with the OS default handler. Used by "launch"
/// key actions — plugin-opener's openPath is scoped out for arbitrary
/// paths, and the OS launchers handle both URLs and paths anyway.
#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    let target = expand_home(&target);
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&target).spawn();
    #[cfg(target_os = "windows")]
    let r = {
        use std::os::windows::process::CommandExt;
        // `start` needs an explicit (empty) window title before the target.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &target])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
    };
    #[cfg(target_os = "linux")]
    let r = std::process::Command::new("xdg-open").arg(&target).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Raw bytes of a local file (sound effects for key actions). Returned as a
/// raw IPC response so the frontend gets an ArrayBuffer, not a JSON array.
#[tauri::command]
fn read_local_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(expand_home(&path))
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// Play a sound file natively (afplay / MediaPlayer / ffplay). Returns an error
/// string the UI can show, so a bad path or missing player isn't silent.
#[tauri::command]
fn sound_play(path: String) -> Result<(), String> {
    sound::play(&expand_home(&path))
}

/// Stop every sound still playing (hold-to-stop key action).
#[tauri::command]
fn sound_stop() {
    sound::stop_all();
}

/// Fade every playing sound to silence over `ms`, then stop (hold-to-fade).
#[tauri::command]
fn sound_fade(ms: u64) {
    sound::fade(ms);
}

/// Names of every audio output device (Settings > secondary output picker).
#[tauri::command]
fn sound_outputs() -> Vec<String> {
    sound::outputs()
}

/// Also play sounds into this output device (virtual device for streams /
/// calls); None or empty turns the second route off.
#[tauri::command]
fn sound_secondary(name: Option<String>) {
    sound::set_secondary(name.filter(|n| !n.is_empty()));
}

#[derive(serde::Deserialize)]
struct SoundKeyDto {
    /// "layer:keyNo", e.g. "a:5"
    id: String,
    path: String,
    /// hold action: "fade" | "restart" | "stop" (absent = stop)
    #[serde(default)]
    hold: Option<String>,
}

/// Register which keys are "play sound" keys so the native serial reader can
/// play them even while the app is backgrounded (the webview is suspended
/// then). The app rebuilds and pushes this whenever assignments or the active
/// profile change.
#[tauri::command]
fn set_sound_keys(keys: Vec<SoundKeyDto>) {
    let map = keys
        .into_iter()
        .map(|k| (k.id, sound::SoundKey { path: k.path, hold: k.hold }))
        .collect();
    sound::set_keys(map);
}

/// Run a user-configured shell command (Stream Deck-style key action).
/// Fire-and-forget: the command is the user's own, output isn't collected.
#[tauri::command]
fn run_command(command: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/C", &command])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("sh")
            .args(["-lc", &command])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Mute/unmute/toggle the computer's default microphone (Stream Deck-style
/// "mic" key action). `mode` is "mute" | "unmute" | "toggle".
#[tauri::command]
fn mic_action(mode: String) -> Result<(), String> {
    vars::mic_action(&mode)
}

/// Whether the default microphone is currently muted — for the Vision 6 wheel
/// menu's live mic status card. None when unknown/unsupported.
#[tauri::command]
fn mic_state() -> Option<bool> {
    vars::mic_state()
}

/// Current system output volume (0..100 + mute) for the "volume level" wheel
/// slider. None when there's no default output device.
#[tauri::command]
fn output_volume_get() -> Option<volume::VolumeState> {
    volume::get()
}

/// Set the system output volume (0..100). Applied live as the wheel turns.
#[tauri::command]
fn output_volume_set(percent: u8) -> Result<(), String> {
    volume::set(percent)
}

/// Current mic input level (0..100 + mute) for the "mic level" wheel slider.
#[tauri::command]
fn mic_level_get() -> Option<volume::VolumeState> {
    volume::get_mic()
}

/// Set the mic input level (0..100). Applied live as the wheel turns.
#[tauri::command]
fn mic_level_set(percent: u8) -> Result<(), String> {
    volume::set_mic(percent)
}

#[derive(serde::Deserialize)]
struct WebhookHeader {
    name: String,
    value: String,
}

/// Fire a user-defined HTTP request (the "webhook" key action): method, URL,
/// headers and body are free-form, curl-style — smart lights, Discord,
/// Home Assistant… Returns the status code; a non-2xx answer is an error so
/// the UI can tell the user why the light didn't turn on.
#[tauri::command]
async fn http_request(
    url: String,
    method: Option<String>,
    headers: Option<Vec<WebhookHeader>>,
    body: Option<String>,
) -> Result<u16, String> {
    let method = reqwest::Method::from_bytes(
        method
            .as_deref()
            .unwrap_or("GET")
            .trim()
            .to_uppercase()
            .as_bytes(),
    )
    .map_err(|_| "invalid HTTP method".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.request(method, &url);
    for h in headers.unwrap_or_default() {
        // skip blank rows: an empty name is an invalid header and makes the
        // whole request builder error out (issue: undeletable empty header)
        let name = h.name.trim();
        if name.is_empty() {
            continue;
        }
        // an invalid header name/value is reported by send(), not a panic
        req = req.header(name, h.value);
    }
    if let Some(b) = body {
        if !b.is_empty() {
            req = req.body(b);
        }
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.is_success() {
        Ok(status.as_u16())
    } else {
        Err(format!("the server answered HTTP {status}"))
    }
}

#[tauri::command]
async fn check_update() -> Result<updater::UpdateInfo, String> {
    updater::check(env!("CARGO_PKG_VERSION")).await
}

/// Read a file the user picked via the open-file dialog (macro JSON import).
#[tauri::command]
fn read_local_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Write a file to a user-chosen path (macro JSON export).
#[tauri::command]
fn write_local_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn recorder_start(app: AppHandle) {
    recorder::capture::ensure_listener(app);
    recorder::capture::start();
}

#[tauri::command]
fn recorder_stop() {
    recorder::capture::stop();
}

#[tauri::command]
fn recorder_state(app: AppHandle) -> bool {
    recorder::capture::ensure_listener(app);
    recorder::capture::is_capturing()
}

/// What each positional key label types on the user's current keyboard
/// layout. Deliberately sync: Tauri runs sync commands on the main thread,
/// which macOS requires for the TIS/UCKeyTranslate calls inside.
#[tauri::command]
fn keyboard_layout() -> std::collections::HashMap<String, layout::KeyChars> {
    layout::layout_map()
}

#[tauri::command]
fn preview_play(
    app: AppHandle,
    preview: State<Preview>,
    events: Vec<Value>,
    speed: f64,
) -> Result<(), String> {
    preview.play(app, events, speed)
}

#[tauri::command]
fn preview_stop(preview: State<Preview>) {
    preview.stop();
}

#[tauri::command]
fn foreground_start(app: AppHandle) {
    profiles::foreground::ensure_watcher(app);
}

#[tauri::command]
fn permissions_status() -> permissions::PermissionsStatus {
    permissions::status()
}

/// Trigger the system prompt / open the right System Settings pane.
#[tauri::command]
fn permissions_request(kind: String) {
    permissions::request(&kind);
}

/// Relaunch the app — needed on macOS for a fresh Input Monitoring grant to
/// take effect.
#[tauri::command]
fn app_restart(app: AppHandle) {
    app.restart();
}

/// Version of the firmware bundled with this app build.
#[tauri::command]
fn firmware_bundled_version(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .resolve("firmware", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    std::fs::read_to_string(dir.join("VERSION"))
        .map(|s| s.trim().to_string())
        .map_err(|e| e.to_string())
}

/// Every file under `dir`, as forward-slash paths rooted at `prefix`
/// (e.g. "lib/adafruit_display_text/label.py"). Recursive; dotfiles
/// (.DS_Store and friends) are left behind on purpose.
fn walk_files(dir: &std::path::Path, prefix: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{prefix}: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let rel = format!("{prefix}/{name}");
        if entry.path().is_dir() {
            out.extend(walk_files(&entry.path(), &rel)?);
        } else {
            out.push(rel);
        }
    }
    Ok(out)
}

/// Copy the bundled firmware onto the device — via its drive, or over
/// serial when the drive is hidden. Never touches the user's config.json or
/// macros/ — only code + modules + vendored lib/ + fonts/ + VERSION (and
/// settings.toml when the bundle ships one). Uses the same read-only
/// recovery as drive_write, so it's async off the main thread.
///
/// Safety rails (the update path must never be able to brick a board):
/// - the keypad is locked into update mode first (proto v7 update_begin:
///   keys/menus dead, progress on its screen, only file traffic accepted);
///   older firmware ignores the command and updates like before
/// - every file is verified after landing (serial: per-file CRC32 handshake;
///   drive: byte-for-byte read-back) — a corrupted file fails the update
///   instead of shipping
/// - `firmware:progress` events drive the app's blocking progress modal
/// - VERSION still goes last, so a half-finished update self-heals by
///   simply running again
/// - on failure the lock is released (update_abort) and the device keeps
///   running its old firmware
#[tauri::command]
async fn firmware_update(app: AppHandle, drive: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app, "transfer");
        let r = firmware_update_run(&app, &drive);
        emit_result_status(&app, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Directories the firmware owns outright: everything inside belongs to the
/// bundle, so a sync may delete whatever the bundle doesn't ship. The user's
/// own files (config.json, macros/, boot_out.txt) live outside them and are
/// never touched.
const FIRMWARE_DIRS: &[&str] = &["mkyada", "lib", "fonts"];

/// Root files the bundle manages. Anything else in / is left alone.
const FIRMWARE_ROOT_FILES: &[&str] = &["boot.py", "code.py", "settings.toml", "VERSION"];

fn firmware_update_run(app: &AppHandle, drive: &str) -> Result<Vec<String>, String> {
    firmware_sync_run(app, drive, None)
}

/// How the board's firmware tree differs from the bundle — the first screen
/// of the recovery wizard, and the proof afterwards that the repair actually
/// changed something. Cheap on purpose: sizes come from directory listings,
/// only VERSION and config.json are read, so it runs in well under a second
/// even over the serial link.
#[derive(serde::Serialize)]
struct FirmwareDiagnosis {
    bundle_version: String,
    device_version: Option<String>,
    /// config.json's model, when the board has one — absent means nobody has
    /// ever told this board what hardware it is (the wizard asks).
    model: Option<String>,
    /// bundle files the board doesn't have at all
    missing: Vec<String>,
    /// present, but not the size the bundle's copy has
    stale: Vec<String>,
    /// files inside the firmware's directories that the bundle doesn't ship
    extra: Vec<String>,
    /// bundle files that already match
    matching: usize,
    total: usize,
}

#[tauri::command]
async fn firmware_diagnose(app: AppHandle, drive: String) -> Result<FirmwareDiagnosis, String> {
    tauri::async_runtime::spawn_blocking(move || firmware_diagnose_run(&app, &drive))
        .await
        .map_err(|e| e.to_string())?
}

fn firmware_diagnose_run(app: &AppHandle, drive: &str) -> Result<FirmwareDiagnosis, String> {
    let files = bundle_files(app)?;
    let tree = device_tree(app, drive)?;

    let mut d = FirmwareDiagnosis {
        bundle_version: text_of(&files, "VERSION"),
        device_version: read_from_device(app, drive, "VERSION")
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string()),
        model: read_from_device(app, drive, "config.json")
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string)),
        missing: Vec::new(),
        stale: Vec::new(),
        extra: Vec::new(),
        matching: 0,
        total: files.len(),
    };
    for (path, content) in &files {
        match tree.get(path) {
            None => d.missing.push(path.clone()),
            // Size is enough to separate versions of a module and costs no
            // reads. Two builds of the same file that differ only in bytes
            // are rewritten by the repair anyway — it never skips a file.
            Some(&size) if size != content.len() as u64 => d.stale.push(path.clone()),
            Some(_) => d.matching += 1,
        }
    }
    let bundled: std::collections::HashSet<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    d.extra = tree
        .keys()
        .filter(|p| !bundled.contains(p.as_str()))
        .cloned()
        .collect();
    Ok(d)
}

fn text_of(files: &[(String, Vec<u8>)], path: &str) -> String {
    files
        .iter()
        .find(|(p, _)| p == path)
        .map(|(_, c)| String::from_utf8_lossy(c).trim().to_string())
        .unwrap_or_default()
}

fn read_from_device(app: &AppHandle, drive: &str, rel: &str) -> Result<Vec<u8>, String> {
    if serialfs::is_serial(drive) {
        serialfs::read_file(&app.state::<DeviceManager>(), rel)
    } else {
        drive::read_file_bytes(drive, rel)
    }
}

/// Full repair: rewrite the firmware tree, delete what doesn't belong, and
/// stamp the model the user picked. Same machinery as an update — the
/// difference is that a rescue-mode board can't tell us what it is, so the
/// wizard supplies the model instead of reading it off the device.
#[tauri::command]
async fn firmware_repair(
    app: AppHandle,
    drive: String,
    model: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        emit_status(&app, "transfer");
        let r = firmware_sync_run(&app, &drive, model.as_deref());
        emit_result_status(&app, &r);
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Is this bundle file worth installing, or is it something an earlier build
/// left in the resource directory?
///
/// The app's resource dir is not rebuilt from scratch: the bundler copies the
/// current firmware tree in without removing what a previous build put there.
/// So a module retired three releases ago, or the `.py` source of a module
/// that is now shipped compiled, can outlive the tree it came from — and then
/// gets faithfully installed onto a keypad. That is the same mixed-version
/// state the recovery wizard exists to clean up, sourced from our own side of
/// the wire: CircuitPython imports `models.mpy` over `models.py`, so the
/// stale source rides along invisibly until a partial write makes it the one
/// that loads. Ship the compiled module alone, and never ship `__pycache__`.
fn keep_bundle_file(rel: &str, present: &std::collections::HashSet<&str>) -> bool {
    if rel.split('/').any(|c| c == "__pycache__") {
        return false;
    }
    match rel.strip_suffix(".py") {
        Some(stem) => !present.contains(format!("{stem}.mpy").as_str()),
        None => true,
    }
}

/// The bundled firmware tree as (device path, contents), in install order.
fn bundle_files(app: &AppHandle) -> Result<Vec<(String, Vec<u8>)>, String> {
    let src = app
        .path()
        .resolve("firmware", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    // Build the whole manifest up front: update_begin announces the byte
    // total (the device's own progress bar) and the UI needs file counts.
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    for name in ["boot.py", "code.py"] {
        files.push((
            name.to_string(),
            std::fs::read(src.join(name)).map_err(|e| format!("{name}: {e}"))?,
        ));
    }
    // CircuitPython reads settings.toml at boot; optional in the bundle.
    if src.join("settings.toml").is_file() {
        files.push((
            "settings.toml".to_string(),
            std::fs::read(src.join("settings.toml")).map_err(|e| format!("settings.toml: {e}"))?,
        ));
    }
    // Firmware modules: release bundles ship precompiled .mpy (no on-device
    // compile — the RP2040 heap can't always compile the big modules from
    // source), dev builds ship .py. Take whichever the bundle has. Vendored
    // libraries and fonts come along too: they must match the code that
    // imports them. Collected as one path list so the filter below can see
    // the whole picture before anything is read.
    let mut rels: Vec<String> = Vec::new();
    let modules = std::fs::read_dir(src.join("mkyada")).map_err(|e| e.to_string())?;
    for entry in modules.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if file.ends_with(".py") || file.ends_with(".mpy") {
            rels.push(format!("mkyada/{file}"));
        }
    }
    for dir in ["lib", "fonts"] {
        rels.extend(walk_files(&src.join(dir), dir)?);
    }
    let present: std::collections::HashSet<&str> = rels.iter().map(String::as_str).collect();
    let keep: Vec<String> = rels
        .iter()
        .filter(|r| keep_bundle_file(r, &present))
        .cloned()
        .collect();
    // BDF fonts aren't guaranteed to be valid UTF-8, so everything rides the
    // bytes path.
    for rel in keep {
        let content = std::fs::read(src.join(&rel)).map_err(|e| format!("{rel}: {e}"))?;
        files.push((rel, content));
    }
    // VERSION goes LAST: if the transfer dies midway the device keeps
    // reporting its old version, so the "update available" banner comes
    // back and the update can simply be run again. Writing it first
    // would leave a half-updated tree that already claims to be current
    // — invisible until something breaks (seen in the field as a
    // boot.py/engine.py HID descriptor mismatch crash-looping the
    // device on every key press).
    let version = std::fs::read(src.join("VERSION")).map_err(|e| e.to_string())?;
    files.push(("VERSION".to_string(), version));
    Ok(files)
}

/// Install the bundle and make the device's firmware directories MATCH it:
/// write every file, then delete whatever the bundle no longer ships.
///
/// The delete half is what keeps a half-finished update from becoming a
/// permanent one. An update that only ever wrote left the board holding a mix
/// of versions — a new `app.mpy` importing a name its stale `models.py` never
/// defined — and re-running the same update reproduced the same mix, because
/// nothing ever removed the stale file. `model` (recovery only) is stamped
/// into config.json once the tree has landed.
fn firmware_sync_run(
    app: &AppHandle,
    drive: &str,
    model: Option<&str>,
) -> Result<Vec<String>, String> {
    let files = bundle_files(app)?;
    let total_bytes: usize = files.iter().map(|(_, c)| c.len()).sum();
    let total_files = files.len();
    // Lock the keypad (best-effort: pre-v7 firmware answers err/nothing and
    // simply updates unlocked, exactly like before).
    {
        let mgr = app.state::<DeviceManager>();
        let _ = serial::send(
            &mgr,
            &serde_json::json!({"t": "update_begin", "bytes": total_bytes}),
        );
    }
    let result = firmware_write_all(app, drive, &files, total_bytes, total_files);
    if result.is_ok() {
        firmware_prune_extra(app, drive, &files);
        if let Some(m) = model {
            // Best-effort: a board whose tree is now correct must not be
            // reported as failed because only the model stamp missed.
            if let Err(e) = firmware_write_model(app, drive, m) {
                dbg_log!("model stamp failed: {e}");
            }
        }
    }
    if result.is_err() {
        // release the lock so the keypad goes back to being a keypad
        let mgr = app.state::<DeviceManager>();
        let _ = serial::send(&mgr, &serde_json::json!({"t": "update_abort"}));
    }
    result
}

/// Delete everything inside the firmware's own directories that the bundle
/// doesn't ship: the stale `.py` twin of a module now compiled to `.mpy`, a
/// module a later version renamed or dropped, libraries a rewrite retired
/// (the 0.20.0 framebuffer work left ~248KB of adafruit_display_text and
/// adafruit_bitmap_font on every board that upgraded rather than being
/// flashed fresh), fonts an older UI used.
///
/// Best-effort per file: a delete that fails costs flash, not correctness, so
/// it must never fail an otherwise-good install.
fn firmware_prune_extra(app: &AppHandle, drive: &str, files: &[(String, Vec<u8>)]) {
    let bundled: std::collections::HashSet<&str> =
        files.iter().map(|(p, _)| p.as_str()).collect();
    let tree = match device_tree(app, drive) {
        Ok(t) => t,
        Err(e) => return dbg_log!("prune: cannot list the device tree: {e}"),
    };
    for path in tree.keys() {
        if bundled.contains(path.as_str()) {
            continue;
        }
        dbg_log!("prune {path}");
        let _ = if serialfs::is_serial(drive) {
            serialfs::delete_file(&app.state::<DeviceManager>(), path)
        } else {
            drive::delete_file(drive, path)
        };
    }
}

/// Every firmware-owned file on the device, as `path -> size`. Only the
/// directories the bundle owns plus the root files it manages: the user's
/// config.json, macros/ and the board's own boot_out.txt stay out of it, so
/// nothing here can ever be pruned by mistake.
fn device_tree(app: &AppHandle, drive: &str) -> Result<BTreeMap<String, u64>, String> {
    let mut out = BTreeMap::new();
    for e in device_entries(app, drive, "")? {
        if !e.dir && FIRMWARE_ROOT_FILES.contains(&e.name.as_str()) {
            out.insert(e.name, e.size);
        }
    }
    for dir in FIRMWARE_DIRS {
        device_collect(app, drive, dir, &mut out)?;
    }
    Ok(out)
}

fn device_collect(
    app: &AppHandle,
    drive: &str,
    dir: &str,
    out: &mut BTreeMap<String, u64>,
) -> Result<(), String> {
    for e in device_entries(app, drive, dir)? {
        let path = format!("{dir}/{}", e.name);
        if e.dir {
            device_collect(app, drive, &path, out)?;
        } else {
            out.insert(path, e.size);
        }
    }
    Ok(())
}

fn device_entries(app: &AppHandle, drive: &str, rel: &str) -> Result<Vec<device::Entry>, String> {
    if serialfs::is_serial(drive) {
        serialfs::list_entries(&app.state::<DeviceManager>(), rel)
    } else {
        drive::list_entries(drive, rel)
    }
}

/// Stamp the hardware model into config.json. In rescue mode the firmware
/// never ran, so nothing on the board knows which model this is — boot.py
/// reads this field to pick the USB product name and the recovery pin, and
/// the running firmware to pick the display, encoder and key wiring. The rest
/// of the user's config is preserved; an unreadable one is rebuilt minimally
/// (the firmware fills every absent field from its own defaults).
fn firmware_write_model(app: &AppHandle, drive: &str, model: &str) -> Result<(), String> {
    let existing = if serialfs::is_serial(drive) {
        serialfs::read_file(&app.state::<DeviceManager>(), "config.json").ok()
    } else {
        drive::read_file_bytes(drive, "config.json").ok()
    };
    let mut cfg = existing
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    cfg.entry("format").or_insert_with(|| json!("mkyada-config"));
    cfg.entry("version").or_insert_with(|| json!(1));
    cfg.insert("model".into(), json!(model));
    // A Vision 6 has exactly six macro keys; a config carrying a Core 6's
    // higher count would be clamped by the firmware anyway, and a wrong count
    // here is what draws the wrong number of keys in the app.
    if model == "vision6" {
        cfg.insert("key_count".into(), json!(6));
        cfg.insert("layer_key".into(), Value::Null);
    }
    let body = serde_json::to_vec_pretty(&Value::Object(cfg)).map_err(|e| e.to_string())?;
    write_to_device_bytes(app, drive, "config.json", &body)
}

fn firmware_write_all(
    app: &AppHandle,
    drive: &str,
    files: &[(String, Vec<u8>)],
    total_bytes: usize,
    total_files: usize,
) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    let mut done_bytes = 0usize;
    for (i, (rel, content)) in files.iter().enumerate() {
        let _ = app.emit(
            "firmware:progress",
            serde_json::json!({
                "file": rel, "index": i, "files": total_files,
                "done": done_bytes, "total": total_bytes,
            }),
        );
        firmware_write_verified(app, drive, rel, content).map_err(|e| format!("{rel}: {e}"))?;
        // A module that changed shape between source and compiled form must
        // not leave its stale twin behind — CircuitPython would happily
        // import the leftover instead of the file we just wrote.
        if let Some(twin) = twin_path(rel) {
            let _ = if serialfs::is_serial(drive) {
                serialfs::delete_file(&app.state::<DeviceManager>(), &twin)
            } else {
                drive::delete_file(drive, &twin)
            };
        }
        done_bytes += content.len();
        written.push(rel.clone());
    }
    let _ = app.emit(
        "firmware:progress",
        serde_json::json!({
            "file": "", "index": total_files, "files": total_files,
            "done": total_bytes, "total": total_bytes,
        }),
    );
    Ok(written)
}

/// The other-extension sibling of a firmware module ("mkyada/ui.mpy" ->
/// "mkyada/ui.py"), for python files under mkyada/ and lib/ only.
fn twin_path(rel: &str) -> Option<String> {
    if !(rel.starts_with("mkyada/") || rel.starts_with("lib/")) {
        return None;
    }
    rel.strip_suffix(".py")
        .map(|s| format!("{s}.mpy"))
        .or_else(|| rel.strip_suffix(".mpy").map(|s| format!("{s}.py")))
}

/// Write one firmware file and prove it landed intact. The serial path
/// CRC32-verifies inside write_file (proto v7); the drive path gets a
/// byte-for-byte read-back — USB mass storage has no end-to-end ack and a
/// silently truncated module is exactly how boards used to brick.
fn firmware_write_verified(
    app: &AppHandle,
    drive: &str,
    rel: &str,
    content: &[u8],
) -> Result<(), String> {
    // Don't rewrite a font the device already has byte-for-byte. The running
    // firmware keeps /fonts/*.bdf OPEN the whole time (adafruit_bitmap_font
    // rasterizes glyphs lazily off disk), and FAT can't os.remove/rename a
    // file that's open — so overwriting the in-use font (spleen, the UI font)
    // failed the transfer at that stage. Fonts don't change between versions,
    // so skipping the identical write sidesteps the collision even on firmware
    // that doesn't release its fonts on update_begin. A read failure (missing
    // file / transient) just falls through to a normal write.
    if rel.starts_with("fonts/") {
        let existing = if serialfs::is_serial(drive) {
            serialfs::read_file(&app.state::<DeviceManager>(), rel).ok()
        } else {
            drive::read_file_bytes(drive, rel).ok()
        };
        if existing.as_deref() == Some(content) {
            return Ok(());
        }
    }
    write_to_device_bytes(app, drive, rel, content)?;
    if !serialfs::is_serial(drive) {
        let back = drive::read_file_bytes(drive, rel)?;
        if back != content {
            return Err("verification read-back does not match".to_string());
        }
    }
    Ok(())
}

/// UF2 bootloader drives currently mounted (a blank or BOOTSEL-held RP2040)
/// — the targets for provisioning a factory-fresh board.
#[tauri::command]
fn list_bootloader_drives() -> Vec<bootloader::BootDriveInfo> {
    bootloader::list_drives()
}

/// Flash the bundled CircuitPython UF2 onto a bootloader drive. The board
/// reboots the moment the copy lands (see device::bootloader), so this runs
/// off the main thread and treats the drive vanishing mid-flush as success.
#[tauri::command]
async fn provision_flash_uf2(app: AppHandle, mount: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app
            .path()
            .resolve("circuitpython", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        let uf2 = bootloader::bundled_uf2(&dir)?;
        bootloader::flash_uf2(&uf2, &mount)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tauri's set_ignore_cursor_events only styles the top-level window. On
/// Windows the WebView2 child HWNDs still hit-test, so the "click-through"
/// overlay swallowed every click on the machine (issues #1/#2). Push the
/// transparent/no-activate styles onto every child window too. Idempotent —
/// called again from the watchdog because WebView2 creates its child
/// windows asynchronously, possibly after the first pass.
#[cfg(target_os = "windows")]
fn harden_click_through(w: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    type Hwnd = *mut c_void;
    #[link(name = "user32")]
    extern "system" {
        fn EnumChildWindows(
            parent: Hwnd,
            cb: extern "system" fn(Hwnd, isize) -> i32,
            lparam: isize,
        ) -> i32;
        fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
    }
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TRANSPARENT: isize = 0x20;
    const WS_EX_LAYERED: isize = 0x0008_0000;
    const WS_EX_NOACTIVATE: isize = 0x0800_0000;
    extern "system" fn apply(hwnd: Hwnd, _lparam: isize) -> i32 {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE,
            );
        }
        1 // keep enumerating
    }
    if let Ok(h) = w.hwnd() {
        unsafe { EnumChildWindows(h.0 as Hwnd, apply, 0) };
    }
}

#[cfg(not(target_os = "windows"))]
fn harden_click_through(_w: &tauri::WebviewWindow) {}

/// Build the full-screen, transparent, click-through overlay window (hidden).
///
/// macOS/Linux only: it's created ONCE at startup and kept warm for the app's
/// lifetime, then only ever shown/hidden. (On Windows WebView2 transparent
/// windows render opaque black — tauri#8308 — so there the overlay is a native
/// GDI layered window instead; see [`overlay_win`].)
#[cfg(not(target_os = "windows"))]
fn build_overlay(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html".into()))
        .title("MKYADA overlay")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .shadow(false)
        .visible(false)
        .position(0.0, 0.0)
        .inner_size(size.width, size.height)
        .build()
        .map_err(|e| e.to_string())
}

/// Full-screen, click-through, transparent overlay used to draw the recorded
/// mouse path on the real screen (port of the old tkinter overlay). Native GDI
/// layered window on Windows; transparent WebView2 window elsewhere.
#[tauri::command]
fn overlay_show(
    app: AppHandle,
    liveness: State<OverlayLiveness>,
    alive: State<OverlayAlive>,
) -> Result<(), String> {
    // fresh grace period — the watchdog must not kill the window we're about to
    // show before the editor's first ping (last) or the overlay webview's first
    // overlay:alive land. Both get up to their timeout from NOW.
    *liveness.0.lock().unwrap() = Instant::now();
    *alive.0.lock().unwrap() = Instant::now();

    #[cfg(target_os = "windows")]
    {
        let _ = &app;
        // Native layered-window overlay. The scene is fed separately by the
        // `overlay:data` listener (from the editor); here we just show it.
        overlay_win::show();
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        // The overlay is pre-created at startup; only build here as a fallback.
        let w = match app.get_webview_window("overlay") {
            Some(w) => w,
            None => build_overlay(&app)?,
        };
        // Click-through: the overlay must never eat a click. Applied BEFORE
        // showing so the window is never a click trap while visible.
        if let Err(e) = w.set_ignore_cursor_events(true) {
            let _ = w.hide();
            return Err(format!("overlay click-through failed: {e}"));
        }
        harden_click_through(&w);
        w.show().map_err(|e| e.to_string())?;
        harden_click_through(&w);
        Ok(())
    }
}

/// Keep the main window above the game while fine-tuning macro coordinates.
#[tauri::command]
fn window_set_pin(app: AppHandle, pinned: bool) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("no main window")?;
    w.set_always_on_top(pinned).map_err(|e| e.to_string())
}

#[tauri::command]
fn overlay_hide(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let _ = &app;
        overlay_win::hide();
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(w) = app.get_webview_window("overlay") {
        // hide, not destroy: the window is created once at startup and kept
        // warm for the app's lifetime. Hidden, it can't trap clicks.
        let _ = w.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Keep the app fully active in the background so tray-mode key actions (sound,
/// webhook, launch…) fire the instant a key is pressed. Without this, macOS App
/// Nap suspends the process when it isn't the foreground app, stalling the
/// webview that triggers those actions — serial key events queue up and only
/// fire when the app is refocused ("sound only plays when the window is active").
///
/// `NSProcessInfo -beginActivityWithOptions:reason:` returns an activity token
/// that must be held for as long as we want App Nap disabled; we deliberately
/// leak it for the process lifetime. Options = NSActivityUserInitiated with the
/// idle-sleep bit cleared, so we prevent App Nap but still let the Mac sleep.
#[cfg(target_os = "macos")]
fn disable_app_nap() {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    type Id = *mut c_void;
    type Sel = *mut c_void;

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
    }

    // NSActivityUserInitiated (0x00FFFFFF) with NSActivityIdleSystemSleepDisabled
    // (1<<20) cleared: no App Nap, but the display/system may still sleep.
    const OPTIONS: u64 = 0x00FF_FFFF & !(1u64 << 20);

    unsafe {
        let ns_process_info = objc_getClass(c"NSProcessInfo".as_ptr());
        let ns_string = objc_getClass(c"NSString".as_ptr());
        if ns_process_info.is_null() || ns_string.is_null() {
            return;
        }
        let sel_pi = sel_registerName(c"processInfo".as_ptr());
        let sel_begin = sel_registerName(c"beginActivityWithOptions:reason:".as_ptr());
        let sel_str = sel_registerName(c"stringWithUTF8String:".as_ptr());
        let sel_retain = sel_registerName(c"retain".as_ptr());

        let send_cls: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
        let pi = send_cls(ns_process_info, sel_pi);
        if pi.is_null() {
            return;
        }
        let send_str: extern "C" fn(Id, Sel, *const c_char) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let reason = send_str(ns_string, sel_str, c"MKYADA runs key actions in the background".as_ptr());

        let send_begin: extern "C" fn(Id, Sel, u64, Id) -> Id =
            std::mem::transmute(objc_msgSend as *const c_void);
        let token = send_begin(pi, sel_begin, OPTIONS, reason);
        if !token.is_null() {
            // retain and never release: the activity (and thus the App Nap
            // exemption) then lasts the whole process lifetime
            let send_retain: extern "C" fn(Id, Sel) -> Id =
                std::mem::transmute(objc_msgSend as *const c_void);
            let _ = send_retain(token, sel_retain);
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        // single-instance must be the first plugin: a second launch hands its
        // argv to us and exits, we surface the existing window instead
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            use tauri::Listener;
            #[cfg(target_os = "macos")]
            disable_app_nap();
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&format!("MKYADA v{}", env!("CARGO_PKG_VERSION")));
            }
            setup_tray(app)?;
            // macOS/Linux WebView2-overlay setup: harden click-through once the
            // overlay webview signals `overlay:ready`, and pre-create it hidden
            // at startup so it warm-inits undisturbed. (Windows draws the overlay
            // natively — see overlay_win — so none of this applies there.)
            #[cfg(not(target_os = "windows"))]
            {
                let h = app.handle().clone();
                app.listen("overlay:ready", move |_| {
                    if let Some(w) = h.get_webview_window("overlay") {
                        let _ = w.set_ignore_cursor_events(true);
                        harden_click_through(&w);
                    }
                });
                if let Err(e) = build_overlay(app.handle()) {
                    eprintln!("overlay pre-create failed: {e}");
                }
            }
            // Overlay watchdog. Two independent heartbeats guard the fullscreen
            // topmost window; if EITHER goes quiet while the overlay is visible,
            // hide it (keep it warm, though):
            //   * `last`  — the editor (main window) proves it's alive via
            //     overlay:ping/overlay:data. Stops if the editor closed/died.
            //   * `alive` — the OVERLAY's own JS proves IT is alive via
            //     overlay:alive. Stops if the overlay webview died/hung while on
            //     screen — which would otherwise be an inescapable black
            //     full-screen trap (the JS failsafes can't run if the JS is
            //     dead). This is the escape hatch that must never be missing.
            let last = Arc::new(Mutex::new(Instant::now()));
            let alive = Arc::new(Mutex::new(Instant::now()));
            app.manage(OverlayLiveness(last.clone()));
            app.manage(OverlayAlive(alive.clone()));
            {
                let l = last.clone();
                app.listen("overlay:ping", move |_| {
                    *l.lock().unwrap() = Instant::now();
                });
                let l = last.clone();
                app.listen("overlay:data", move |_event| {
                    *l.lock().unwrap() = Instant::now();
                    // Windows draws the overlay natively — parse the editor's
                    // macro payload into a scene and push it to the layered
                    // window. (Elsewhere the overlay webview draws it itself.)
                    #[cfg(target_os = "windows")]
                    overlay_win::set_scene_from_payload(_event.payload());
                });
                let a = alive.clone();
                app.listen("overlay:alive", move |_| {
                    *a.lock().unwrap() = Instant::now();
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let editor_gone = last.lock().unwrap().elapsed() > Duration::from_secs(5);
                #[cfg(target_os = "windows")]
                {
                    let _ = &handle;
                    let _ = &alive;
                    // Native overlay: if the editor stops vouching for it while
                    // it's up, hide it. (It can't hang/black-trap like the
                    // webview did — we own the drawing thread — so the
                    // overlay:alive check isn't needed here.)
                    if overlay_win::is_visible() && editor_gone {
                        overlay_win::hide();
                    }
                }
                #[cfg(not(target_os = "windows"))]
                if let Some(w) = handle.get_webview_window("overlay") {
                    if !w.is_visible().unwrap_or(false) {
                        continue;
                    }
                    // The overlay emits overlay:alive every 500ms; ~2s of silence
                    // means its webview is dead/hung — tear the trap down fast.
                    let overlay_dead = alive.lock().unwrap().elapsed() > Duration::from_secs(2);
                    if editor_gone || overlay_dead {
                        let _ = w.hide();
                    }
                }
            });
            Ok(())
        })
        // closing the window hides to the tray (unless the user turned
        // "run in background" off) — key actions and profiles keep working
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // The path overlay only makes sense while the editor is on
                    // screen — hide it when the main window goes to the tray so
                    // it never sits on top of the desktop "until reboot".
                    #[cfg(target_os = "windows")]
                    overlay_win::hide();
                    #[cfg(not(target_os = "windows"))]
                    if let Some(o) = window.app_handle().get_webview_window("overlay") {
                        let _ = o.hide();
                    }
                    if run_in_background(window.app_handle()) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .manage(DeviceManager::default())
        .manage(Preview::default())
        .manage(obs::ObsManager::default())
        .invoke_handler(tauri::generate_handler![
            scan_devices,
            connect_device,
            disconnect_device,
            device_send,
            connected_port,
            list_drives,
            drive_write,
            drive_write_cancel,
            drive_read,
            drive_delete,
            drive_list,
            drive_eject,
            run_command,
            sound_play,
            sound_stop,
            sound_outputs,
            sound_secondary,
            sound_fade,
            set_sound_keys,
            debug_log,
            open_target,
            mic_action,
            mic_state,
            output_volume_get,
            output_volume_set,
            mic_level_get,
            mic_level_set,
            http_request,
            obs::obs_connect,
            obs::obs_disconnect,
            obs::obs_action,
            obs::obs_request,
            obs::obs_state,
            read_local_bytes,
            check_update,
            read_local_file,
            write_local_file,
            recorder_start,
            recorder_stop,
            recorder_state,
            keyboard_layout,
            preview_play,
            preview_stop,
            foreground_start,
            permissions_status,
            permissions_request,
            app_restart,
            firmware_bundled_version,
            firmware_update,
            firmware_diagnose,
            firmware_repair,
            list_bootloader_drives,
            provision_flash_uf2,
            overlay_show,
            overlay_hide,
            window_set_pin,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // macOS: clicking the dock icon while the window is hidden in the
            // tray should bring it back (standard Reopen behavior)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
