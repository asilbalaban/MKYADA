//! Host-side playback preview (OS-level input injection).
//!
//! This is only a convenience for previewing macros while editing — games may
//! ignore it. Real playback goes through the device as hardware HID.
//!
//! Key events are injected *positionally* (hardware keycode / virtual key),
//! exactly like the keypad's HID reports, so the OS applies the user's
//! keyboard layout the same way in both paths: on a Turkish layout the label
//! "/" types ".", matching what was recorded.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct Preview {
    stop: Arc<AtomicBool>,
}

impl Default for Preview {
    fn default() -> Self {
        Self { stop: Arc::new(AtomicBool::new(false)) }
    }
}

impl Preview {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    pub fn play(&self, app: AppHandle, events: Vec<Value>, speed: f64) -> Result<(), String> {
        self.stop.store(false, Ordering::Relaxed);
        let stop = self.stop.clone();
        let speed = speed.max(0.01);
        std::thread::spawn(move || {
            // Windows quantizes thread::sleep to the system timer (~15.6 ms by
            // default); a recording is a stream of ~16 ms move deltas, so the
            // per-event rounding error made previews visibly stutter and lag.
            #[cfg(windows)]
            let _timer_res = timer_res::OneMs::acquire();

            let mut sink = match sink::Sink::new() {
                Ok(s) => s,
                Err(e) => {
                    let _ = app.emit("preview:done", format!("input injection failed: {e}"));
                    return;
                }
            };
            // Schedule on absolute deadlines from the start of playback:
            // sleep overshoot then corrects itself instead of accumulating
            // across thousands of events.
            let start = std::time::Instant::now();
            let mut due = std::time::Duration::ZERO;
            let spin_margin = std::time::Duration::from_millis(3);
            'events: for ev in &events {
                let delay = ev.get("delay").and_then(Value::as_f64).unwrap_or(0.0);
                due += std::time::Duration::from_secs_f64(delay / 1000.0 / speed);
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break 'events;
                    }
                    let elapsed = start.elapsed();
                    if elapsed >= due {
                        break;
                    }
                    let remaining = due - elapsed;
                    if remaining > spin_margin {
                        // coarse sleep, sliced so stop stays responsive
                        std::thread::sleep(
                            (remaining - spin_margin).min(std::time::Duration::from_millis(50)),
                        );
                    } else {
                        // final stretch: yield until the deadline for sub-ms accuracy
                        std::thread::yield_now();
                    }
                }
                sink.apply(ev);
            }
            sink.release_all();
            let _ = app.emit("preview:done", String::new());
        });
        Ok(())
    }
}

#[cfg(windows)]
mod timer_res {
    //! Ask Windows for 1 ms scheduler resolution while a preview is playing
    //! (winmm timeBeginPeriod), and give it back when done.

    #[allow(non_snake_case)]
    #[link(name = "winmm")]
    extern "system" {
        fn timeBeginPeriod(period: u32) -> u32;
        fn timeEndPeriod(period: u32) -> u32;
    }

    pub struct OneMs;

    impl OneMs {
        pub fn acquire() -> Self {
            unsafe { timeBeginPeriod(1) };
            OneMs
        }
    }

    impl Drop for OneMs {
        fn drop(&mut self) {
            unsafe { timeEndPeriod(1) };
        }
    }
}

/// Shared event-field helpers for both sinks.
fn ev_down(ev: &Value) -> bool {
    ev.get("action").and_then(Value::as_str) == Some("down")
}
fn ev_xy(ev: &Value) -> (Option<i64>, Option<i64>) {
    (ev.get("x").and_then(Value::as_i64), ev.get("y").and_then(Value::as_i64))
}

#[cfg(target_os = "macos")]
mod sink {
    //! Raw CGEvent posting. Deliberately NOT enigo: enigo resolves Unicode
    //! keys through TIS/UCKeyTranslate (HIToolbox), which modern macOS asserts
    //! must run on the main dispatch queue — calling it from the playback
    //! thread killed the whole app with SIGTRAP. CGEventCreate*/CGEventPost
    //! are thread-safe and never touch TSM.

