//! Live system variables for feedback: CPU %, RAM, microphone mute.
//!
//! A background thread samples every 2 s and emits `vars:changed` to the
//! frontend, which shows a status strip and (optionally) mirrors mic state
//! onto the keypad LED via the serial `led` command. No data leaves the
//! machine — this feeds the UI, nothing else.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct SystemVars {
    /// total CPU load, 0–100
    pub cpu: f32,
    /// bytes
    pub mem_used: u64,
    pub mem_total: u64,
    /// None = unknown (no default input device / unsupported platform)
    pub mic_muted: Option<bool>,
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = sysinfo::System::new();
        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            let vars = SystemVars {
                cpu: sys.global_cpu_usage(),
                mem_used: sys.used_memory(),
                mem_total: sys.total_memory(),
                mic_muted: mic_muted(),
            };
            let _ = app.emit("vars:changed", &vars);
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

/// Whether the default input device is muted. Raw CoreAudio FFI, same
/// pattern as permissions.rs — no crate needed.
#[cfg(target_os = "macos")]
fn mic_muted() -> Option<bool> {
    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }
    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object_id: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> i32;
    }
    const SYSTEM_OBJECT: u32 = 1; // kAudioObjectSystemObject
    const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const SCOPE_INPUT: u32 = u32::from_be_bytes(*b"inpt");
    const SEL_DEFAULT_INPUT: u32 = u32::from_be_bytes(*b"dIn ");
    const SEL_MUTE: u32 = u32::from_be_bytes(*b"mute");
    unsafe {
        let addr = AudioObjectPropertyAddress {
            selector: SEL_DEFAULT_INPUT,
            scope: SCOPE_GLOBAL,
            element: 0,
        };
        let mut dev: u32 = 0;
        let mut size = 4u32;
        let status = AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut dev as *mut u32 as *mut _,
        );
        if status != 0 || dev == 0 {
            return None;
        }
        let addr = AudioObjectPropertyAddress {
            selector: SEL_MUTE,
            scope: SCOPE_INPUT,
            element: 0,
        };
        let mut muted: u32 = 0;
        let mut size = 4u32;
        let status = AudioObjectGetPropertyData(
            dev,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut muted as *mut u32 as *mut _,
        );
        if status != 0 {
            return None; // device exposes no mute control
        }
        Some(muted != 0)
    }
}

/// WASAPI: default capture endpoint's IAudioEndpointVolume::GetMute.
#[cfg(target_os = "windows")]
fn mic_muted() -> Option<bool> {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eMultimedia, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    unsafe {
        // per-thread; repeated calls just return S_FALSE, which is fine
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eCapture, eMultimedia).ok()?;
        let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
        volume.GetMute().ok().map(|b| b.as_bool())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn mic_muted() -> Option<bool> {
    None // Linux: PulseAudio/PipeWire support later
}
