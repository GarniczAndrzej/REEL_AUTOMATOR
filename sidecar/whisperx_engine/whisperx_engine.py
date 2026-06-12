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
              "segments": [
                { "start": float, "end": float, "text": str,
                  "words": [ { "text": str, "start": float, "end": float,
                              "score": float|null, "speaker": str|null } ] }
              ]
            }

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
                   downloaded transcription model.

This script is intentionally dependency-light at import time: heavy deps
(`whisperx`, `torch`) are imported lazily inside the functions that need them so
`--selftest` / `--version` stay fast and work before any model is downloaded.
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

# Per-language wav2vec2 alignment model bundled into the frozen artifact at build
# time (see sidecar/build.sh). When frozen, PyInstaller unpacks data into
# sys._MEIPASS; in source runs we look next to this file.
ALIGN_MODEL_SUBDIR = "align_models"


def _emit_progress(phase, percent):
    """Write one greppable progress line to stderr."""
    pct = max(0, min(100, int(round(percent))))
    sys.stderr.write("PROGRESS phase=%s percent=%d\n" % (phase, pct))
    sys.stderr.flush()


def _log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def _bundle_root():
    """Directory where bundled data (alignment models) lives."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return meipass
    return os.path.dirname(os.path.abspath(__file__))


def _alignment_model_dir(language):
    return os.path.join(_bundle_root(), ALIGN_MODEL_SUBDIR, language or "")


def _alignment_model_ready(language=None):
    """True when at least one bundled alignment model is present."""
    base = os.path.join(_bundle_root(), ALIGN_MODEL_SUBDIR)
    if not os.path.isdir(base):
        return False
    if language:
        d = _alignment_model_dir(language)
        return os.path.isdir(d) and bool(os.listdir(d))
    # any language present
    try:
        return any(
            os.path.isdir(os.path.join(base, e)) and os.listdir(os.path.join(base, e))
            for e in os.listdir(base)
        )
    except OSError:
        return False


def _detect_device():
    """Return ('cuda'|'mps'|'cpu', gpu_bool, compute_type)."""
    try:
        import torch
    except Exception:
        return "cpu", False, "int8"
    if torch.cuda.is_available():
        return "cuda", True, "float16"
    # Apple Metal. faster-whisper/CTranslate2 has no MPS backend yet, so we run
    # CT2 transcription on CPU but report GPU availability for align/diarize.
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps", True, "int8"
    return "cpu", False, "int8"


def cmd_selftest():
    device, gpu, _ = _detect_device()
    try:
        import whisperx  # noqa: F401

        version = getattr(__import__("whisperx"), "__version__", ENGINE_VERSION)
        ok = True
    except Exception as e:  # whisperx not importable → not ok, but still report
        version = ENGINE_VERSION
        ok = False
        _log("selftest: whisperx import failed: %s" % e)
    out = {
        "ok": ok,
        "version": str(version),
        "gpu": gpu,
        "device": device,
        "alignment_model_ready": _alignment_model_ready(),
    }
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()
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


def _diarize(whisperx, aligned, audio, hf_token, device):
    _emit_progress("diarize", 0)
    try:
        try:
            from whisperx.diarize import DiarizationPipeline
        except Exception:
            DiarizationPipeline = whisperx.DiarizationPipeline  # older layout
        pipeline = DiarizationPipeline(use_auth_token=hf_token, device=device)
        diarize_segments = pipeline(audio)
        aligned = whisperx.assign_word_speakers(diarize_segments, aligned)
        _emit_progress("diarize", 100)
        return aligned
    except Exception as e:
        _log("diarization failed: %s" % e)
        sys.exit(EXIT_DIARIZE_FAIL)


def cmd_transcribe(args):
    import whisperx

    device, _, compute_type = _detect_device()
    audio = _load_audio(whisperx, args.audio)

    _emit_progress("transcribe", 0)
    try:
        model = whisperx.load_model(
            args.model,
            device if device != "mps" else "cpu",  # CT2 has no MPS backend
            compute_type=compute_type,
            language=None if args.language in (None, "", "auto") else args.language,
        )
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

    aligned = _align(whisperx, result["segments"], audio, language, device)

    if args.diarize:
        if not args.hf_token:
            _log("diarization requested but no --hf-token provided")
            sys.exit(EXIT_DIARIZE_FAIL)
        aligned = _diarize(whisperx, aligned, audio, args.hf_token, device)

    out = _normalize(language, aligned)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()
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

    device, _, _ = _detect_device()
    audio = _load_audio(whisperx, args.audio)
    language = None if args.language in (None, "", "auto") else args.language
    if not language:
        _log("align-only requires an explicit --language")
        sys.exit(EXIT_USAGE)

    segments = _read_transcript_segments(args.transcript, language)
    if not segments:
        _log("no segments parsed from transcript")
        sys.exit(EXIT_USAGE)

    aligned = _align(whisperx, segments, audio, language, device)
    out = _normalize(language, aligned)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()
    return EXIT_OK


def build_parser():
    p = argparse.ArgumentParser(prog="whisperx-engine", description="WhisperX engine sidecar")
    p.add_argument("--audio", help="path to a 16 kHz mono WAV (or any ffmpeg-decodable file)")
    p.add_argument("--model", help="faster-whisper CT2 model id or local path")
    p.add_argument("--language", default="auto", help="language code, or 'auto'")
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--diarize", action="store_true", help="run speaker diarization")
    p.add_argument("--hf-token", default=None, help="Hugging Face token for pyannote")
    p.add_argument("--align-only", action="store_true", help="force-align an existing transcript")
    p.add_argument("--transcript", default=None, help=".srt/.vtt to align (with --align-only)")
    p.add_argument("--selftest", action="store_true", help="print readiness JSON and exit")
    p.add_argument("--version", action="store_true", help="alias for --selftest")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.selftest or args.version:
            return cmd_selftest()
        if args.align_only:
            if not args.audio:
                _log("--align-only requires --audio")
                return EXIT_USAGE
            return cmd_align_only(args)
        if not args.audio or not args.model:
            _log("transcription requires --audio and --model")
            return EXIT_USAGE
        return cmd_transcribe(args)
    except SystemExit:
        raise
    except Exception as e:  # last-resort guard → distinct internal code
        _log("engine internal error: %s" % e)
        return EXIT_ENGINE_INTERNAL


if __name__ == "__main__":
    sys.exit(main())
