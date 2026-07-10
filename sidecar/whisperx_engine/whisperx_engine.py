#!/usr/bin/env python3
"""
WhisperX engine sidecar for Reels EDL Automator.

A thin CLI around `whisperx` that the Rust backend drives as a frozen Tauri
`externalBin` sidecar (the same way the FFmpeg sidecar is driven). It produces
text + word-level forced alignment with no separate user install.

Contract (stable — the Rust layer parses exactly this):

  stdout  ── one normalized JSON document on success:
            {
              "language": str,
              "device": str,   # transcription (CT2) device actually used: cuda|cpu
              "segments": [
                { "start": float, "end": float, "text": str,
                  "words": [ { "text": str, "start": float, "end": float,
                              "score": float|null, "speaker": str|null } ] }
              ]
            }
            (the Rust layer parses this as an untyped Value, so `device` is an
            additive field older consumers simply ignore.)

  stderr  ── greppable progress lines, one per update:
            PROGRESS phase=<transcribe|align|diarize> percent=<0-100>
            (plus free-form human log lines that the Rust layer ignores)

  exit codes ── machine-distinguishable (see EXIT_* below). The Rust layer maps
            each to a specific Polish user message.

Modes:
  (default)        transcribe + forced-align (+ optional --diarize)
  --align-only     force-align an existing transcript to the audio
                   (skips transcription; requires --transcript)
  --selftest       readiness probe; prints {ok, version, gpu,
                   alignment_model_ready} and exits 0. Must NOT require a
                   downloaded transcription model. `alignment_model_ready` is a
                   *real* check: it loads the bundled align model and runs one
                   tiny forced-align, so a broken bundling of the wav2vec2 import
                   chain reports false instead of a misleading true.

This script is intentionally dependency-light at import time: heavy deps
(`whisperx`, `torch`) are imported lazily inside the functions that need them so
`--version` stays fast and works before any model is downloaded. `--selftest`
loads the (bundled, offline) align model to verify alignment really works, so it
takes a few seconds — still no downloaded transcription model required.
"""

import argparse
import json
import os
import sys

# ── Exit codes (kept in sync with src-tauri/src/whisper.rs error mapping) ──
EXIT_OK = 0
EXIT_USAGE = 2  # argparse default
EXIT_ENGINE_INTERNAL = 1
EXIT_MODEL_NOT_FOUND = 10
EXIT_AUDIO_DECODE_FAIL = 11
EXIT_ALIGN_FAIL = 12
EXIT_DIARIZE_FAIL = 13
EXIT_TRANSCRIBE_FAIL = 14

ENGINE_VERSION = "1.0.0"

# Per-language wav2vec2 alignment model. It is NOT baked into the frozen binary:
# a multi-GB onefile Mach-O fails to load on macOS, so the model ships *beside*
# the sidecar (Tauri bundle.resources) and its directory is passed in via
# `--align-model-dir` (env ENGINE_ALIGN_DIR). Resolution order: explicit override
# → next to the executable → PyInstaller _MEIPASS (legacy) → next to this script.
ALIGN_MODEL_SUBDIR = "align_models"


def _align_models_base():
    """Directory containing per-language alignment models (<base>/<lang>)."""
    override = os.environ.get("ENGINE_ALIGN_DIR")
    if override:
        return override
    # Beside the executable — frozen sidecar with align_models/ shipped next to it.
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    cand = os.path.join(exe_dir, ALIGN_MODEL_SUBDIR)
    if os.path.isdir(cand):
        return cand
    # Legacy baked location / source run.
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return os.path.join(meipass, ALIGN_MODEL_SUBDIR)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ALIGN_MODEL_SUBDIR)


# Pin UTF-8 on both std streams before we capture/redirect them. The JSON result
# contract carries non-ASCII (Polish diacritics ą/ć/ę/ł/ń/ó/ś/ź/ż) via
# ensure_ascii=False, but on Windows the std streams default to the legacy
# ANSI/OEM codepage (cp1250/cp1252/cp852) when stdio is a pipe — which mangles or
# drops those characters (and can even raise UnicodeEncodeError mid-run). The Rust
# layer reads stdout as UTF-8, so force UTF-8 here. Best-effort: a non-
# reconfigurable stream (already detached / unusual freeze) is left as-is.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# Real stdout is reserved for the single JSON result document — the Rust layer
# parses stdout verbatim as JSON. whisperx/pyannote/faster-whisper log chatter
# (e.g. "Performing voice activity detection") to stdout, which would corrupt
# that contract, so main() reassigns sys.stdout → stderr for the whole run and
# the result is written through this captured original handle instead.
_RESULT_OUT = sys.stdout


