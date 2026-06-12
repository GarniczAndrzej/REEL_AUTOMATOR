mod engine;
mod ffmpeg;
mod models;
mod project;
mod whisper;
mod waveform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            project::save_project,
            project::load_project,
            project::load_llm_cache,
            project::save_llm_cache,
            project::clear_llm_cache,
            project::save_render_queue,
            project::load_render_queue,
            project::list_render_presets,
            project::load_render_preset,
            project::save_render_preset,
            project::delete_render_preset,
            whisper::transcribe_video,
            whisper::cancel_transcription,
            engine::whisperx_engine_check,
            models::list_models,
            models::download_model,
            models::delete_model,
            waveform::extract_waveform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
