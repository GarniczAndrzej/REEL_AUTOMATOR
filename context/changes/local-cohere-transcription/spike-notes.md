# Phase 0 — Cohere offline transcription feasibility spike

**Date**: 2026-06-25
**Env**: `sidecar/.venv` — Python 3.10.11, torch 2.8.0, transformers 4.57.6,
whisperx 3.8.6, tokenizers 0.22.2, huggingface_hub 0.36.2 (macOS arm64).

This phase exists to fail cheap: prove the two load-bearing unknowns before the
costly Phase 2 sidecar rebuild — (1) can `transformers` load
`CohereLabs/cohere-transcribe-03-2026` **offline from a local dir** in an env that
still imports the whisperx wav2vec2 align stack, and (2) a first Polish-quality read.

## What the spike established (no large download required)

### HF model metadata (`/api/models/CohereLabs/cohere-transcribe-03-2026`)

- **Model is real and popular**: 743k downloads, 1016 likes, `pipeline_tag:
  automatic-speech-recognition`, `library_name: transformers`, license Apache-2.0,
  declares `pl` among 14 languages. `lastModified 2026-06-10`.
- **`"gated": "auto"`** — the repo is **gated** (auto-approval). Despite the
  Apache-2.0 license, HF requires an accepted license + an **HF token** to download
  the weights. This deviates from the plan's "no API key / offline open weights"
  premise: download-on-demand (Phase 1) must thread an HF token (the `HF_TOKEN`
  plumbing exists) **and** the user must accept the license once on the HF page.
- **`"tags": [... "cohere_asr", ... "custom_code" ...]`** and an **`auto_map`** that
  routes every class to repo-local `.py` files:
  - `AutoConfig` → `configuration_cohere_asr.CohereAsrConfig`
  - `AutoModelForSpeechSeq2Seq` → `modeling_cohere_asr.CohereAsrForConditionalGeneration`
  - `AutoProcessor` → `processing_cohere_asr.CohereAsrProcessor`
  - `AutoTokenizer` → `tokenization_cohere_asr.CohereAsrTokenizer`
- **File manifest** (HF tree): single `model.safetensors` = **4.13 GB** (LFS),
  plus remote-code modules `configuration_cohere_asr.py` (1.8 KB),
  `modeling_cohere_asr.py` (64.6 KB), `processing_cohere_asr.py` (20.6 KB),
  `tokenization_cohere_asr.py` (6.6 KB), and `config.json`, `generation_config.json`,
  `preprocessor_config.json`, `processor_config.json`, `tokenizer.json` (1.8 MB),
  `tokenizer.model` (493 KB LFS), `tokenizer_config.json`, `special_tokens_map.json`.

### Required `transformers` version → it's not a version, it's remote code

- `cohere_asr` is **NOT** a native model type in transformers 4.57.6 (the newest in
  the venv). `CONFIG_MAPPING_NAMES` contains only `cohere`, `cohere2`,
  `cohere2_vision` (the Command **text** LLMs) — **not** `cohere_asr`.
- `grep CohereAsrForConditionalGeneration` over installed `transformers/` → **no
  match**. The ASR architecture exists **only as HF remote code** in the repo.
- **Verdict**: there is no `transformers` version bump that adds this natively (as of
  4.57.6). Loading the model **requires `trust_remote_code=True`** regardless of
  version. → **This is the documented Phase-0 gate trigger.**

### whisperx `pl` align coexistence (criterion 0.3) — PASS

- In the **same** `sidecar/.venv`, with `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`:
  `import transformers (4.57.6); import torch (2.8.0); import whisperx (3.8.6)` all
  succeed, and `whisperx.load_align_model(language_code='pl', device='cpu')` loads
  the cached `jonatasgrosman/wav2vec2-large-xlsr-53-polish` align model **offline**.
- → transformers 4.57.6 (the version that would carry the Cohere remote code) does
  **not** break the whisperx align import/load. The align stack and a modern
  transformers coexist cleanly.

## What the spike could NOT establish (blocked)

### Criterion 0.1 (load model offline + print Polish text) — NOT DONE

Blocked on three missing prerequisites, none available in this environment:

1. **Gated download** needs (a) the user to accept the license on the HF model page
   and (b) an HF token — **no HF token is present** locally
   (`HfFolder.get_token()` / `HF_TOKEN` both empty).
2. **4.13 GB weights** not downloaded (deferred until the gate decision; pointless to
   pull 4 GB before deciding whether the packaging path is viable).
3. **No Polish audio clip** exists in the repo (only scipy test WAVs in site-packages).

