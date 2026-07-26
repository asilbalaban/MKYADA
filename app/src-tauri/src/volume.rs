//! System output-volume control for the "volume level" key's wheel menu.
//! Mirrors the mic code in vars.rs: raw CoreAudio FFI on macOS, WASAPI on
//! Windows. Read/write the default output device's master volume (0..100%)
//! plus its mute flag.

/// Current output volume (0..100) and mute state.
#[derive(serde::Serialize)]
pub struct VolumeState {
    pub percent: u8,
    pub muted: bool,
}

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
    const SCOPE_OUTPUT: u32 = u32::from_be_bytes(*b"outp");
    const SCOPE_INPUT: u32 = u32::from_be_bytes(*b"inpt");
    const SEL_DEFAULT_OUTPUT: u32 = u32::from_be_bytes(*b"dOut");
    const SEL_DEFAULT_INPUT: u32 = u32::from_be_bytes(*b"dIn ");
    // kAudioHardwareServiceDeviceProperty_VirtualMainVolume ("vmvc"): a scalar
    // 0..1 master fader, the same one the menu-bar volume slider drives.
    const SEL_VIRTUAL_VOLUME: u32 = u32::from_be_bytes(*b"vmvc");
    const SEL_MUTE: u32 = u32::from_be_bytes(*b"mute");

    fn default_device(selector: u32) -> Option<u32> {
        let addr = AudioObjectPropertyAddress {
            selector,
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

    fn get_scoped(dev: u32, scope: u32) -> Option<(u8, bool)> {
        let vaddr = AudioObjectPropertyAddress {
            selector: SEL_VIRTUAL_VOLUME,
            scope,
            element: 0,
        };
        let mut vol: f32 = 0.0;
        let mut size = 4u32;
        let vs = unsafe {
            AudioObjectGetPropertyData(dev, &vaddr, 0, std::ptr::null(), &mut size, &mut vol as *mut f32 as *mut _)
        };
        if vs != 0 {
            return None;
        }
        let maddr = AudioObjectPropertyAddress {
            selector: SEL_MUTE,
            scope,
            element: 0,
        };
        let mut muted: u32 = 0;
        let mut msize = 4u32;
        let _ = unsafe {
            AudioObjectGetPropertyData(dev, &maddr, 0, std::ptr::null(), &mut msize, &mut muted as *mut u32 as *mut _)
        };
        Some(((vol.clamp(0.0, 1.0) * 100.0).round() as u8, muted != 0))
    }

    fn set_scoped(dev: u32, scope: u32, percent: u8) -> Result<(), String> {
        let addr = AudioObjectPropertyAddress {
            selector: SEL_VIRTUAL_VOLUME,
            scope,
            element: 0,
        };
        let vol: f32 = (percent.min(100) as f32) / 100.0;
        let status = unsafe {
            AudioObjectSetPropertyData(dev, &addr, 0, std::ptr::null(), 4, &vol as *const f32 as *const _)
        };
        if status != 0 {
            return Err(format!("AudioObjectSetPropertyData failed: {status}"));
        }
        Ok(())
    }

    pub fn get() -> Option<(u8, bool)> {
        get_scoped(default_device(SEL_DEFAULT_OUTPUT)?, SCOPE_OUTPUT)
    }
    pub fn set(percent: u8) -> Result<(), String> {
        set_scoped(default_device(SEL_DEFAULT_OUTPUT).ok_or("no default output device")?, SCOPE_OUTPUT, percent)
    }
    pub fn get_input() -> Option<(u8, bool)> {
        get_scoped(default_device(SEL_DEFAULT_INPUT)?, SCOPE_INPUT)
    }
    pub fn set_input(percent: u8) -> Result<(), String> {
        set_scoped(default_device(SEL_DEFAULT_INPUT).ok_or("no default input device")?, SCOPE_INPUT, percent)
    }
}

#[cfg(target_os = "windows")]
mod windows_vol {
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eMultimedia, eRender, EDataFlow, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    fn endpoint_volume(flow: EDataFlow) -> Option<IAudioEndpointVolume> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(flow, eMultimedia).ok()?;
            device.Activate(CLSCTX_ALL, None).ok()
        }
    }

    fn get_flow(flow: EDataFlow) -> Option<(u8, bool)> {
        let volume = endpoint_volume(flow)?;
        unsafe {
            let scalar = volume.GetMasterVolumeLevelScalar().ok()?;
            let muted = volume.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            Some(((scalar.clamp(0.0, 1.0) * 100.0).round() as u8, muted))
        }
    }

    fn set_flow(flow: EDataFlow, percent: u8) -> Result<(), String> {
        let volume = endpoint_volume(flow).ok_or("no default audio endpoint")?;
        let scalar = (percent.min(100) as f32) / 100.0;
        unsafe { volume.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) }.map_err(|e| e.to_string())
    }

    pub fn get() -> Option<(u8, bool)> {
        get_flow(eRender)
    }
    pub fn set(percent: u8) -> Result<(), String> {
        set_flow(eRender, percent)
    }
    pub fn get_input() -> Option<(u8, bool)> {
        get_flow(eCapture)
    }
    pub fn set_input(percent: u8) -> Result<(), String> {
        set_flow(eCapture, percent)
    }
}

#[cfg(target_os = "macos")]
use macos::{get as vol_get, get_input as vol_get_in, set as vol_set, set_input as vol_set_in};
#[cfg(target_os = "windows")]
use windows_vol::{get as vol_get, get_input as vol_get_in, set as vol_set, set_input as vol_set_in};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn vol_get() -> Option<(u8, bool)> {
    None
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn vol_set(_percent: u8) -> Result<(), String> {
    Err("output volume control isn't supported on this platform yet".into())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn vol_get_in() -> Option<(u8, bool)> {
    None
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn vol_set_in(_percent: u8) -> Result<(), String> {
    Err("mic input control isn't supported on this platform yet".into())
}

pub fn get() -> Option<VolumeState> {
    vol_get().map(|(percent, muted)| VolumeState { percent, muted })
}
pub fn set(percent: u8) -> Result<(), String> {
    vol_set(percent)
}
pub fn get_mic() -> Option<VolumeState> {
    vol_get_in().map(|(percent, muted)| VolumeState { percent, muted })
}
pub fn set_mic(percent: u8) -> Result<(), String> {
    vol_set_in(percent)
}
