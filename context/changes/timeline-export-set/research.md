---
date: 2026-06-22T00:00:00+02:00
researcher: GarniczAndrzej
git_commit: 085ee3a
branch: master
repository: REEL_AUTOMATOR
topic: "S-08 timeline-export-set — Premiere XML / FCPXML / Resolve Lua export set with markers"
tags: [research, codebase, exporters, fcpxml, markers, regression]
status: complete
last_updated: 2026-06-22
last_updated_by: GarniczAndrzej
last_updated_note: "Added follow-up external research on the FCPXML format spec (Apple DTD + reference)"
---

# Research: S-08 `timeline-export-set` — full timeline-export set (XML / FCPXML / Lua) with markers

**Date**: 2026-06-22T00:00:00+02:00
**Researcher**: GarniczAndrzej
**Git Commit**: 085ee3a
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

For roadmap slice **S-08 / `timeline-export-set`** (PRD FR-027/028/029): the editor should export FCP7 xmeml `.xml` (Premiere), a net-new `.fcpxml` (Final Cut Pro X), and a DaVinci Resolve `.lua` console script — **all carrying the S-01 hook/body/punchline markers** and importing cleanly. Research the existing codebase to back planning, weighting: (1) frame-math / span fidelity, (2) net-new FCPXML integration, (3) marker-model translation across formats, (4) regression-test scaffolding. Scope: **exporters + their wiring only** (no S-09 plugin, no external FCPXML-spec research).

## Summary

The work splits into **three asymmetric tasks**, not one:

1. **Markers into XML + Lua** — *low plumbing, format-specific emission.* Both `generateXML` and `generateLua` already receive `reelsData`, so `reel.markers` is already in hand; they simply ignore it today. Only EDL emits markers (`* LOC:` locator lines). Adding markers needs **no new caller wiring** — just emission code inside each exporter, plus the per-format record-frame math (see below).
2. **FCPXML is genuinely net-new** — *new file + new caller wiring + new HTML row + new state field + new regression cases.* There is **no FCPXML code today**, only legacy xmeml v4. FCPXML (Apple DTD) uses a different time model (rational time, `<marker>` elements) than xmeml — confirming the roadmap's open question that it likely needs its own marker/timecode model rather than reusing the xmeml exporter.
3. **Regression cases per format** — mirror **Test 13** (the EDL-marker case). Suite is currently **206 passed / 0 failed**; harness is a bespoke `assert`/`assertEq` tally.

The single sharpest correctness risk: **each format computes a marker's record-timeline frame differently** and there is **no shared record-frame helper**. EDL uses `cursor = 3600*fps` (CMX-3600) + `recIn + (s.start_frame - span.start_frame)`; XML uses a per-`<sequence>` cursor starting at 0; Lua uses its own cursor starting at 0. Marker frame math must be re-derived per exporter, keeping the integer-frame invariant.

All exporters are **pure `(opts) → string`** (no `state`, no DOM, no I/O). `state → opts` mapping happens in exactly one place: the `gen*()` wrappers in `src/ui/export-popover.js`. That purity boundary must be preserved — `reel.markers` is threaded through `opts`, never read from `state` inside an exporter.

## Detailed Findings

### A. Current exporters (`src/exporters/`) — structure & frame math

**Shared helpers**
- `mergeAdjacentClips(clipIds, sentences, thresholdFrames = 12)` — `src/parser/segments.js:1`. Returns spans `{ start_frame, end_frame, ids[], text, source_idx, duration_frame }`. The `12` default lives only here; every exporter passes an explicit threshold. `0` ⇒ only zero-gap touching clips merge (the regression `MERGE_0` byte-identical baseline). Warns (never throws) on missing ids / overlaps — pure aside from `console.warn`.
- `framesToTC(frames, fps)` — `src/parser/srt.js:11` — SMPTE `HH:MM:SS:FF` (NDF `:`) / drop-frame (`;` for 29.97/59.94). **Used only by EDL.** `_isDropFrame` is **duplicated** at `src/parser/srt.js:7` and `src/exporters/edl.js:4`.
- `Math.round(seconds * fps)` happens **only at parse time** (`src/parser/srt.js:102-103`, `:154-155`). Exporters consume already-integer `start_frame`/`end_frame`, so they are integer-frame-clean by construction — **no exporter should ever re-round to seconds.**

