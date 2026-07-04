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
/// Mouse-move sample throttle, matching the tkinter recorder's 15 ms.
const MOVE_SAMPLE_MS: u128 = 15;

pub fn key_label(key: Key) -> Option<&'static str> {
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
                    let _ = app.emit("record:hotkey", ());
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
                let _ = app.emit("record:event", obj);
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
