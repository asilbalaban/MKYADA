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

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Graphics::GdiPlus::{
    GdipCreateBitmapFromScan0, GdipCreateFont, GdipCreateFontFamilyFromName, GdipCreatePen1,
    GdipCreateSolidFill, GdipDeleteBrush, GdipDeleteFont, GdipDeleteFontFamily, GdipDeleteGraphics,
    GdipDeletePen, GdipDisposeImage, GdipDrawEllipseI, GdipDrawLinesI, GdipDrawString,
    GdipFillEllipseI, GdipFillPolygonI, GdipGetImageGraphicsContext, GdipGraphicsClear,
    GdipSetPenDashStyle, GdipSetPenLineJoin, GdipSetSmoothingMode, GdiplusStartup,
    GdiplusStartupInput, DashStyleDash, FillModeAlternate, GpBitmap, GpBrush, GpFont, GpFontFamily,
    GpGraphics, GpImage, GpPen, GpSolidFill, LineJoinRound, Point, RectF, SmoothingModeAntiAlias,
    Unit,
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

/// One polyline (a run of mouse moves, or a drag path) in screen pixels.
/// `arrow` draws a direction arrowhead at the last point.
#[derive(Clone)]
pub struct Polyline {
    pub pts: Vec<(f32, f32)>,
    pub argb: u32,
    pub width: f32,
    pub arrow: bool,
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
    pub dashed: bool,
}

/// A small text label (e.g. the "#7" row number at a movement's start).
#[derive(Clone)]
pub struct Label {
    pub x: f32,
    pub y: f32,
    pub text: String,
    pub argb: u32,
}

#[derive(Clone, Default)]
pub struct Scene {
    pub polylines: Vec<Polyline>,
    pub markers: Vec<Marker>,
    pub labels: Vec<Label>,
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
            arrow: true,
        }],
        markers: vec![
            Marker {
                x: w * 0.08,
                y: h * 0.15,
                r: 16.0,
                argb: 0xFF34_D399,
                width: 3.0,
                dot_argb: 0xFF34_D399,
                dashed: false,
            },
            Marker {
                x: w * 0.90,
                y: h * 0.80,
                r: 16.0,
                argb: 0xFFFB_7185,
                width: 3.0,
                dot_argb: 0xFFFB_7185,
                dashed: false,
            },
        ],
        labels: vec![Label {
            x: w * 0.08,
            y: h * 0.15,
            text: "#1".into(),
            argb: LABEL_MOVE_ARGB,
        }],
    }
}

const WM_APP_REDRAW: u32 = 0x8000 + 1; // WM_APP + 1
const WM_APP_SHOW: u32 = 0x8000 + 2;
const WM_APP_HIDE: u32 = 0x8000 + 3;

