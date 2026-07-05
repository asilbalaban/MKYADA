//! Native Win32 path overlay for Windows.
//!
//! WebView2 transparent windows composite opaque BLACK on some Windows machines
//! (tauri/wry #8308) — an inescapable full-screen trap. So on Windows the macro
//! path overlay is NOT a webview: it's a layered (WS_EX_LAYERED) top-most,
//! click-through (WS_EX_TRANSPARENT) window drawn with GDI+ and pushed to the
//! screen with `UpdateLayeredWindow` (per-pixel alpha). This is independent of
//! WebView2 / the GPU compositor, so it always renders and is see-through.
//!
//! The window lives on its own thread with a message loop. Other threads drive
//! it by storing a `Scene` and posting messages to redraw / show / hide.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, Once, OnceLock};

use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Graphics::GdiPlus::{
    GdipCreateBitmapFromScan0, GdipCreatePen1, GdipCreateSolidFill, GdipDeleteBrush,
    GdipDeleteGraphics, GdipDeletePen, GdipDisposeImage, GdipDrawEllipseI, GdipDrawLinesI,
    GdipFillEllipseI, GdipGetImageGraphicsContext, GdipGraphicsClear, GdipSetPenLineJoin,
    GdipSetSmoothingMode, GdiplusStartup, GdiplusStartupInput, GpBitmap, GpBrush, GpGraphics,
    GpImage, GpPen, GpSolidFill, LineJoinRound, Point, SmoothingModeAntiAlias, Unit,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetSystemMetrics, PostMessageW,
    RegisterClassW, SetWindowPos, ShowWindow, TranslateMessage, UpdateLayeredWindow, HWND_TOPMOST,
    MSG, SM_CXSCREEN, SM_CYSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE,
    SW_SHOWNOACTIVATE, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

// GDI+ premultiplied 32-bit ARGB — the format UpdateLayeredWindow wants. Drawing
// via a GDI+ bitmap that wraps the DIB bits (rather than a GDI HDC) is what makes
// the alpha channel come out correct.
const PIXEL_FORMAT_32BPP_PARGB: i32 = 925707;

/// One polyline (a run of mouse moves) in screen pixels.
#[derive(Clone)]
pub struct Polyline {
    pub pts: Vec<(f32, f32)>,
    pub argb: u32,
    pub width: f32,
}

/// One click marker (a ring + centre dot) in screen pixels.
#[derive(Clone)]
pub struct Marker {
    pub x: f32,
    pub y: f32,
    pub r: f32,
    pub argb: u32,
    pub width: f32,
    pub dot_argb: u32,
}

#[derive(Clone, Default)]
pub struct Scene {
    pub polylines: Vec<Polyline>,
    pub markers: Vec<Marker>,
}

struct Overlay {
    hwnd: AtomicIsize,
    scene: Mutex<Scene>,
}

static OVERLAY: OnceLock<Overlay> = OnceLock::new();
static VISIBLE: AtomicBool = AtomicBool::new(false);

/// Whether the overlay is currently shown (so the watchdog only hides it when
/// it's actually up).
pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::Acquire)
}

/// A hardcoded diagnostic scene: a sky-blue zig-zag + a green and a red click
/// ring. Kept for manually confirming the native layered window renders.
#[allow(dead_code)]
pub fn test_scene() -> Scene {
    let (w, h) = screen_size();
    let (w, h) = (w as f32, h as f32);
    Scene {
        polylines: vec![Polyline {
            pts: vec![
                (w * 0.08, h * 0.15),
                (w * 0.92, h * 0.28),
                (w * 0.10, h * 0.60),
                (w * 0.90, h * 0.80),
                (w * 0.50, h * 0.95),
            ],
            argb: 0xFF38_BDF8,
            width: 4.0,
        }],
        markers: vec![
            Marker {
                x: w * 0.08,
                y: h * 0.15,
                r: 16.0,
                argb: 0xFF4A_DE80,
                width: 3.0,
                dot_argb: 0xFFFF_FFFF,
            },
            Marker {
                x: w * 0.90,
                y: h * 0.80,
                r: 16.0,
                argb: 0xFFF8_7171,
                width: 3.0,
                dot_argb: 0xFFFF_FFFF,
            },
        ],
    }
}

