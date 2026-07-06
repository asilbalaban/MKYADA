//! Global input capture for the macro recorder, via rdev OS hooks.
//!
//! One listener thread runs for the whole process lifetime (rdev's hooks
//! can't be unregistered); a flag decides whether events are forwarded to the
//! frontend as `record:event`. F8 presses are always forwarded as
//! `record:hotkey` so the UI can offer start/stop while unfocused.
//!
//! Key labels use pynput-style names ("ctrl_l", "f5", "a") — the same
//! vocabulary the firmware's hidmap resolves.

use rdev::{Button, EventType, Key};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

static CAPTURING: AtomicBool = AtomicBool::new(false);
static LISTENER: Once = Once::new();
/// Mouse-move sample throttle. 8 ms ≈ 125 Hz — the USB HID full-speed
/// polling ceiling, so playback can reproduce every recorded sample. (The
/// v4 stream macro format has no size ceiling, so dense recordings are fine.)
const MOVE_SAMPLE_MS: u128 = 8;

/// Windows reports keys as virtual-key codes, which layouts REASSIGN per
/// physical key (German swaps Y/Z, French AZERTY moves the whole letter
/// block, Turkish-F everything). Macro labels must be positional — the HID
/// contract — so round-trip the VK back to its scancode under the active
/// layout and name the physical key by its US position. Without this, a
/// German user recording "z" would get a macro that plays back "y".
#[cfg(target_os = "windows")]
mod positional {
    use rdev::Key;
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
        fn GetKeyboardLayout(thread: u32) -> *mut c_void;
        fn MapVirtualKeyExW(code: u32, map_type: u32, hkl: *mut c_void) -> u32;
    }

    const MAPVK_VK_TO_VSC: u32 = 0;

    /// rdev Key -> Windows virtual-key code, for the layout-movable keys only
    /// (letters, digits, punctuation). Named keys never move.
    fn vk(key: Key) -> Option<u32> {
        use Key::*;
        Some(match key {
            KeyA => 0x41, KeyB => 0x42, KeyC => 0x43, KeyD => 0x44, KeyE => 0x45,
            KeyF => 0x46, KeyG => 0x47, KeyH => 0x48, KeyI => 0x49, KeyJ => 0x4A,
            KeyK => 0x4B, KeyL => 0x4C, KeyM => 0x4D, KeyN => 0x4E, KeyO => 0x4F,
            KeyP => 0x50, KeyQ => 0x51, KeyR => 0x52, KeyS => 0x53, KeyT => 0x54,
            KeyU => 0x55, KeyV => 0x56, KeyW => 0x57, KeyX => 0x58, KeyY => 0x59,
            KeyZ => 0x5A,
            Num0 => 0x30, Num1 => 0x31, Num2 => 0x32, Num3 => 0x33, Num4 => 0x34,
            Num5 => 0x35, Num6 => 0x36, Num7 => 0x37, Num8 => 0x38, Num9 => 0x39,
            SemiColon => 0xBA, Equal => 0xBB, Comma => 0xBC, Minus => 0xBD,
            Dot => 0xBE, Slash => 0xBF, BackQuote => 0xC0, LeftBracket => 0xDB,
            BackSlash => 0xDC, RightBracket => 0xDD, Quote => 0xDE,
            _ => return None,
        })
    }

    /// US set-1 scancode -> positional label (inverse of layout.rs's table).
    fn sc_label(sc: u32) -> Option<&'static str> {
        Some(match sc {
            0x02 => "1", 0x03 => "2", 0x04 => "3", 0x05 => "4", 0x06 => "5",
            0x07 => "6", 0x08 => "7", 0x09 => "8", 0x0A => "9", 0x0B => "0",
            0x0C => "-", 0x0D => "=",
            0x10 => "q", 0x11 => "w", 0x12 => "e", 0x13 => "r", 0x14 => "t",
            0x15 => "y", 0x16 => "u", 0x17 => "i", 0x18 => "o", 0x19 => "p",
            0x1A => "[", 0x1B => "]",
            0x1E => "a", 0x1F => "s", 0x20 => "d", 0x21 => "f", 0x22 => "g",
            0x23 => "h", 0x24 => "j", 0x25 => "k", 0x26 => "l", 0x27 => ";",
            0x28 => "'", 0x29 => "`", 0x2B => "\\",
            0x2C => "z", 0x2D => "x", 0x2E => "c", 0x2F => "v", 0x30 => "b",
            0x31 => "n", 0x32 => "m", 0x33 => ",", 0x34 => ".", 0x35 => "/",
            _ => return None,
        })
    }

    pub fn label(key: Key) -> Option<&'static str> {
        let vk = vk(key)?;
        let hkl = unsafe {
            let fg = GetForegroundWindow();
            let thread = if fg.is_null() {
                0
            } else {
                GetWindowThreadProcessId(fg, std::ptr::null_mut())
            };
            GetKeyboardLayout(thread)
        };
        let sc = unsafe { MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, hkl) };
        sc_label(sc)
    }
}