// Colours (0xAARRGGBB) mirroring the web OverlayView.
const PATH_ARGB: u32 = 0xFF38_BDF8; // blue — plain cursor move
const DRAG_ARGB: u32 = 0xFFFB_923C; // orange — button-held drag
const PATH_HOT_ARGB: u32 = 0xFFFB_BF24; // amber — selected row
const CLICK_LEFT_ARGB: u32 = 0xFF34_D399; // emerald
const CLICK_RIGHT_ARGB: u32 = 0xFFFB_7185; // rose
const CLICK_MIDDLE_ARGB: u32 = 0xFFC0_84FC; // violet
const CLICK_HOT_ARGB: u32 = 0xFFFB_BF24; // amber
const LABEL_MOVE_ARGB: u32 = 0xFF7D_D3FC; // light blue — move row number

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
    let n = events.len();

    let mut polylines: Vec<Polyline> = Vec::new();
    let mut markers: Vec<Marker> = Vec::new();
    let mut labels: Vec<Label> = Vec::new();
    let scale = |x: f64, y: f64| ((x * sx) as f32, (y * sy) as f32);
    let click_color = |button: &str, hot: bool| -> u32 {
        if hot {
            CLICK_HOT_ARGB
        } else if button == "right" {
            CLICK_RIGHT_ARGB
        } else if button == "middle" {
            CLICK_MIDDLE_ARGB
        } else {
            CLICK_LEFT_ARGB
        }
    };

    // Replicate groupEvents so item indices line up with the editor rows and a
    // button-held drag is told apart from a plain cursor move.
    const MOVE_SPLIT_MS: f64 = 2000.0;
    let mut idx: i64 = -1;
    let mut i = 0usize;
    while i < n {
        let ev = &events[i];
        let ty = ev["type"].as_str().unwrap_or("");

        // button down [+ moves] + matching up → one click / drag row
        if ty == "button" && ev["action"].as_str() == Some("down") {
            let mut j = i + 1;
            while j < n && events[j]["type"].as_str() == Some("move") {
                j += 1;
            }
            let matched = j < n
                && events[j]["type"].as_str() == Some("button")
                && events[j]["action"].as_str() == Some("up")
                && events[j]["button"] == ev["button"];
            if matched {
                idx += 1;
                let hot = is_hot(idx);
                let show = !only_selected || hot;
                let button = ev["button"].as_str().unwrap_or("left");
                let (dx, dy) = scale(ev["x"].as_f64().unwrap_or(0.0), ev["y"].as_f64().unwrap_or(0.0));
                let up = &events[j];
                let (ux, uy) = scale(up["x"].as_f64().unwrap_or(0.0), up["y"].as_f64().unwrap_or(0.0));
                if j == i + 1 {
                    // clickgroup: press ring + (dashed) release ring
                    if show {
                        let col = click_color(button, hot);
                        markers.push(Marker { x: dx, y: dy, r: if hot { 14.0 } else { 11.0 }, argb: col, width: 3.0, dot_argb: col, dashed: false });
                        markers.push(Marker { x: ux, y: uy, r: if hot { 10.0 } else { 8.0 }, argb: col, width: 2.5, dot_argb: col, dashed: true });
                    }
                } else if show {
                    // draggroup: press → path → release, orange (amber if hot)
                    let mut pts = vec![(dx, dy)];
                    for k in (i + 1)..j {
                        pts.push(scale(events[k]["x"].as_f64().unwrap_or(0.0), events[k]["y"].as_f64().unwrap_or(0.0)));
                    }
                    let col = if hot { PATH_HOT_ARGB } else { DRAG_ARGB };
                    labels.push(Label { x: dx, y: dy, text: format!("#{}", idx + 1), argb: col });
                    polylines.push(Polyline { pts, argb: col, width: if hot { 4.0 } else { 3.0 }, arrow: true });
                    let rcol = click_color(button, hot);
                    markers.push(Marker { x: ux, y: uy, r: if hot { 10.0 } else { 8.0 }, argb: rcol, width: 2.5, dot_argb: rcol, dashed: true });
                }
                i = j + 1;
                continue;
            }
        }

        // a run of moves → one or more movegroups (split every ~2s)
        if ty == "move" {
            idx += 1;
            let mut start_idx = idx;
            let mut cur: Vec<(f32, f32)> = vec![scale(ev["x"].as_f64().unwrap_or(0.0), ev["y"].as_f64().unwrap_or(0.0))];
            let mut dur = 0.0f64;
            i += 1;
            while i < n && events[i]["type"].as_str() == Some("move") {
                let m = &events[i];
                let (mx, my) = scale(m["x"].as_f64().unwrap_or(0.0), m["y"].as_f64().unwrap_or(0.0));
                let delay = m["delay"].as_f64().unwrap_or(0.0);
                if dur + delay > MOVE_SPLIT_MS && cur.len() > 1 {
                    push_move_group(&mut polylines, &mut labels, std::mem::take(&mut cur), start_idx, is_hot(start_idx), only_selected);
                    idx += 1;
                    start_idx = idx;
                    cur = vec![(mx, my)];
                    dur = 0.0;
                } else {
                    cur.push((mx, my));
                    dur += delay;
                }
                i += 1;
            }
            push_move_group(&mut polylines, &mut labels, cur, start_idx, is_hot(start_idx), only_selected);
            continue;
        }

        // any other single event (lone button up, key, scroll, wait, …)
        idx += 1;
        let hot = is_hot(idx);
        if ty == "button" && (!only_selected || hot) {
            let button = ev["button"].as_str().unwrap_or("left");
            let up = ev["action"].as_str() == Some("up");
            let (mx, my) = scale(ev["x"].as_f64().unwrap_or(0.0), ev["y"].as_f64().unwrap_or(0.0));
            let col = click_color(button, hot);
            markers.push(Marker { x: mx, y: my, r: if up { 8.0 } else { 11.0 }, argb: col, width: if up { 2.5 } else { 3.0 }, dot_argb: col, dashed: up });
        }
        i += 1;
    }

    set_scene(Scene { polylines, markers, labels });
}