**EDL** — `src/exporters/edl.js`
- Sig: `generateEDL({ reelsData, sentences, fps, gapFrames, videoFilename, mergeThreshold })` (`edl.js:8-15`).
- Record TC offset: `let cursor = 3600 * fps;` (`edl.js:18`, CMX-3600). Source IN/OUT = `framesToTC(span.start_frame/.end_frame, fps)`; record IN/OUT = `framesToTC(recIn/recOut, fps)`. `cursor += dur` per span; `cursor += gapFrames` between reels (`edl.js:57`, `:70-72`).
- **Markers (only EDL emits them):** `MARKER_DEFS = [['hook','GREEN','HOOK'],['body','BLUE','BODY'],['punchline','RED','PUNCHLINE']]` (`edl.js:21-26`). Builds `recordFrameById` while walking spans: `recordFrameById.set(id, recIn + (s.start_frame - span.start_frame))` (`edl.js:47`). Emission gated on `reel.markers` (`edl.js:59-69`):
  ```
  * LOC: <record-tc> GREEN HOOK
  ```
  `virality_score` / `scores` / `reason` are **not emitted by any exporter** — only the three `markers` clip-id pointers reach output.
- Honors per-reel override: `reel.mergeThreshold ?? mergeThreshold` (same in all three exporters), even though v5 folded the override into a global (code still honors it if present).

**XML (xmeml v4)** — `src/exporters/xml.js`
- Sig: `generateXML({ reelsData, sentences, fps, videoFilename, videoPath, videoResolution, projectName, mergeThreshold })` (`xml.js:3-12`). `projectName` is destructured but currently **unused** in the body.
- **One `<sequence>` per reel** (`xml.js:38-120`); no `gapFrames` (reels are separate sequences, not one timeline). Per-sequence record cursor starts at 0 (`xml.js:64`, advances `:108`); `<start>/<end>` = record frames, `<in>/<out>` = source frames.
- **Shared `<file>` reference (fragile):** the first clipitem across the whole document emits the full `<file id="source_file_1">` block; every later clipitem emits the self-closing back-reference `<file id="source_file_1"/>` (`xml.js:35-36`, `:82-102`).
- **Markers: none.** Only metadata channel today is `<comments><mastercomment1>` (text, `xml.js:104-106`). xmeml v4 markers attach as `<marker>` children of `<sequence>` or `<clipitem>`.

**Lua (DaVinci Resolve)** — `src/exporters/lua.js`
- Sig: `generateLua({ reelsData, sentences, fps, gapFrames, videoPath, projectName, mergeThreshold })` (`lua.js:3-11`). Requires `videoPath` (caller toasts + returns null if absent).
- Emits raw integer frames into a `segs` table keyed `r{ri+1}s{si+1}` (`lua.js:68-70`), then a **single batched** `mediaPool:AppendToTimeline(allClips)` (`lua.js:132-133`) with a running `cursor` (starts 0; `+= gapFrames` between reels).
- **Markers: none.** Future hook point: `timeline:AddMarker(frameId, color, name, note, duration)` after the append.
- Note: `mergeAdjacentClips` is called **three times** in this file (`lua.js:57-61`, `:96-100`, `:105-109`) — keep them consistent if changing merge behaviour.

### B. Marker / score data model

