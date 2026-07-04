//! Current keyboard-layout character map.
//!
//! Macro key labels are positional (US physical keys) because that's what the
//! keypad sends as HID — the OS then renders them through the user's layout.
//! So on a Turkish keyboard the physical key labeled "." is stored as "/"
//! (its US position) and still *types* "." when played back. This module
//! tells the UI what each positional label actually produces on the user's
//! layout, so we can display "." instead of the confusing "/" and compile
//! "Type text" assignments layout-aware.
//!
//! Returned map: positional label -> { base, shift } characters. An empty map
//! means "couldn't resolve the layout" and the UI falls back to US labels.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
pub struct KeyChars {
    pub base: String,
    pub shift: String,
    /// AltGr (right-Alt / Option) character — how Turkish layouts reach "@".
    pub altgr: String,
}

/// Single-character positional labels (the keys whose meaning shifts with the
/// layout). Named keys (enter, f5, …) are layout-independent.
pub const CHAR_LABELS: [&str; 47] = [
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o",
    "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "0", "1", "2", "3",
    "4", "5", "6", "7", "8", "9", "-", "=", "[", "]", "\\", ";", "'", "`",
    ",", ".", "/",
];

pub fn layout_map() -> HashMap<String, KeyChars> {
    imp::layout_map()
}

#[cfg(target_os = "macos")]
mod imp {
    //! UCKeyTranslate against the current keyboard layout. TIS* calls must run
    //! on the main thread on modern macOS (same HIToolbox assertion that made
    //! us drop rdev) — the `keyboard_layout` command is deliberately sync, and
    //! Tauri runs sync commands on the main thread.

    use super::{KeyChars, CHAR_LABELS};
    use std::collections::HashMap;
    use std::ffi::c_void;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
        fn TISGetInputSourceProperty(source: *mut c_void, key: *const c_void) -> *mut c_void;
        static kTISPropertyUnicodeKeyLayoutData: *const c_void;
        fn UCKeyTranslate(
            layout: *const c_void,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            options: u32,
            dead_key_state: *mut u32,
            max_len: usize,
            actual_len: *mut usize,
            unicode_string: *mut u16,
        ) -> i32;
        fn LMGetKbdType() -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataGetBytePtr(data: *mut c_void) -> *const u8;
        fn CFRelease(cf: *mut c_void);
    }

    /// Positional label -> macOS hardware keycode (mirror of the recorder's
    /// keycode -> label table in capture_macos.rs).
    fn keycode(label: &str) -> Option<u16> {
        Some(match label {
            "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5,
            "z" => 6, "x" => 7, "c" => 8, "v" => 9, "b" => 11, "q" => 12,
            "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17,
            "1" => 18, "2" => 19, "3" => 20, "4" => 21, "6" => 22, "5" => 23,
            "=" => 24, "9" => 25, "7" => 26, "-" => 27, "8" => 28, "0" => 29,
            "]" => 30, "o" => 31, "u" => 32, "[" => 33, "i" => 34, "p" => 35,
            "l" => 37, "j" => 38, "'" => 39, "k" => 40, ";" => 41, "\\" => 42,
            "," => 43, "/" => 44, "n" => 45, "m" => 46, "." => 47, "`" => 50,
            _ => return None,
        })
    }

    const K_UC_KEY_ACTION_DOWN: u16 = 0;
    const K_UC_KEY_TRANSLATE_NO_DEAD_KEYS: u32 = 1; // kUCKeyTranslateNoDeadKeysMask
    pub const SHIFT_MOD_STATE: u32 = 2; // (shiftKey >> 8) & 0xFF
    pub const OPTION_MOD_STATE: u32 = 8; // (optionKey >> 8) & 0xFF

    fn translate(layout: *const c_void, code: u16, mod_state: u32, kbd_type: u32) -> String {
        let mut dead: u32 = 0;
        let mut buf = [0u16; 8];
        let mut len: usize = 0;
        let status = unsafe {
            UCKeyTranslate(
                layout,
                code,
                K_UC_KEY_ACTION_DOWN,
                mod_state,
                kbd_type,
                K_UC_KEY_TRANSLATE_NO_DEAD_KEYS,
                &mut dead,
                buf.len(),
                &mut len,
                buf.as_mut_ptr(),
            )
        };
        if status != 0 || len == 0 {
            return String::new();
        }
        let s = String::from_utf16_lossy(&buf[..len]);
        // control chars (esc, delete, …) aren't useful display names
        if s.chars().any(|c| c.is_control()) {
            return String::new();
        }
        s
    }

    pub fn layout_map() -> HashMap<String, KeyChars> {
        let mut map = HashMap::new();
        unsafe {
            let source = TISCopyCurrentKeyboardLayoutInputSource();
            if source.is_null() {
                return map;
            }
            let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
            if data.is_null() {
                CFRelease(source);
                return map;
            }
            let layout = CFDataGetBytePtr(data) as *const c_void;
            let kbd_type = LMGetKbdType() as u32;
            for label in CHAR_LABELS {
                let Some(code) = keycode(label) else { continue };
                let base = translate(layout, code, 0, kbd_type);
                let shift = translate(layout, code, SHIFT_MOD_STATE, kbd_type);
                let altgr = translate(layout, code, OPTION_MOD_STATE, kbd_type);
                if !base.is_empty() || !shift.is_empty() {
                    map.insert(label.to_string(), KeyChars { base, shift, altgr });
                }
            }
            CFRelease(source);
        }
        map
    }
}

