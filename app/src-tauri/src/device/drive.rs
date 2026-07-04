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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    // FAT + a microcontroller on the other side: make sure bytes hit the disk
    // before the caller sends a `reload`/`play` over serial.
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(())
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