const WM_APP_REDRAW: u32 = 0x8000 + 1; // WM_APP + 1
const WM_APP_SHOW: u32 = 0x8000 + 2;
const WM_APP_HIDE: u32 = 0x8000 + 3;

// Colours (0xAARRGGBB) mirroring the web OverlayView.
const PATH_ARGB: u32 = 0xD938_BDF8; // sky, ~85%
const PATH_HOT_ARGB: u32 = 0xFFFB_BF24; // amber
const CLICK_LEFT_ARGB: u32 = 0xFF4A_DE80; // green
const CLICK_RIGHT_ARGB: u32 = 0xFFF8_7171; // red
const CLICK_UP_ARGB: u32 = 0xFFFA_CC15; // yellow — button RELEASE marker
const CLICK_HOT_ARGB: u32 = 0xFFFB_BF24; // amber
const DOT_ARGB: u32 = 0xFFFF_FFFF;

/// Build a scene from the editor's `overlay:data` payload and push it to the
/// overlay. Mirrors the web OverlayView: consecutive moves form a polyline,
/// button-downs become click rings, coords are scaled from the recording
/// screen to the real monitor, and selected rows are highlighted.
pub fn set_scene_from_payload(payload: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    let macro_ = &v["macro"];
    let (mw, mh) = screen_size();
    let sw = macro_["screen"]["width"].as_f64().unwrap_or(mw as f64).max(1.0);
    let sh = macro_["screen"]["height"].as_f64().unwrap_or(mh as f64).max(1.0);
    let sx = mw as f64 / sw;
    let sy = mh as f64 / sh;

    // selected: number[] | number | null
    let mut selected: Vec<i64> = Vec::new();
    match &v["selected"] {
        serde_json::Value::Array(a) => {
            selected = a.iter().filter_map(|x| x.as_i64()).collect();
        }
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                selected.push(i);
            }
        }
        _ => {}
    }
    let only_selected = v["onlySelected"].as_bool().unwrap_or(false);
    let is_hot = |idx: i64| selected.contains(&idx);

    let empty = Vec::new();
    let events = macro_["events"].as_array().unwrap_or(&empty);

    let mut polylines = Vec::new();
    let mut markers = Vec::new();
    // Replicate groupEvents' item indexing: a run of moves is ONE item, each
    // non-move is its own item — so `selected` indices line up with the editor.
    let mut idx: i64 = -1;
    let mut cur: Option<Vec<(f32, f32)>> = None;
    let scale = |x: f64, y: f64| ((x * sx) as f32, (y * sy) as f32);

    let flush = |idx: &mut i64,
                 cur: &mut Option<Vec<(f32, f32)>>,
                 polylines: &mut Vec<Polyline>| {
        if let Some(pts) = cur.take() {
            *idx += 1;
            let hot = is_hot(*idx);
            if only_selected && !hot {
                return;
            }
            if pts.len() >= 2 {
                polylines.push(Polyline {
                    pts,
                    argb: if hot { PATH_HOT_ARGB } else { PATH_ARGB },
                    width: if hot { 4.0 } else { 2.5 },
                });
            }
        }
    };

    for ev in events {
        let ty = ev["type"].as_str().unwrap_or("");
        if ty == "move" {
            let x = ev["x"].as_f64().unwrap_or(0.0);
            let y = ev["y"].as_f64().unwrap_or(0.0);
            cur.get_or_insert_with(Vec::new).push(scale(x, y));
        } else {
            flush(&mut idx, &mut cur, &mut polylines);
            idx += 1;
            let hot = is_hot(idx);
            if ty == "button" {
                if only_selected && !hot {
                    continue;
                }
                let up = ev["action"].as_str() == Some("up");
                let x = ev["x"].as_f64().unwrap_or(0.0);
                let y = ev["y"].as_f64().unwrap_or(0.0);
                let (sx_, sy_) = scale(x, y);
                // down = green/red ring by button; up = smaller yellow ring so
                // where the button was RELEASED (end of a drag) shows too.
                let ring = if hot {
                    CLICK_HOT_ARGB
                } else if up {
                    CLICK_UP_ARGB
                } else if ev["button"].as_str() == Some("right") {
                    CLICK_RIGHT_ARGB
                } else {
                    CLICK_LEFT_ARGB
                };
                markers.push(Marker {
                    x: sx_,
                    y: sy_,
                    r: match (hot, up) {
                        (true, false) => 14.0,
                        (true, true) => 11.0,
                        (false, false) => 11.0,
                        (false, true) => 8.0,
                    },
                    argb: ring,
                    width: if up { 2.5 } else { 3.0 },
                    dot_argb: if hot { CLICK_HOT_ARGB } else { DOT_ARGB },
                });
            }
        }
    }
    flush(&mut idx, &mut cur, &mut polylines);

    set_scene(Scene { polylines, markers });
}

