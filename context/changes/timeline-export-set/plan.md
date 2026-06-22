# S-08 Timeline Export Set (XML / FCPXML / Lua markers) Implementation Plan

## Overview

Bring the full timeline-export set to parity on **hook/body/punchline markers** and add a net-new **FCPXML** exporter (PRD FR-027/028/029, roadmap S-08). Today only EDL emits markers (`* LOC:` locator lines); `generateXML` and `generateLua` already receive `reel.markers` but ignore it, and there is no FCPXML exporter at all. This change emits markers in xmeml `.xml` and Resolve `.lua`, adds a separate pure `generateFCPXML` for Final Cut Pro X, and extends the regression fence with one marker case per format.

## Current State Analysis

- **Exporters are pure `(opts) → string`** — no `state`, DOM, or I/O. The sole `state → opts` adapter is the `gen*()` wrappers in `src/ui/export-popover.js:94-136`. Any new field (markers for XML/Lua, all FCPXML opts) is threaded via `opts`/`reel`, never read inside the exporter. This purity is what keeps the regression suite trivial.
- **EDL is the reference marker implementation** (`src/exporters/edl.js:21-69`): a local `MARKER_DEFS = [['hook','GREEN','HOOK'],['body','BLUE','BODY'],['punchline','RED','PUNCHLINE']]`, a `recordFrameById` map built while walking spans (`recIn + (s.start_frame - span.start_frame)`), and `* LOC:` emission strictly gated on `reel.markers` so marker-free EDLs stay byte-identical to legacy.
- **XML (xmeml v4)** — `src/exporters/xml.js`: one `<sequence>` per reel, per-sequence record cursor starting at 0 (`xml.js:64`), shared `<file id="source_file_1">` reference (fragile — first clipitem emits the full block, later ones the self-closing back-ref). Only metadata channel today is `<comments><mastercomment1>`. **No markers.**
- **Lua (Resolve)** — `src/exporters/lua.js`: builds a `segs` table, then a single batched `mediaPool:AppendToTimeline(allClips)` with a running `cursor` (starts 0, `+= gapFrames` between reels). `mergeAdjacentClips` is called **three times** in this file — keep consistent. **No markers.**
- **Marker validity is pre-guaranteed.** `src/ai/validate.js:84-105` ensures each `reel.markers[*]` is an integer clip_id present in that reel's `clip_ids`. By export time a marker resolves to a sentence in one of the reel's spans — but still guard `recordFrame == null` like EDL does (a marker whose clip merged into a span is fine; one not found is skipped).
- **Integer-frame invariant holds end-to-end.** `Math.round(seconds * fps)` happens only at parse time (`src/parser/srt.js`); exporters consume integer frames and must never re-round to seconds. FCPXML's rational-time form (`F*num/den s`) *is* the exact frame count — no seconds round-trip.
- **`_isDropFrame` is duplicated** at `src/parser/srt.js:7` and `src/exporters/edl.js:4`. FCPXML needs the same predicate for `tcFormat="DF"/"NDF"`.
- **Regression harness** — `test/regression.js`: bespoke `assert`/`assertEq` tally, **currently 206 passed / 0 failed**. Test 13 (`:1014-1092`) is the EDL-marker reference: marked reel `{clip_ids:[2,3], markers:{hook:2,body:2,punchline:3}}` + an unmarked reel, asserts exactly 3 `* LOC:` lines and zero LOC for the unmarked reel. Test 4 (XML byte-identical) and Test 5 (Lua functional) are the baselines that marker-free output must not perturb.

## Desired End State

After this plan:

