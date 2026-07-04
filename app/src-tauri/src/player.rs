//! Host-side playback preview via enigo (OS-level input injection).
//!
//! This is only a convenience for previewing macros while editing — games may
//! ignore it. Real playback goes through the device as hardware HID.

use enigo::{
    Axis, Button, Coordinate,
    Direction::{Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

fn to_key(label: &str) -> Option<Key> {
    Some(match label {
        "ctrl" | "ctrl_l" | "ctrl_r" => Key::Control,
        "shift" | "shift_l" | "shift_r" => Key::Shift,
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
            Key::Unicode(c)
        }
    })
}

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
            let mut enigo = match Enigo::new(&Settings::default()) {
                Ok(e) => e,
                Err(e) => {
                    let _ = app.emit("preview:done", format!("enigo init failed: {e}"));
                    return;
                }
            };
            for ev in &events {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let delay = ev.get("delay").and_then(Value::as_f64).unwrap_or(0.0);
                if delay > 0.0 {
                    // sleep in slices so stop stays responsive
                    let mut remaining = delay / 1000.0 / speed;
                    while remaining > 0.0 && !stop.load(Ordering::Relaxed) {
                        let s = remaining.min(0.05);
                        std::thread::sleep(std::time::Duration::from_secs_f64(s));
                        remaining -= s;
                    }
                }
                let t = ev.get("type").and_then(Value::as_str).unwrap_or("");
                let down = ev.get("action").and_then(Value::as_str) == Some("down");
                match t {
                    "key" => {
                        if let Some(k) =
                            ev.get("key").and_then(Value::as_str).and_then(to_key)
                        {
                            let _ = enigo.key(k, if down { Press } else { Release });
                        }
                    }
                    "move" => {
                        let x = ev.get("x").and_then(Value::as_i64).unwrap_or(0) as i32;
                        let y = ev.get("y").and_then(Value::as_i64).unwrap_or(0) as i32;
                        let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                    }
                    "button" => {
                        if let (Some(x), Some(y)) = (
                            ev.get("x").and_then(Value::as_i64),
                            ev.get("y").and_then(Value::as_i64),
                        ) {
                            let _ = enigo.move_mouse(x as i32, y as i32, Coordinate::Abs);
                        }
                        let b = match ev.get("button").and_then(Value::as_str) {
                            Some("right") => Button::Right,
                            Some("middle") => Button::Middle,
                            _ => Button::Left,
                        };
                        let _ = enigo.button(b, if down { Press } else { Release });
                    }
                    "scroll" => {
                        let dy = ev.get("dy").and_then(Value::as_i64).unwrap_or(0) as i32;
                        if dy != 0 {
                            let _ = enigo.scroll(-dy, Axis::Vertical);
                        }
                    }
                    _ => {}
                }
            }
            let _ = app.emit("preview:done", String::new());
        });
        Ok(())
    }
}
