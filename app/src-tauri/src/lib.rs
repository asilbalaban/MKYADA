mod device;
mod updater;

use device::drive::{self, DriveInfo};
use device::serial::{self, DeviceInfo, DeviceManager};
use serde_json::Value;
use tauri::{AppHandle, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(DeviceManager::default())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