def _write_result(doc):
    """Write the one JSON contract document to the real (reserved) stdout."""
    _RESULT_OUT.write(doc)
    _RESULT_OUT.flush()


def _emit_progress(phase, percent):
    """Write one greppable progress line to stderr."""
    pct = max(0, min(100, int(round(percent))))
    sys.stderr.write("PROGRESS phase=%s percent=%d\n" % (phase, pct))
    sys.stderr.flush()


def _log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def _alignment_model_dir(language):
    return os.path.join(_align_models_base(), language or "")


def _cublas_usable():
    """True iff the two cuBLAS DLLs CTranslate2 needs for CUDA inference are loadable.

    CUDA *enumeration* needs only the driver (nvcuda.dll), but CT2 inference needs
    cuBLAS + cuBLASLt — which the CPU build does NOT ship. Without this gate the CPU
    engine would enumerate CUDA on any NVIDIA box and claim device:cuda, then fail at
    the first matmul. So ct2_device must require cuBLAS, not just a device count.

    - Shipping GPU build: rthook_cublas.py preloads them → REEL_CUBLAS_PRELOAD == "ok".
    - Dormant gpu-full build: torch's own cuBLAS is pulled in by `import torch`, so a
      by-name load resolves the already-loaded module (caller imports torch first).
    - CPU build: no cuBLAS anywhere → False → CT2 stays on CPU.
    Non-Windows has no cuBLAS-DLL packaging concept (macOS has no CUDA; Linux GPU is
    out of scope), so don't let this gate suppress a genuine CT2 CUDA device there.
    """
    if sys.platform != "win32":
        return True
    if os.environ.get("REEL_CUBLAS_PRELOAD") == "ok":
        return True
    base = getattr(sys, "_MEIPASS", None)
    try:
        import ctypes

        # cuBLASLt first — cublas64_12.dll depends on it. Prefer the bundled absolute
        # path (gpu-full ships torch's copy in _MEIPASS); fall back to by-name, which
        # resolves an already-loaded module (torch's cuBLAS after import).
        for name in ("cublasLt64_12.dll", "cublas64_12.dll"):
            cand = os.path.join(base, name) if base else None
            ctypes.WinDLL(cand if cand and os.path.isfile(cand) else name)
        return True
    except Exception:
        return False


def _ct2_cuda_available():
    """True iff CTranslate2 can see a CUDA device AND cuBLAS is usable for inference.

    This is the *transcription* device probe. CT2's stock PyPI wheel is CUDA-capable
    on its own (it links cuBLAS lazily via LoadLibrary), so this is independent of
    torch's build — a torch+cpu process can still transcribe on CUDA through CT2, as
    long as the cuBLAS DLLs are present. Any import/call failure ⇒ False.
    """
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() <= 0:
            return False
    except Exception:
        return False
    return _cublas_usable()


def _detect_devices():
    """Probe the transcription (CT2) device and the torch (VAD/align/diarize) device
    independently. They may legitimately differ: on the shipping Windows GPU build
    CT2 runs on CUDA while torch is CPU-only.

    Returns (ct2_device, torch_device, gpu, compute_type):
      - ct2_device   : 'cuda' if CT2 sees a CUDA device with usable cuBLAS else 'cpu'
      - torch_device : 'cuda' | 'mps' | 'cpu' from torch's own capability
      - gpu          : ct2_device == 'cuda' or torch_device in ('cuda', 'mps')
      - compute_type : 'float16' when CT2 is on CUDA, else 'int8'
    """
    # Determine torch's device FIRST: on the dormant gpu-full build `import torch`
    # loads torch's cuBLAS into the process, which _ct2_cuda_available()'s by-name
    # cuBLAS check then resolves. Harmless for the shipping GPU/CPU builds.
    try:
        import torch

        if torch.cuda.is_available():
            torch_device = "cuda"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            torch_device = "mps"
        else:
            torch_device = "cpu"
    except Exception:
        torch_device = "cpu"
    ct2_device = "cuda" if _ct2_cuda_available() else "cpu"
    gpu = ct2_device == "cuda" or torch_device in ("cuda", "mps")
    compute_type = "float16" if ct2_device == "cuda" else "int8"
    return ct2_device, torch_device, gpu, compute_type


