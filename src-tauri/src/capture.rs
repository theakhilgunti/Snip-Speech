//! Screen capture, snip-overlay windows and cropping.
//!
//! Flow: hotkey -> `start` grabs every display -> one borderless overlay window per
//! display shows its frozen frame -> the user drags a box -> `finish_snip` crops the
//! original full-resolution pixels -> PNG saved to a temp folder that is wiped on
//! quit (and swept again on the next launch in case of a crash).

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use image::{codecs::jpeg::JpegEncoder, DynamicImage, ExtendedColorType, ImageEncoder, RgbaImage};
use tauri::{
    ipc::Response, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

/// Selections smaller than this (in physical pixels) count as an accidental click.
const MIN_SNIP_PX: u32 = 10;
/// Keep at most this many snips on disk during a session.
const MAX_SNIPS_ON_DISK: usize = 10;

struct Frame {
    label: String,
    image: RgbaImage,
    jpeg: Vec<u8>,
}

struct OverlayInfo {
    label: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

#[derive(Default)]
struct Session {
    active: bool,
    frames: Vec<Frame>,
    latest: Option<PathBuf>,
}

#[derive(Default)]
pub struct SnipState(Mutex<Session>);

// ---------------------------------------------------------------- temp storage

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("SnipSpeech-snips")
}

/// Delete every saved snip and recreate the empty folder.
pub fn sweep_temp() {
    let dir = temp_dir();
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::create_dir_all(&dir);
}

fn prune_old_snips() {
    let Ok(rd) = fs::read_dir(temp_dir()) else { return };
    let mut files: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    files.sort(); // names embed a timestamp, so oldest sort first
    while files.len() > MAX_SNIPS_ON_DISK {
        let _ = fs::remove_file(files.remove(0));
    }
}

// ------------------------------------------------------------------ permission

#[cfg(target_os = "macos")]
mod mac_permission {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }
}

/// On macOS, make sure Screen Recording is allowed (prompting the first time).
fn ensure_capture_permission() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        if !mac_permission::CGPreflightScreenCaptureAccess() {
            mac_permission::CGRequestScreenCaptureAccess();
            return Err(
                "SnipSpeech needs Screen Recording permission. Enable it in System Settings > \
                 Privacy & Security > Screen Recording, then quit and reopen SnipSpeech."
                    .into(),
            );
        }
    }
    Ok(())
}

// -------------------------------------------------------------------- capture

fn grab_frames() -> Result<(Vec<Frame>, Vec<OverlayInfo>), String> {
    ensure_capture_permission()?;
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let mut frames = Vec::new();
    let mut infos = Vec::new();

    for (i, m) in monitors.iter().enumerate() {
        let image = m.capture_image().map_err(|e| e.to_string())?;
        let label = format!("overlay-{i}");

        // Lightweight JPEG copy for the overlay background; the crop uses `image`.
        let rgb = DynamicImage::ImageRgba8(image.clone()).to_rgb8();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 88)
            .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;

        infos.push(OverlayInfo {
            label: label.clone(),
            x: m.x().map_err(|e| e.to_string())?,
            y: m.y().map_err(|e| e.to_string())?,
            w: m.width().map_err(|e| e.to_string())?,
            h: m.height().map_err(|e| e.to_string())?,
        });
        frames.push(Frame { label, image, jpeg });
    }
    if frames.is_empty() {
        return Err("No displays found.".into());
    }
    Ok((frames, infos))
}