#[cfg(target_os = "windows")]
mod imp {
    //! ToUnicodeEx per physical key against the foreground thread's layout.

    use super::{KeyChars, CHAR_LABELS};
    use std::collections::HashMap;
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
        fn GetKeyboardLayout(thread: u32) -> *mut c_void;
        fn MapVirtualKeyExW(code: u32, map_type: u32, hkl: *mut c_void) -> u32;
        fn ToUnicodeEx(
            vk: u32,
            scan_code: u32,
            key_state: *const u8,
            buf: *mut u16,
            buf_len: i32,
            flags: u32,
            hkl: *mut c_void,
        ) -> i32;
    }

    const MAPVK_VSC_TO_VK_EX: u32 = 3;
    const VK_SHIFT: usize = 0x10;
    const VK_CONTROL: usize = 0x11;
    const VK_MENU: usize = 0x12;
    /// 1<<2: don't change kernel keyboard state (Win10 1607+), so probing
    /// dead keys can't corrupt the user's next real keystroke.
    const TO_UNICODE_NO_STATE: u32 = 4;

    /// Positional label -> US set-1 scancode (physical key).
    pub fn scancode(label: &str) -> Option<u32> {
        Some(match label {
            "1" => 0x02, "2" => 0x03, "3" => 0x04, "4" => 0x05, "5" => 0x06,
            "6" => 0x07, "7" => 0x08, "8" => 0x09, "9" => 0x0A, "0" => 0x0B,
            "-" => 0x0C, "=" => 0x0D,
            "q" => 0x10, "w" => 0x11, "e" => 0x12, "r" => 0x13, "t" => 0x14,
            "y" => 0x15, "u" => 0x16, "i" => 0x17, "o" => 0x18, "p" => 0x19,
            "[" => 0x1A, "]" => 0x1B,
            "a" => 0x1E, "s" => 0x1F, "d" => 0x20, "f" => 0x21, "g" => 0x22,
            "h" => 0x23, "j" => 0x24, "k" => 0x25, "l" => 0x26, ";" => 0x27,
            "'" => 0x28, "`" => 0x29, "\\" => 0x2B,
            "z" => 0x2C, "x" => 0x2D, "c" => 0x2E, "v" => 0x2F, "b" => 0x30,
            "n" => 0x31, "m" => 0x32, "," => 0x33, "." => 0x34, "/" => 0x35,
            _ => return None,
        })
    }

    pub fn current_hkl() -> *mut c_void {
        unsafe {
            let fg = GetForegroundWindow();
            let thread = if fg.is_null() { 0 } else { GetWindowThreadProcessId(fg, std::ptr::null_mut()) };
            GetKeyboardLayout(thread)
        }
    }

    /// Layout's virtual-key code for a physical key — what the user's layout
    /// driver assigns to that position. Used for positional preview playback.
    pub fn positional_vk(label: &str) -> Option<u32> {
        let sc = scancode(label)?;
        let vk = unsafe { MapVirtualKeyExW(sc, MAPVK_VSC_TO_VK_EX, current_hkl()) };
        if vk == 0 { None } else { Some(vk) }
    }

    fn translate(sc: u32, shift: bool, altgr: bool, hkl: *mut c_void) -> String {
        let vk = unsafe { MapVirtualKeyExW(sc, MAPVK_VSC_TO_VK_EX, hkl) };
        if vk == 0 {
            return String::new();
        }
        let mut state = [0u8; 256];
        if shift {
            state[VK_SHIFT] = 0x80;
        }
        if altgr {
            // Windows models AltGr as Ctrl+Alt
            state[VK_CONTROL] = 0x80;
            state[VK_MENU] = 0x80;
        }
        let mut buf = [0u16; 8];
        let n = unsafe {
            ToUnicodeEx(vk, sc, state.as_ptr(), buf.as_mut_ptr(), buf.len() as i32, TO_UNICODE_NO_STATE, hkl)
        };
        if n <= 0 {
            return String::new(); // dead key or no mapping
        }
        let s = String::from_utf16_lossy(&buf[..n as usize]);
        if s.chars().any(|c| c.is_control()) {
            return String::new();
        }
        s
    }

    pub fn layout_map() -> HashMap<String, KeyChars> {
        let hkl = current_hkl();
        let mut map = HashMap::new();
        for label in CHAR_LABELS {
            let Some(sc) = scancode(label) else { continue };
            let base = translate(sc, false, false, hkl);
            let shift = translate(sc, true, false, hkl);
            let altgr = translate(sc, false, true, hkl);
            if !base.is_empty() || !shift.is_empty() {
                map.insert(label.to_string(), KeyChars { base, shift, altgr });
            }
        }
        map
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::KeyChars;
    use std::collections::HashMap;

    /// No layout introspection wired up (Linux): empty map = US fallback.
    pub fn layout_map() -> HashMap<String, KeyChars> {
        HashMap::new()
    }
}

#[cfg(target_os = "windows")]
pub use imp::positional_vk;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_map_resolves_us_basics() {
        // On any dev machine the current layout should at least map letters.
        let map = layout_map();
        if map.is_empty() {
            return; // headless CI without a window server
        }
        let a = map.get("a").expect("letter a mapped");
        assert_eq!(a.base.to_lowercase(), a.shift.to_lowercase());
        // run with --nocapture to eyeball the active layout's punctuation row
        for label in [";", "'", ",", ".", "/", "[", "]"] {
            if let Some(ch) = map.get(label) {
                println!("{label} -> {} (shift: {})", ch.base, ch.shift);
            }
        }
    }
}