### Criterion 0.4 (one-line Polish-quality read) — NOT DONE

Depends on 0.1; cannot be produced without running the model on a Polish clip.

## Gate verdict — TRIPPED → STOP and re-plan Phase 2 packaging

The plan's Phase-0 gate (plan.md §"Success Criteria → Manual Verification"):

> **Gate**: if the model needs `trust_remote_code` (incompatible with the frozen
> offline onefile) or a `transformers` bump that breaks the align import, STOP and
> re-plan Phase 2's packaging before proceeding.

**The model needs `trust_remote_code=True`.** The gate is tripped. The whisperx
align import is fine, but the trust_remote_code branch of the gate is hit, so per the
plan we do **not** start Phase 1 until Phase 2's packaging is re-planned.

### Concrete re-plan inputs for Phase 2 packaging

1. **PyInstaller onefile + `trust_remote_code` + offline.** transformers loads the
   remote `.py` via `dynamic_module_utils` (importlib from the model dir / the
   `~/.cache/huggingface/modules/transformers_modules/...` cache). For an offline
   frozen binary this means: (a) the **model dir must ship the four `*_cohere_asr.py`
   files** (so the Phase-1 download manifest must include them, not just weights +
   tokenizer); (b) the `.spec` must hidden-import **every transformers internal the
   remote code touches**, since PyInstaller's static analysis can't see imports inside
   loose `.py` files — this is the documented fragility and the reason the gate stops.
2. **Gated weights** change the credential story: download-on-demand now needs an HF
   token at fetch time + a one-time manual license-accept. Not a Cohere key, but still
   a credential + manual step the plan's "no API key" framing didn't account for.
3. **Single 4.13 GB `model.safetensors`** must stay **out** of the onefile (download
   beside the binary), consistent with the `never-bake-multi-GB-into-onefile` lesson.

A throwaway end-to-end load+transcribe (criteria 0.1/0.4) should still be run **after**
the user accepts the license + provides an HF token + a Polish clip is available — but
only once the gate decision is made, to avoid a 4 GB pull on an unviable path.

## Commands (for reproduction)

```bash
# HF metadata + file manifest (no auth needed for public metadata)
curl -s https://huggingface.co/api/models/CohereLabs/cohere-transcribe-03-2026
curl -s https://huggingface.co/api/models/CohereLabs/cohere-transcribe-03-2026/tree/main

# native support check (cheap, local)
sidecar/.venv/bin/python -c "from transformers.models.auto.configuration_auto import CONFIG_MAPPING_NAMES; print('cohere_asr' in CONFIG_MAPPING_NAMES)"  # -> False

# align coexistence (offline), same venv as transformers 4.57.6
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 sidecar/.venv/bin/python -c \
  "import whisperx; m,meta=whisperx.load_align_model(language_code='pl',device='cpu'); print(meta['type'])"  # -> huggingface
```

---

## ADDENDUM 2026-06-25 — criteria 0.1/0.4 RUN (token+license+clip provided) → NEW, BIGGER GATE

Prereqs that blocked the first spike were all satisfied this session: HF token (user
`Vndrew`) written to `~/.cache/huggingface/token`; license accepted (gated
`resolve/main/config.json` → **HTTP 200**); full 4.13 GB manifest pulled to a scratch
dir; Polish clip `~/Desktop/LOVELETTER.mov` (126.9 s, stereo 48 k) extracted to 16 k
mono WAV via the bundled static ffmpeg sidecar.

### Hard facts captured (hold regardless of the path decision)

- **Real download manifest + size** (feeds Phase 1 §1): single `model.safetensors`
  **4131862976 bytes** (4.13 GB) + the 4 `*_cohere_asr.py` + `config.json`,
  `generation_config.json`, `preprocessor_config.json`, `processor_config.json`,
  `special_tokens_map.json`, `tokenizer.json`, `tokenizer.model` (LFS, 493 KB),
  `tokenizer_config.json`. (Repo also ships `README.md`, `assets/`, `demo/`, not needed.)
- **`config.json` → `max_audio_clip_s: 35`** = the model's real max audio window
  (resolves Phase 2 §1 "do NOT guess" chunk size). Also `overlap_chunk_second: 5`,
  `max_seq_len: 1024`, `pos_emb_max_len: 5000` encoder frames (~400 s ceiling, but 35 s
  is the trained/quality window). `supported_languages` includes `pl`.
- **New runtime deps the Cohere remote code hard-requires** (via transformers
  `check_imports`): **`librosa`, `sentencepiece`** (and README's full set:
  `soundfile protobuf accelerate`). Installed into `sidecar/.venv` this session —
  these are **Phase 2 `requirements.txt` additions** (pull numba/llvmlite/soxr/audioread).