- `Reel` @typedef — `src/state.js:40-48`: `reel_name`, `clip_ids:number[]`, `virality_score?:number`, `scores?:{hook,flow,value,trend}`, `reason?:string`, **`markers?:{hook?,body?,punchline?}` — each value is a member of `clip_ids`**, `ai_order?`.
- `Sentence` @typedef — `src/state.js:15-25`: `id`, `text`, `start_frame`, `end_frame`, `duration_frame`, `start_tc`, `end_tc`, `source_idx?`, `words?`.
- LLM schema — `src/ai/prompt.js:12-30` (`RESPONSE_FORMAT`, always injected) defines `markers:{hook,body,punchline}` as clip_ids; guidance `prompt.js:36-41` states markers must be members of `clip_ids`.
- **Validate-before-use (FR-018)** — `src/ai/validate.js`: `MARKER_KEYS = ['hook','body','punchline']` (`:6`); markers must be an object, each present key an integer clip_id, **each value must belong to that reel's `clip_ids`** (`:84-105`). Called at `src/ui/step2-prompt-panel.js:147` (AI run) and `:217` (manual paste). ⇒ By the time a reel reaches an exporter, `reel.markers[*]` is guaranteed to be a clip_id present in `clip_ids`.
- **Marker → frame is exporter-local.** The only existing clip_id→record-frame mapping is EDL's `recordFrameById` (`edl.js:38-48`). No shared helper — XML and Lua must each derive the record frame from their own cursor.

### C. Export UI wiring & save path

- `src/ui/export-popover.js` — `FORMATS` map (`:138-152`): `edl/xml/lua → { gen, ext, suffix, store }`. `saveFormat(fmt)` (`:154`) calls `FORMATS[fmt].gen()`, stashes to `state[store]`, `emit()`, then `saveTextToPath({ defaultName: videoBase()+suffix, content })`. `copyFormat(fmt)` mirrors for clipboard.
- `gen*()` wrappers are the **only** `state → opts` bridge: `genEDL` (`:94-103`), `genXML` (`:105-117`), `genLua` (`:119-136`). State fields used: `fps`, `gapFrames`, `mergeThreshold`, `videoFilename`, `videoPath`, `videoResolution`, `projectName`, `reelsData`, `sentences`.
- **Save helper** — `src/util/save-file.js:17` `saveTextToPath({ defaultName, content, filters })`: native `@tauri-apps/plugin-dialog` `save()` → `invoke('save_text_file', { path, content })`; returns `false` on cancel. **Every save prompts for a location** (matches the project rule — never auto-download).
- **HTML** — `src/index.html:967-1051`. Primary rows EDL / XML / Lua, each `⬇ Generuj i zapisz` + `Kopiuj`; a `<details>` "Więcej formatów (transkrypcja, prompt)" holds SRT/VTT/MD/copy-prompt. Existing Polish subtitles: XML = "Premiere Pro (xmeml / FCP7)", Lua = "Skrypt DaVinci (Lua)".
- **FCPXML slot-in (additive):** new `src/exporters/fcpxml.js` (`generateFCPXML(opts)`); import + `FORMATS.fcpxml = { gen: genFCPXML, ext:'fcpxml', suffix:'_timeline.fcpxml', store:'fcpxmlContent' }`; a `genFCPXML()` wrapper; `state.fcpxmlContent`; a new primary HTML row with `exFcpxmlGen`/`exFcpxmlCopy` + two listeners; Polish label/subtitle. Mirrors the XML row exactly.

### D. Regression scaffolding (`test/regression.js`)