def _resolve_devices(args):
    """_detect_devices() with the optional --device/--compute-type overrides applied.
    Returns the same 4-tuple (ct2_device, torch_device, gpu, compute_type).

    --device overrides the CT2 (transcription) device ONLY — never torch's, so the
    override cannot push VAD/align onto a CUDA torch it doesn't have. compute_type is
    derived from the POST-override ct2_device (so `--device cpu` on a CUDA box yields
    int8, not a float16 that CT2 would silently demote to a slower float32); an
    explicit --compute-type still wins over that.
    """
    ct2_device, torch_device, gpu, compute_type = _detect_devices()
    override = getattr(args, "device", None)
    if override:
        ct2_device = override
        gpu = ct2_device == "cuda" or torch_device in ("cuda", "mps")
    compute_type = "float16" if ct2_device == "cuda" else "int8"
    ct_override = getattr(args, "compute_type", None)
    if ct_override:
        compute_type = ct_override
    return ct2_device, torch_device, gpu, compute_type


def _build_asr_options(args):
    """faster-whisper asr_options overrides for whisperx.load_model.

    Only user-set keys are included; an empty dict means load_model keeps its own
    defaults (so an untouched modal = no behavior change). Every key here is a
    real field of the pinned faster_whisper TranscriptionOptions — whisperx
    raises on unknown keys, so a typo surfaces loudly instead of shipping as a
    silent dead control (Phase 7 contract)."""
    opts = {}
    if getattr(args, "beam_size", None) is not None:
        opts["beam_size"] = int(args.beam_size)
    if getattr(args, "initial_prompt", None):
        opts["initial_prompt"] = args.initial_prompt
    return opts


def _build_vad_options(args):
    """vad_options overrides (vad_onset/vad_offset) for whisperx.load_model.
    Empty dict ⇒ whisperx VAD defaults."""
    opts = {}
    if getattr(args, "vad_onset", None) is not None:
        opts["vad_onset"] = float(args.vad_onset)
    if getattr(args, "vad_offset", None) is not None:
        opts["vad_offset"] = float(args.vad_offset)
    return opts


def _selftest_align_runs(whisperx, language="pl"):
    """Actually exercise forced alignment on a tiny synthetic clip.

    The files-only readiness check is misleading: the alignment model files can be
    present while the frozen import chain (whisperx.alignment → transformers lazy
    Wav2Vec2ForCTC) is broken — exactly the bundling gap that shipped a binary
    self-reporting `alignment_model_ready: true` yet failing every real --align-only
    with exit 12. So load the model and run one tiny align; if it raises, alignment
    is NOT ready. Runs on CPU (the failure mode was an import error, device-agnostic)
    and offline (the model ships beside the binary).
    """
    model_dir = _alignment_model_dir(language)
    if not (os.path.isdir(model_dir) and os.listdir(model_dir)):
        return False
    try:
        import numpy as np

        align_model, metadata = whisperx.load_align_model(
            language_code=language, device="cpu", model_dir=model_dir
        )
        audio = np.zeros(8000, dtype=np.float32)  # 0.5 s of 16 kHz silence
        whisperx.align(
            [{"start": 0.0, "end": 0.5, "text": "test"}],
            align_model,
            metadata,
            audio,
            "cpu",
            return_char_alignments=False,
        )
        return True
    except Exception as e:
        _log("selftest: alignment exercise failed: %s" % e)
        if os.environ.get("ENGINE_DEBUG"):
            import traceback

            _log(traceback.format_exc())
        return False


