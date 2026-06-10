mod face_detect;
mod ffmpeg;
mod project;
mod rendering;
mod whisper;
mod waveform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(rendering::RenderRegistry::new())
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
            rendering::run_render,
            rendering::cancel_render,
            rendering::detect_hw_encoder,
            rendering::extract_thumbnail,
            whisper::transcribe_video,
            face_detect::detect_face_keyframes,
            waveform::extract_waveform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
