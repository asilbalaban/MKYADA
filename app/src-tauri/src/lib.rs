mod device;
mod layout;
#[cfg(target_os = "windows")]
mod overlay_win;
mod permissions;
mod player;
mod profiles;
mod recorder;
mod updater;
mod vars;

use device::drive::{self, DriveInfo};
use device::serial::{self, DeviceInfo, DeviceManager};
use device::serialfs;
use player::Preview;
use serde_json::Value;
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
    serial::connect(app, &mgr, &port)
}

#[tauri::command]
fn disconnect_device(mgr: State<DeviceManager>) {
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
        write_to_device(&app, &drive, &path, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Route a file write to the mounted drive or the serial fs protocol.
/// Serial writes stream `drive:progress` events per acknowledged chunk —
/// large macros take seconds and the UI shows a progress bar (issue #10).
/// Mounted-drive writes are a single fast fs call; no progress to report.
fn write_to_device(app: &AppHandle, drive: &str, rel: &str, content: &str) -> Result<(), String> {
    // a cancel request belongs to the previous transfer, not this one
    serialfs::clear_cancel();
    if serialfs::is_serial(drive) {
        let mgr = app.state::<DeviceManager>();
        serialfs::write_file(&mgr, rel, content.as_bytes(), |written, total| {
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
    content: &str,
) -> Result<(), String> {
    let err = match drive::write_file(drive, rel, content) {
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
                match drive::write_file(drive, rel, content) {
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
        match drive::write_file(&target, rel, content) {
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
        if serialfs::is_serial(&drive) {
            let mgr = app.state::<DeviceManager>();
            let bytes = serialfs::read_file(&mgr, &path)?;
            String::from_utf8(bytes).map_err(|e| e.to_string())
        } else {
            drive::read_file(&drive, &path)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn drive_delete(app: AppHandle, drive: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if serialfs::is_serial(&drive) {
            let mgr = app.state::<DeviceManager>();
            serialfs::delete_file(&mgr, &path)
        } else {
            drive::delete_file(&drive, &path)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn drive_list(app: AppHandle, drive: String, path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if serialfs::is_serial(&drive) {
            let mgr = app.state::<DeviceManager>();
            serialfs::list_dir(&mgr, &path)
        } else {
            drive::list_dir(&drive, &path)
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
        // an invalid header name/value is reported by send(), not a panic
        req = req.header(h.name.trim(), h.value);
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

/// Copy the bundled firmware onto the device — via its drive, or over
/// serial when the drive is hidden. Never touches the user's config.json,
/// macros/ or lib/ — only code + modules + VERSION. Uses the same read-only
/// recovery as drive_write, so it's async off the main thread.
#[tauri::command]
async fn firmware_update(app: AppHandle, drive: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = app
            .path()
            .resolve("firmware", tauri::path::BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        let mut written = Vec::new();
        for name in ["boot.py", "code.py", "VERSION"] {
            let content = std::fs::read_to_string(src.join(name)).map_err(|e| e.to_string())?;
            write_to_device(&app, &drive, name, &content)?;
            written.push(name.to_string());
        }
        let modules = std::fs::read_dir(src.join("mkyada")).map_err(|e| e.to_string())?;
        for entry in modules.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if !file.ends_with(".py") {
                continue;
            }
            let content = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            write_to_device(&app, &drive, &format!("mkyada/{file}"), &content)?;
            written.push(format!("mkyada/{file}"));
        }
        Ok(written)
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
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&format!("MKYADA v{}", env!("CARGO_PKG_VERSION")));
            }
            setup_tray(app)?;
            vars::start(app.handle().clone());
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
            open_target,
            mic_action,
            http_request,
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
