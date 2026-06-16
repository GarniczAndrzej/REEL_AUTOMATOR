# Frame Brief: WhisperX engine readiness probe — 15-min idle hang on every launch

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

The user cannot transcribe because the WhisperX engine readiness indicator
("✓ Silnik gotowy") takes ~15 minutes to resolve on **every** app launch.
During the wait the machine **looks idle** (no obviously pegged CPU/disk/network).

## Initial Framing (preserved)

- **User's stated cause or approach**: "A problem with the engine analyzer and
  booting up the engine. The sidecar engine has some weight, so it's big."
  (i.e. boot/compute is slow because the binary is large.)
- **User's proposed direction**: Speed up the engine readiness check / engine boot.
- **Pre-dispatch narrowing** (Step 1.5): user is watching **the readiness badge**
  (not a transcription run); the wait happens on **every app launch** (not first-run
  only); during the wait the machine **looks idle**.

## Dimension Map

The 15-minute wait could originate at any of these dimensions of the
`whisperx_engine_check` → sidecar `--selftest` path:

1. **PyInstaller onefile cold extraction** — 290 MB onefile unpacks to a temp dir on
   every spawn (`whisperx_engine.spec` is onefile, `console=True`).
2. **Frozen `whisperx`/`torch` import** — `cmd_selftest` does `import whisperx`, dragging
   in torch/transformers from the frozen archive.  ← part of user's "boot is slow" framing
3. **Forced-align compute** — `_selftest_align_runs` loads the align model and runs a real
   `whisperx.align()` on a synthetic 0.5 s clip every launch.
4. **Blocking I/O during selftest (network socket or HF filelock)** — the align model is an
   HF-cache snapshot (`models--jonatasgrosman--wav2vec2-large-xlsr-53-polish` + `.locks/`);
   `load_align_model` can phone home / wait on a lock if an offline flag is missed.
5. **Design: heavyweight probe re-run every launch for a non-gating cosmetic badge** — no
   cross-launch caching; `refreshEngineReadiness()` re-runs the full probe each launch, and the
   badge does **not** gate the Transcribe button.