/// Begin a snip: freeze all displays and open one overlay per display.
pub fn start(app: &AppHandle) {
    {
        let state = app.state::<SnipState>();
        let mut s = state.0.lock().unwrap();
        if s.active {
            return; // already snipping
        }
        s.active = true;
    }

    let app = app.clone();
    std::thread::spawn(move || match grab_frames() {
        Ok((frames, infos)) => {
            app.state::<SnipState>().0.lock().unwrap().frames = frames;
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                for info in &infos {
                    let built = WebviewWindowBuilder::new(
                        &handle,
                        &info.label,
                        WebviewUrl::App("overlay.html".into()),
                    )
                    .title("SnipSpeech overlay")
                    .decorations(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .shadow(false)
                    .visible_on_all_workspaces(true)
                    .position(info.x as f64, info.y as f64)
                    .inner_size(info.w as f64, info.h as f64)
                    .focused(true)
                    .build();
                    if let Err(e) = built {
                        eprintln!("[snipspeech] overlay failed: {e}");
                        end_session(&handle);
                        return;
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("[snipspeech] capture failed: {e}");
            app.state::<SnipState>().0.lock().unwrap().active = false;
            // Tell the user on screen instead of failing silently.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.center();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit("capture-error", e);
        }
    });
}

/// Jump straight to the macOS Screen Recording privacy pane.
#[tauri::command]
pub fn open_screen_recording_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();
}

/// Close every overlay window and drop the frozen frames from memory.
fn end_session(app: &AppHandle) {
    {
        let state = app.state::<SnipState>();
        let mut s = state.0.lock().unwrap();
        s.active = false;
        s.frames.clear();
    }
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.destroy();
        }
    }
}

// ------------------------------------------------------------------- commands

/// The frozen JPEG for one overlay window.
#[tauri::command]
pub fn overlay_frame(state: State<SnipState>, label: String) -> Result<Response, String> {
    let s = state.0.lock().unwrap();
    s.frames
        .iter()
        .find(|f| f.label == label)
        .map(|f| Response::new(f.jpeg.clone()))
        .ok_or_else(|| "no frame for this overlay".to_string())
}

/// Crop the chosen rectangle (physical pixels, relative to that display's frame).
#[tauri::command]
pub fn finish_snip(
    app: AppHandle,
    state: State<SnipState>,
    label: String,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let cropped = {
        let s = state.0.lock().unwrap();
        let frame = s
            .frames
            .iter()
            .find(|f| f.label == label)
            .ok_or("no frame for this overlay")?;
        let (iw, ih) = frame.image.dimensions();
        let x = x.min(iw.saturating_sub(1));
        let y = y.min(ih.saturating_sub(1));
        let w = w.min(iw - x);
        let h = h.min(ih - y);
        if w < MIN_SNIP_PX || h < MIN_SNIP_PX {
            None // accidental click: treat as cancel
        } else {
            Some(image::imageops::crop_imm(&frame.image, x, y, w, h).to_image())
        }
    };

    end_session(&app); // overlay disappears immediately

    let Some(cropped) = cropped else { return Ok(()) };

    let dir = temp_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("snip-{stamp}.png"));
    cropped.save(&path).map_err(|e| e.to_string())?;
    prune_old_snips();

    state.0.lock().unwrap().latest = Some(path.clone());
    show_preview(&app);
    let _ = app.emit("snip-captured", path.to_string_lossy().to_string());
    Ok(())
}

#[tauri::command]
pub fn cancel_snip(app: AppHandle) {
    end_session(&app);
}

/// Bytes of the most recent snip PNG (used by the Milestone 2 preview window).
#[tauri::command]
pub fn read_latest_snip(state: State<SnipState>) -> Result<Response, String> {
    let path = state
        .0
        .lock()
        .unwrap()
        .latest
        .clone()
        .ok_or("no snip yet")?;
    if !is_inside_temp(&path) {
        return Err("refusing to read outside the snip folder".into());
    }
    fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

fn is_inside_temp(path: &Path) -> bool {
    path.starts_with(temp_dir())
}

fn show_preview(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("preview") {
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let _ = WebviewWindowBuilder::new(
            &handle,
            "preview",
            WebviewUrl::App("preview.html".into()),
        )
        .title("Snip preview")
        .inner_size(520.0, 420.0)
        .always_on_top(true)
        .center()
        .build();
    });
}