def cmd_selftest(args=None):
    ct2_device, torch_device, gpu, compute_type = _resolve_devices(args or argparse.Namespace())
    align_ready = False
    try:
        import whisperx  # noqa: F401

        version = getattr(__import__("whisperx"), "__version__", ENGINE_VERSION)
        ok = True
        align_ready = _selftest_align_runs(whisperx)
    except Exception as e:  # whisperx not importable → not ok, but still report
        version = ENGINE_VERSION
        ok = False
        _log("selftest: whisperx import failed: %s" % e)
    out = {
        "ok": ok,
        "version": str(version),
        "gpu": gpu,
        # `device` stays as an alias of ct2_device so no existing consumer breaks;
        # ct2_device/torch_device are the truthful pair (macOS: cpu/mps, Windows
        # GPU: cuda/cpu, gpu-full: cuda/cuda).
        "device": ct2_device,
        "ct2_device": ct2_device,
        "torch_device": torch_device,
        "compute_type": compute_type,
        # Truthful now: reflects an actual tiny align run, not just file presence.
        "alignment_model_ready": align_ready,
    }
    _write_result(json.dumps(out))
    return EXIT_OK


def cmd_capability(args=None):
    """Lightweight readiness probe — same JSON shape as cmd_selftest, but cheap.

    Reports {ok, version, gpu, device, ct2_device, torch_device, compute_type,
    cublas, alignment_model_ready} from a device detection (CT2 device count +
    torch), with the --device/--compute-type overrides applied, plus an align-dir
    *existence* check. It deliberately does NOT `import whisperx`,
    `load_align_model`, or run a real `align()`, so it cannot block on a model
    deserialize or an HF network call. Because it never imports whisperx, its
    `__version__` is unavailable — we report ENGINE_VERSION.

    Trade-off: a dir check can report `alignment_model_ready: true` for a binary
    whose frozen import chain is broken (the false-positive cmd_selftest guards
    against). The Rust/frontend layer renders this verdict as a non-authoritative
    tier; the authoritative green is earned only by --selftest.
    """
    ct2_device, torch_device, gpu, compute_type = _resolve_devices(args or argparse.Namespace())
    model_dir = _alignment_model_dir("pl")
    align_ready = os.path.isdir(model_dir) and bool(os.listdir(model_dir))
    # cuBLAS preload verdict from the §4 runtime hook (GPU build only). "ok" ⇒ the
    # two cuBLAS DLLs loaded; anything else (including absent, i.e. the CPU build,
    # where the field is meaningless) ⇒ false.
    cublas = os.environ.get("REEL_CUBLAS_PRELOAD") == "ok"
    out = {
        "ok": True,  # device detection always completes (cpu fallback on failure)
        "version": str(ENGINE_VERSION),
        "gpu": gpu,
        "device": ct2_device,
        "ct2_device": ct2_device,
        "torch_device": torch_device,
        "compute_type": compute_type,
        "cublas": cublas,
        "alignment_model_ready": align_ready,
    }
    _write_result(json.dumps(out))
    return EXIT_OK


def _load_audio(whisperx, audio_path):
    if not os.path.isfile(audio_path):
        _log("audio not found: %s" % audio_path)
        sys.exit(EXIT_AUDIO_DECODE_FAIL)
    try:
        return whisperx.load_audio(audio_path)
    except Exception as e:
        _log("audio decode failed: %s" % e)
        sys.exit(EXIT_AUDIO_DECODE_FAIL)