    use super::{ev_down, ev_xy};
    use serde_json::Value;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    type CGEventRef = *mut c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreateKeyboardEvent(source: *const c_void, keycode: u16, keydown: bool) -> CGEventRef;
        fn CGEventCreateMouseEvent(source: *const c_void, etype: u32, pos: CGPoint, button: u32) -> CGEventRef;
        // wheel1 declared as a fixed arg (not through `...`): on Apple ARM64
        // variadic args go on the stack while the callee reads wheel1 from a
        // register — declaring it variadic would silently pass garbage.
        fn CGEventCreateScrollWheelEvent(source: *const c_void, units: u32, wheel_count: u32, wheel1: i32, ...) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventPost(tap: u32, event: CGEventRef);
        fn CGMainDisplayID() -> u32;
        fn CGDisplayPixelsWide(display: u32) -> usize;
        fn CGDisplayPixelsHigh(display: u32) -> usize;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *mut c_void);
    }

    const HID_TAP: u32 = 0; // kCGHIDEventTap
    // mouse event types
    const LEFT_DOWN: u32 = 1;
    const LEFT_UP: u32 = 2;
    const RIGHT_DOWN: u32 = 3;
    const RIGHT_UP: u32 = 4;
    const MOUSE_MOVED: u32 = 5;
    const LEFT_DRAGGED: u32 = 6;
    const RIGHT_DRAGGED: u32 = 7;
    const OTHER_DOWN: u32 = 25;
    const OTHER_UP: u32 = 26;
    const OTHER_DRAGGED: u32 = 27;
    const SCROLL_UNIT_PIXEL: u32 = 0;
    // modifier flags
    const FLAG_SHIFT: u64 = 0x0002_0000;
    const FLAG_CTRL: u64 = 0x0004_0000;
    const FLAG_ALT: u64 = 0x0008_0000;
    const FLAG_CMD: u64 = 0x0010_0000;

    /// Label -> macOS hardware keycode (mirror of the recorder's table in
    /// capture_macos.rs, plus generic modifier aliases).
    fn keycode(label: &str) -> Option<u16> {
        Some(match label {
            "a" => 0, "s" => 1, "d" => 2, "f" => 3, "h" => 4, "g" => 5,
            "z" => 6, "x" => 7, "c" => 8, "v" => 9, "b" => 11, "q" => 12,
            "w" => 13, "e" => 14, "r" => 15, "y" => 16, "t" => 17,
            "1" => 18, "2" => 19, "3" => 20, "4" => 21, "6" => 22, "5" => 23,
            "=" => 24, "9" => 25, "7" => 26, "-" => 27, "8" => 28, "0" => 29,
            "]" => 30, "o" => 31, "u" => 32, "[" => 33, "i" => 34, "p" => 35,
            "enter" | "return" => 36, "l" => 37, "j" => 38, "'" => 39, "k" => 40,
            ";" => 41, "\\" => 42, "," => 43, "/" => 44, "n" => 45, "m" => 46,
            "." => 47, "tab" => 48, "space" => 49, "`" => 50, "backspace" => 51,
            "esc" | "escape" => 53,
            "cmd" | "cmd_l" | "win" => 55, "cmd_r" => 54,
            "shift" | "shift_l" => 56, "shift_r" => 60,
            "alt" | "alt_l" => 58, "alt_r" | "alt_gr" => 61,
            "ctrl" | "ctrl_l" => 59, "ctrl_r" => 62,
            "caps_lock" => 57,
            "f1" => 122, "f2" => 120, "f3" => 99, "f4" => 118, "f5" => 96,
            "f6" => 97, "f7" => 98, "f8" => 100, "f9" => 101, "f10" => 109,
            "f11" => 103, "f12" => 111,
            "insert" => 114, "home" => 115, "page_up" => 116, "delete" => 117,
            "end" => 119, "page_down" => 121,
            "left" => 123, "right" => 124, "down" => 125, "up" => 126,
            _ => return None,
        })
    }

    fn modifier_flag(code: u16) -> Option<u64> {
        Some(match code {
            54 | 55 => FLAG_CMD,
            56 | 60 => FLAG_SHIFT,
            58 | 61 => FLAG_ALT,
            59 | 62 => FLAG_CTRL,
            _ => return None,
        })
    }

    pub struct Sink {
        /// currently held modifier flags — posted CGEvents don't inherit
        /// modifier state automatically, so we stamp every key event
        flags: u64,
        left_down: bool,
        right_down: bool,
        middle_down: bool,
        x: f64,
        y: f64,
        max_x: f64,
        max_y: f64,
    }

    impl Sink {
        pub fn new() -> Result<Self, String> {
            let (w, h) = unsafe {
                let d = CGMainDisplayID();
                (CGDisplayPixelsWide(d) as f64, CGDisplayPixelsHigh(d) as f64)
            };
            Ok(Self {
                flags: 0,
                left_down: false,
                right_down: false,
                middle_down: false,
                x: 0.0,
                y: 0.0,
                max_x: (w - 1.0).max(0.0),
                max_y: (h - 1.0).max(0.0),
            })
        }

        fn post(&self, event: CGEventRef) {
            if event.is_null() {
                return;
            }
            unsafe {
                CGEventSetFlags(event, self.flags);
                CGEventPost(HID_TAP, event);
                CFRelease(event);
            }
        }

        fn pos(&self) -> CGPoint {
            CGPoint { x: self.x, y: self.y }
        }

        fn move_to(&mut self, x: Option<i64>, y: Option<i64>) {
            if let (Some(x), Some(y)) = (x, y) {
                self.x = (x as f64).clamp(0.0, self.max_x);
                self.y = (y as f64).clamp(0.0, self.max_y);
            }
        }

        pub fn apply(&mut self, ev: &Value) {
            let down = ev_down(ev);
            match ev.get("type").and_then(Value::as_str).unwrap_or("") {
                "key" => {
                    let Some(code) = ev
                        .get("key")
                        .and_then(Value::as_str)
                        .and_then(keycode)
                    else {
                        return;
                    };
                    if let Some(flag) = modifier_flag(code) {
                        if down {
                            self.flags |= flag;
                        } else {
                            self.flags &= !flag;
                        }
                    }
                    let e = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) };
                    self.post(e);
                }
                "move" => {
                    let (x, y) = ev_xy(ev);
                    self.move_to(x, y);
                    let etype = if self.left_down {
                        LEFT_DRAGGED
                    } else if self.right_down {
                        RIGHT_DRAGGED
                    } else if self.middle_down {
                        OTHER_DRAGGED
                    } else {
                        MOUSE_MOVED
                    };
                    let button = if self.right_down { 1 } else if self.middle_down { 2 } else { 0 };
                    let e = unsafe {
                        CGEventCreateMouseEvent(std::ptr::null(), etype, self.pos(), button)
                    };
                    self.post(e);
                }
                "button" => {
                    let (x, y) = ev_xy(ev);
                    self.move_to(x, y);
                    let (etype, button) = match ev.get("button").and_then(Value::as_str) {
                        Some("right") => {
                            self.right_down = down;
                            (if down { RIGHT_DOWN } else { RIGHT_UP }, 1)
                        }
                        Some("middle") => {
                            self.middle_down = down;
                            (if down { OTHER_DOWN } else { OTHER_UP }, 2)
                        }
                        _ => {
                            self.left_down = down;
                            (if down { LEFT_DOWN } else { LEFT_UP }, 0)
                        }
                    };
                    let e = unsafe {
                        CGEventCreateMouseEvent(std::ptr::null(), etype, self.pos(), button)
                    };
                    self.post(e);
                }
                "scroll" => {
                    let dy = ev.get("dy").and_then(Value::as_i64).unwrap_or(0) as i32;
                    if dy != 0 {
                        // recorder captures line-ish deltas; scale to pixels
                        let e = unsafe {
                            CGEventCreateScrollWheelEvent(
                                std::ptr::null(),
                                SCROLL_UNIT_PIXEL,
                                1,
                                dy * 10,
                            )
                        };
                        self.post(e);
                    }
                }
                _ => {}
            }
        }

        /// Never leave keys/buttons stuck down after a stop mid-macro.
        pub fn release_all(&mut self) {
            for code in [55u16, 54, 56, 60, 58, 61, 59, 62] {
                if modifier_flag(code).is_some_and(|f| self.flags & f != 0) {
                    if let Some(f) = modifier_flag(code) {
                        self.flags &= !f;
                    }
                    let e = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, false) };
                    self.post(e);
                }
            }
            for (held, etype, button) in [
                (self.left_down, LEFT_UP, 0u32),
                (self.right_down, RIGHT_UP, 1),
                (self.middle_down, OTHER_UP, 2),
            ] {
                if held {
                    let e = unsafe {
                        CGEventCreateMouseEvent(std::ptr::null(), etype, self.pos(), button)
                    };
                    self.post(e);
                }
            }
            self.left_down = false;
            self.right_down = false;
            self.middle_down = false;
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod sink {
    //! enigo-based injection for Windows/Linux. On Windows, single-character
    //! labels are resolved to the layout's virtual key for that physical
    //! position (positional, like the keypad's HID reports); named keys map
    //! to enigo's Key enum.

    use super::{ev_down, ev_xy};
    use enigo::{
        Axis, Button, Coordinate,
        Direction::{Press, Release},
        Enigo, Key, Keyboard, Mouse, Settings,
    };
    use serde_json::Value;

    fn to_key(label: &str) -> Option<Key> {
        Some(match label {
            "ctrl" | "ctrl_l" | "ctrl_r" => Key::Control,
            "shift" | "shift_l" | "shift_r" => Key::Shift,
            // AltGr must be the RIGHT alt (VK_RMENU) on Windows, or layouts
            // won't produce their AltGr characters ("@" on Turkish Q)
            #[cfg(target_os = "windows")]
            "alt_gr" | "alt_r" => Key::Other(0xA5),
            #[cfg(target_os = "windows")]
            "alt" | "alt_l" => Key::Alt,
            #[cfg(not(target_os = "windows"))]
            "alt" | "alt_l" | "alt_r" | "alt_gr" => Key::Alt,
            "cmd" | "cmd_l" | "cmd_r" | "win" => Key::Meta,
            "enter" | "return" => Key::Return,
            "esc" | "escape" => Key::Escape,
            "backspace" => Key::Backspace,
            "tab" => Key::Tab,
            "space" => Key::Space,
            "caps_lock" => Key::CapsLock,
            "up" => Key::UpArrow,
            "down" => Key::DownArrow,
            "left" => Key::LeftArrow,
            "right" => Key::RightArrow,
            "delete" => Key::Delete,
            "home" => Key::Home,
            "end" => Key::End,
            "page_up" => Key::PageUp,
            "page_down" => Key::PageDown,
            "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4,
            "f5" => Key::F5, "f6" => Key::F6, "f7" => Key::F7, "f8" => Key::F8,
            "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
            s => {
                let mut chars = s.chars();
                let c = chars.next()?;
                if chars.next().is_some() {
                    return None; // unsupported multi-char label
                }
                // Positional virtual key on Windows: reproduces the physical
                // keystroke, so the OS layout renders the same character the
                // user recorded ("." on a Turkish keyboard, not "/").
                #[cfg(target_os = "windows")]
                if let Some(vk) = crate::layout::positional_vk(s) {
                    return Some(Key::Other(vk));
                }
                Key::Unicode(c)
            }
        })
    }

    pub struct Sink {
        enigo: Enigo,
        held: Vec<Key>,
    }

    impl Sink {
        pub fn new() -> Result<Self, String> {
            Enigo::new(&Settings::default())
                .map(|enigo| Self { enigo, held: Vec::new() })
                .map_err(|e| e.to_string())
        }

        pub fn apply(&mut self, ev: &Value) {
            let down = ev_down(ev);
            match ev.get("type").and_then(Value::as_str).unwrap_or("") {
                "key" => {
                    if let Some(k) = ev.get("key").and_then(Value::as_str).and_then(to_key) {
                        let _ = self.enigo.key(k, if down { Press } else { Release });
                        if down {
                            self.held.push(k);
                        } else if let Some(i) = self.held.iter().position(|&h| h == k) {
                            self.held.remove(i);
                        }
                    }
                }
                "move" => {
                    let (x, y) = ev_xy(ev);
                    let _ = self.enigo.move_mouse(
                        x.unwrap_or(0) as i32,
                        y.unwrap_or(0) as i32,
                        Coordinate::Abs,
                    );
                }
                "button" => {
                    if let (Some(x), Some(y)) = ev_xy(ev) {
                        let _ = self.enigo.move_mouse(x as i32, y as i32, Coordinate::Abs);
                    }
                    let b = match ev.get("button").and_then(Value::as_str) {
                        Some("right") => Button::Right,
                        Some("middle") => Button::Middle,
                        _ => Button::Left,
                    };
                    let _ = self.enigo.button(b, if down { Press } else { Release });
                }
                "scroll" => {
                    let dy = ev.get("dy").and_then(Value::as_i64).unwrap_or(0) as i32;
                    if dy != 0 {
                        let _ = self.enigo.scroll(-dy, Axis::Vertical);
                    }
                }
                _ => {}
            }
        }

        /// Never leave keys stuck down after a stop mid-macro.
        pub fn release_all(&mut self) {
            for k in std::mem::take(&mut self.held) {
                let _ = self.enigo.key(k, Release);
            }
        }
    }
}
