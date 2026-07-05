mod device;
mod layout;
mod permissions;
mod player;
mod profiles;
mod recorder;
mod updater;
mod vars;

use device::drive::{self, DriveInfo};
use device::serial::{self, DeviceInfo, DeviceManager};
use player::Preview;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// Last time the editor proved it's alive while the overlay is up
/// (via `overlay:ping` / `overlay:data` events). The overlay is a fullscreen
/// topmost window — if the editor stops vouching for it, tear it down from
/// the Rust side even when the overlay webview itself is dead/blank.
struct OverlayLiveness(Arc<Mutex<Instant>>);

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
    use tauri::Emitter;

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

/// Write to the keypad drive. If the drive is read-only (FAT dirty bit on
/// macOS, or the firmware holding the filesystem — the usual case on
/// Windows), restart the keypad over serial and retry once it re-mounts:
/// the cross-platform equivalent of unplug/replug. Async so the up-to-25s
/// recovery never blocks the main thread.
#[tauri::command]
async fn drive_write(
    app: AppHandle,
    drive: String,
    path: String,
    content: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        drive_write_recovering(&app, &drive, &path, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn drive_write_recovering(
    app: &AppHandle,
    drive: &str,
    rel: &str,
    content: &str,
) -> Result<(), String> {
    let err = match drive::write_file(drive, rel, content) {
        Ok(()) => return Ok(()),
        Err(e) if e.starts_with(drive::READONLY_MARKER) => e,
        Err(e) => return Err(e),
    };
    let human = err
        .trim_start_matches(drive::READONLY_MARKER)
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
        last.trim_start_matches(drive::READONLY_MARKER).trim()
    ))
}

#[tauri::command]
fn drive_read(drive: String, path: String) -> Result<String, String> {
    drive::read_file(&drive, &path)
}

#[tauri::command]
fn drive_delete(drive: String, path: String) -> Result<(), String> {
    drive::delete_file(&drive, &path)
}

#[tauri::command]
fn drive_list(drive: String, path: String) -> Result<Vec<String>, String> {
    drive::list_dir(&drive, &path)
}

/// Cleanly unmount the drive before a device reset, so the next mount
/// doesn't come up read-only (macOS FAT dirty-bit behavior).
#[tauri::command]
fn drive_eject(drive: String) -> Result<(), String> {
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

/// Copy the bundled firmware onto the device drive. Never touches the user's
/// config.json, macros/ or lib/ — only code + modules + VERSION. Uses the
/// same read-only recovery as drive_write, so it's async off the main thread.
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
            drive_write_recovering(&app, &drive, name, &content)?;
            written.push(name.to_string());
        }
        let modules = std::fs::read_dir(src.join("mkyada")).map_err(|e| e.to_string())?;
        for entry in modules.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if !file.ends_with(".py") {
                continue;
            }
            let content = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            drive_write_recovering(&app, &drive, &format!("mkyada/{file}"), &content)?;
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

/// Full-screen, click-through, transparent overlay window used to draw the
/// recorded mouse path on the real screen (port of the old tkinter overlay).
#[tauri::command]
fn overlay_show(app: AppHandle, liveness: State<OverlayLiveness>) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    // fresh grace period — the watchdog must not kill the window we're
    // about to show before the editor's first ping arrives
    *liveness.0.lock().unwrap() = Instant::now();
    if let Some(w) = app.get_webview_window("overlay") {
        if let Err(e) = w.set_ignore_cursor_events(true) {
            let _ = w.destroy();
            return Err(format!("overlay click-through failed: {e}"));
        }
        harden_click_through(&w);
        w.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("no monitor")?;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    // Build hidden, make it click-through FIRST, then show. If the window
    // became visible before ignore_cursor_events landed (or that call
    // failed), a fullscreen topmost invisible window would swallow every
    // click on the machine — the user couldn't even reach Task Manager.
    let w = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("index.html".into()))
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
        .map_err(|e| e.to_string())?;
    if let Err(e) = w.set_ignore_cursor_events(true) {
        let _ = w.destroy(); // never leave a click-eating window behind
        return Err(format!("overlay click-through failed: {e}"));
    }
    harden_click_through(&w);
    w.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Keep the main window above the game while fine-tuning macro coordinates.
#[tauri::command]
fn window_set_pin(app: AppHandle, pinned: bool) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("no main window")?;
    w.set_always_on_top(pinned).map_err(|e| e.to_string())
}

#[tauri::command]
fn overlay_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        // destroy, not close: a blank/hung overlay webview (seen on Windows)
        // never answers a polite close request
        let _ = w.destroy();
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
            // Overlay watchdog: the editor heartbeats overlay:ping/overlay:data
            // every second while its overlay is up. If those stop (editor gone,
            // main webview dead) OR keep coming while nobody can see the app,
            // a fullscreen topmost window must never linger — destroy it.
            let last = Arc::new(Mutex::new(Instant::now()));
            app.manage(OverlayLiveness(last.clone()));
            {
                let l = last.clone();
                app.listen("overlay:ping", move |_| {
                    *l.lock().unwrap() = Instant::now();
                });
                let l = last.clone();
                app.listen("overlay:data", move |_| {
                    *l.lock().unwrap() = Instant::now();
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                if let Some(w) = handle.get_webview_window("overlay") {
                    if last.lock().unwrap().elapsed() > Duration::from_secs(5) {
                        let _ = w.destroy();
                    } else {
                        // WebView2 spawns child HWNDs late; keep re-applying
                        // the click-through styles while the overlay lives
                        harden_click_through(&w);
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
                    // screen. The hidden-to-tray webview keeps heartbeating, so
                    // without this the overlay would sit on top of the desktop
                    // "until reboot" (issue #2).
                    if let Some(o) = window.app_handle().get_webview_window("overlay") {
                        let _ = o.destroy();
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
            drive_read,
            drive_delete,
            drive_list,
            drive_eject,
            run_command,
            open_target,
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