- `generateXML` emits sequence-level `<marker>` elements (record-frame `<in>/<out>` + `<name>` + `<color>`) for every reel that carries `reel.markers`; marker-free reels produce output **byte-identical to the current Test 4 baseline**.
- `generateLua` emits `timeline:AddMarker(...)` calls (Green/Blue/Red) for marked reels after the batched append; marker-free runs stay functionally identical to the Test 5 baseline.
- A new `src/exporters/fcpxml.js` produces a valid FCPXML 1.9 document (rational time, shared `<asset>`, one `<project>`/`<sequence>` per reel, clip-local `<marker value>`), wired into the export popover as a fourth primary format with its own HTML row, `state.fcpxmlContent`, and Polish label.
- The hook/body/punchline **labels** come from one shared canonical constant imported by every exporter; colors stay format-local (each format's color vocabulary differs; FCPXML has no color channel).
- The regression suite gains one marker case per format and still passes (target: 206 + new cases, 0 failed).

Verify: `node --experimental-vm-modules test/regression.js` passes; manual import of each exported file into its target NLE shows three correctly-placed markers for a marked reel.

### Key Discoveries:

- `reel.markers` already reaches XML/Lua via `reelsData` — plumbing cost is near-zero; the real work is **per-format record-frame math** and **per-format marker syntax** (`src/exporters/edl.js:38-48` is the only existing clip_id→frame map).
- Three distinct marker schemes are **correct**, not a gap: EDL/xmeml use a record frame; FCPXML uses a clip-local source frame with **no color** (color encoded in `value` text). See research §"Three distinct marker schemes confirmed".
- FCPXML ≠ xmeml: different DTD, rational-seconds time model, `<asset-clip>` spine, EMPTY `<marker>` with attributes. Reusing `xml.js` is a trap (research §"The headline").
- `state.videoResolution` ("1920x1080") splits to width/height; FCPXML `media-rep src` **must be an absolute `file://` URL**, so FCPXML requires `state.videoPath` (guard+toast like Lua).

## What We're NOT Doing

- No S-09 NLE plugin work, no UI beyond the additive FCPXML export row.
- Not adding marker **text notes** (clip text as `<comment>`/note) — markers carry the label only, matching EDL's current behavior. (Deferred; would need EDL parity follow-up.)
- Not emitting `virality_score` / `scores` / `reason` into any export — only the three `markers` clip-id pointers reach output, as today.
- Not changing EDL marker behavior (already shipped in S-01 / Test 13).
- Not adding inter-reel `gapFrames` to FCPXML (reels are separate sequences, exactly like xmeml).
- Not targeting FCPXML 1.10/1.11 features — floor at 1.9 (FCP 10.4.9).
- Not introducing a test framework — extend `test/regression.js` in place.

## Implementation Approach

Three phases, in dependency order. Phase 1 is low-plumbing marker emission into two existing exporters plus the shared label constant they (and FCPXML) will import. Phase 2 is the genuinely net-new FCPXML exporter and its additive UI/state wiring. Phase 3 extends the regression fence so all four formats are guarded, including the byte-identical marker-free guards that protect the legacy Test 4/5 baselines. Each exporter stays a pure function; all `state` access remains in the `gen*()` wrappers.

## Critical Implementation Details

- **Per-format record-frame math is non-shareable and must be re-derived in each exporter.** xmeml markers use the per-sequence record cursor (starts 0) — mirror EDL's `recordFrameById` walk but without the `3600*fps` offset. Lua markers use the running `cursor` at the moment each span is appended. FCPXML markers use a **clip-local source frame** (base = the `asset-clip`'s `start`), no record cursor. Getting the base wrong silently misplaces markers; the regression frame-range asserts (like Test 13's `recStart`/`recEnd` bounds) are the guard.
- **Marker emission must stay strictly gated on `reel.markers`.** A reel without markers must produce byte-identical (XML) / functionally identical (Lua) output to the pre-change baseline — this is the regression contract, not a nicety.
- **FCPXML rational time keeps integer numerators.** `framesToRational(F, fps) → "${F*num}/${den}s"` with `0 → "0s"`; never divide to a decimal. A 1-frame marker `duration` = `"${num}/${den}s"`.

## Phase 1: Shared marker labels + XML/Lua markers

### Overview

Introduce one shared canonical hook/body/punchline label constant, then emit markers in `generateXML` (sequence-level `<marker>`, record frame) and `generateLua` (`timeline:AddMarker`, Green/Blue/Red), both gated on `reel.markers`.

### Changes Required:

#### 1. Shared marker label constant

**File**: `src/exporters/markers.js` (new)

**Intent**: Single source of truth for the canonical marker **label** per key, so a future label rename touches one place instead of four. Colors stay format-local (each exporter maps to its own color vocabulary; FCPXML has none).

**Contract**: Export an ordered list of `{ key, label }` for `hook`/`body`/`punchline` (labels `HOOK`/`BODY`/`PUNCHLINE`), matching the order and labels already hard-coded in `src/exporters/edl.js:22-26`. Provide it in a shape each exporter can zip with its own color (e.g. `MARKER_LABELS = [['hook','HOOK'],['body','BODY'],['punchline','PUNCHLINE']]`). Optionally refactor `edl.js` to import the labels (keeping its local `GREEN/BLUE/RED` colors) so the canonical claim is real — only if it leaves EDL output byte-identical (Test 3/13 must still pass).

#### 2. xmeml markers (sequence-level)

**File**: `src/exporters/xml.js`

**Intent**: Emit one `<marker>` per present `reel.markers` key as a child of the reel's `<sequence>`, positioned at the marker clip's record frame. Gated on `reel.markers`; absent → no change to output.

**Contract**: While walking `spans` (the existing `cursor` loop at `xml.js:64-109`), build a `recordFrameById` map exactly like `edl.js:44-47` but with the per-sequence cursor (no `3600*fps` offset): `recordFrameById.set(id, cursor_at_span_start + (s.start_frame - span.start_frame))`. After the track/media close for that sequence, if `reel.markers`, emit for each `[key,label]` in the shared constant whose `cid = reel.markers[key]` is non-null and whose `recFrame = recordFrameById.get(cid)` is non-null: a `<marker>` with `<name>` (label), `<in>`/`<out>` = `recFrame`/`recFrame+1` (integer frames), and a `<color>` mapping hook/body/punchline → Green/Blue/Red. Place `<marker>` children where xmeml accepts them on `<sequence>` (sibling of `<media>`). Reuse the existing `esc()` for the label. Marker-free path must remain byte-identical to Test 4.

#### 3. Lua markers (`timeline:AddMarker`)

**File**: `src/exporters/lua.js`

**Intent**: Emit `timeline:AddMarker(...)` calls for marked reels after the batched `AppendToTimeline`, using the record frame at which each marked clip was appended. Gated on `reel.markers`.

**Contract**: Capture the record frame per clip_id while building `allClips` in the existing `reelsData.forEach` loop (`lua.js:104-130`) — when a span is appended, its record frame is the current `cursor`; map each `id` in `span.ids` to `cursor + (sentence.start_frame - span.start_frame)`. After the append-success branch (`lua.js:133`), for each marked reel emit `timeline:AddMarker(<recFrame>, "<Color>", "<LABEL>", "", 1, "")` with Color ∈ Green/Blue/Red for hook/body/punchline and LABEL from the shared constant. Skip null clip_id / null record frame. Use Lua's existing string-escape style (`.replace(/"/g, "'")`). Keep all three `mergeAdjacentClips` calls consistent. Marker-free output stays functionally identical to Test 5.

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Rust type-check unaffected (no backend change): `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Prettier clean on touched files: `npx prettier --check "src/exporters/*.js"`

#### Manual Verification:

- Import a marked-reel `.xml` into Premiere/Resolve: three markers (Green HOOK / Blue BODY / Red PUNCHLINE) appear at the expected timeline positions on the reel's sequence.
- Run a marked-reel `.lua` in Resolve Console: three timeline markers appear in the correct colors at the expected frames; marker-free reel adds none.
- Marker-free export of both formats is visually unchanged from before.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation that the NLE imports show correctly-placed markers before proceeding.

---

## Phase 2: Net-new FCPXML exporter + wiring

### Overview

Add a separate pure `generateFCPXML` (FCPXML 1.9, rational time, shared asset, one project/sequence per reel, clip-local `<marker>`), then wire it into the export popover additively, mirroring the XML row.

### Changes Required:

#### 1. FCPXML exporter

**File**: `src/exporters/fcpxml.js` (new)

**Intent**: Emit a valid FCPXML 1.9 document for Final Cut Pro X with hook/body/punchline markers, parallel in structure to xmeml (one timeline per reel) but using FCPXML's rational-time/`<asset-clip>` grammar.

**Contract**: `generateFCPXML({ reelsData, sentences, fps, videoFilename, videoPath, videoResolution, projectName, mergeThreshold }) → string` (pure). Structure: `<?xml?>` + `<!DOCTYPE fcpxml>` + `<fcpxml version="1.9">`; a `<resources>` block with one `<format id="r1" frameDuration="num/den s" width height/>` and one shared `<asset id="r2" … duration="${maxEndFrame}-rational">` whose `<media-rep kind="original-media" src="file:///abs…"/>` is an absolute `file://` URL from `videoPath`; one `<event name=projectName>` containing one `<project>` per reel, each with a `<sequence format="r1" tcStart="0s" tcFormat=DF|NDF …>` and a `<spine>` of `<asset-clip ref="r2" offset=<recordCursor> start=<span.start_frame> duration=<span.duration_frame>>`. Markers: for each present `reel.markers` key, attach an EMPTY `<marker start=<source-frame> duration=<1 frame> value="LABEL"/>` to the `asset-clip` **whose span contains that clip_id**, with `start = framesToRational(sentence.start_frame, fps)` clamped to `[clip.start, clip.start+duration]` — **no record cursor, no color** (label in `value`). Helpers: a local `framesToRational(F, fps)` using the per-fps `frameDuration` table from research (`23.976→1001/24000`, `24→100/2400`, `25→100/2500`, `29.97→1001/30000`, `30→100/3000`, `50→100/5000`, `59.94→1001/60000`, `60→100/6000`); `tcFormat="DF"` only for 29.97/59.94 (reuse a shared `_isDropFrame` — de-dup `srt.js:7`/`edl.js:4` into one exported helper while here). XML-escape `name`/`value`/`project name` (reuse an `esc()` like `xml.js:23`). Labels from the shared marker constant (Phase 1). Width/height from `videoResolution.split('x')`, fallback 1920x1080.

```
framesToRational(F, fps): const [num, den] = FRAME_DURATION[fps]; return F === 0 ? '0s' : `${F * num}/${den}s`;
```

#### 2. Export wiring

**File**: `src/ui/export-popover.js`

**Intent**: Add FCPXML as a fourth primary format, mirroring the XML/Lua wiring; guard on `videoPath` like Lua (FCPXML needs an absolute `file://`).

**Contract**: Import `generateFCPXML`; add a `genFCPXML()` wrapper that toasts+returns null when `state.videoPath` is absent (mirror `genLua` at `:119-126`) and otherwise threads the same state fields as `genXML` plus `videoPath`; add `FORMATS.fcpxml = { gen: genFCPXML, ext: 'fcpxml', suffix: '_timeline.fcpxml', store: 'fcpxmlContent' }`; add two `init()` listeners `exFcpxmlGen`→`saveFormat('fcpxml')` and `exFcpxmlCopy`→`copyFormat('fcpxml')`.

#### 3. State field

**File**: `src/state.js`

**Intent**: Add the cache slot for generated FCPXML content, parallel to `xmlContent`/`luaContent`.

**Contract**: Add `fcpxmlContent` (init `''`) next to the existing `xmlContent`/`luaContent` fields.

#### 4. Export HTML row

**File**: `src/index.html`

**Intent**: Add a fourth primary `export-format-row` for FCPXML between the XML and Lua rows, mirroring the XML row markup.

**Contract**: New `.export-format-row` with Polish label "FCPXML" + `.fps-note` subtitle "Final Cut Pro X"; buttons `id="exFcpxmlGen"` ("⬇ Generuj i zapisz") and `id="exFcpxmlCopy"` ("Kopiuj"), matching `src/index.html:1004-1015`.

### Success Criteria:

#### Automated Verification:

- Regression suite passes (incl. new FCPXML cases from Phase 3): `node --experimental-vm-modules test/regression.js`
- Prettier clean: `npx prettier --check "src/**/*.{js,html}"`
- No stray `state` import inside `src/exporters/fcpxml.js` (purity): `grep -L "from '../state" src/exporters/fcpxml.js` returns the file

#### Manual Verification:

- Generate `.fcpxml` for a project with `videoPath` set; import into Final Cut Pro X 10.4.9+: one project/timeline per reel, clips at correct positions, three markers per marked reel labeled HOOK/BODY/PUNCHLINE.
- Without `videoPath`: the FCPXML button surfaces the missing-path toast and writes nothing.
- The new row appears between XML and Lua and both buttons work (save dialog prompts for location; copy puts content on clipboard).

**Implementation Note**: Pause for manual FCP import confirmation before considering the phase complete.

---

## Phase 3: Regression cases per format

### Overview

Extend `test/regression.js` after Test 13 with one marker case per new format, each asserting (a) markers present for a marked reel and (b) marker-free output unchanged from the existing baseline.

### Changes Required:

#### 1. XML marker regression case

**File**: `test/regression.js`

**Intent**: Prove xmeml markers emit for a marked reel and that a marker-free run stays byte-identical to the Test 4 baseline.

**Contract**: New test after Test 13 reusing the Test 13 `markerReels` shape (`{clip_ids:[2,3], markers:{hook:2,body:2,punchline:3}}` + an unmarked reel). Assert exactly three `<marker>` elements with `<name>HOOK</name>`/`BODY`/`PUNCHLINE` and Green/Blue/Red `<color>` for the marked reel and zero `<marker>` for the unmarked reel; assert each marker's `<in>` falls within the marked reel's per-sequence record-frame range (mirror Test 13's `recStart`/`recEnd` bound check, but cursor-from-0). Add a marker-free `generateXML` call and assert it `assertEq`s the existing Test 4 expected baseline (byte-identical guard).

#### 2. Lua marker regression case

**File**: `test/regression.js`

**Intent**: Prove Lua emits `timeline:AddMarker` for a marked reel and none for a marker-free run.

**Contract**: Assert three `AddMarker(` lines for the marked reel with `"Green"`/`"Blue"`/`"Red"` and `"HOOK"`/`"BODY"`/`"PUNCHLINE"`; assert the record-frame argument matches the expected cursor position; assert a marker-free run emits zero `AddMarker(` lines (functional baseline guard, parallel to Test 13's marker-free EDL assert).

#### 3. FCPXML marker regression case

**File**: `test/regression.js`

**Intent**: Prove FCPXML structure + clip-local markers for a marked reel and a clean marker-free document.

**Contract**: Add a fixture import of `generateFCPXML`. Assert the document contains `<fcpxml version="1.9">`, one `<format>` and one `<asset>` in `<resources>`, one `<project>` per reel, and rational-time attributes (`start=".../...s"`). For the marked reel assert exactly three EMPTY `<marker … value="HOOK"/>`/`BODY`/`PUNCHLINE` attached within the spine and that each `start` is rational and within its clip's `[start, start+duration]`; assert the unmarked reel's projects carry zero `<marker`. Assert a `videoPath`-less call is not exercised here (wrapper guards that, not the pure fn — the pure fn always needs `videoPath` in opts).

### Success Criteria:

#### Automated Verification:

- Full suite passes with new cases: `node --experimental-vm-modules test/regression.js` (expect 206 baseline + new asserts, 0 failed)
- Suite exits 0 (the harness `process.exit(1)` on any fail stays green)

#### Manual Verification:

- Skim the new test output lines to confirm each new case ran (not silently skipped) and the marker assertions reference real frame values.

**Implementation Note**: This is the automated fence — once green, the change is regression-guarded. Final manual NLE import confirmations come from Phases 1–2.

---

## Testing Strategy

### Unit Tests (regression suite):

- XML markers: 3 `<marker>` for marked reel, 0 for unmarked, record-frame range, marker-free byte-identical to Test 4.
- Lua markers: 3 `AddMarker` for marked reel, 0 for unmarked, correct color/label/frame.
- FCPXML: valid 1.9 skeleton, shared asset, per-reel project, rational time, 3 clip-local `<marker value>` for marked reel, 0 for unmarked.

### Key edge cases:

- A marker clip_id whose clip merged into a multi-clip span (still resolves — guard `recordFrame == null` and skip if not found).
- A reel with `markers` present but a key null/absent (emit only the present keys).
- Marker-free reel mixed with a marked reel in the same run (only the marked one emits).

### Manual Testing Steps:

1. Build a project with two reels, one carrying markers; export each format.
2. Import `.xml` into Premiere and Resolve; confirm 3 markers on the marked sequence.
3. Run `.lua` in Resolve Console; confirm 3 colored timeline markers.
4. Import `.fcpxml` into Final Cut Pro X; confirm per-reel timelines + 3 labeled markers.
5. Export with no `videoPath`; confirm FCPXML toasts and writes nothing.

## Performance Considerations

None material — exporters are in-memory string builders over a small `reelsData`/`sentences` set; marker emission adds at most 3 elements per reel.

## Migration Notes

`state.fcpxmlContent` is a new additive field; older `.reelproj` files load tolerantly (unknown/absent keys are ignored per the schema-v5 tolerance described in CLAUDE.md). No schema version bump required — `fcpxmlContent` is a generated cache, not persisted project data.

## References

- Internal + external research: `context/changes/timeline-export-set/research.md`
- EDL marker reference (the pattern to mirror): `src/exporters/edl.js:21-69`
- Test 13 (EDL marker regression reference): `test/regression.js:1014-1092`
- FCPXML spec follow-up: research.md §"Follow-up Research 2026-06-22 — FCPXML format spec"

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Shared marker labels + XML/Lua markers

#### Automated

- [x] 1.1 Regression suite passes: `node --experimental-vm-modules test/regression.js` — 0125d09
- [x] 1.2 Rust type-check unaffected: `cargo check` — 0125d09
- [x] 1.3 Prettier clean on touched exporter files — 0125d09

#### Manual

- [ ] 1.4 `.xml` import into Premiere/Resolve shows 3 correctly-placed/colored markers on marked sequence
- [ ] 1.5 `.lua` run in Resolve shows 3 colored timeline markers; marker-free reel adds none
- [ ] 1.6 Marker-free export of both formats visually unchanged

### Phase 2: Net-new FCPXML exporter + wiring

#### Automated

- [x] 2.1 Regression suite passes (incl. FCPXML cases) — 4151921
- [x] 2.2 Prettier clean on `src/**/*.{js,html}` — 4151921
- [x] 2.3 No `state` import inside `src/exporters/fcpxml.js` (purity check) — 4151921

#### Manual

- [ ] 2.4 `.fcpxml` imports into FCP X with per-reel timelines + 3 labeled markers per marked reel
- [ ] 2.5 Missing `videoPath` surfaces toast and writes nothing
- [ ] 2.6 New FCPXML row appears between XML and Lua; save + copy both work

### Phase 3: Regression cases per format

#### Automated

- [x] 3.1 Full suite passes with new cases (206 baseline + new asserts, 0 failed) — 7f47f22
- [x] 3.2 Suite exits 0 — 7f47f22

#### Manual

- [ ] 3.3 New test output lines confirm each case ran with real frame values
