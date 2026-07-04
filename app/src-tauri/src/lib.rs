mod device;
mod permissions;
mod player;
mod profiles;
mod recorder;
mod updater;

use device::drive::{self, DriveInfo};
use device::serial::{self, DeviceInfo, DeviceManager};
use player::Preview;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

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

#[tauri::command]
fn drive_write(drive: String, path: String, content: String) -> Result<(), String> {
    drive::write_file(&drive, &path, &content)
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
/// config.json, macros/ or lib/ — only code + modules + VERSION.
#[tauri::command]
fn firmware_update(app: AppHandle, drive: String) -> Result<Vec<String>, String> {
    let src = app
        .path()
        .resolve("firmware", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let mut written = Vec::new();
    for name in ["boot.py", "code.py", "VERSION"] {
        let content = std::fs::read_to_string(src.join(name)).map_err(|e| e.to_string())?;
        drive::write_file(&drive, name, &content)?;
        written.push(name.to_string());
    }
    let modules = std::fs::read_dir(src.join("mkyada")).map_err(|e| e.to_string())?;
    for entry in modules.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if !file.ends_with(".py") {
            continue;
        }
        let content = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        drive::write_file(&drive, &format!("mkyada/{file}"), &content)?;
        written.push(format!("mkyada/{file}"));
    }
    Ok(written)
}

/// Full-screen, click-through, transparent overlay window used to draw the
/// recorded mouse path on the real screen (port of the old tkinter overlay).
#[tauri::command]
fn overlay_show(app: AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("overlay") {
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
        let _ = w.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&format!("MKYADA v{}", env!("CARGO_PKG_VERSION")));
            }
            Ok(())
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
            check_update,
            read_local_file,
            write_local_file,
            recorder_start,
            recorder_stop,
            recorder_state,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
