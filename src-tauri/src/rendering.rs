use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

// ── RenderRegistry ──────────────────────────────────────────────────

pub struct RenderRegistry {
    cancellers: Mutex<HashMap<String, Arc<Notify>>>,
}

impl RenderRegistry {
    pub fn new() -> Self {
        Self { cancellers: Mutex::new(HashMap::new()) }
    }
    fn register(&self, id: &str) -> Arc<Notify> {
        let n = Arc::new(Notify::new());
        self.cancellers.lock().unwrap().insert(id.to_string(), n.clone());
        n
    }
    fn unregister(&self, id: &str) {
        self.cancellers.lock().unwrap().remove(id);
    }
    pub fn cancel(&self, id: &str) {
        if let Some(n) = self.cancellers.lock().unwrap().get(id) {
            n.notify_waiters();
        }
    }
}

// ── Structs ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct Span {
    pub in_s: f64,
    pub out_s: f64,
    #[serde(default)]
    pub source_idx: usize,
}

#[derive(Deserialize)]
pub struct LogoCfg {
    pub path: String,
    pub position: String,
    pub opacity: f64,
    pub width_pct: f64,
}

#[derive(Deserialize)]
pub struct ClipCfg {
    pub path: String,
}

#[derive(Deserialize, Clone)]
pub struct FaceKf {
    pub t: f64,
    pub x: f64,
}

fn default_aspect() -> String { "source".to_string() }
fn default_output_w() -> u32 { 1920 }
fn default_true() -> bool { true }

#[derive(Deserialize)]
pub struct RenderRequest {
    pub reel_id: String,
    pub source_path: String,
    pub spans: Vec<Span>,
    pub out_path: String,
    pub video_bitrate: String,
    pub fps: u32,

    // Phase 2
    #[serde(default = "default_aspect")]
    pub aspect: String,
    pub logo: Option<LogoCfg>,
    pub intro: Option<ClipCfg>,
    pub outro: Option<ClipCfg>,
    #[serde(default)]
    pub loudness_normalize: bool,
    #[serde(default = "default_output_w")]
    pub output_w: u32,

    // Phase 3
    #[serde(default)]
    pub burn_subtitles: bool,
    pub subtitle_srt: Option<String>,
    pub subtitle_style: Option<String>,
    #[serde(default)]
    pub preview: bool,
    #[serde(default)]
    pub stream_copy: bool,

    // Phase 4 F2
    pub video_codec: Option<String>,

    // Phase 4 F5
    #[serde(default)]
    pub face_keyframes: Option<Vec<FaceKf>>,

    // F18 — multi-source
    #[serde(default)]
    pub source_paths: Vec<String>,

    // whether each source has an audio stream (default true for backwards compat)
    #[serde(default = "default_true")]
    pub has_audio: bool,

    // filler removal produces micro-spans; stream copy cannot handle it
    #[serde(default)]
    pub remove_fillers: bool,
}

// ── Eligibility ─────────────────────────────────────────────────────

fn eligible_for_stream_copy(req: &RenderRequest) -> bool {
    req.stream_copy
        && req.source_paths.is_empty()  // stream copy requires single source
        && req.aspect == "source"
        && req.logo.is_none()
        && req.intro.is_none()
        && req.outro.is_none()
        && !req.burn_subtitles
        && !req.loudness_normalize
        && !req.remove_fillers
}

// ── Face tracking expression builder ────────────────────────────────

fn build_face_frac_expr(kfs: &[FaceKf]) -> String {
    if kfs.len() == 1 {
        return format!("{:.4}", kfs[0].x);
    }
    // Piecewise linear interpolation: nest if(lt(t,T1), X0+slope*(t-T0), ...) inward
    let mut expr = format!("{:.4}", kfs.last().unwrap().x);
    for i in (0..kfs.len() - 1).rev() {
        let t0 = kfs[i].t;
        let t1 = kfs[i + 1].t;
        let x0 = kfs[i].x;
        let dx = kfs[i + 1].x - x0;
        let dt = t1 - t0;
        if dt < 0.001 { continue; }
        expr = format!(
            "if(lt(t,{:.3}),{:.4}+{:.4}*clip((t-{:.3})/{:.3},0,1),{})",
            t1, x0, dx, t0, dt, expr
        );
    }
    expr
}