6. **macOS Gatekeeper/XProtect first-run scan** — large unsigned binary scanned on first exec.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| D1: onefile extraction is the 15 min | onefile (`whisperx_engine.spec:100` EXE, no COLLECT); 290 MB. But extraction pegs disk/CPU — user reports **idle**; would also be ~seconds, not minutes | WEAK |
| D2: frozen import is the 15 min (user's framing) | `cmd_selftest` imports whisperx (`whisperx_engine.py:217`). Import is CPU-bound → contradicts **idle**; binary is 290 MB, **not** multi-GB, so "too big" doesn't apply | WEAK |
| D3: forced-align compute is the 15 min | `_selftest_align_runs` loads model + runs real align every launch (`whisperx_engine.py:174-210`). Compute is CPU-bound → contradicts **idle** | WEAK |
| **D4: selftest blocks on I/O (network/lock) despite HF-offline** | Reproduction (see below) with HF-offline flags set showed **0 network sockets across the whole run** and **no lock files held** → NOT a sustained socket/lock hang *in the offline path*. The 15-min tail is environmental (offline mode not effective on the user's run, network hit on a slow/blocked link) — not reproducible here | WEAK in offline path; environmental otherwise |
| **D5: heavyweight probe re-run every launch for a non-gating badge** | No persistence/cache; `refreshEngineReadiness()` runs each `initModelManager()` (`transcribe.js:92`); Transcribe button gates only on video+model, **not** readiness (`transcribe.js:73-76`); prior commit `287e5c8 "...faster engine readiness"` shows recurring pain | **STRONG (verified)** |
| D6: Gatekeeper first-run scan | Would hit **first launch only** and is CPU-ish — user reports **every launch** + **idle** | NONE (ruled out) |

## Narrowing Signals

Decisive observations that narrowed the hypothesis space:

- "Watching the **badge**, not transcription" → isolates the `--selftest` probe; the real
  transcription path is a separate concern and is not the reported problem.
- "**Every launch**" → rules out Gatekeeper first-run scan and any one-time warm-up; confirmed
  by code that re-runs the full probe each launch with no cross-launch cache.
- "**Looks idle**" → contradicts all three compute hypotheses (extraction/import/align peg a
  core) and points at a blocking-I/O wait (socket or filelock).

## Reproduction (verified 2026-06-16)

Ran the sidecar exactly as production does — `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ENGINE_DEBUG=1 whisperx-engine --selftest --align-model-dir .../align_models` — timed,
with `lsof`/`ps` snapshots throughout:

- **Total wall time ≈ 65 s** (warm binary), exit 0, output
  `{"ok": true, "device": "mps", "alignment_model_ready": true}`.
- **0 network sockets** on any engine process across 4 snapshots over the full run; **no
  `.lock`/HF files held**. Child process sleeping (`STAT=S`) at low, falling CPU (10% → 3%).
- `--version` is an **alias for `--selftest`** (`whisperx_engine.py:489`) — it also runs the
  full align exercise; it did not finish within a 60 s guard.

Conclusions: (1) the offline selftest is **~65 s of heavyweight work every launch** — fully
reproducible, fully in our control; (2) it is **not** a network-socket or filelock hang *in the
offline path*; (3) the user's 15-min figure must come from the **offline mode not being
effective on their actual run** (network hit on a slow/blocked link) and/or **cold 290 MB
onefile extraction** — neither reproduced here and both environment-specific.

## Cross-System Convention

A readiness/health badge is conventionally **cheap, cached, and non-blocking**: a fast capability
check whose result is memoized, run in the background, and never on the critical path of a
cosmetic indicator. This codebase instead runs the heaviest possible probe (frozen ML import +
model load + real forced-align) synchronously on every launch. The convention says: make the
probe lightweight and/or cache its verdict across launches; never let a non-gating badge do
minutes of work — least of all blocking I/O — on the launch path.

## Reframed Problem Statement

> **The actual problem to plan around is**: the engine readiness probe does far too much work —
> a full frozen-`whisperx` import, align-model load, and a real forced-align (~65 s reproduced,
> warm + offline) — and re-runs it from scratch on **every** launch, with no cross-launch caching,
> to paint a **cosmetic, non-gating** badge; on the user's machine an environmental factor
> (network hit despite intended offline mode, and/or cold onefile extraction) stretches that to
> ~15 min.

The user's framing ("engine boot/analyzer compute is slow because the binary is big") is **half
right**: the heavyweight frozen import + model load + align genuinely is slow (~65 s reproduced),
so "boot is heavy" has real substance. But "because the binary is big" is the wrong lever — the
binary is 290 MB (not multi-GB), and shrinking it isn't the fix. The fix is to **stop doing this
work on every launch**: the probe is non-gating, so its result can be cached across launches and
the check itself lightened (a fast capability check instead of a real forced-align) and moved
fully off the critical path. That collapses the reproducible 65 s **and** makes the environmental
15-min tail irrelevant — the user never waits on the badge to transcribe, because transcription
was never actually gated on it.

## Confidence

- **HIGH on the reframe** — Reproduction confirms the stable, in-our-control core: even warm +
  offline, the readiness probe is **~65 s of heavyweight work (frozen import + align-model load +
  real forced-align) re-run on every launch** to paint a badge that does **not** gate the
  Transcribe button, with **no cross-launch caching**. That is the real problem, and it is
  reproducible on this machine.
- **MEDIUM on the 15-min tail** — The extra ~14 min over the reproduced 65 s is **environmental**
  (the user's run hitting the network despite intended offline mode, on a slow/blocked link, and/or
  cold 290 MB onefile extraction). It did **not** reproduce here (0 sockets in the offline path) and
  needs the *user's* machine to pin. Crucially, it **does not block planning**: fixing the
  architecture (cache the verdict + lighten the probe + run off the critical path) neutralizes the
  tail regardless of which environmental call leaks.

  **Optional pin (on the user's machine, not a blocker)**: run the same selftest *without* the
  offline flags and watch `lsof -nP -i` — if a socket to `huggingface.co`/`download.pytorch.org`
  hangs, that names the leaking call to harden; if cold-vs-warm wall time differs by minutes, it's
  extraction.

## What Changes for /10x-plan

The plan is **not** "make the engine boot faster." It is: (1) make the readiness badge cheap and
non-blocking — cache/persist the verdict across launches and/or run a lightweight capability check
instead of a real forced-align, and run it truly off the critical path; and (2) eliminate the
blocking I/O stall in `--selftest` (extend the offline coverage / drop the network call, or fix the
lock) identified by the verification step above.

## References

- Source: `src-tauri/src/engine.rs:16-23` (with_hf_offline rationale), `:96-140` (whisperx_engine_check)
- Source: `sidecar/whisperx_engine/whisperx_engine.py:174-235` (_selftest_align_runs, cmd_selftest)
- Source: `src/ui/import/transcribe.js:73-113` (syncTranscribeBtn gates without readiness; refreshEngineReadiness on every launch, no cache)
- Packaging: `sidecar/whisperx_engine.spec:100-112` (onefile, console); binary 290 MB
- Align model: `src-tauri/binaries/align_models/pl/models--jonatasgrosman--wav2vec2-large-xlsr-53-polish` (HF snapshot + `.locks/`)
- Prior incident: commit `287e5c8` "faster engine readiness"; archive `context/archive/2026-06-12-builtin-whisperx-transcription/`
- Investigation: conducted inline (small, familiar surface) — no TaskCreate sub-agents dispatched
