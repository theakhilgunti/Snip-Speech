//! The floating always-on-top SnipSpeech pill (and its expandable drawer).
//!
//! The window is created once at startup, hidden, so its page is loaded and listening
//! before the first snip arrives. Closing/minimizing only hides it.

use tauri::{
    window::{Effect, EffectState, EffectsBuilder},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

pub const PILL_W: f64 = 340.0;
pub const PILL_H: f64 = 56.0;

fn default_position(app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let logical_w = m.size().width as f64 / m.scale_factor();
        return ((logical_w - PILL_W) / 2.0, 64.0);
    }
    (200.0, 64.0)
}

/// Create the (hidden) pill window. Must run on the main thread (e.g. in `setup`).
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let (x, y) = default_position(app);
    WebviewWindowBuilder::new(app, "pill", WebviewUrl::App("pill.html".into()))
        .title("SnipSpeech")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .shadow(true)
        .visible_on_all_workspaces(true)
        .inner_size(PILL_W, PILL_H)
        .position(x, y)
        .visible(false)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::HudWindow)
                .state(EffectState::Active)
                .radius(26.0)
                .build(),
        )
        .build()?;
    Ok(())
}

/// Bring the pill to the front, optionally asking it to open a drawer tab
/// ("transcript", "history" or "settings").
pub fn show(app: &AppHandle, tab: Option<&'static str>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if handle.get_webview_window("pill").is_none() {
            let _ = build(&handle);
        }
        if let Some(w) = handle.get_webview_window("pill") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        if let Some(t) = tab {
            let _ = handle.emit("pill-open-tab", t);
        }
    });
}