// ── Filter-complex arg builder ───────────────────────────────────────

pub fn build_args(req: &RenderRequest, out: &str) -> Result<Vec<String>, String> {
    // Validate aspect
    if !matches!(req.aspect.as_str(), "source" | "vertical_9_16") {
        return Err(format!("Invalid aspect value: '{}'. Must be 'source' or 'vertical_9_16'.", req.aspect));
    }

    // Effective source paths: use source_paths if provided (F18), else single source_path
    let effective_sources: Vec<&str> = if !req.source_paths.is_empty() {
        req.source_paths.iter().map(String::as_str).collect()
    } else {
        vec![req.source_path.as_str()]
    };
    let logo_input_idx = effective_sources.len();

    let mut filter = String::new();
    let n = req.spans.len();

    for (i, s) in req.spans.iter().enumerate() {
        let si = s.source_idx;
        if si >= effective_sources.len() {
            return Err(format!(
                "span source_idx {} is out of range (only {} source(s) provided)",
                si, effective_sources.len()
            ));
        }
        filter.push_str(&format!(
            "[{si}:v]trim=start={in_s}:end={out_s},setpts=PTS-STARTPTS[v{i}];",
            si = si, in_s = s.in_s, out_s = s.out_s, i = i
        ));
        if req.has_audio {
            filter.push_str(&format!(
                "[{si}:a]atrim=start={in_s}:end={out_s},asetpts=PTS-STARTPTS[a{i}];",
                si = si, in_s = s.in_s, out_s = s.out_s, i = i
            ));
        } else {
            let dur = s.out_s - s.in_s;
            filter.push_str(&format!(
                "anullsrc=r=48000:cl=stereo,atrim=duration={dur:.6},asetpts=PTS-STARTPTS[a{i}];",
                dur = dur, i = i
            ));
        }
    }
    for i in 0..n {
        filter.push_str(&format!("[v{}][a{}]", i, i));
    }
    filter.push_str(&format!("concat=n={}:v=1:a=1[vc][ac]", n));

    let mut last_v = "[vc]".to_string();

    // 9:16 reframe
    if req.aspect == "vertical_9_16" {
        let crop_x = match &req.face_keyframes {
            Some(kfs) if !kfs.is_empty() => {
                let expr = build_face_frac_expr(kfs);
                format!("clip(({expr})*iw-ih*9/32,0,iw-ih*9/16)")
            }
            _ => "(iw-ih*9/16)/2".to_string(),
        };
        filter.push_str(&format!(";{}crop=ih*9/16:ih:{}:0,scale=1080:1920[vcrop]", last_v, crop_x));
        last_v = "[vcrop]".to_string();
    }

    // Logo overlay
    if let Some(logo) = &req.logo {
        let xy = match logo.position.as_str() {
            "tl" => "30:30",
            "tr" => "W-w-30:30",
            "bl" => "30:H-h-30",
            _    => "W-w-30:H-h-30",
        };
        let logo_px = ((req.output_w as f64) * logo.width_pct / 100.0).round() as u32;
        filter.push_str(&format!(
            ";[{}:v]scale={}:-1,format=rgba,colorchannelmixer=aa={:.3}[lg]",
            logo_input_idx, logo_px, logo.opacity
        ));
        filter.push_str(&format!(";{}[lg]overlay={}[vlogo]", last_v, xy));
        last_v = "[vlogo]".to_string();
    }

    // Subtitle burn-in
    if req.burn_subtitles {
        if let Some(srt) = &req.subtitle_srt {
            // Sanitize reel_id and aspect for use in filename (avoid shell metacharacter injection)
            let safe_id: String = req.reel_id.chars()
                .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect();
            let safe_aspect: String = req.aspect.chars()
                .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
                .collect();
            // Use reel_id + aspect in filename to avoid concurrent render collisions (M12)
            let srt_path = std::env::temp_dir()
                .join(format!("reel_{}_{}.srt", safe_id, safe_aspect));
            std::fs::write(&srt_path, srt).map_err(|e| e.to_string())?;
            // Convert backslashes to forward slashes (Windows), then escape for filter_complex
            let escaped = srt_path.to_string_lossy()
                .replace('\\', "/")
                .replace(':', r"\:")
                .replace(',', r"\,")
                .replace('\'', r"\'");
            let style = req.subtitle_style.clone().unwrap_or_else(|| {
                "FontName=DejaVu Sans,FontSize=42,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,BorderStyle=1,Alignment=2,MarginV=80".into()
            });
            filter.push_str(&format!(
                ";{}subtitles='{}':force_style='{}'[vsub]",
                last_v, escaped, style
            ));
            last_v = "[vsub]".to_string();
        }
    }

    // 480p preview scale
    if req.preview {
        filter.push_str(&format!(";{}scale=-2:480[vprev]", last_v));
        last_v = "[vprev]".to_string();
    }

    // Loudness normalization (skip for preview)
    let audio_label = if req.loudness_normalize && !req.preview {
        filter.push_str(";[ac]loudnorm=I=-14:LRA=11:TP=-1.5[an]");
        "[an]"
    } else {
        "[ac]"
    };

    let mut args = vec!["-y".into()];
    for src in &effective_sources {
        args.push("-i".into());
        args.push(src.to_string());
    }
    if let Some(logo) = &req.logo {
        args.extend_from_slice(&["-i".into(), logo.path.clone()]);
    }
    args.extend_from_slice(&[
        "-filter_complex".into(), filter,
        "-map".into(), last_v,
        "-map".into(), audio_label.into(),
    ]);

    if req.preview {
        let preview_codec = req.video_codec.as_deref().unwrap_or("libx264");
        if preview_codec == "h264_videotoolbox" {
            args.extend_from_slice(&[
                "-c:v".into(), "h264_videotoolbox".into(),
                "-q:v".into(), "50".into(),
            ]);
        } else {
            args.extend_from_slice(&[
                "-c:v".into(), "libx264".into(),
                "-preset".into(), "veryfast".into(),
                "-crf".into(), "28".into(),
            ]);
        }
        args.extend_from_slice(&[
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "96k".into(),
        ]);
    } else {
        let codec = req.video_codec.as_deref().unwrap_or("libx264");
        args.push("-c:v".into());
        args.push(codec.into());
        match codec {
            "h264_nvenc" => args.extend_from_slice(&[
                "-b:v".into(), req.video_bitrate.clone(),
                "-rc".into(), "vbr".into(), "-cq".into(), "19".into(),
            ]),
            "h264_qsv" => args.extend_from_slice(&[
                "-b:v".into(), req.video_bitrate.clone(),
                "-look_ahead".into(), "1".into(),
            ]),
            _ => {
                args.extend_from_slice(&["-b:v".into(), req.video_bitrate.clone()]);
                if codec == "libx264" {
                    args.extend_from_slice(&["-preset".into(), "medium".into()]);
                }
            }
        }
        args.extend_from_slice(&["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }

    args.extend_from_slice(&[
        "-progress".into(), "pipe:2".into(),
        "-nostats".into(),
        out.into(),
    ]);
    Ok(args)
}

// ── Stream-copy fast path ────────────────────────────────────────────

async fn run_stream_copy(
    app: &tauri::AppHandle,
    req: &RenderRequest,
    cancel: Arc<Notify>,
) -> Result<String, String> {
    let stem = req.out_path.strip_suffix(".mp4").unwrap_or(&req.out_path);
    let mut intermediates: Vec<String> = Vec::new();

    for (i, span) in req.spans.iter().enumerate() {
        let part = format!("{}_part{}.mp4", stem, i);
        let args = vec![
            "-y".into(),
            "-ss".into(), span.in_s.to_string(),
            "-to".into(), span.out_s.to_string(),
            "-i".into(), req.source_path.clone(),
            "-c".into(), "copy".into(),
            "-avoid_negative_ts".into(), "make_zero".into(),
            "-progress".into(), "pipe:2".into(), "-nostats".into(),
            part.clone(),
        ];
        if let Err(e) = crate::ffmpeg::run_ffmpeg_cancellable(app, args, &req.reel_id, 1, cancel.clone()).await {
            for p in &intermediates { let _ = std::fs::remove_file(p); }
            let _ = std::fs::remove_file(&part); // delete partially-written part
            return Err(e);
        }
        intermediates.push(part);
    }

    let list = intermediates.iter()
        .map(|p| format!("file '{}'", p.replace('\'', r"'\''")))
        .collect::<Vec<_>>()
        .join("\n");
    let list_path = format!("{}.list", stem);
    std::fs::write(&list_path, &list).map_err(|e| e.to_string())?;

    let final_args = vec![
        "-y".into(), "-f".into(), "concat".into(), "-safe".into(), "0".into(),
        "-i".into(), list_path.clone(),
        "-c".into(), "copy".into(),
        "-progress".into(), "pipe:2".into(), "-nostats".into(),
        req.out_path.clone(),
    ];
    let result = crate::ffmpeg::run_ffmpeg_cancellable(
        app, final_args, &req.reel_id, 1, cancel,
    ).await;

    for p in &intermediates { let _ = std::fs::remove_file(p); }
    let _ = std::fs::remove_file(&list_path);

    if let Err(e) = result {
        let _ = std::fs::remove_file(&req.out_path);
        return Err(e);
    }
    Ok(req.out_path.clone())
}

// ── Bookend concat ───────────────────────────────────────────────────

async fn concat_with_bookends(
    app: &tauri::AppHandle,
    reel_id: &str,
    body_path: &str,
    intro: Option<&ClipCfg>,
    outro: Option<&ClipCfg>,
    final_path: &str,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let mut list = String::new();
    if let Some(c) = intro {
        list.push_str(&format!("file '{}'\n", c.path.replace('\'', r"'\''")));
    }
    list.push_str(&format!("file '{}'\n", body_path.replace('\'', r"'\''")));
    if let Some(c) = outro {
        list.push_str(&format!("file '{}'\n", c.path.replace('\'', r"'\''")));
    }

    let list_path = format!("{}.concat.txt", body_path);
    std::fs::write(&list_path, &list).map_err(|e| e.to_string())?;

    let copy_args = vec![
        "-y".into(), "-f".into(), "concat".into(), "-safe".into(), "0".into(),
        "-i".into(), list_path.clone(),
        "-c".into(), "copy".into(),
        "-progress".into(), "pipe:2".into(), "-nostats".into(),
        final_path.into(),
    ];
    match crate::ffmpeg::run_ffmpeg_cancellable(app, copy_args, reel_id, 1, cancel.clone()).await {
        Ok(_) => {}
        Err(e) if e == "cancelled" => {
            let _ = std::fs::remove_file(body_path);
            let _ = std::fs::remove_file(&list_path);
            let _ = std::fs::remove_file(final_path);
            return Err(e);
        }
        Err(_) => {
            // Codec mismatch — fall back to re-encode
            let reencode_args = vec![
                "-y".into(), "-f".into(), "concat".into(), "-safe".into(), "0".into(),
                "-i".into(), list_path.clone(),
                "-c:v".into(), "libx264".into(), "-b:v".into(), "8M".into(),
                "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(),
                "-progress".into(), "pipe:2".into(), "-nostats".into(),
                final_path.into(),
            ];
            let r = crate::ffmpeg::run_ffmpeg_cancellable(app, reencode_args, reel_id, 1, cancel).await;
            // Always clean up before returning, even on re-encode failure
            let _ = std::fs::remove_file(body_path);
            let _ = std::fs::remove_file(&list_path);
            return r;
        }
    }

    let _ = std::fs::remove_file(body_path);
    let _ = std::fs::remove_file(&list_path);
    Ok(())
}

// ── Core render logic ────────────────────────────────────────────────

async fn do_render(
    app: &tauri::AppHandle,
    req: &RenderRequest,
    cancel: Arc<Notify>,
) -> Result<String, String> {
    if eligible_for_stream_copy(req) {
        return run_stream_copy(app, req, cancel).await;
    }

    let total_frames: u64 = req.spans.iter()
        .map(|s| ((s.out_s - s.in_s) * req.fps as f64).ceil() as u64)
        .sum();

    // Track subtitle SRT path so we can delete it after rendering (same sanitization as build_args)
    let srt_temp = if req.burn_subtitles && req.subtitle_srt.is_some() {
        let safe_id: String = req.reel_id.chars()
            .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect();
        let safe_aspect: String = req.aspect.chars()
            .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
            .collect();
        Some(std::env::temp_dir().join(format!("reel_{}_{}.srt", safe_id, safe_aspect)))
    } else {
        None
    };

    let has_bookends = req.intro.is_some() || req.outro.is_some();
    let body_path = if has_bookends {
        format!("{}_body.mp4", req.out_path.strip_suffix(".mp4").unwrap_or(&req.out_path))
    } else {
        req.out_path.clone()
    };

    let args = build_args(req, &body_path)?;
    let render_result = crate::ffmpeg::run_ffmpeg_cancellable(
        app, args, &req.reel_id, total_frames, cancel.clone(),
    ).await;

    // Always clean up subtitle SRT regardless of render outcome
    if let Some(ref p) = srt_temp { let _ = std::fs::remove_file(p); }

    if let Err(e) = render_result {
        let _ = std::fs::remove_file(&body_path);
        return Err(e);
    }

    if has_bookends {
        if let Err(e) = concat_with_bookends(
            app,
            &req.reel_id,
            &body_path,
            req.intro.as_ref(),
            req.outro.as_ref(),
            &req.out_path,
            cancel,
        ).await {
            // body_path is cleaned by concat_with_bookends; remove partial final output
            let _ = std::fs::remove_file(&req.out_path);
            return Err(e);
        }
    }

    Ok(req.out_path.clone())
}

// ── Tauri commands ───────────────────────────────────────────────────

#[tauri::command]
pub async fn run_render(
    app: tauri::AppHandle,
    state: tauri::State<'_, RenderRegistry>,
    req: RenderRequest,
) -> Result<String, String> {
    let cancel = state.register(&req.reel_id);
    let result = do_render(&app, &req, cancel).await;
    state.unregister(&req.reel_id);
    result
}

#[tauri::command]
pub fn cancel_render(state: tauri::State<'_, RenderRegistry>, reel_id: String) {
    state.cancel(&reel_id);
}

#[tauri::command]
pub async fn detect_hw_encoder(app: tauri::AppHandle) -> Result<String, String> {
    let (encoders_txt, _) = crate::ffmpeg::run_ffmpeg_output(&app, &["-hide_banner", "-encoders"]).await?;

    let candidates: &[&str] = if encoders_txt.contains("h264_videotoolbox") {
        &["h264_videotoolbox"]
    } else if encoders_txt.contains("h264_nvenc") {
        &["h264_nvenc"]
    } else if encoders_txt.contains("h264_qsv") {
        &["h264_qsv"]
    } else {
        &[]
    };

    // Use a per-call unique suffix to avoid concurrent detection collisions
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir()
        .join(format!("reel_hw_probe_{}_{}.mp4", std::process::id(), ts));
    let tmp_str = tmp.to_string_lossy().to_string();

    for &codec in candidates {
        let result = crate::ffmpeg::run_ffmpeg_output(&app, &[
            "-y", "-f", "lavfi",
            "-i", "color=c=black:s=32x32:r=1:d=0.1",
            "-c:v", codec, "-frames:v", "1",
            &tmp_str,
        ]).await;
        let _ = std::fs::remove_file(&tmp);
        if let Ok((_, true)) = result { return Ok(codec.to_string()); }
    }

    Ok("libx264".to_string())
}

// ── F6: thumbnail extraction ─────────────────────────────────────────

#[tauri::command]
pub async fn extract_thumbnail(
    app: tauri::AppHandle,
    state: tauri::State<'_, RenderRegistry>,
    video_path: String,
    timestamp: f64,
    out_path: String,
) -> Result<String, String> {
    let reel_id = format!("thumb:{}", out_path);
    let cancel = state.register(&reel_id);
    let args = vec![
        "-y".into(),
        "-ss".into(), timestamp.to_string(),
        "-i".into(), video_path,
        "-frames:v".into(), "1".into(),
        "-q:v".into(), "2".into(),
        out_path.clone(),
    ];
    let result = crate::ffmpeg::run_ffmpeg_cancellable(&app, args, &reel_id, 1, cancel).await;
    state.unregister(&reel_id);
    result?;
    Ok(out_path)
}
