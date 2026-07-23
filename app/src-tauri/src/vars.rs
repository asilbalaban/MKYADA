//! Microphone mute control for "mic" key assignments.

/// Whether the default input device is muted. Raw CoreAudio FFI, same
/// pattern as permissions.rs — no crate needed.
#[cfg(target_os = "macos")]
mod macos {
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
        fn AudioObjectSetPropertyData(
            object_id: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const std::ffi::c_void,
            size: u32,
            data: *const std::ffi::c_void,
        ) -> i32;
    }
    const SYSTEM_OBJECT: u32 = 1; // kAudioObjectSystemObject
    const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const SCOPE_INPUT: u32 = u32::from_be_bytes(*b"inpt");
    const SEL_DEFAULT_INPUT: u32 = u32::from_be_bytes(*b"dIn ");
    const SEL_MUTE: u32 = u32::from_be_bytes(*b"mute");

    fn default_input_device() -> Option<u32> {
        let addr = AudioObjectPropertyAddress {
            selector: SEL_DEFAULT_INPUT,
            scope: SCOPE_GLOBAL,
            element: 0,
        };
        let mut dev: u32 = 0;
        let mut size = 4u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut dev as *mut u32 as *mut _,
            )
        };
        if status != 0 || dev == 0 {
            None
        } else {
            Some(dev)
        }
    }

    pub fn mic_muted() -> Option<bool> {
        let dev = default_input_device()?;
        let addr = AudioObjectPropertyAddress {
            selector: SEL_MUTE,
            scope: SCOPE_INPUT,
            element: 0,
        };
        let mut muted: u32 = 0;
        let mut size = 4u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                dev,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                &mut muted as *mut u32 as *mut _,
            )
        };
        if status != 0 {
            return None; // device exposes no mute control
        }
        Some(muted != 0)
    }

    pub fn set_mic_muted(muted: bool) -> Result<(), String> {
        let dev = default_input_device().ok_or("no default input device")?;
        let addr = AudioObjectPropertyAddress {
            selector: SEL_MUTE,
            scope: SCOPE_INPUT,
            element: 0,
        };
        let value: u32 = if muted { 1 } else { 0 };
        let status = unsafe {
            AudioObjectSetPropertyData(
                dev,
                &addr,
                0,
                std::ptr::null(),
                4,
                &value as *const u32 as *const _,
            )
        };
        if status != 0 {
            return Err(format!("AudioObjectSetPropertyData failed: {status}"));
        }
        Ok(())
    }
}

/// WASAPI: default capture endpoint's IAudioEndpointVolume.
#[cfg(target_os = "windows")]
mod windows_mic {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eMultimedia, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    fn endpoint_volume() -> Option<IAudioEndpointVolume> {
        unsafe {
            // per-thread; repeated calls just return S_FALSE, which is fine
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eCapture, eMultimedia).ok()?;
            device.Activate(CLSCTX_ALL, None).ok()
        }
    }

    pub fn mic_muted() -> Option<bool> {
        let volume = endpoint_volume()?;
        unsafe { volume.GetMute().ok().map(|b| b.as_bool()) }
    }

    pub fn set_mic_muted(muted: bool) -> Result<(), String> {
        let volume = endpoint_volume().ok_or("no default capture endpoint")?;
        unsafe { volume.SetMute(muted, std::ptr::null()) }.map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
use macos::{mic_muted, set_mic_muted};
#[cfg(target_os = "windows")]
use windows_mic::{mic_muted, set_mic_muted};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn mic_muted() -> Option<bool> {
    None // Linux: PulseAudio/PipeWire support later
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn set_mic_muted(_muted: bool) -> Result<(), String> {
    Err("mic control isn't supported on this platform yet".into())
}

/// Perform a mic key action: "mute" / "unmute" force the state, anything
/// else (including "toggle") flips it based on the last known read.
pub fn mic_action(mode: &str) -> Result<(), String> {
    match mode {
        "mute" => set_mic_muted(true),
        "unmute" => set_mic_muted(false),
        _ => {
            let current = mic_muted().ok_or("no default input device")?;
            set_mic_muted(!current)
        }
    }
}