def _align(whisperx, segments, audio, language, device):
    """Forced-align segments; emits align progress; exits EXIT_ALIGN_FAIL on error."""
    _emit_progress("align", 0)
    try:
        model_dir = _alignment_model_dir(language)
        kwargs = {"language_code": language, "device": device}
        if os.path.isdir(model_dir) and os.listdir(model_dir):
            kwargs["model_dir"] = model_dir
        align_model, metadata = whisperx.load_align_model(**kwargs)
        result = whisperx.align(
            segments,
            align_model,
            metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        _emit_progress("align", 100)
        return result
    except Exception as e:
        _log("alignment failed: %s" % e)
        if os.environ.get("ENGINE_DEBUG"):
            import traceback

            _log(traceback.format_exc())
        sys.exit(EXIT_ALIGN_FAIL)


def _normalize(language, aligned):
    """Map whisperx aligned output → the stable contract JSON shape."""
    segments = []
    for seg in aligned.get("segments", []):
        words = []
        for w in seg.get("words", []) or []:
            # whisperx uses 'word' for the token text; start/end may be absent
            # for unalignable tokens — skip those (no usable boundary).
            if "start" not in w or "end" not in w:
                continue
            words.append(
                {
                    "text": w.get("word", w.get("text", "")),
                    "start": float(w["start"]),
                    "end": float(w["end"]),
                    "score": float(w["score"]) if w.get("score") is not None else None,
                    "speaker": w.get("speaker"),
                }
            )
        segments.append(
            {
                "start": float(seg.get("start", 0.0)),
                "end": float(seg.get("end", 0.0)),
                "text": (seg.get("text") or "").strip(),
                "words": words,
                "speaker": seg.get("speaker"),
            }
        )
    return {"language": language, "segments": segments}


def _diarize(whisperx, aligned, audio, hf_token, device, min_speakers=None, max_speakers=None):
    _emit_progress("diarize", 0)
    try:
        try:
            from whisperx.diarize import DiarizationPipeline
        except Exception:
            DiarizationPipeline = whisperx.DiarizationPipeline  # older layout
        # The HF-token kwarg was renamed `use_auth_token` → `token` in newer
        # whisperx; try the current name first, fall back for older builds.
        try:
            pipeline = DiarizationPipeline(token=hf_token, device=device)
        except TypeError:
            pipeline = DiarizationPipeline(use_auth_token=hf_token, device=device)
        # min/max speakers are optional bounds (Phase 7); None ⇒ auto-detect.
        diarize_segments = pipeline(
            audio, min_speakers=min_speakers, max_speakers=max_speakers
        )
        aligned = whisperx.assign_word_speakers(diarize_segments, aligned)
        _emit_progress("diarize", 100)
        return aligned
    except Exception as e:
        # Scrub the token from the message: pyannote/HF auth errors can echo it
        # back, and this text flows to stderr → the app's error tail.
        msg = str(e)
        if hf_token:
            msg = msg.replace(hf_token, "***")
        _log("diarization failed: %s" % msg)
        sys.exit(EXIT_DIARIZE_FAIL)


def cmd_transcribe(args):
    import whisperx
    from faster_whisper import WhisperModel

    ct2_device, torch_device, _, compute_type = _resolve_devices(args)
    # VAD runs on torch's device, but CT2/whisperx has no MPS backend for VAD, so
    # 'mps' collapses to 'cpu' (preserving the pre-decoupling behavior exactly).
    vad_device = torch_device if torch_device != "mps" else "cpu"
    audio = _load_audio(whisperx, args.audio)

    # Phase 7 — optional tuning. Empty dicts ⇒ whisperx keeps its own defaults.
    asr_options = _build_asr_options(args)
    vad_options = _build_vad_options(args)

    _emit_progress("transcribe", 0)
    try:
        load_kwargs = dict(
            compute_type=compute_type,
            language=None if args.language in (None, "", "auto") else args.language,
        )
        if asr_options:
            load_kwargs["asr_options"] = asr_options
        if vad_options:
            load_kwargs["vad_options"] = vad_options
        # Build the CT2 ASR model on ct2_device (may be CUDA under a CPU-torch
        # build) and hand it to whisperx via its `model=` seam, while load_model's
        # positional device — which it forwards to the torch-based VAD — gets
        # vad_device. This is what lets CT2 sit on CUDA with VAD on CPU torch.
        asr_model = WhisperModel(args.model, device=ct2_device, compute_type=compute_type)
        model = whisperx.load_model(
            args.model,
            vad_device,
            model=asr_model,
            **load_kwargs,
        )
    except TypeError as e:
        # An unknown asr_options/vad_options key reaches whisperx as an unexpected
        # kwarg → fail loudly rather than silently ignoring a dead control.
        _log("invalid advanced option for the pinned whisperx version: %s" % e)
        sys.exit(EXIT_TRANSCRIBE_FAIL)
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg or "no such file" in msg or "does not exist" in msg:
            _log("model not found: %s" % e)
            sys.exit(EXIT_MODEL_NOT_FOUND)
        _log("model load failed: %s" % e)
        sys.exit(EXIT_MODEL_NOT_FOUND)

    try:
        result = model.transcribe(audio, batch_size=args.batch_size)
    except Exception as e:
        _log("transcription failed: %s" % e)
        sys.exit(EXIT_TRANSCRIBE_FAIL)
    _emit_progress("transcribe", 100)

    language = result.get("language") or args.language or "unknown"

    aligned = _align(whisperx, result["segments"], audio, language, torch_device)

    if args.diarize:
        if not args.hf_token:
            _log("diarization requested but no --hf-token provided")
            sys.exit(EXIT_DIARIZE_FAIL)
        aligned = _diarize(
            whisperx,
            aligned,
            audio,
            args.hf_token,
            torch_device,
            min_speakers=getattr(args, "min_speakers", None),
            max_speakers=getattr(args, "max_speakers", None),
        )

    out = _normalize(language, aligned)
    out["device"] = ct2_device  # transcription device actually used (criterion 1.9)
    _write_result(json.dumps(out, ensure_ascii=False))
    return EXIT_OK


def _sentence_pseudo_cues(text, audio_dur):
    """Spread a flat Cohere transcript across [0, audio_dur] as sentence pseudo-cues.

    Cohere's native processor reassembles a *flat* string and does NOT expose
    per-chunk time spans (Phase 0 finding), so we cannot build real per-chunk
    align windows. Instead we split the transcript on sentence-ending punctuation
    and assign each sentence a window proportional to its character length across
    the audio duration. WhisperX `align()` then re-times every word *within* each
    pseudo-cue — keeping the forced-align search bounded per sentence instead of
    one unbounded full-audio segment (research §F option 2), which is what keeps
    long (>13-min) webinars fast and memory-stable.
    """
    import re

    text = (text or "").strip()
    if not text:
        return []
    parts = re.findall(r"[^.!?…]+[.!?…]*", text)
    parts = [p.strip() for p in parts if p.strip()]
    if not parts:
        parts = [text]
    total_chars = sum(len(p) for p in parts) or 1
    cues = []
    cursor = 0.0
    acc = 0
    last = len(parts) - 1
    for i, p in enumerate(parts):
        acc += len(p)
        start = cursor
        end = audio_dur if i == last else audio_dur * (acc / total_chars)
        if end <= start:
            end = min(audio_dur, start + 0.01)
        cues.append({"start": start, "end": end, "text": p})
        cursor = end
    return cues


def cmd_transcribe_cohere(args):
    """Native (no trust_remote_code) Cohere ASR producer.

    Mirrors cmd_transcribe's contract (audio in → aligned, normalized payload out)
    but swaps only the ASR stage: native transformers >=5.4.0 `CohereAsr`
    transcribes the audio offline, its processor auto-chunks long audio
    (max_audio_clip_s=35, 5 s overlap) and reassembles one flat transcript via
    `audio_chunk_index`. WhisperX still owns ALL word timing — the flat transcript
    is split into sentence pseudo-cues and fed to the unchanged _align → _normalize,
    so the downstream frame-math / exporter pipeline is untouched.
    """
    import whisperx
    import torch
    from transformers import AutoProcessor, CohereAsrForConditionalGeneration

    # Concrete language is required (Cohere has no auto-detect), mirroring the
    # cmd_align_only contract.
    language = None if args.language in (None, "", "auto") else args.language
    if not language:
        _log("cohere engine requires an explicit --language")
        sys.exit(EXIT_USAGE)

    _, torch_device, _, _ = _resolve_devices(args)
    audio = _load_audio(whisperx, args.audio)  # float32 16 kHz mono np array
    audio_dur = float(len(audio)) / 16000.0

    _emit_progress("transcribe", 0)
    try:
        proc = AutoProcessor.from_pretrained(args.model, local_files_only=True)
        # Phase 0 dtype gotcha: the safetensors weights are bf16 but the processor
        # emits float32 features, and CPU has no usable bf16 conv. Load float32 and
        # keep generation on CPU (Cohere is a quality trade, never a speed path).
        model = CohereAsrForConditionalGeneration.from_pretrained(
            args.model, local_files_only=True, dtype=torch.float32
        ).eval()
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg or "no such file" in msg or "does not exist" in msg:
            _log("cohere model not found: %s" % e)
            sys.exit(EXIT_MODEL_NOT_FOUND)
        # A downloaded-but-failing load (OOM, corrupt weights, dtype/version
        # mismatch) is NOT a missing model — don't tell the user to re-download.
        _log("cohere model load failed: %s" % e)
        sys.exit(EXIT_TRANSCRIBE_FAIL)

    try:
        inputs = proc(
            audio,
            language=language,
            punctuation=bool(args.punctuation),
            sampling_rate=16000,
        )
        chunk_index = inputs.pop("audio_chunk_index", None)
        _emit_progress("transcribe", 50)
        # Greedy by default. A user-set --beam-size > 1 switches the decode to
        # beam search (real quality lever, paid for in CPU/memory on this 2B
        # float32 path — Cohere is a quality trade, never a speed path).
        gen_kwargs = dict(
            decoder_input_ids=inputs["decoder_input_ids"],
            attention_mask=inputs.get("attention_mask"),
            max_new_tokens=445,
        )
        beam = getattr(args, "beam_size", None)
        if beam is not None and int(beam) > 1:
            gen_kwargs["num_beams"] = int(beam)
            gen_kwargs["do_sample"] = False
            gen_kwargs["early_stopping"] = True
        with torch.no_grad():
            gen = model.generate(inputs["input_features"], **gen_kwargs)
        # Slice off the decoder prompt prefix, decode each chunk, reassemble.
        gen_only = gen[:, inputs["decoder_input_ids"].shape[1] :]
        per_chunk = proc.batch_decode(gen_only, skip_special_tokens=True)
        if chunk_index is not None:
            # `_reassemble_chunk_texts` is a private processor API — depends on the
            # transformers==5.12.1 pin (requirements.lock.txt). Re-verify it still
            # exists on any transformers bump; if it vanishes this throws and the
            # run fails cleanly (EXIT_TRANSCRIBE_FAIL), no silent corruption.
            text = proc._reassemble_chunk_texts(per_chunk, chunk_index, " ")[0]
        else:
            text = " ".join(t.strip() for t in per_chunk if t.strip())
    except Exception as e:
        _log("cohere transcription failed: %s" % e)
        sys.exit(EXIT_TRANSCRIBE_FAIL)
    _emit_progress("transcribe", 100)

    segments = _sentence_pseudo_cues(text, audio_dur)
    if not segments:
        _log("cohere produced an empty transcript")
        sys.exit(EXIT_TRANSCRIBE_FAIL)

    aligned = _align(whisperx, segments, audio, language, torch_device)
    out = _normalize(language, aligned)
    _write_result(json.dumps(out, ensure_ascii=False))
    return EXIT_OK


def _read_transcript_segments(path, language):
    """Parse a .srt/.vtt transcript into whisperx-style segments for alignment."""
    import re

    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"^WEBVTT[^\n]*\n", "", text)

    def to_sec(ts):
        ts = ts.replace(",", ".")
        h, m, s = ts.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)

    pat = re.compile(
        r"(\d{1,2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|$)"
    )
    segs = []
    for m in pat.finditer(text):
        body = re.sub(r"<[^>]+>", "", m.group(3)).replace("\n", " ").strip()
        if not body:
            continue
        segs.append({"start": to_sec(m.group(1)), "end": to_sec(m.group(2)), "text": body})
    return segs


