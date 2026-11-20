//! Snip history: the extracted TEXT of past snips (never the images), saved in the
//! app's data folder. Text is tiny, and "Clear History" wipes it in one click.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const FILE: &str = "history.json";
const KEY: &str = "entries";
/// Oldest entries are dropped beyond this many.
const MAX_ENTRIES: usize = 200;

#[derive(Serialize)]
pub struct HistoryItem {
    id: u64,
    preview: String,
    words: usize,
}

fn entries(app: &AppHandle) -> Vec<Value> {
    app.store(FILE)
        .ok()
        .and_then(|s| s.get(KEY))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

/// Record a new snip's text (newest first). Skips an immediate duplicate.
pub fn add(app: &AppHandle, text: &str) {
    let Ok(store) = app.store(FILE) else { return };
    let mut list = entries(app);
    if list.first().and_then(|e| e["text"].as_str()) == Some(text) {
        return;
    }
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    list.insert(0, json!({ "id": id, "text": text }));
    list.truncate(MAX_ENTRIES);
    store.set(KEY, Value::Array(list));
    let _ = store.save();
}

#[tauri::command]
pub fn history_list(app: AppHandle) -> Vec<HistoryItem> {
    entries(&app)
        .iter()
        .filter_map(|e| {
            let text = e["text"].as_str()?;
            let one_line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            let preview: String = one_line.chars().take(110).collect();
            Some(HistoryItem {
                id: e["id"].as_u64()?,
                preview,
                words: text.split_whitespace().count(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn history_get(app: AppHandle, id: u64) -> Option<String> {
    entries(&app)
        .iter()
        .find(|e| e["id"].as_u64() == Some(id))
        .and_then(|e| e["text"].as_str().map(str::to_owned))
}

/// Wipe every saved snip from disk.
#[tauri::command]
pub fn history_clear(app: AppHandle) -> Result<(), String> {
    let store = app.store(FILE).map_err(|e| e.to_string())?;
    store.delete(KEY);
    store.save().map_err(|e| e.to_string())
}
