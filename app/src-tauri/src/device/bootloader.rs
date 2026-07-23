//! UF2 bootloader drive discovery and CircuitPython provisioning.
//!
//! A blank (or BOOTSEL-held) RP2040 mounts as a small FAT drive ("RPI-RP2")
//! whose root holds `INFO_UF2.TXT`. Copying any `.uf2` file there flashes
//! it — and the board resets itself the instant the copy lands, yanking the
//! drive out from under the host mid-flush. The app uses this to turn a
//! factory-fresh board into a MKYADA device: flash the bundled CircuitPython
//! build here, then run the normal firmware install once CIRCUITPY appears.

use super::drive;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BootDriveInfo {
    pub path: String,
    pub board_id: String,
}

/// The `Board-ID:` line of a mount's INFO_UF2.TXT (e.g. "RPI-RP2").
/// Read as raw bytes — the bootloader's file is ASCII but not worth
/// trusting to be valid UTF-8.
fn board_id(dir: &Path) -> Option<String> {
    let bytes = fs::read(dir.join("INFO_UF2.TXT")).ok()?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .find_map(|l| l.trim().strip_prefix("Board-ID:"))
        .map(|v| v.trim().to_string())
}

/// RP2040 bootloader drives currently mounted (Board-ID starting "RPI-RP2").
pub fn list_drives() -> Vec<BootDriveInfo> {
    let mut found = Vec::new();
    for dir in drive::candidate_mounts() {
        let Some(id) = board_id(&dir) else { continue };
        if id.starts_with("RPI-RP2") {
            found.push(BootDriveInfo {
                path: dir.to_string_lossy().into_owned(),
                board_id: id,
            });
        }
    }
    found
}

/// The single .uf2 shipped in the app's `circuitpython` resource dir. Looked
/// up by extension so the CircuitPython version lives in the filename, not
/// in code.
pub fn bundled_uf2(dir: &Path) -> Result<PathBuf, String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("bundled CircuitPython image missing: {e}"))?;
    entries
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("uf2")))
        .ok_or_else(|| "no .uf2 file in the bundled circuitpython resources".to_string())
}

/// Has the bootloader drive disappeared? The board reboots as soon as the
/// UF2 copy completes, but the OS can take a moment to tear the mount down —
/// poll briefly so a reboot mid-error-check isn't mistaken for a failure.
fn drive_gone(mount: &Path) -> bool {
    for _ in 0..10 {
        if !mount.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Copy the UF2 onto a bootloader drive. The board flashes blocks as they
/// arrive and resets when the file is complete, so the tail of the copy (or
/// the flush) routinely fails with an I/O error even though the flash
/// succeeded — any error after which the mount has vanished counts as
/// success.
pub fn flash_uf2(uf2: &Path, mount: &str) -> Result<(), String> {
    let mount_dir = Path::new(mount);
    if !mount_dir.join("INFO_UF2.TXT").is_file() {
        return Err(format!("{mount} is not a UF2 bootloader drive (no INFO_UF2.TXT)"));
    }
    let mut src = fs::File::open(uf2).map_err(|e| format!("{}: {e}", uf2.display()))?;
    let dest = mount_dir.join("circuitpython.uf2");
    let mut out = fs::File::create(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = src.read(&mut buf).map_err(|e| format!("{}: {e}", uf2.display()))?;
        if n == 0 {
            break;
        }
        if let Err(e) = out.write_all(&buf[..n]) {
            return if drive_gone(mount_dir) {
                Ok(())
            } else {
                Err(format!("writing {}: {e}", dest.display()))
            };
        }
    }
    if let Err(e) = out.sync_all() {
        return if drive_gone(mount_dir) {
            Ok(())
        } else {
            Err(format!("flushing {}: {e}", dest.display()))
        };
    }
    Ok(())
}
