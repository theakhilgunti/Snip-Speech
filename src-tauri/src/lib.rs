use serde_json::json;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const KEYBIND_KEY: &str = "keybind";

/// Called by the global hotkey and the tray's "New Snip".
/// The capture overlay is wired in here in Milestone 2.
fn trigger_snip(_app: &AppHandle) {
    println!("[snipspeech] snip requested");
}

fn saved_keybind(app: &AppHandle) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store.get(KEYBIND_KEY)?.as_str().map(str::to_owned)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn get_keybind(app: AppHandle) -> Option<String> {
    saved_keybind(&app)
}

#[tauri::command]
fn set_keybind(app: AppHandle, accelerator: String) -> Result<(), String> {
    let gs = app.global_shortcut();
    let previous = saved_keybind(&app);

    // Free the old shortcut first so re-recording never leaves two active.
    let _ = gs.unregister_all();

    if let Err(e) = gs.register(accelerator.as_str()) {
        // Restore the previous shortcut if the new one is invalid or taken.
        if let Some(prev) = previous {
            let _ = gs.register(prev.as_str());
        }
        return Err(format!("Couldn't register that shortcut ({e}). Try another."));
    }

    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEYBIND_KEY, json!(accelerator));
    store.save().map_err(|e| e.to_string())?;

    // Onboarding done: drop into background/tray mode.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
fn clear_keybind(app: AppHandle) -> Result<(), String> {
    let _ = app.global_shortcut().unregister_all();
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.delete(KEYBIND_KEY);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        trigger_snip(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![get_keybind, set_keybind, clear_keybind])
        .setup(|app| {
            let handle = app.handle().clone();

            // Tray icon + menu.
            let new_snip = MenuItemBuilder::with_id("new_snip", "New Snip").build(app)?;
            let controls = MenuItemBuilder::with_id("controls", "Open Controls").build(app)?;
            let keybind = MenuItemBuilder::with_id("keybind", "Change Keybind").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit SnipSpeech").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&new_snip, &controls, &keybind])
                .separator()
                .item(&quit)
                .build()?;

            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SnipSpeech")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "new_snip" => trigger_snip(app),
                    "controls" => show_main(app),
                    "keybind" => {
                        show_main(app);
                        let _ = app.emit("show-onboarding", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Restore the saved shortcut, or run first-launch onboarding.
            match saved_keybind(&handle) {
                Some(accel) => {
                    if handle.global_shortcut().register(accel.as_str()).is_err() {
                        // Saved shortcut no longer valid/available: ask again.
                        show_main(&handle);
                    }
                }
                None => show_main(&handle),
            }
            Ok(())
        })
        // Closing the window hides it; the app keeps living in the tray.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SnipSpeech");
}
