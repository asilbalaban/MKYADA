//! Global input capture on macOS via a raw CGEventTap.
//!
//! Deliberately NOT rdev: rdev's tap callback resolves key characters through
//! TSM/HIToolbox (`TSMGetInputSourceProperty`), which modern macOS asserts
//! must run on the main dispatch queue — calling it from the tap thread kills
//! the process with SIGTRAP. We map hardware keycodes to pynput-style labels
//! with a static table instead, so the callback never touches TSM.
//!
//! Public interface matches recorder/capture.rs: ensure_listener / start /
//! stop / is_capturing, emitting `record:event` + `record:hotkey`.

use serde_json::json;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

static CAPTURING: AtomicBool = AtomicBool::new(false);
/// Tap thread alive? Unlike a Once, this allows a retry after a failed tap
/// creation (e.g. Input Monitoring granted after the first attempt).
static RUNNING: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();
static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
const MOVE_SAMPLE_MS: u128 = 15;

// --- CoreGraphics / CoreFoundation FFI ---

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

type CGEventRef = *const c_void;
type CFMachPortRef = *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: extern "C" fn(*const c_void, u32, CGEventRef, *mut c_void) -> CGEventRef,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFMachPortCreateRunLoopSource(
        allocator: *const c_void,
        port: CFMachPortRef,
        order: i64,
    ) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    static kCFRunLoopCommonModes: *const c_void;
}

// event types
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const MOUSE_MOVED: u32 = 5;
const LEFT_DRAGGED: u32 = 6;
const RIGHT_DRAGGED: u32 = 7;
const SCROLL_WHEEL: u32 = 22;
const OTHER_DOWN: u32 = 25;
const OTHER_UP: u32 = 26;
const OTHER_DRAGGED: u32 = 27;
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFFFFFE;
const TAP_DISABLED_BY_USER: u32 = 0xFFFFFFFF;

// fields
const FIELD_KEYCODE: u32 = 9; // kCGKeyboardEventKeycode
const FIELD_SCROLL_DY: u32 = 11; // kCGScrollWheelEventDeltaAxis1

const SESSION_TAP: u32 = 1; // kCGSessionEventTap
const HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
const LISTEN_ONLY: u32 = 1; // kCGEventTapOptionListenOnly

const F8_KEYCODE: i64 = 100;

/// macOS hardware keycode -> pynput-style label (same vocabulary the
/// firmware's hidmap resolves). US physical layout.
fn key_label(code: i64) -> Option<&'static str> {
    Some(match code {
        0 => "a", 1 => "s", 2 => "d", 3 => "f", 4 => "h", 5 => "g",
        6 => "z", 7 => "x", 8 => "c", 9 => "v", 11 => "b", 12 => "q",
        13 => "w", 14 => "e", 15 => "r", 16 => "y", 17 => "t",
        18 => "1", 19 => "2", 20 => "3", 21 => "4", 22 => "6", 23 => "5",
        24 => "=", 25 => "9", 26 => "7", 27 => "-", 28 => "8", 29 => "0",
        30 => "]", 31 => "o", 32 => "u", 33 => "[", 34 => "i", 35 => "p",
        36 => "enter", 37 => "l", 38 => "j", 39 => "'", 40 => "k",
        41 => ";", 42 => "\\", 43 => ",", 44 => "/", 45 => "n", 46 => "m",
        47 => ".", 48 => "tab", 49 => "space", 50 => "`", 51 => "backspace",
        53 => "esc",
        54 => "cmd_r", 55 => "cmd_l", 56 => "shift_l", 58 => "alt_l",
        59 => "ctrl_l", 60 => "shift_r", 61 => "alt_r", 62 => "ctrl_r",
        96 => "f5", 97 => "f6", 98 => "f7", 99 => "f3", 100 => "f8",
        101 => "f9", 103 => "f11", 109 => "f10", 111 => "f12",
        114 => "insert", 115 => "home", 116 => "page_up", 117 => "delete",
        118 => "f4", 119 => "end", 120 => "f2", 121 => "page_down",
        122 => "f1", 123 => "left", 124 => "right", 125 => "down", 126 => "up",
        _ => return None,
    })
}

struct CaptureState {
    last: Instant,
    last_move: Instant,
    mouse_x: i32,
    mouse_y: i32,
    /// modifier keycodes currently held (FlagsChanged has no up/down flag)
    mods_down: Vec<i64>,
}

static STATE: Mutex<Option<CaptureState>> = Mutex::new(None);

fn emit_event(st: &mut CaptureState, mut payload: serde_json::Value) {
    payload["delay"] = json!(st.last.elapsed().as_millis() as u64);
    st.last = Instant::now();
    if let Some(app) = APP.get() {
        let _ = app.emit("record:event", payload);
    }
}

