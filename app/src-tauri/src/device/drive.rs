//! CIRCUITPY drive discovery and file access.
//!
//! Bulk data (configs, macro JSON) is written to the board's mass-storage
//! drive rather than sent over serial. A drive is matched to its serial
//! connection by comparing the `UID:` line of `boot_out.txt` with `hello.uid`.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct DriveInfo {
    pub path: String,
    pub uid: String,
    pub board: String,
}

fn mount_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    roots.push(PathBuf::from("/Volumes"));
    #[cfg(target_os = "linux")]
    {
        if let Ok(user) = std::env::var("USER") {
            roots.push(PathBuf::from(format!("/media/{user}")));
            roots.push(PathBuf::from(format!("/run/media/{user}")));
        }
        roots.push(PathBuf::from("/media"));
    }
    roots
}

fn parse_boot_out(dir: &Path) -> Option<DriveInfo> {
    let text = fs::read_to_string(dir.join("boot_out.txt")).ok()?;
    let mut uid = String::new();
    let mut board = String::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("UID:") {
            uid = v.trim().to_lowercase();
        } else if let Some(v) = line.strip_prefix("Board ID:") {
            board = v.trim().to_string();
        }
    }
    Some(DriveInfo {
        path: dir.to_string_lossy().into_owned(),
        uid,
        board,
    })
}

pub fn list_drives() -> Vec<DriveInfo> {
    let mut found = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let dir = PathBuf::from(format!("{}:\\", letter as char));
            if dir.join("boot_out.txt").is_file() {
                if let Some(info) = parse_boot_out(&dir) {
                    found.push(info);
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for root in mount_roots() {
            let Ok(entries) = fs::read_dir(&root) else { continue };
            for entry in entries.flatten() {
                let dir = entry.path();
                if dir.join("boot_out.txt").is_file() {
                    if let Some(info) = parse_boot_out(&dir) {
                        found.push(info);
                    }
                }
            }
        }
    }
    found
}

/// Reject absolute paths and `..` so callers can only touch files on the drive.
fn safe_join(drive: &str, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("invalid path: {rel}"));
    }
    Ok(Path::new(drive).join(rel_path))
}

pub fn write_file(drive: &str, rel: &str, content: &str) -> Result<(), String> {
    let path = safe_join(drive, rel)?;
    match write_file_raw(&path, content) {
        Err(e) if is_read_only(&e) => {
            // macOS mounts CIRCUITPY read-only when its FAT dirty bit is set
            // (the keypad reset/unplugged while mounted). A remount runs fsck
            // and restores write access — same effect as unplug/replug.
            remount_read_write(drive)
                .map_err(|re| format!("{e} — auto-remount failed: {re}. Unplug and replug the keypad."))?;
            write_file_raw(&path, content).map_err(|e| e.to_string())
        }
        r => r.map_err(|e| e.to_string()),
    }
}

fn write_file_raw(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = fs::File::create(path)?;
    f.write_all(content.as_bytes())?;
    // FAT + a microcontroller on the other side: make sure bytes hit the disk
    // before the caller sends a `reload`/`play` over serial.
    f.sync_all()
}

fn is_read_only(e: &std::io::Error) -> bool {
    // EROFS(30) on unix; ERROR_WRITE_PROTECT(19) on Windows.
    #[cfg(unix)]
    return e.raw_os_error() == Some(30);
    #[cfg(windows)]
    return e.raw_os_error() == Some(19);
}

/// Unmount + mount the volume so the OS re-checks the FAT filesystem and
/// gives us write access back. macOS only; elsewhere the condition hasn't
/// been observed, so just report failure and let the error surface.
#[cfg(target_os = "macos")]
fn remount_read_write(mount: &str) -> Result<(), String> {
    let node = device_node(mount)?;
    let unmounted = diskutil(&["unmount", mount])
        .or_else(|_| diskutil(&["unmount", "force", mount]));
    unmounted?;
    diskutil(&["mount", &node])?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn remount_read_write(_mount: &str) -> Result<(), String> {
    Err("remount is only supported on macOS".into())
}

/// Cleanly unmount the drive so the FAT dirty bit is cleared BEFORE the
/// keypad resets — prevents the next mount from coming up read-only.
/// Best effort: the board re-exposes the drive after reset either way.
pub fn eject(mount: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        diskutil(&["unmount", mount])?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = mount; // Windows/Linux flush on write; unmount isn't needed.
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn diskutil(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("diskutil")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The /dev/diskXsY node behind a mount point (needed to mount it again).
#[cfg(target_os = "macos")]
fn device_node(mount: &str) -> Result<String, String> {
    let info = diskutil(&["info", mount])?;
    info.lines()
        .find_map(|l| l.trim().strip_prefix("Device Node:"))
        .map(|v| v.trim().to_string())
        .ok_or_else(|| format!("no device node for {mount}"))
}

pub fn read_file(drive: &str, rel: &str) -> Result<String, String> {
    fs::read_to_string(safe_join(drive, rel)?).map_err(|e| e.to_string())
}

pub fn delete_file(drive: &str, rel: &str) -> Result<(), String> {
    fs::remove_file(safe_join(drive, rel)?).map_err(|e| e.to_string())
}

/// File names in a directory on the drive (e.g. "macros"). Missing dir = empty.
pub fn list_dir(drive: &str, rel: &str) -> Result<Vec<String>, String> {
    let path = safe_join(drive, rel)?;
    let Ok(entries) = fs::read_dir(path) else {
        return Ok(Vec::new());
    };
    Ok(entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect())
}