pub fn key_label(key: Key) -> Option<&'static str> {
    // Physical position wins over the layout's VK assignment (Windows).
    #[cfg(target_os = "windows")]
    if let Some(l) = positional::label(key) {
        return Some(l);
    }
    use Key::*;
    Some(match key {
        KeyA => "a", KeyB => "b", KeyC => "c", KeyD => "d", KeyE => "e",
        KeyF => "f", KeyG => "g", KeyH => "h", KeyI => "i", KeyJ => "j",
        KeyK => "k", KeyL => "l", KeyM => "m", KeyN => "n", KeyO => "o",
        KeyP => "p", KeyQ => "q", KeyR => "r", KeyS => "s", KeyT => "t",
        KeyU => "u", KeyV => "v", KeyW => "w", KeyX => "x", KeyY => "y",
        KeyZ => "z",
        Num0 => "0", Num1 => "1", Num2 => "2", Num3 => "3", Num4 => "4",
        Num5 => "5", Num6 => "6", Num7 => "7", Num8 => "8", Num9 => "9",
        F1 => "f1", F2 => "f2", F3 => "f3", F4 => "f4", F5 => "f5",
        F6 => "f6", F7 => "f7", F8 => "f8", F9 => "f9", F10 => "f10",
        F11 => "f11", F12 => "f12",
        ControlLeft => "ctrl_l", ControlRight => "ctrl_r",
        ShiftLeft => "shift_l", ShiftRight => "shift_r",
        Alt => "alt_l", AltGr => "alt_gr",
        MetaLeft => "cmd_l", MetaRight => "cmd_r",
        Return => "enter", Escape => "esc", Backspace => "backspace",
        Tab => "tab", Space => "space", CapsLock => "caps_lock",
        UpArrow => "up", DownArrow => "down", LeftArrow => "left", RightArrow => "right",
        Delete => "delete", Home => "home", End => "end",
        PageUp => "page_up", PageDown => "page_down", Insert => "insert",
        Minus => "-", Equal => "=", LeftBracket => "[", RightBracket => "]",
        BackSlash => "\\", SemiColon => ";", Quote => "'", BackQuote => "`",
        Comma => ",", Dot => ".", Slash => "/",
        _ => return None,
    })
}

struct CaptureState {
    last: Instant,
    last_move: Instant,
    mouse_x: i32,
    mouse_y: i32,
}

/// Ensure the global hook thread is running. Idempotent.
pub fn ensure_listener(app: AppHandle) {
    LISTENER.call_once(move || {
        // The rdev callback runs INSIDE the OS low-level hook. On Windows
        // every input event in the system waits on that callback, and
        // app.emit does webview IPC — slow enough to lag or drop clicks
        // machine-wide (issue #2). Hand events to a channel and emit from a
        // separate thread so the hook returns in microseconds.
        let (tx, rx) = std::sync::mpsc::channel::<(&'static str, serde_json::Value)>();
        std::thread::spawn(move || {
            for (name, payload) in rx {
                let _ = app.emit(name, payload);
            }
        });
        std::thread::spawn(move || {
            let state = Mutex::new(CaptureState {
                last: Instant::now(),
                last_move: Instant::now(),
                mouse_x: 0,
                mouse_y: 0,
            });
            let result = rdev::listen(move |event| {
                let mut st = state.lock().unwrap();
                let capturing = CAPTURING.load(Ordering::Relaxed);

                // F8 works even when not capturing, so the UI can arm/stop
                // the recorder while another window has focus.
                if let EventType::KeyPress(Key::F8) = event.event_type {
                    let _ = tx.send(("record:hotkey", serde_json::Value::Null));
                    return;
                }
                if let EventType::KeyRelease(Key::F8) = event.event_type {
                    return;
                }
                if !capturing {
                    // Track position so the first click after arming has coords.
                    if let EventType::MouseMove { x, y } = event.event_type {
                        st.mouse_x = x as i32;
                        st.mouse_y = y as i32;
                    }
                    st.last = Instant::now();
                    return;
                }

                let payload = match event.event_type {
                    EventType::KeyPress(k) | EventType::KeyRelease(k) => {
                        let Some(label) = key_label(k) else { return };
                        let action = matches!(event.event_type, EventType::KeyPress(_));
                        json!({"type": "key",
                               "action": if action { "down" } else { "up" },
                               "key": label})
                    }
                    EventType::MouseMove { x, y } => {
                        st.mouse_x = x as i32;
                        st.mouse_y = y as i32;
                        if st.last_move.elapsed().as_millis() < MOVE_SAMPLE_MS {
                            return;
                        }
                        st.last_move = Instant::now();
                        json!({"type": "move", "x": x as i32, "y": y as i32})
                    }
                    EventType::ButtonPress(b) | EventType::ButtonRelease(b) => {
                        let name = match b {
                            Button::Left => "left",
                            Button::Right => "right",
                            Button::Middle => "middle",
                            Button::Unknown(_) => return,
                        };
                        let action = matches!(event.event_type, EventType::ButtonPress(_));
                        json!({"type": "button",
                               "action": if action { "down" } else { "up" },
                               "button": name, "x": st.mouse_x, "y": st.mouse_y})
                    }
                    EventType::Wheel { delta_x, delta_y } => {
                        json!({"type": "scroll", "dx": delta_x, "dy": delta_y,
                               "x": st.mouse_x, "y": st.mouse_y})
                    }
                };

                let mut obj = payload;
                obj["delay"] = json!(st.last.elapsed().as_millis() as u64);
                st.last = Instant::now();
                let _ = tx.send(("record:event", obj));
            });
            if let Err(e) = result {
                // Typical on macOS without Accessibility permission.
                eprintln!("rdev listen failed: {e:?}");
            }
        });
    });
}

pub fn start() {
    CAPTURING.store(true, Ordering::Relaxed);
}

pub fn stop() {
    CAPTURING.store(false, Ordering::Relaxed);
}

pub fn is_capturing() -> bool {
    CAPTURING.load(Ordering::Relaxed)
}
