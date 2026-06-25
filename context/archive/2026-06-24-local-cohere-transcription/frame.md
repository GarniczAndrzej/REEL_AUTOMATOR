# Frame Brief: Local (offline) Cohere transcription

> Framing step before /10x-plan. Captures what is *actually* at issue,
> separated from what was initially assumed.

## Reported Observation

Add **Cohere** as a transcription provider, integrated into the existing WhisperX
pipeline: Cohere produces the raw transcript, WhisperX still performs word-level
forced alignment (so the integer-frame export math is untouched). The change is
named `local-cohere-transcription`.

## Initial Framing (preserved)

- **User's stated cause or approach**: Run the Cohere **open-weights** model
  (`CohereLabs/cohere-transcribe-03-2026`, ~2B params, Apache-2.0, HF Transformers)
  **offline in the sidecar** — not the cloud API.
- **User's proposed direction**: Plug a second transcription producer in at the
  align seam, converging on the same align-input + output payload; everything
  downstream (segmentation, exporters, state) untouched.
- **Pre-dispatch narrowing** (Step 1.5):
  - "Local" = **offline open weights** (not cloud API).
  - Motivation = **both** better Polish transcription quality **and** faster /
    less painful than the current WhisperX cold-spawn.
  - Content = **long webinars (>13 min)**.

## Dimension Map

The observation could originate at any of these dimensions:

1. **Packaging feasibility** — can ~2B offline weights ship at all given the
   onefile lesson? ← the assumed hard wall
2. **Sidecar runtime** — does the frozen engine already carry torch/transformers?
3. **Speed** — does an offline 2B model deliver "faster"? ← initial framing's 2nd motive
4. **Engine mode + model manager** — lift to slot a Cohere producer into the engine
5. **Polish-quality premise** — *is Cohere actually better at Polish?* ← initial framing's 1st motive, never measured

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| Packaging blocks offline weights | App already ships 2.4 GB align model beside the binary (`tauri.conf.json:39-40`, `build.sh:118-126`) **and** a registry-agnostic download-on-demand flow (`models.rs:140-276`). Onefile stays model-free by design (`whisperx_engine.spec:22-26`). | **NONE** (feasible) |
| Sidecar lacks the HF runtime | torch + transformers already pinned & frozen (`requirements.txt:10-12`, `whisperx_engine.spec:34,49-77`) — needed today for wav2vec2 align. | **NONE** (already present) |
| Offline Cohere is "faster" | Cold-spawn = 290 MB onefile extraction + torch import, NOT the model (no-model `--capability` probe still 37-67s — `s-18/change.md:18-21`). Offline keeps WhisperX align spawn, **adds a 2nd 2B model load**, eager-PyTorch slower than INT8 CTranslate2 (`whisperx_engine.py:126,386,405`), bigger binary → worse cold-spawn. | **STRONG (contradicted)** |
| Engine can't host a 2nd producer cleanly | `cmd_align_only` (`whisperx_engine.py:460`) already runs align standalone; a Cohere producer feeds the existing `_align`→`_normalize` (`:277,:305`) unchanged; 0 Rust parsing changes. New = one transformers load branch + `--engine` flag + generalize `model.bin` sentinel (`models.rs:20,52`). | **MEDIUM (feasible, build is the cost)** |
| Cohere Polish quality > current WhisperX | **No measurement exists.** Cannot be verified by reading code. This is the load-bearing, unverified premise. | **UNVERIFIED** |

## Narrowing Signals

Decisive observations that narrowed the space:

- User confirmed "local" = **offline open weights**, retiring the research's cloud-API default.
- User confirmed content = **long webinars** — research's 25 MB cloud cap (~13 min)
  would block the production path on cloud, so cloud can't be the shipping target for this content.
- Three independent sub-agents converged: packaging is **not** the wall; the **speed**
  premise is contradicted; the engine change is **MEDIUM**, dominated by the build/bundle step.

## Cross-System Convention

This app already handles "multi-GB ML weights + offline + torch" — twice (the 2.4 GB
wav2vec2 align model beside the binary; CT2 models via download-on-demand). The offline
Cohere path matches that convention. What does **not** match a verified convention is the
quality claim: every prior model decision (WhisperX selection, S-25 prompt work) rests on
the bundled `pl` wav2vec2 + faster-whisper stack; there is no recorded Polish-ASR benchmark
comparing Cohere against it.

## Reframed Problem Statement

> **The actual problem to plan around is**: whether Cohere's Polish transcription
> quality beats the current WhisperX model by enough to justify a heavier sidecar, a
> second multi-GB offline model, and a likely **speed regression** — and the cheapest
> way to answer that is a cloud-API quality spike *before* committing to the offline build.

Two of the initial framing's load-bearing assumptions don't survive: (1) **"faster" is
contradicted** — the cold-spawn pain is a packaging artifact the model swap can't reduce and
will worsen, so the offline build must be planned as a *quality-for-speed trade*, not a
speed win; (2) **"better Polish quality" is unverified** — it's the sole un-contradicted
motive and the entire justification for a LARGE build, yet nothing measures it. The
offline-vs-cloud question the research posed is therefore not "which do we build" but
"cloud is the cheap harness to de-risk the premise the offline build rests on." If offline
is *also* driven by privacy / no-paid-key / no-25 MB-cap, those independently justify the
offline target — but they don't make the quality premise true.

## Confidence

**MEDIUM.** HIGH-confidence on what's ruled out (speed) and what's feasible (packaging,
engine) — backed by file:line evidence and three converging agents. The GO/NO-GO pivot,
though — *is Cohere's Polish actually better?* — is **unverified** and inherently a
measurement, not a code-read.

**Verification step before /10x-plan commits to the offline build**: run a cloud-API
quality spike (`POST api.cohere.com/v2/audio/transcriptions`, a few-line `fetch` mirroring
`callOpenRouter`, no download, no sidecar rebuild) on 1-2 representative Polish webinar
clips and compare Polish accuracy against current WhisperX output. Build offline only if
Cohere wins.

## What Changes for /10x-plan

Plan the offline path **explicitly as a quality-driven trade that accepts equal-or-worse
speed and a heavier sidecar** — never sell it as faster. Gate the LARGE build (download-on-
demand multi-GB weights + transformers load branch + `--engine` flag + sentinel
generalization) behind a cheap cloud-API Polish-quality spike. The engine/packaging design
is already de-risked; the open decision is GO/NO-GO on quality, not on feasibility.

## References

- Source files: `sidecar/whisperx_engine/whisperx_engine.py:277,305,366,460`,
  `whisperx_engine.spec:22-26,34-77`, `sidecar/build.sh:118-126`,
  `src-tauri/tauri.conf.json:39-40`, `src-tauri/src/whisper.rs:201-250,292,370,699`,
  `src-tauri/src/engine.rs:16,38,54`, `src-tauri/src/models.rs:20,52,140-276`,
  `src/transcription/model-registry.js:1-105`
- Related research: `context/changes/local-cohere-transcription/research.md`
- Prior context: `context/archive/2026-06-16-s-18/` (cold-spawn = packaging),
  `context/archive/2026-06-12-builtin-whisperx-transcription/` (onefile lesson),
  memory `whisperx-cold-spawn-cost`
