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

#[allow(clippy::vec_init_then_push)] // pushes are cfg-gated per OS
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

/// Every directory that could be a removable drive's mount point: drive
/// letters on Windows, children of the OS mount roots elsewhere. Shared by
/// the CIRCUITPY discovery here and the UF2 bootloader scan
/// (device::bootloader).
pub(crate) fn candidate_mounts() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        (b'A'..=b'Z')
            .map(|letter| PathBuf::from(format!("{}:\\", letter as char)))
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut dirs = Vec::new();
        for root in mount_roots() {
            let Ok(entries) = fs::read_dir(&root) else { continue };
            dirs.extend(entries.flatten().map(|e| e.path()));
        }
        dirs
    }
}

pub fn list_drives() -> Vec<DriveInfo> {
    let mut found = Vec::new();
    for dir in candidate_mounts() {
        if dir.join("boot_out.txt").is_file() {
            if let Some(info) = parse_boot_out(&dir) {
                found.push(info);
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

/// Error prefix that marks "the drive is write-protected" — callers
/// (lib.rs drive_write) key off it to restart the keypad and retry. Kept out
/// of the raw OS message because io::Error text is localized on Windows.
pub const READONLY_MARKER: &str = "READONLY:";

/// Error prefix that marks "the board was too busy to finish the write in
/// time" (Windows ERROR_SEM_TIMEOUT / "os error 121"). The board couldn't
/// service the USB mass-storage write while it was busy — playing a macro,
/// running GC — so the request timed out. Transient: the caller (lib.rs
/// drive_write) stops playback and retries. Kept out of the raw message
/// because io::Error text is localized on Windows.
pub const BUSY_MARKER: &str = "BUSY:";

/// UID of the board that owns a mounted drive (from its boot_out.txt).
pub fn uid_of(mount: &str) -> Option<String> {
    parse_boot_out(Path::new(mount))
        .map(|d| d.uid)
        .filter(|u| !u.is_empty())
}

/// Takes raw bytes because not everything we install is UTF-8 (BDF fonts,
/// vendored libraries); string callers go through lib.rs write_to_device.
pub fn write_file_bytes(drive: &str, rel: &str, content: &[u8]) -> Result<(), String> {
    let path = safe_join(drive, rel)?;
    match write_file_raw(&path, content) {
        Err(e) if is_read_only(&e) => {
            // macOS mounts CIRCUITPY read-only when its FAT dirty bit is set
            // (the keypad reset/unplugged while mounted). A remount runs fsck
            // and restores write access — same effect as unplug/replug.
            #[cfg(target_os = "macos")]
            if remount_read_write(drive).is_ok() {
                return write_file_raw(&path, content).map_err(|e| e.to_string());
            }
            // No host-side fix (Windows: the firmware holds the filesystem
            // and reports the drive write-protected) — flag it so the caller
            // can restart the keypad and retry.
            Err(format!("{READONLY_MARKER} the keypad's USB drive is read-only ({e})."))
        }
        // The board was busy and didn't service the USB write in time. Flag it
        // so the caller can stop playback and retry (and reset if it persists).
        Err(e) if is_busy_timeout(&e) => {
            Err(format!("{BUSY_MARKER} the keypad was too busy to save ({e})."))
        }
        r => r.map_err(|e| e.to_string()),
    }
}

fn write_file_raw(path: &Path, content: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = fs::File::create(path)?;
    f.write_all(content)?;
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

fn is_busy_timeout(e: &std::io::Error) -> bool {
    // ERROR_SEM_TIMEOUT(121): the board didn't service the USB storage write
    // in time because it was busy (playing a macro, GC). Windows-only and
    // transient — retrying once the board is idle succeeds.
    #[cfg(windows)]
    return e.raw_os_error() == Some(121);
    #[cfg(not(windows))]
    {
        let _ = e;
        false
    }
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
