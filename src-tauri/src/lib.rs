mod engine;
mod ffmpeg;
mod metadata;
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
            project::save_text_file,
            project::load_llm_cache,
            project::save_llm_cache,
            project::clear_llm_cache,
            whisper::transcribe_video,
            whisper::align_transcript,
            whisper::cancel_transcription,
            engine::whisperx_engine_check,
            engine::whisperx_engine_capability,
            models::list_models,
            models::download_model,
            models::delete_model,
            waveform::extract_waveform,
            metadata::probe_video_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