def cmd_align_only(args):
    import whisperx

    if not args.transcript or not os.path.isfile(args.transcript):
        _log("align-only requires an existing --transcript file")
        sys.exit(EXIT_USAGE)

    _, torch_device, _, _ = _resolve_devices(args)
    audio = _load_audio(whisperx, args.audio)
    language = None if args.language in (None, "", "auto") else args.language
    if not language:
        _log("align-only requires an explicit --language")
        sys.exit(EXIT_USAGE)

    segments = _read_transcript_segments(args.transcript, language)
    if not segments:
        _log("no segments parsed from transcript")
        sys.exit(EXIT_USAGE)

    aligned = _align(whisperx, segments, audio, language, torch_device)
    out = _normalize(language, aligned)
    _write_result(json.dumps(out, ensure_ascii=False))
    return EXIT_OK


def build_parser():
    p = argparse.ArgumentParser(prog="whisperx-engine", description="WhisperX engine sidecar")
    p.add_argument("--audio", help="path to a 16 kHz mono WAV (or any ffmpeg-decodable file)")
    p.add_argument("--model", help="faster-whisper CT2 model id or local path")
    p.add_argument("--language", default="auto", help="language code, or 'auto'")
    p.add_argument("--batch-size", type=int, default=8)
    # ── Engine selection ──────────────────────────────────────────────────────
    # `whisperx` = the default faster-whisper CT2 transcribe+align path.
    # `cohere`   = native transformers (>=5.4.0) CohereAsr producer; WhisperX
    #              still owns word-level alignment (cmd_transcribe_cohere).
    p.add_argument(
        "--engine",
        choices=["whisperx", "cohere"],
        default="whisperx",
        help="transcription engine (default: whisperx)",
    )
    # Cohere-only: emit punctuation/casing. `--no-punctuation` disables it. Carrier
    # for the Phase 4 advanced-panel toggle; ignored on the whisperx path.
    p.add_argument(
        "--punctuation",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Cohere: emit punctuation/casing (use --no-punctuation to disable)",
    )
    # ── Phase 7 advanced settings (all optional; omitted = engine default) ──
    # Exposed, user-tunable knobs. Each maps to a real whisperx/faster-whisper
    # option, verified against the pinned versions. Anything not passed here keeps
    # whisperx's own default, so an untouched modal reproduces current behavior.
    p.add_argument(
        "--device",
        default=None,
        help="override the CT2 transcription device only ('cpu' forces CPU); "
        "torch's VAD/align/diarize device is unaffected",
    )
    p.add_argument(
        "--compute-type",
        default=None,
        help="CT2 compute type: float16|int8|int8_float16|float32",
    )
    p.add_argument("--beam-size", type=int, default=None, help="decoding beam size")
    p.add_argument("--initial-prompt", default=None, help="initial decoding prompt")
    p.add_argument("--vad-onset", type=float, default=None, help="VAD onset threshold")
    p.add_argument("--vad-offset", type=float, default=None, help="VAD offset threshold")
    p.add_argument("--min-speakers", type=int, default=None, help="diarization: min speakers")
    p.add_argument("--max-speakers", type=int, default=None, help="diarization: max speakers")
    p.add_argument("--diarize", action="store_true", help="run speaker diarization")
    p.add_argument("--hf-token", default=None, help="Hugging Face token for pyannote (prefer the HF_TOKEN env var)")
    p.add_argument("--align-only", action="store_true", help="force-align an existing transcript")
    p.add_argument("--transcript", default=None, help=".srt/.vtt to align (with --align-only)")
    p.add_argument(
        "--align-model-dir",
        default=None,
        help="directory holding per-language alignment models (ships beside the sidecar)",
    )
    p.add_argument("--selftest", action="store_true", help="print readiness JSON and exit")
    p.add_argument(
        "--capability",
        action="store_true",
        help="print lightweight readiness JSON (no model load) and exit",
    )
    p.add_argument("--version", action="store_true", help="alias for --selftest")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    # Keep stdout pristine for the single JSON result: route every library log /
    # print emitted during processing to stderr. Heavy deps are imported lazily
    # (after this point), so logging StreamHandlers bound to "stdout" at import
    # time pick up stderr too. The result goes out via _write_result(_RESULT_OUT).
    sys.stdout = sys.stderr
    # The HF token is supplied via the HF_TOKEN env var (kept off argv so it is
    # not visible in `ps`); an explicit --hf-token, if given, still wins.
    if not args.hf_token:
        args.hf_token = os.environ.get("HF_TOKEN") or None
    # An explicit --align-model-dir wins over auto-resolution (next-to-exe etc.).
    if getattr(args, "align_model_dir", None):
        os.environ["ENGINE_ALIGN_DIR"] = args.align_model_dir
    try:
        if args.capability:
            return cmd_capability(args)
        if args.selftest or args.version:
            return cmd_selftest(args)
        if args.align_only:
            if not args.audio:
                _log("--align-only requires --audio")
                return EXIT_USAGE
            return cmd_align_only(args)
        if not args.audio or not args.model:
            _log("transcription requires --audio and --model")
            return EXIT_USAGE
        if args.engine == "cohere":
            return cmd_transcribe_cohere(args)
        return cmd_transcribe(args)
    except SystemExit:
        raise
    except Exception as e:  # last-resort guard → distinct internal code
        _log("engine internal error: %s" % e)
        return EXIT_ENGINE_INTERNAL


if __name__ == "__main__":
    # PyInstaller + multiprocessing: torch / faster-whisper / pyannote may spawn
    # child processes (macOS default start method is 'spawn'). Without this the
    # frozen binary re-execs itself with multiprocessing bootstrap args and our
    # argparse rejects them ("unrecognized arguments: -B -S -I -c ...
    # resource_tracker"). freeze_support() makes the child run the mp bootstrap
    # instead of main(); it is a no-op for a normal CLI invocation.
    import multiprocessing

    multiprocessing.freeze_support()
    sys.exit(main())
