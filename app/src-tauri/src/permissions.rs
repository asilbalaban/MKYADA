//! OS permission status & prompting.
//!
//! Only macOS gates the features we use:
//!   - Input Monitoring (TCC ListenEvent) -> global capture for the recorder
//!   - Accessibility                      -> enigo local-preview playback
//!
//! Device configuration and hardware-HID playback need no permissions on any
//! OS. Windows/Linux report everything as granted.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
// Denied/Unknown are only ever produced by the macOS TCC checks
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum PermState {
    Granted,
    Denied,
    Unknown,
}

#[derive(Serialize)]
pub struct PermissionsStatus {
    pub platform: &'static str,
    /// needed to record macros (global input capture)
    pub input_monitoring: PermState,
    /// needed for local preview playback (input injection)
    pub accessibility: PermState,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::PermState;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        // request: 0 = PostEvent, 1 = ListenEvent
        // returns: 0 = granted, 1 = denied, 2 = unknown (never asked)
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> bool;
    }

    const LISTEN_EVENT: u32 = 1;

    pub fn accessibility() -> PermState {
        if unsafe { AXIsProcessTrusted() } {
            PermState::Granted
        } else {
            PermState::Denied
        }
    }

    pub fn input_monitoring() -> PermState {
        match unsafe { IOHIDCheckAccess(LISTEN_EVENT) } {
            0 => PermState::Granted,
            1 => PermState::Denied,
            _ => PermState::Unknown,
        }
    }

    /// Trigger the one-time system prompt (also registers the app in the
    /// Input Monitoring list even when the user must flip the switch by hand).
    pub fn request_input_monitoring() -> bool {
        unsafe { IOHIDRequestAccess(LISTEN_EVENT) }
    }

    pub fn open_settings(pane: &str) {
        let anchor = match pane {
            "accessibility" => "Privacy_Accessibility",
            "input_monitoring" => "Privacy_ListenEvent",
            _ => "Privacy",
        };
        let _ = std::process::Command::new("open")
            .arg(format!(
                "x-apple.systempreferences:com.apple.preference.security?{anchor}"
            ))
            .spawn();
    }
}

#[cfg(target_os = "macos")]
pub fn status() -> PermissionsStatus {
    PermissionsStatus {
        platform: "macos",
        input_monitoring: imp::input_monitoring(),
        accessibility: imp::accessibility(),
    }
}

#[cfg(target_os = "macos")]
pub fn request(kind: &str) {
    match kind {
        "input_monitoring" => {
            if !imp::request_input_monitoring() {
                // already denied once: the prompt won't reappear, guide the
                // user to the settings pane instead
                imp::open_settings("input_monitoring");
            }
        }
        "accessibility" => imp::open_settings("accessibility"),
        _ => {}
    }
}

#[cfg(not(target_os = "macos"))]
pub fn status() -> PermissionsStatus {
    PermissionsStatus {
        platform: if cfg!(windows) { "windows" } else { "linux" },
        input_monitoring: PermState::Granted,
        accessibility: PermState::Granted,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn request(_kind: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    // Check-only calls never prompt; this verifies the FFI links and returns
    // a sane state on the current platform.
    #[test]
    fn status_returns_valid_states() {
        let s = status();
        assert!(matches!(s.platform, "macos" | "windows" | "linux"));
        assert!(matches!(
            s.input_monitoring,
            PermState::Granted | PermState::Denied | PermState::Unknown
        ));
        assert!(matches!(
            s.accessibility,
            PermState::Granted | PermState::Denied | PermState::Unknown
        ));
    }
}