- **Offline `trust_remote_code` load WORKS** on transformers 4.57.6:
  `AutoModelForSpeechSeq2Seq.from_pretrained(dir, trust_remote_code=True,
  local_files_only=True)` loaded `CohereAsrForConditionalGeneration` (float32) **in
  6.5 s** with `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` (after the deps above). So the
  *load* half of the original gate is GREEN.

### The blocker — transcription on 4.57.6 trust_remote_code path FAILS

- `processor(audio, language="pl")` returned **only** `input_features` + `length`
  (`audio_chunk_index=None`). `model.generate()` then crashed:
  `AttributeError: 'NoneType' object has no attribute 'new_ones'` in transformers
  4.57.6 `generation/utils.py:_update_model_kwargs_for_generation` (decoder_attention_mask
  is None).
- **Root cause (read the remote code):** the repo-local `CohereAsrProcessor.__call__`
  (`processing_cohere_asr.py:488`) is a **degraded fallback** — it does *only* feature
  extraction + optional text tokenization. It **silently ignores `language=`**, has **no
  punctuation control, no auto-chunking, no `audio_chunk_index` reassembly**. So no
  prompt `input_ids` are built → the model's `generate()` (`modeling_cohere_asr.py:885`)
  sets `decoder_attention_mask=None` and 4.57.6's generation loop dies on it. The remote
  code even carries explicit version branches for "4.52–4.55" and ">=5.3" — **4.57.6
  falls in an unhandled gap.**
- **The README's full-featured behavior** (language prompts, `punctuation=True/False`,
  long-form auto-chunk + `audio_chunk_index`) is the **NATIVE** `transformers>=5.4.0`
  integration ("supported natively in `transformers`", `pip install transformers>=5.4.0`),
  **NOT** the trust_remote_code modules. The remote `.py` is the older/degraded path.

### Reframed gate — this is a transformers MAJOR-VERSION fork, not just trust_remote_code

- **whisperx 3.8.6 `Requires-Dist: transformers>=4.48.0` — NO upper bound.** So bumping
  the sidecar to **transformers ≥5.4.0** is not forbidden by whisperx, and would unlock
  the clean native Cohere path (no trust_remote_code, processor handles language +
  punctuation + long-form chunking + reassembly natively → also removes the plan's
  manual chunk-and-stitch / RMS-boundary / per-chunk-segment design AND the frozen
  trust_remote_code packaging probe §0).
- **Cost/risk of that path:** transformers 4→5 is a *major* version bump to the
  already-working WhisperX engine; pyannote.audio 4.0.4 / faster-whisper 1.2.1 / the
  align stack must be re-validated on 5.x. This is bigger than the plan's premise
  (plan assumed trust_remote_code-on-4.57.6 + manual chunking).

### Impact on the plan (why Phase 2 as written no longer fits)

The plan's Phase 2 is built on trust_remote_code @ 4.57.6 + manual chunk-and-stitch +
per-chunk `_align` segments + a frozen trust_remote_code packaging probe. The spike shows
that path is a **degraded fallback that doesn't transcribe** on 4.57.6. The viable path is
**native transformers ≥5.4.0**, which deletes most of Phase 2 §0/§1's hand-rolled chunking
and changes the packaging story. → **Re-plan required; escalated to user for the
version-bump decision (the central unknown is whisperx/pyannote coexistence on
transformers ≥5.4.0).**

### Repro (this session)

