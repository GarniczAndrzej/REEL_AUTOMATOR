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

// ── F13 render queue persistence ──────────────────────────────────────

#[tauri::command]
pub async fn save_render_queue(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    fs::write(dir.join("render-queue.json"), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_render_queue(app: tauri::AppHandle) -> Option<String> {
    let dir = app.path().app_cache_dir().ok()?;
    fs::read_to_string(dir.join("render-queue.json")).ok()
}

// ── F12 global render presets ─────────────────────────────────────────

#[tauri::command]
pub async fn list_render_presets(app: tauri::AppHandle) -> Vec<String> {
    let dir = match app.path().app_config_dir() {
        Ok(d) => d.join("presets"),
        Err(_) => return vec![],
    };
    let Ok(entries) = fs::read_dir(&dir) else { return vec![]; };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") { Some(name[..name.len() - 5].to_string()) } else { None }
        })
        .collect()
}

#[tauri::command]
pub async fn save_render_preset(app: tauri::AppHandle, name: String, content: String) -> Result<(), String> {
    let safe = sanitize_name(&name);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("presets");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{}.json", safe)), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_render_preset(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let safe = sanitize_name(&name);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("presets");
    let path = dir.join(format!("{}.json", safe));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn load_render_preset(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let safe = sanitize_name(&name);
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("presets");
    fs::read_to_string(dir.join(format!("{}.json", safe))).map_err(|e| e.to_string())
}

fn sanitize_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "_unnamed".to_string();
    }
    trimmed.chars()
        .take(100)
        .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect()
}