fn overlay() -> &'static Overlay {
    OVERLAY.get_or_init(|| Overlay {
        hwnd: AtomicIsize::new(0),
        scene: Mutex::new(Scene::default()),
    })
}

fn screen_size() -> (i32, i32) {
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

/// Spawn the overlay window + message loop thread once.
pub fn ensure_started() {
    static ONCE: Once = Once::new();
    let _ = overlay();
    ONCE.call_once(|| {
        std::thread::Builder::new()
            .name("mkyada-overlay".into())
            .spawn(|| unsafe { thread_main() })
            .ok();
    });
}

/// Block briefly until the overlay window exists; returns its HWND or 0.
fn wait_hwnd() -> HWND {
    for _ in 0..200 {
        let h = overlay().hwnd.load(Ordering::Acquire);
        if h != 0 {
            return HWND(h as *mut _);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    HWND(overlay().hwnd.load(Ordering::Acquire) as *mut _)
}

pub fn set_scene(scene: Scene) {
    ensure_started();
    *overlay().scene.lock().unwrap() = scene;
    let h = wait_hwnd();
    if !h.0.is_null() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_REDRAW, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn show() {
    ensure_started();
    let h = wait_hwnd();
    if !h.0.is_null() {
        VISIBLE.store(true, Ordering::Release);
        unsafe {
            let _ = PostMessageW(h, WM_APP_SHOW, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn hide() {
    VISIBLE.store(false, Ordering::Release);
    let h = HWND(overlay().hwnd.load(Ordering::Acquire) as *mut _);
    if !h.0.is_null() {
        unsafe {
            let _ = PostMessageW(h, WM_APP_HIDE, WPARAM(0), LPARAM(0));
        }
    }
}

unsafe fn thread_main() {
    // GDI+ once for this thread/process.
    let mut token: usize = 0;
    let input = GdiplusStartupInput {
        GdiplusVersion: 1,
        ..Default::default()
    };
    let _ = GdiplusStartup(&mut token, &input, std::ptr::null_mut());

    let hmodule = GetModuleHandleW(None).unwrap();
    let hinst = HINSTANCE(hmodule.0);
    let class_name = w!("MkyadaPathOverlay");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: hinst,
        lpszClassName: class_name,
        ..Default::default()
    };
    RegisterClassW(&wc);

    let (w, h) = screen_size();
    let hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
        class_name,
        w!("MKYADA overlay"),
        WS_POPUP,
        0,
        0,
        w,
        h,
        None,
        None,
        hinst,
        None,
    )
    .unwrap();
    overlay().hwnd.store(hwnd.0 as isize, Ordering::Release);

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
        let _ = TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_APP_REDRAW => {
            redraw(hwnd);
            LRESULT(0)
        }
        WM_APP_SHOW => {
            redraw(hwnd);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            LRESULT(0)
        }
        WM_APP_HIDE => {
            let _ = ShowWindow(hwnd, SW_HIDE);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Render the current scene into a premultiplied-ARGB DIB and push it to the
/// window with UpdateLayeredWindow (per-pixel alpha, no GPU compositor).
unsafe fn redraw(hwnd: HWND) {
    let (w, h) = screen_size();
    if w <= 0 || h <= 0 {
        return;
    }
    let scene = overlay().scene.lock().unwrap().clone();

    let screen_dc = GetDC(None);
    let mem_dc = CreateCompatibleDC(screen_dc);

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let dib = match CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(d) => d,
        Err(_) => {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return;
        }
    };
    let old = SelectObject(mem_dc, HGDIOBJ(dib.0));

    // GDI+ draws into a bitmap wrapping the SAME memory as the DIB, so the alpha
    // channel is written correctly (premultiplied ARGB).
    let mut bitmap: *mut GpBitmap = std::ptr::null_mut();
    GdipCreateBitmapFromScan0(
        w,
        h,
        w * 4,
        PIXEL_FORMAT_32BPP_PARGB,
        Some(bits as *const u8),
        &mut bitmap,
    );
    let mut g: *mut GpGraphics = std::ptr::null_mut();
    GdipGetImageGraphicsContext(bitmap as *mut GpImage, &mut g);
    GdipSetSmoothingMode(g, SmoothingModeAntiAlias);
    GdipGraphicsClear(g, 0x0000_0000); // fully transparent

    for pl in &scene.polylines {
        if pl.pts.len() < 2 {
            continue;
        }
        let mut pen: *mut GpPen = std::ptr::null_mut();
        GdipCreatePen1(pl.argb, pl.width, Unit(2), &mut pen); // UnitPixel
        GdipSetPenLineJoin(pen, LineJoinRound);
        let pts: Vec<Point> = pl
            .pts
            .iter()
            .map(|(x, y)| Point {
                X: x.round() as i32,
                Y: y.round() as i32,
            })
            .collect();
        GdipDrawLinesI(g, pen, pts.as_ptr(), pts.len() as i32);
        GdipDeletePen(pen);
    }

    for m in &scene.markers {
        let mut pen: *mut GpPen = std::ptr::null_mut();
        GdipCreatePen1(m.argb, m.width, Unit(2), &mut pen);
        GdipDrawEllipseI(
            g,
            pen,
            (m.x - m.r).round() as i32,
            (m.y - m.r).round() as i32,
            (m.r * 2.0).round() as i32,
            (m.r * 2.0).round() as i32,
        );
        GdipDeletePen(pen);

        let mut brush: *mut GpSolidFill = std::ptr::null_mut();
        GdipCreateSolidFill(m.dot_argb, &mut brush);
        GdipFillEllipseI(
            g,
            brush as *mut GpBrush,
            (m.x - 2.5).round() as i32,
            (m.y - 2.5).round() as i32,
            5,
            5,
        );
        GdipDeleteBrush(brush as *mut GpBrush);
    }

    GdipDeleteGraphics(g);
    GdipDisposeImage(bitmap as *mut GpImage);

    let pt_dst = POINT { x: 0, y: 0 };
    let sz = SIZE { cx: w, cy: h };
    let pt_src = POINT { x: 0, y: 0 };
    let blend = windows::Win32::Graphics::Gdi::BLENDFUNCTION {
        BlendOp: 0,          // AC_SRC_OVER
        BlendFlags: 0,
        SourceConstantAlpha: 255,
        AlphaFormat: 1, // AC_SRC_ALPHA
    };
    let _ = UpdateLayeredWindow(
        hwnd,
        screen_dc,
        Some(&pt_dst),
        Some(&sz),
        mem_dc,
        Some(&pt_src),
        COLORREF(0),
        Some(&blend),
        windows::Win32::UI::WindowsAndMessaging::ULW_ALPHA,
    );

    SelectObject(mem_dc, old);
    let _ = DeleteObject(HGDIOBJ(dib.0));
    let _ = DeleteDC(mem_dc);
    ReleaseDC(None, screen_dc);
}