extern "C" fn tap_callback(
    _proxy: *const c_void,
    etype: u32,
    event: CGEventRef,
    _user: *mut c_void,
) -> CGEventRef {
    // The OS disables taps whose callbacks stall; just re-enable and go on.
    if etype == TAP_DISABLED_BY_TIMEOUT || etype == TAP_DISABLED_BY_USER {
        let port = TAP_PORT.load(Ordering::Relaxed);
        if !port.is_null() {
            unsafe { CGEventTapEnable(port, true) };
        }
        return event;
    }

    let mut guard = match STATE.lock() {
        Ok(g) => g,
        Err(_) => return event,
    };
    let Some(st) = guard.as_mut() else { return event };
    let capturing = CAPTURING.load(Ordering::Relaxed);

    // F8 arms/stops recording even while another window is focused.
    if etype == KEY_DOWN {
        let code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
        if code == F8_KEYCODE {
            if let Some(app) = APP.get() {
                let _ = app.emit("record:hotkey", ());
            }
            return event;
        }
    }
    if etype == KEY_UP {
        let code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
        if code == F8_KEYCODE {
            return event;
        }
    }

    if !capturing {
        if matches!(etype, MOUSE_MOVED | LEFT_DRAGGED | RIGHT_DRAGGED | OTHER_DRAGGED) {
            let p = unsafe { CGEventGetLocation(event) };
            st.mouse_x = p.x as i32;
            st.mouse_y = p.y as i32;
        }
        if etype == FLAGS_CHANGED {
            // keep the held-modifier set in sync while idle
            let code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
            if let Some(i) = st.mods_down.iter().position(|&c| c == code) {
                st.mods_down.remove(i);
            } else if key_label(code).is_some() {
                st.mods_down.push(code);
            }
        }
        st.last = Instant::now();
        return event;
    }

    match etype {
        KEY_DOWN | KEY_UP => {
            let code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
            if let Some(label) = key_label(code) {
                let payload = json!({"type": "key",
                    "action": if etype == KEY_DOWN { "down" } else { "up" },
                    "key": label});
                emit_event(st, payload);
            }
        }
        FLAGS_CHANGED => {
            // modifier press/release: toggle tracked state per keycode
            let code = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
            let Some(label) = key_label(code) else { return event };
            let action = if let Some(i) = st.mods_down.iter().position(|&c| c == code) {
                st.mods_down.remove(i);
                "up"
            } else {
                st.mods_down.push(code);
                "down"
            };
            let payload = json!({"type": "key", "action": action, "key": label});
            emit_event(st, payload);
        }
        MOUSE_MOVED | LEFT_DRAGGED | RIGHT_DRAGGED | OTHER_DRAGGED => {
            let p = unsafe { CGEventGetLocation(event) };
            st.mouse_x = p.x as i32;
            st.mouse_y = p.y as i32;
            if st.last_move.elapsed().as_millis() >= MOVE_SAMPLE_MS {
                st.last_move = Instant::now();
                let payload = json!({"type": "move", "x": st.mouse_x, "y": st.mouse_y});
                emit_event(st, payload);
            }
        }
        LEFT_DOWN | LEFT_UP | RIGHT_DOWN | RIGHT_UP | OTHER_DOWN | OTHER_UP => {
            let p = unsafe { CGEventGetLocation(event) };
            st.mouse_x = p.x as i32;
            st.mouse_y = p.y as i32;
            let (name, down) = match etype {
                LEFT_DOWN => ("left", true),
                LEFT_UP => ("left", false),
                RIGHT_DOWN => ("right", true),
                RIGHT_UP => ("right", false),
                OTHER_DOWN => ("middle", true),
                _ => ("middle", false),
            };
            let payload = json!({"type": "button",
                "action": if down { "down" } else { "up" },
                "button": name, "x": st.mouse_x, "y": st.mouse_y});
            emit_event(st, payload);
        }
        SCROLL_WHEEL => {
            let dy = unsafe { CGEventGetIntegerValueField(event, FIELD_SCROLL_DY) };
            if dy != 0 {
                let payload = json!({"type": "scroll", "dx": 0, "dy": dy,
                    "x": st.mouse_x, "y": st.mouse_y});
                emit_event(st, payload);
            }
        }
        _ => {}
    }
    event
}

pub fn ensure_listener(app: AppHandle) {
    let _ = APP.set(app);
    // Already have a live tap thread? Nothing to do. A previous FAILED attempt
    // cleared RUNNING, so granting the permission and trying again works
    // without restarting the app (though macOS usually applies a fresh
    // Input Monitoring grant only after relaunch).
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        *STATE.lock().unwrap() = Some(CaptureState {
            last: Instant::now(),
            last_move: Instant::now(),
            mouse_x: 0,
            mouse_y: 0,
            mods_down: Vec::new(),
        });
        let mask: u64 = [
            KEY_DOWN, KEY_UP, FLAGS_CHANGED, LEFT_DOWN, LEFT_UP, RIGHT_DOWN,
            RIGHT_UP, MOUSE_MOVED, LEFT_DRAGGED, RIGHT_DRAGGED, SCROLL_WHEEL,
            OTHER_DOWN, OTHER_UP, OTHER_DRAGGED,
        ]
        .iter()
        .fold(0u64, |m, &t| m | (1u64 << t));
        unsafe {
            let port = CGEventTapCreate(
                SESSION_TAP,
                HEAD_INSERT,
                LISTEN_ONLY,
                mask,
                tap_callback,
                std::ptr::null_mut(),
            );
            if port.is_null() {
                RUNNING.store(false, Ordering::SeqCst);
                if let Some(app) = APP.get() {
                    let _ = app.emit(
                        "record:error",
                        "Could not start global capture — macOS denied Input Monitoring \
                         for this app version. Grant it in System Settings, then restart MKYADA.",
                    );
                }
                return;
            }
            TAP_PORT.store(port, Ordering::Relaxed);
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            CFRunLoopRun();
            // Run loop ended (shouldn't happen): allow a future retry.
            RUNNING.store(false, Ordering::SeqCst);
        }
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

#[cfg(test)]
mod tests {
    use super::key_label;

    #[test]
    fn keycode_map_covers_essentials() {
        assert_eq!(key_label(0), Some("a"));
        assert_eq!(key_label(56), Some("shift_l"));
        assert_eq!(key_label(59), Some("ctrl_l"));
        assert_eq!(key_label(100), Some("f8"));
        assert_eq!(key_label(126), Some("up"));
        assert_eq!(key_label(999), None);
    }
}
