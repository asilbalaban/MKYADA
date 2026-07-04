#[cfg(not(target_os = "macos"))]
pub mod capture;

// macOS gets its own CGEventTap capture: rdev's tap callback resolves key
// names through TSM/HIToolbox, which must run on the main dispatch queue on
// modern macOS and crashes the app with SIGTRAP when called from the tap
// thread. Our implementation maps hardware keycodes directly and never calls
// input-source APIs.
#[cfg(target_os = "macos")]
#[path = "capture_macos.rs"]
pub mod capture;
