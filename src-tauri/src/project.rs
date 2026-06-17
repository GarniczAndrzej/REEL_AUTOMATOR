use serde_json::Value;
use std::fs;
use tauri::Manager;

#[tauri::command]
pub fn save_project(path: String, payload: Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_project(path: String) -> Result<Value, String> {
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

/// Write arbitrary text to a user-chosen path (transcript .srt/.vtt export).
/// The path comes from the dialog plugin's save() picker on the frontend.
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Read arbitrary text from a user-chosen path (preset .json import).
/// Symmetric with save_text_file; the path comes from the dialog plugin's open() picker.
#[tauri::command]
pub fn load_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ── F7 LLM cache ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn load_llm_cache(app: tauri::AppHandle, hash: String) -> Option<String> {
    let dir = app.path().app_cache_dir().ok()?.join("llm-cache");
    fs::read_to_string(dir.join(format!("{}.json", hash))).ok()
}

#[tauri::command]
pub async fn save_llm_cache(app: tauri::AppHandle, hash: String, content: String) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("llm-cache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{}.json", hash)), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_llm_cache(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("llm-cache");
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