/// Push a plain-move polyline + its "#row" start label (skipping empty or
/// hidden groups). Kept out of the loop so the borrow checker stays happy.
fn push_move_group(
    polylines: &mut Vec<Polyline>,
    labels: &mut Vec<Label>,
    pts: Vec<(f32, f32)>,
    item_idx: i64,
    hot: bool,
    only_selected: bool,
) {
    if (only_selected && !hot) || pts.len() < 2 {
        return;
    }
    let (x0, y0) = pts[0];
    labels.push(Label {
        x: x0,
        y: y0,
        text: format!("#{}", item_idx + 1),
        argb: if hot { PATH_HOT_ARGB } else { LABEL_MOVE_ARGB },
    });
    polylines.push(Polyline {
        pts,
        argb: if hot { PATH_HOT_ARGB } else { PATH_ARGB },
        width: if hot { 4.0 } else { 2.5 },
        arrow: true,
    });
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

        // Direction arrowhead at the end of the path.
        if pl.arrow {
            let (x1, y1) = pl.pts[pl.pts.len() - 2];
            let (x2, y2) = pl.pts[pl.pts.len() - 1];
            let (dx, dy) = (x2 - x1, y2 - y1);
            let len = (dx * dx + dy * dy).sqrt();
            if len > 0.5 {
                let (ux, uy) = (dx / len, dy / len);
                let (px, py) = (-uy, ux); // perpendicular
                let (al, hw) = (13.0f32, 7.0f32); // arrow length / half-width
                let (bx, by) = (x2 - ux * al, y2 - uy * al);
                let tri = [
                    Point { X: x2.round() as i32, Y: y2.round() as i32 },
                    Point { X: (bx + px * hw).round() as i32, Y: (by + py * hw).round() as i32 },
                    Point { X: (bx - px * hw).round() as i32, Y: (by - py * hw).round() as i32 },
                ];
                let mut ab: *mut GpSolidFill = std::ptr::null_mut();
                GdipCreateSolidFill(pl.argb | 0xFF00_0000, &mut ab);
                GdipFillPolygonI(g, ab as *mut GpBrush, tri.as_ptr(), 3, FillModeAlternate);
                GdipDeleteBrush(ab as *mut GpBrush);
            }
        }
    }

    for m in &scene.markers {
        let mut pen: *mut GpPen = std::ptr::null_mut();
        GdipCreatePen1(m.argb, m.width, Unit(2), &mut pen);
        if m.dashed {
            GdipSetPenDashStyle(pen, DashStyleDash);
        }
        GdipDrawEllipseI(
            g,
            pen,
            (m.x - m.r).round() as i32,
            (m.y - m.r).round() as i32,
            (m.r * 2.0).round() as i32,
            (m.r * 2.0).round() as i32,
        );
        GdipDeletePen(pen);

        // Solid centre dot only for the press ring (dashed = release, no dot).
        if !m.dashed {
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
    }

    // Row-number labels ("#7") at movement starts, with a dark shadow so they
    // read over any wallpaper.
    if !scene.labels.is_empty() {
        let mut family: *mut GpFontFamily = std::ptr::null_mut();
        GdipCreateFontFamilyFromName(w!("Segoe UI"), std::ptr::null_mut(), &mut family);
        if !family.is_null() {
            let mut font: *mut GpFont = std::ptr::null_mut();
            GdipCreateFont(family, 12.0, 1, Unit(2), &mut font); // bold, UnitPixel
            if !font.is_null() {
                for lb in &scene.labels {
                    let wide: Vec<u16> = lb.text.encode_utf16().collect();
                    let draw = |dx: f32, dy: f32, argb: u32| unsafe {
                        let rect = RectF { X: lb.x + 6.0 + dx, Y: lb.y - 16.0 + dy, Width: 60.0, Height: 20.0 };
                        let mut br: *mut GpSolidFill = std::ptr::null_mut();
                        GdipCreateSolidFill(argb, &mut br);
                        GdipDrawString(g, PCWSTR(wide.as_ptr()), wide.len() as i32, font, &rect, std::ptr::null(), br as *mut GpBrush);
                        GdipDeleteBrush(br as *mut GpBrush);
                    };
                    draw(1.0, 1.0, 0xCC00_0000); // shadow
                    draw(0.0, 0.0, lb.argb);
                }
                GdipDeleteFont(font);
            }
            GdipDeleteFontFamily(family);
        }
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