- Run: `node --experimental-vm-modules test/regression.js` (native ESM, no bundler). Imports exporters directly (`generateEDL/XML/Lua` etc.).
- Harness: globals `passed`/`failed`; `assert(cond,label,detail)` (`:33-42`) and `assertEq(a,b,label)` with first-diff printer (`:44-62`); final tally `:1324-1331`, `process.exit(1)` on any fail. **Current: 206 passed / 0 failed.**
- Fixtures: `newSentences = parseSRT(srtText, FPS, MIN_CHARS)` from `test/sample.srt` (12 clips); `reelsData` two reels (`:280-283`); constants `FPS=25, GAP_FRAMES=60, VIDEO_FILE, VIDEO_PATH, RESOLUTION='1920x1080', PROJECT_NAME='Reels', MERGE_0=0` (`:264-272`).
- Existing exporter cases: **Test 3** EDL byte-identical-to-legacy (`:374-408`), **Test 4** XML byte-identical (`:414-452`), **Test 5** Lua functional (`:460-507`), **Test 13** EDL markers (`:1014-1092`) — the reference pattern: marked reel `{clip_ids:[2,3], markers:{hook:2,body:2,punchline:3}}` + an unmarked reel, asserts exactly 3 `* LOC:` lines with `GREEN HOOK`/`BLUE BODY`/`RED PUNCHLINE` and zero LOC for the unmarked reel.
- **New cases** belong after Test 13: one per format (XML-markers, FCPXML-markers, Lua-markers), each asserting (a) markers present for a marked reel and (b) marker-free output stays **byte-identical to the existing Test 4/Test 5 baseline** (regression guard against perturbing legacy output).

## Code References

- `src/exporters/edl.js:18,21-26,38-48,59-69` — CMX-3600 cursor; `MARKER_DEFS`; `recordFrameById`; `* LOC:` emission (the marker template).
- `src/exporters/xml.js:3-12,38-120,82-102,104-106` — sig; per-sequence cursor; shared `<file>` ref; `<mastercomment1>` (no markers).
- `src/exporters/lua.js:3-11,57-61,68-70,132-133` — sig; triple merge call; `segs` table; batched append (no markers).
- `src/parser/segments.js:1` — `mergeAdjacentClips` (export-span source).
- `src/parser/srt.js:11` — `framesToTC` (EDL-only TC formatter).
- `src/state.js:15-25,40-48` — `Sentence` / `Reel` typedefs (`markers` at `:46`).
- `src/ai/prompt.js:12-41` — LLM `RESPONSE_FORMAT` + scoring/marker guidance.
- `src/ai/validate.js:6,84-105` — `MARKER_KEYS`; marker membership validation (FR-018 gate).
- `src/ui/step2-prompt-panel.js:147,217` — validation call sites.
- `src/ui/export-popover.js:94-152` — `gen*()` wrappers + `FORMATS` map + `saveFormat`/`copyFormat`.
- `src/util/save-file.js:17` — `saveTextToPath` (native save dialog).
- `src/index.html:967-1051` — export-popover HTML (Polish labels).
- `test/regression.js:33-62,264-283,374-507,1014-1092,1324-1331` — harness, fixtures, exporter cases, Test 13 markers, tally.

## Architecture Insights

- **Purity boundary is the contract.** Exporters import only parser helpers — no `state`, DOM, or I/O. The `gen*()` wrappers in `export-popover.js` are the sole `state → opts` adapter. Any new field (markers for XML/Lua, all FCPXML opts) is threaded via `opts`/`reel`, never read inside the exporter. This is also what keeps regression tests trivial (call generator with fixture opts, assert on string).
- **`reel.markers` is already delivered, just unused** by XML/Lua. The plumbing cost of cross-format markers is near-zero; the real work is **per-format record-frame math** (3 different cursor schemes, no shared helper) and **per-format marker syntax** (EDL `* LOC:`; xmeml `<marker>`; FCPXML rational-time `<marker>`; Lua `timeline:AddMarker(...)`).
- **FCPXML ≠ xmeml.** Reusing the xmeml exporter for `.fcpxml` is a trap: different DTD, rational time (`<frame>/<rate>` vs `n/d s`), different marker element. Treat as a separate pure exporter. (The exact FCPXML element grammar is an **external-research** follow-up — out of this internal-research scope.)
- **Integer-frame invariant holds end-to-end.** Rounding is parse-time only; exporters never re-round. Marker frames must stay integer (`recIn + offset`), no seconds round-trip.
- **Marker validity is pre-guaranteed.** `validate.js` ensures each marker value is a clip_id in the reel — exporters can assume a marker resolves to a sentence in one of the reel's spans; still guard `recordFrame == null` like EDL does (a marker clip merged into a span is fine; one not found is skipped).

