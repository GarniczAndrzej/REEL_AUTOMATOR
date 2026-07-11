# Windows Audio Decode Fix — Plan Brief

> Full plan: `context/changes/windows-audio-decode-fix/plan.md`
> Frame brief: `context/changes/windows-audio-decode-fix/frame.md`

## What & Why

The app's FFmpeg-resolution contract ends at the Rust boundary — the WhisperX sidecar child
re-resolves `ffmpeg` by bare name from an inherited `PATH` the app never provisions, so audio
decode depends on an ambient system ffmpeg on **every** platform. Windows is simply the first one
with no ambient ffmpeg to mask it. A fully-provisioned Windows machine (green ZALEŻNOŚCI, engine
self-test passing, model downloaded) therefore dies on **Transkrybuj wideo** with
`Nie udało się zdekodować audio` — on both the GPU and CPU engines.

## Starting Point

Every FFmpeg call the *Rust* process makes is already absolute and correct (`ffmpeg_bin_path` →
`crate::proc`, shipped in S-29 Phase 3). The contract just stops at the process boundary: whisperx
3.8.6's `load_audio` is a plain `subprocess.run(["ffmpeg", …])` with no injection point, and the
staged/dev FFmpeg is triple-suffixed (`ffmpeg-x86_64-pc-windows-msvc.exe`) — a name no bare-`ffmpeg`
lookup will ever find. This is the one place that violates a rule the project already follows
everywhere else.

## Desired End State

Transcription and align-only both complete on Windows, on both engine variants and both resolution
paths (staged deps root and dev checkout) — including on engines **already on users' disks**. The
engine decodes through an FFmpeg the app resolved and handed it, never through an ambient lookup.
And `--selftest` finally decodes a real file, so a green "Silnik gotowy" badge can no longer certify
a machine that cannot transcribe.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Problem scope | Contract-level, not Windows-level | The bare-`ffmpeg` dependence is platform-independent; macOS has only ever been exercised in dev, where Homebrew masks it. | Frame |
| Fix shape | **Both** halves: Rust `PATH` shim + engine `REEL_FFMPEG_BIN` | The Rust half is the *only* thing that fixes engines already staged in the field; the engine half kills the ambient-`PATH` dependence for good. | Plan |
| Flag vs env var | Env var | An unknown CLI flag makes argparse exit 2 — passing `--ffmpeg-bin` would **break** every already-staged engine. An unknown env var is silently ignored. | Plan |
| Shim mechanics | Hardlink beside the resolved exe; skip entirely when already bare-named | Same-volume by construction (free, no 143 MB copy); the skip means we never write into a code-signed macOS `.app`. | Plan |
| Shim freshness | Idempotent on **identity**, not existence | `swap_in_place` re-stages FFmpeg by rename (new inode), so an existence-only check would pin the shim to a stale binary forever — silently, and leaking ~143 MB. | Plan review |
| Readiness | `--selftest` decodes a synthetic WAV → `audio_decode_ready` (no Rust pre-flight) | The current self-test aligns against synthetic *silence* and never invokes ffmpeg — structurally incapable of catching this. A Rust pre-flight was dropped: the Rust-side WAV extraction already fails first if FFmpeg is unresolvable. | Frame → Plan → Plan review |
| Engine propagation | Bump `version` → existing `stale` flag → **opt-in** update | Staging is presence-only, so nobody is forced through a 0.5–1 GB re-download for a bug the shim already fixed for them. | Plan |
| macOS | Code is platform-neutral (no `cfg` gates); **verification + release are Windows-only** | The fix is a strict improvement either way, and gating it *out* of macOS would mean writing more code to preserve a known-broken bundle. | Plan |

## Scope

**In scope:** the Rust spawn-env helper (`with_ffmpeg`) at all five engine spawn sites; the FFmpeg
shim resolver (identity-aware, so an FFmpeg re-stage cannot leave it pinned to a stale binary); an
exit-11 toast that names FFmpeg; the engine's `_decode_audio` / `_load_audio` split and its decode
self-test; the `audio_decode_ready` field end-to-end (engine → Rust → badge); rebuild + re-pin +
release of the Windows CPU and GPU engines.