```bash
# token + license probe
curl -s -o /dev/null -w "%{http_code}" -L -H "Authorization: Bearer $(cat ~/.cache/huggingface/token)" \
  https://huggingface.co/CohereLabs/cohere-transcribe-03-2026/resolve/main/config.json   # -> 200

# full weights pull (scratch)
sidecar/.venv/bin/hf download CohereLabs/cohere-transcribe-03-2026 --local-dir <scratch>/cohere-weights

# deps the remote code requires
sidecar/.venv/bin/pip install librosa sentencepiece protobuf accelerate

# offline load+transcribe spike (load OK in 6.5s; generate() crashes on 4.57.6)
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_MODULES_CACHE=<scratch>/hf_modules \
  sidecar/.venv/bin/python <scratch>/spike_load.py <scratch>/cohere-weights <scratch>/loveletter_16k.wav pl
```
```

---

## ADDENDUM 2 — 2026-06-25 — NATIVE transformers 5.12.1 gate RUN → **BOTH CRITERIA PASS** → proceed with single-engine bump

The re-planned Phase 0 (native transformers ≥5.4.0, no `trust_remote_code`) was executed
end-to-end this session. Both load-bearing unknowns are now resolved **green**.

### Env (recoverable)

- Upgraded the dev `sidecar/.venv` **in place** from transformers 4.57.6 → **transformers
  5.12.1** (+ `librosa sentencepiece soundfile protobuf accelerate`). This also bumped
  `huggingface-hub` → 1.20.1, `protobuf` → 7.35.1, and pulled `typer/httpx/anyio` (deps of
  the new `hf` CLI). torch stayed 2.8.0, whisperx 3.8.6, pyannote-audio 4.0.4, faster-whisper
  1.2.1, ctranslate2 4.8.0 (all unchanged).
- **Restore command** (revert the dev venv to the shipping build):
  `sidecar/.venv/bin/python -m pip install -r context/changes/local-cohere-transcription/venv-freeze-4.57.6.snapshot.txt`
  (full freeze snapshot of the 4.57.6 env, captured before the bump).
- Weights live in the **HF hub cache** (persistent, reusable):
  `~/.cache/huggingface/hub/models--CohereLabs--cohere-transcribe-03-2026` — pulled the
  **native set only** (excluded `*.py`, `assets/`, `demo/`, `README.md`), so the load is
  forced down the native path. `model.safetensors` = 4131862976 bytes.

### Criterion 0.1 — native load + transcribe Polish (no trust_remote_code) → **PASS**

- `AutoProcessor.from_pretrained(repo, local_files_only=True)` →
  `CohereAsrProcessor` (NATIVE — the remote `.py` were never downloaded).
- `CohereAsrForConditionalGeneration.from_pretrained(repo, local_files_only=True,
  dtype=torch.float32)` loaded in **2.9 s**.
- Transcribed `~/Desktop/LOVELETTER.mov` → 16 kHz mono WAV (126.9 s) → **fluent, non-empty
  Polish text**; `model.generate(...)` took **18.5 s** (CPU, float32).
- ⚠️ **dtype gotcha (Phase 2 must handle):** the safetensors weights are **bf16**; the
  processor emits **float32** features. On CPU a bf16 conv raises
  `RuntimeError: Input type (float) and bias type (c10::BFloat16) should be the same`.
  Fix used: `from_pretrained(..., dtype=torch.float32)`. The engine's Cohere branch must
  load float32 on CPU (CPU has no usable bf16 conv).

### Criterion 0.2 — language + punctuation honored → **PASS**

- `processor(audio, language="pl", punctuation=True/False, sampling_rate=16000)`.
- `punctuation=True` → capitalization + full punctuation; `punctuation=False` → lowercase,
  sparse punctuation. **Outputs differ** (`punctuation_differs: true`) → the knob is real
  and honored (feeds the Phase 4 panel toggle).

### Criterion 0.3 — long-audio auto-chunk + `audio_chunk_index` → **PASS**; per-chunk spans → **NOT EXPOSED**

- 126.9 s audio auto-chunked into **4 chunks** (`max_audio_clip_s=35`, `overlap_chunk_second=5`).
- `audio_chunk_index = [(0,0),(0,1),(0,2),(0,3)]` — a list of **`(sample_idx, chunk_idx)`**
  positional tuples. `processor._reassemble_chunk_texts(per_chunk_texts, audio_chunk_index,
  " ")` (and `processor.decode(..., audio_chunk_index=…, language="pl")`) reassemble into one
  continuous string. ✓
- **Per-chunk `[start,end]` time spans are NOT exposed.** The feature extractor's
  `_split_audio_chunks_energy` computes real per-chunk sample spans (`chunks_meta =
  [(start,end)]`) **internally but discards them** — only the positional index survives. And
  boundaries snap to **energy-based quiet points** (variable, not a fixed 35 s grid), so they
  cannot be cleanly reconstructed from `chunk_idx` either.
  → **Phase 2 align-window decision: use the documented fallback — sentence-split pseudo-cues
  over the audio duration** (research §F option 2), NOT one unbounded full-audio segment.
  WhisperX `align()` then re-times words within each pseudo-segment.

### Criterion 0.4 — one-line Polish-quality read → **strong; Cohere > WhisperX-small on this clip**

- On the SAME opening line, WhisperX `small` produced "dla mojego **kwieta**" (wrong word) and
  "dzięki **AIS** sales"; native Cohere produced "dla mojego **klienta**" (correct) and
  "dzięki **IIS** Sales". Cohere's Polish is fluent with correct diacritics and domain terms;
  weak spot is **brand names** ("AI Sales" → "IIS/II Sales", "WAIT System" → "white system").
  Promising enough to justify the build; the rigorous WER decision is Phase 5.

### Criterion 0.5 — HARD GATE: WhisperX survives transformers 5.12.1 → **PASS (all four)**

Ran the engine sources directly from the upgraded venv (`whisperx_engine.py`):

| Check | Result |
|---|---|
| `--selftest` | `{"ok":true, "alignment_model_ready":true, "device":"mps"}` — wav2vec2 align chain intact |
| transcribe (30 s pl control, `small` CT2) | EXIT 0, `language=pl`, 10 segments |
| align | 79 words with timings |
| **diarize** (pyannote 4.0.4) | EXIT 0, 2 speakers (`SPEAKER_00`/`SPEAKER_01`) assigned |

Re-confirmed with the user watching on the **full 126.9 s clip + `large-v3`**: EXIT 0,
28 segments, 312 words, 11 speakers auto-detected (testimonial montage). large-v3 also got
"**AI Sales**" and "**klienta**" correct — a strong Phase-5 baseline (Cohere missed the
"AI Sales" brand name → "IIS Sales"), so default-vs-optional is genuinely open for Phase 5.

- ⚠️ Non-fatal: a `torchcodec` dylib warning ("fix torchcodec installation" — `libtorchcodec_*.dylib`
  can't find `libavutil.*` via `@rpath`) prints on import; it appears on the **WhisperX path
  too** and does **not** stop transcribe/align/diarize. Pre-existing, unrelated to the bump.

### Gate verdict — **PASS → single-engine transformers 5.x bump confirmed**

Both criteria green: native Cohere transcribes Polish offline on tf 5.12.1, and the shipping
WhisperX transcribe+align+**diarize** survives the bump. The isolated-sidecar fallback is
**NOT** triggered. Proceed to Phase 1 with the committed single-engine architecture.

### Phase 2 hand-off facts (native generate recipe, proven this session)

```python
proc  = AutoProcessor.from_pretrained(model_dir, local_files_only=True)
model = CohereAsrForConditionalGeneration.from_pretrained(
            model_dir, local_files_only=True, dtype=torch.float32).eval()   # float32 on CPU