## Historical Context (from prior changes)

- **S-01 (`scored-selection-edl`, archived `context/archive/2026-06-12-scored-selection-edl/`)** introduced the scored schema (`virality_score`, `scores`, `hook/body/punchline` markers) + the validate-before-use gate + EDL marker emission (regression Test 13). Lesson recorded: a free-form editable prompt must still elicit the fixed validated schema — validate every LLM response before the export pipeline. S-08 inherits this marker model verbatim.
- **F-01 (`remove-render-path`)** shrank the schema-consumer surface (no `renderConfig`), and established the regression fence as the only automated guard — S-08 must extend it (per-format marker case) in the same change.
- **Roadmap S-08 open question** (`roadmap.md:228-229`): "Does the `.fcpxml` need its own marker/timecode model vs the xmeml exporter?" — this research answers **yes, almost certainly** (distinct DTD + time model), pending the external FCPXML-spec confirmation.

## Related Research

- None prior for this change (`research.md` is the first artifact under `context/changes/timeline-export-set/`). Adjacent: `context/archive/2026-06-12-scored-selection-edl/` (marker origin).

## Open Questions

1. **FCPXML grammar (external research).** Exact `.fcpxml` version, time representation (rational `1001/30000s`), `<marker>`/`<chapter-marker>` element shape, and resource/asset modelling — needs Context7/exa, deliberately **out of this internal-research scope**. Blocks writing `generateFCPXML` but not the marker/XML/Lua work.
2. **xmeml marker placement.** Attach `<marker>` to `<sequence>` (reel-level) or `<clipitem>` (clip-level)? EDL places markers at the clip's record frame; the cleanest parallel is a `<sequence>`-level `<marker>` with the per-sequence record frame. Import-test in Premiere/Resolve (the xmeml structure is flagged fragile in CLAUDE.md).
3. **Lua marker API & color mapping.** `timeline:AddMarker(frameId, color, name, note, duration)` — confirm Resolve marker colour names (its palette differs from EDL's GREEN/BLUE/RED) and that frameId is the timeline (record) frame. Decide a stable hook/body/punchline → Resolve-colour map.
4. **Marker colour/name parity across formats.** Keep one canonical hook/body/punchline → (colour,label) table reused by all exporters, or let each format map independently? A shared `MARKER_DEFS`-style constant would prevent drift but must respect each format's colour vocabulary.
5. **Per-reel vs single-timeline for FCPXML.** xmeml emits one `<sequence>` per reel and Lua one timeline; should FCPXML emit one `<project>`/`<sequence>` per reel (parallel to xmeml) — assume yes for consistency unless the format pushes otherwise. **Answered below: yes — one `<project>` (one `<sequence>`) per reel inside a single `<event>`.**

---

## Follow-up Research 2026-06-22 — FCPXML format spec (external)

Sources: Apple **FCPXML DTD / "Document Type Definition"**, Apple **"Creating FCPXML Documents"** + **"Associating Ratings, Keywords, Markers, and Metadata with Media"**, the SpliceKit **FCPXML_FORMAT_REFERENCE.md**, and working samples (bbc/fcpx-xml-composer, fcp.cafe). This answers Open Question #1 and resolves the roadmap's "own marker/timecode model?" question.

### The headline: `.fcpxml` ≠ `.xml` (xmeml) — two different formats, do not conflate

| | **xmeml v4** (our existing `xml.js`, `.xml`) | **FCPXML** (net-new, `.fcpxml`) |
|---|---|---|
| Root | `<xmeml version="4">` + `<!DOCTYPE xmeml>` | `<fcpxml version="1.9">` + `<!DOCTYPE fcpxml>` |
| App target | Premiere Pro / FCP7 / Resolve | Final Cut Pro X (10.4.9+) |
| Time model | **integer frames** (`<in>120</in>`) | **rational seconds** (`start="120120/24000s"`) |
| Media ref | `<file id>` + `<pathurl>` | `<asset>` in `<resources>` + `<media-rep src>` |
| Timeline | `<sequence><media><video><track><clipitem>` | `<event><project><sequence><spine><asset-clip>` |
| Marker el. | `<marker>` w/ **subelements** `<name>/<in>/<out>/<comment>/<color>` (record frames) | `<marker>` **EMPTY**, attributes `start`/`duration`/`value` (no color) |

⇒ **FCPXML is a separate pure exporter (`generateFCPXML`), not a tweak to `xml.js`.** Reusing the xmeml builder is a trap (different DTD, time model, and marker grammar).

### FCPXML document skeleton (target **version 1.9**, FCP 10.4.9+ — widest safe floor)

The `<library>` wrapper is **optional** for interchange — Apple's own "Creating FCPXML Documents" example and the BBC sample start at `<event>`. Keep it minimal:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat1080p25"
            frameDuration="100/2500s" width="1920" height="1080"/>
    <asset id="r2" name="webinar_2024" start="0s" duration="<assetDur>s"
           hasVideo="1" hasAudio="1" format="r1"
           audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="file:///abs/path/webinar_2024.mp4"/>
    </asset>
  </resources>
  <event name="Reels">
    <project name="Reel 1 - ...">           <!-- one project per reel -->
      <sequence duration="<seqDur>s" format="r1"
                tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
        <spine>
          <asset-clip ref="r2" name="#2 ..." offset="0s"
                      start="<srcIn>s" duration="<dur>s" audioRole="dialogue">
            <marker start="<srcFrameOfMarker>s" duration="<1frame>s" value="HOOK"/>
          </asset-clip>
          <asset-clip ref="r2" offset="<cursor>s" start="..." duration="..."/>
        </spine>
      </sequence>
    </project>
  </event>
</fcpxml>
```

### Clip timing semantics (maps cleanly onto our span model)

- `ref` → the single shared `<asset id="r2">` (one asset, every clip references it — same shared-source pattern as xmeml's `<file>`).
- `offset` → **timeline/record position** = our per-sequence cursor (starts `0s`, advances by each span's duration; this is the FCPXML analogue of xmeml's `<start>` and Lua's `recordFrame`).
- `start` → **source in-point** = `span.start_frame`.
- `duration` → `span.duration_frame`.
- One `<asset-clip>` per merged span; one `<project>`/`<sequence>` per reel; all projects inside one `<event>`. (No inter-reel `gapFrames` — reels are separate sequences, exactly like xmeml.)

### Rational-time conversion (the core frame-math task)

All times are `numerator/denominator s`. Convert our integer frames using the format's canonical `frameDuration = num/den`:

> **`framesToRational(F, fps) → "${F*num}/${den}s"`** (numerator stays integer; `0 → "0s"`). A 1-frame marker `duration` = `"${num}/${den}s"`.

Per-fps `frameDuration` (from Apple's predefined-format table):

| fps | frameDuration | tcFormat |
|---|---|---|
| 23.976 | `1001/24000s` | NDF |
| 24 | `100/2400s` | NDF |
| 25 | `100/2500s` | NDF |
| 29.97 | `1001/30000s` | **DF** |
| 30 | `100/3000s` | NDF |
| 50 | `100/5000s` | NDF |
| 59.94 | `1001/60000s` | NDF (or DF) |
| 60 | `100/6000s` | NDF |

This keeps everything integer-numerator and frame-aligned (FCP rounds to `frameDuration` boundaries on import). **Honors the integer-frame invariant** — no seconds rounding; the rational form *is* the exact frame count. `width`/`height` come from parsing `state.videoResolution` ("1920x1080" → 1920, 1080; fallback 1920x1080). Optionally also emit a matching `name="FFVideoFormat1080p25"` when fps+resolution match a known preset, but explicit `frameDuration`/`width`/`height` alone is sufficient and safer.

### Markers in FCPXML — simpler frame math than EDL, but **no color channel**

- `<marker start=".." duration=".." value="HOOK"/>` is **EMPTY with attributes**; child of the `<asset-clip>` (or `<clip>`).
- `start` is in the **clip's local timeline whose origin is the clip's `start`** (source-time). So for a marker pointing at sentence `cid`: attach it to the `asset-clip` whose span contains `cid`, with `start = framesToRational(sentence.start_frame, fps)` (same base as that clip's `start`), clamped to `[clip.start, clip.start+duration]`. **No record-cursor needed** (unlike EDL/xmeml markers). Confirmed by Apple example: `<asset-clip start="5s" duration="5s"><marker start="6s"/>` = 1s into the clip.
- `duration` = one frame (`framesToRational(1, fps)`).
- **FCPXML markers have NO color attribute** (only `value`, `note`, `completed`, `start`, `duration`). The hook/body/punchline distinction must live in the `value` text (e.g. `value="HOOK"` / `"BODY"` / `"PUNCHLINE"`). Contrast EDL's `GREEN/BLUE/RED`. `<chapter-marker>` is a separate element (adds `posterOffset`) — not needed here; plain `<marker>` is the right match for hook/body/punchline.

### Three distinct marker schemes confirmed (no shared helper is correct)

| Format | Marker element | Position base | Color |
|---|---|---|---|
| EDL | `* LOC: <tc> GREEN HOOK` | **record** frame (`3600*fps` + cursor) → SMPTE TC | yes (named) |
| xmeml (`.xml`) | `<marker>` on `<sequence>`, `<in>/<out>` integer frames + `<name>` (+ optional `<color><red/green/blue>`) | **record** frame (per-sequence cursor) | optional |
| FCPXML (`.fcpxml`) | `<marker start duration value>` on `<asset-clip>` | **source** frame (clip-local, base = clip `start`) | none (encode in `value`) |

### Net-new wiring checklist (mirrors the XML row, additive)

`src/exporters/fcpxml.js` (`generateFCPXML(opts)`, pure) → import in `export-popover.js` → `FORMATS.fcpxml = { gen: genFCPXML, ext:'fcpxml', suffix:'_timeline.fcpxml', store:'fcpxmlContent' }` → `genFCPXML()` wrapper (needs `videoPath` for `media-rep src="file://"` — guard+toast like Lua, since a bare filename won't resolve) → `state.fcpxmlContent` → new primary HTML row `exFcpxmlGen`/`exFcpxmlCopy` with a Polish label (e.g. "FCPXML" / subtitle "Final Cut Pro X") → two listeners → regression case after Test 13 (markers present + marker-free output stable).

### Spec gotchas to carry into the plan

1. **Version floor.** Target `1.9` (FCP 10.4.9). Avoid bleeding-edge `1.11+` features (none needed).
2. **`media-rep src` must be an absolute `file://` URL** — relative/ bare names don't resolve across NLEs (note from hyperframes spec: "Premiere and Resolve both resolve `file:///...`; relative paths are not reliable"). ⇒ FCPXML requires `state.videoPath`, like Lua.
3. **`asset` needs `start`/`duration`** spanning at least the used media; set asset `duration` ≥ max source `end_frame`. `hasAudio`/`audioChannels`/`audioRate` can default (`1`/`2`/`48000`) — we don't probe the file, mirror the BBC/Apple samples.
4. **29.97/59.94 → `tcFormat="DF"`**, else `"NDF"` (reuse the existing `_isDropFrame` predicate from `srt.js:7`/`edl.js:4` — and consider de-duplicating it while here).
5. **One asset, many clips** — emit the shared `<asset>`/`<format>` once in `<resources>`; every `asset-clip` uses `ref="r2"`. Parallels (and de-risks the same way as) xmeml's shared `<file>`.
6. **XML-escape** `name`/`value`/`project name` (reuse an `esc()` like `xml.js:23`).