**Out of scope:** macOS verification/release (code lands, claims don't); rebuilding `gpu-full`
(3.3 GB, env-only escape hatch — the shim carries it); forcing convergence via version-aware
staging; `waveform.rs` / `metadata.rs` (already absolute — confirmed correct, manual-verify only);
chasing whether the extracted WAV is itself healthy (unfalsified but not load-bearing).

## Architecture / Approach

One chokepoint, provisioned from both sides.

`_load_audio` (`whisperx_engine.py:374`) is the **only** decode site — verified, not assumed: every
internal `load_audio` call inside whisperx is `isinstance(audio, str)`-guarded, and the engine always
passes an ndarray. So fixing that one function closes all three entry points (transcribe, cohere,
align-only) at once.

Rust gains `engine::with_ffmpeg(app, &mut cmd)` — a sibling of the existing `with_hf_offline` /
`with_utf8_io` — applied at every engine spawn. It sets `REEL_FFMPEG_BIN` (inert on today's engines)
and **prepends** a shim dir holding a bare-named `ffmpeg[.exe]` to the child's `PATH`, so our binary
wins over any stray system ffmpeg. The engine then prefers that explicit path, falling back to
`whisperx.load_audio` only for a bare dev-CLI run.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Rust provisions the child's FFmpeg | **The shippable fix** — un-breaks the affected machine and every already-staged engine, with no rebuild and no re-download | Shim materialization must be idempotent, or the CPU-retry spawn re-copies 143 MB mid-run |
| 2. Engine explicit FFmpeg + truthful decode self-test | Ambient `PATH` becomes irrelevant; the badge can finally fail | The `parse_engine_status` hand-map trap — a new field not read out there is silently `None` forever; and `Option<bool>` must model "absent ⇒ unknown, never failed" |
| 3. Rebuild, re-pin, release (CPU + GPU) | The fixed engine reaches users as an opt-in update | A GPU rebuild that loses `cublas: true` would silently demote every GPU machine; an unmatched `sha256` fail-closes the downloader |

**Prerequisites:** S-24, S-29, S-30 (all shipped). For Phase 3: a working `sidecar/build.sh` on
Windows and push access to the `GarniczAndrzej/reel-automator-deps` releases.

**Estimated effort:** ~2–3 sessions. Phase 1 is a short session and is independently shippable;
Phase 3 is dominated by ~1.5 GB of build + upload wall-clock, not by code.

## Open Risks & Assumptions

- **The macOS bundle break is predicted, not observed.** The frame argues a Finder-launched `.app`
  fails identically today (POSIX `execvp` never searches the caller's exe dir). We fix it on the
  argument without reproducing it; if the prediction is wrong, we added machinery macOS didn't need.
  Either way the code is platform-neutral, so nothing is *gated* on this being true.
- **Two engine populations will coexist indefinitely** — old engines carried by the shim, new ones
  carrying the explicit contract. This is intentional (opt-in update), and `audio_decode_ready:
  Option<bool>` is what keeps the old population from reading as broken.
- **The shim depends on the child inheriting our `PATH`.** A future whisperx bump that changes how
  `load_audio` resolves ffmpeg would break the Rust half — but that would require an engine rebuild
  anyway, at which point the Phase 2 contract carries it.
- **D1 remains open**: whether the extracted WAV is itself healthy was never verified (exit 11 has
  two branches that look identical). Not load-bearing — the ffmpeg lookup fails first and
  deterministically — so it's confirmed opportunistically in Phase 1, not treated as a blocker.

## Success Criteria (Summary)

- On the affected Windows machine, **Transkrybuj wideo** produces a transcript instead of
  `Nie udało się zdekodować audio` — on the GPU engine and the CPU engine alike.
- Align-only completes on the same video (the second decode entry point, never previously exercised).
- `--selftest` reports `audio_decode_ready: false` when ffmpeg is genuinely unreachable — the check
  can actually fail, which is what makes the green badge mean something.