inputs = proc(audio_f32_16k, language="pl", punctuation=flag, sampling_rate=16000)
chunk_index = inputs.pop("audio_chunk_index")
gen = model.generate(inputs["input_features"],
                     decoder_input_ids=inputs["decoder_input_ids"],
                     attention_mask=inputs.get("attention_mask"),
                     max_new_tokens=445)
gen_only  = gen[:, inputs["decoder_input_ids"].shape[1]:]      # slice off the prompt prefix
per_chunk = proc.batch_decode(gen_only, skip_special_tokens=True)
text = proc._reassemble_chunk_texts(per_chunk, chunk_index, " ")[0]
# align: sentence-split `text` into pseudo-cues across [0, audio_dur] -> _align -> _normalize
```

### Repro (this session)

```bash
# 0) recoverable env: snapshot, then bump in place
sidecar/.venv/bin/python -m pip freeze > context/changes/local-cohere-transcription/venv-freeze-4.57.6.snapshot.txt
sidecar/.venv/bin/python -m pip install -U "transformers==5.12.1" librosa sentencepiece soundfile protobuf accelerate

# 1) native weights (native set only) to hub cache
HF_TOKEN=$(cat ~/.cache/huggingface/token) sidecar/.venv/bin/hf download \
  CohereLabs/cohere-transcribe-03-2026 --exclude "assets/*" "demo/*" "*.py" "README.md"

# 2) extract Polish clip
src-tauri/binaries/ffmpeg-aarch64-apple-darwin -y -i ~/Desktop/LOVELETTER.mov -ac 1 -ar 16000 <scratch>/loveletter_16k.wav

# 3) native Cohere transcribe spike (criteria 0.1-0.4)
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 sidecar/.venv/bin/python <scratch>/cohere_native_spike.py <scratch>/loveletter_16k.wav

# 4) HARD GATE: WhisperX transcribe+align+diarize on tf 5.12.1 (criterion 0.5)
HF_TOKEN=$(cat ~/.cache/huggingface/token) ENGINE_ALIGN_DIR=$PWD/sidecar/whisperx_engine/align_models \
  sidecar/.venv/bin/python sidecar/whisperx_engine/whisperx_engine.py \
    --audio <scratch>/control_30s.wav --model "<appdata>/whisper-models/small" --language pl --diarize
```
```
