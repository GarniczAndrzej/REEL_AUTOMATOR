mod deps;
mod engine;
mod ffmpeg;
mod keychain;
mod metadata;
mod models;
mod project;
mod whisper;
mod waveform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // S-21 instrumentation: surface (never suppress) any panic in a command
    // future or Tauri/tokio internal with a greppable `[PANIC]` tag, then chain
    // to the default hook so the standard unwind/backtrace print still happens.
    // A silent unwind out of a command future was a structural blind spot.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        eprintln!("[PANIC] {location} — {payload}");
        default_hook(info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            project::save_project,
            project::load_project,
            project::save_text_file,
            project::load_text_file,
            project::open_path,
            project::load_llm_cache,
            project::save_llm_cache,
            project::clear_llm_cache,
            whisper::transcribe_video,
            whisper::align_transcript,
            whisper::cancel_transcription,
            engine::whisperx_engine_check,
            engine::whisperx_engine_capability,
            engine::whisperx_engine_cached,
            deps::load_deps_spec,
            deps::deps_status,
            deps::get_deps_root,
            deps::set_deps_root,
            deps::deps_root_space,
            deps::download_dependency,
            models::list_models,
            models::download_model,
            models::delete_model,
            waveform::extract_waveform,
            metadata::probe_video_metadata,
            keychain::get_credential,
            keychain::set_credential,
            keychain::delete_credential,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
