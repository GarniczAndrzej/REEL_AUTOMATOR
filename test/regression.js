/**
 * Phase 1 regression test suite.
 *
 * Tests:
 *  1. parseSRT — output matches legacy logic exactly
 *  2. mergeAdjacentClips — threshold 0 = no merge, threshold 12 = merges adjacent
 *  3. generateEDL (threshold=0) — byte-identical to legacy EDL function
 *  4. generateXML (threshold=0) — byte-identical to legacy XML function
 *  5. generateLua (threshold=0) — functionally equivalent (key format changed intentionally per spec)
 */

import { readFileSync } from 'node:fs';
import { parseSRT, framesToTC, parseTime } from '../src/parser/srt.js';
import { mergeAdjacentClips } from '../src/parser/segments.js';
import { generateEDL } from '../src/exporters/edl.js';
import { generateXML } from '../src/exporters/xml.js';
import { generateLua } from '../src/exporters/lua.js';

const SRT_PATH = new URL('./sample.srt', import.meta.url).pathname;
const srtText = readFileSync(SRT_PATH, 'utf-8');

let passed = 0;
let failed = 0;

function assert(cond, label, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    if (detail) console.error(`    ${detail}`);
    failed++;
  }
}

function assertEq(a, b, label) {
  if (a === b) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    const aLines = String(a).split('\n');
    const bLines = String(b).split('\n');
    for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
      if (aLines[i] !== bLines[i]) {
        console.error(`    First diff at line ${i + 1}:`);
        console.error(`    NEW: ${JSON.stringify(aLines[i])}`);
        console.error(`    LEG: ${JSON.stringify(bLines[i])}`);
        break;
      }
    }
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────
// Legacy implementations (ported verbatim from legacy HTML, no DOM)
// ─────────────────────────────────────────────────────────────────

function legacyParseTime(str) {
  const [h, m, s] = str.replace(',', '.').split(':');
  return +h * 3600 + +m * 60 + parseFloat(s);
}

function legacyFramesToTC(frames, fps) {
  frames = Math.max(0, Math.floor(frames));
  const h = Math.floor(frames / (3600 * fps));
  const m = Math.floor((frames % (3600 * fps)) / (60 * fps));
  const s = Math.floor((frames % (60 * fps)) / fps);
  const f = Math.floor(frames % fps);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

function legacyParseSRT(content, fps, minChars) {
  const pattern = /(\d+)\n(\d{2}:\d{2}:\d{2}[,\.]\d{3}) --> (\d{2}:\d{2}:\d{2}[,\.]\d{3})\n([\s\S]*?)(?=\n\n|\n*$)/gm;
  const matches = [...content.matchAll(pattern)];
  const sentences = [];
  let current = [];
  let startTime = null;
  let sentenceId = 1;
  matches.forEach((m, i) => {
    const start = m[2], end = m[3];
    const text = m[4].replace(/\n/g, ' ').trim().replace(/<[^>]+>/g, '');
    if (!text) return;
    if (startTime === null) startTime = legacyParseTime(start);
    current.push(text);
    const endsWithPunct = /[.?!]$/.test(text.trim());
    const isLast = i === matches.length - 1;
    if (endsWithPunct || isLast) {
      const full = current.join(' ').trim();
      if (full.length >= minChars) {
        const endTime = legacyParseTime(end);
        const sf = Math.round(startTime * fps);
        const ef = Math.round(endTime * fps);
        sentences.push({ id: sentenceId++, text: full, start_frame: sf, end_frame: ef, duration_frame: ef - sf, start_tc: legacyFramesToTC(sf, fps), end_tc: legacyFramesToTC(ef, fps) });
      }
      current = [];
      startTime = null;
    }
  });
  return sentences;
}

function legacyGenerateEDL(reelsData, sentences, fps, gapFrames, videoFile) {
  const lines = ['TITLE: REELS_EDL_AUTOMATOR', 'FCM: NON-DROP FRAME', ''];
  let cursor = 3600 * fps;
  let eventNum = 1;
  reelsData.forEach(reel => {
    lines.push(`* ============================================`);
    lines.push(`* REEL: ${reel.reel_name}`);
    lines.push(`* ============================================`);
    reel.clip_ids.forEach(id => {
      const s = sentences.find(x => x.id === id);
      if (!s) return;
      const srcIn = legacyFramesToTC(s.start_frame, fps);
      const srcOut = legacyFramesToTC(s.end_frame, fps);
      const recIn = legacyFramesToTC(cursor, fps);
      const recOut = legacyFramesToTC(cursor + s.duration_frame, fps);
      lines.push(`${String(eventNum).padStart(3, '0')}  AX       V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
      lines.push(`* FROM CLIP NAME: ${videoFile}`);
      lines.push(`* SEGMENT ID: ${s.id}`);
      lines.push(`* TEXT: ${s.text.substring(0, 100)}`);
      lines.push('');
      cursor += s.duration_frame;
      eventNum++;
    });
    cursor += gapFrames;
  });
  return lines.join('\n');
}

function legacyGenerateXML(reelsData, sentences, fps, videoFile, videoPath, videoResolution, projectName, gapFrames) {
  const [vw, vh] = videoResolution.split('x');
  const pathUrl = videoPath.startsWith('/')
    ? 'file://localhost' + videoPath.replace(/ /g, '%20')
    : 'file://localhost/' + videoPath.replace(/\\/g, '/').replace(/ /g, '%20');
  const totalFrames = sentences.length ? Math.max(...sentences.map(s => s.end_frame)) + fps * 10 : 90000;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE xmeml>');
  lines.push('<xmeml version="4">');
  const fileId = 'source_file_1';
  reelsData.forEach((reel, ri) => {
    const clips = reel.clip_ids.map(id => sentences.find(s => s.id === id)).filter(Boolean);
    const reelDur = clips.reduce((a, s) => a + s.duration_frame, 0);
    const reelName = esc(reel.reel_name);
    const ntsc = (fps === 24 || fps === 30 || fps === 60) ? 'TRUE' : 'FALSE';
    lines.push(`  <sequence id="seq_${ri + 1}">`);
    lines.push(`    <name>${reelName}</name>`);
    lines.push(`    <duration>${reelDur}</duration>`);
    lines.push(`    <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`);
    lines.push(`    <timecode><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`);
    lines.push(`    <media>`);
    lines.push(`      <video>`);
    lines.push(`        <format><samplecharacteristics><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><width>${vw}</width><height>${vh}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`);
    lines.push(`        <track>`);
    let cursor = 0;
    clips.forEach((seg, ci) => {
      const clipId = `clip_r${ri + 1}_c${ci + 1}`;
      const clipName = esc(`#${seg.id} ${seg.text.substring(0, 55)}`);
      lines.push(`          <clipitem id="${clipId}">`);
      lines.push(`            <masterclipid>${clipId}_master</masterclipid>`);
      lines.push(`            <name>${clipName}</name>`);
      lines.push(`            <duration>${seg.duration_frame}</duration>`);
      lines.push(`            <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`);
      lines.push(`            <start>${cursor}</start>`);
      lines.push(`            <end>${cursor + seg.duration_frame}</end>`);
      lines.push(`            <in>${seg.start_frame}</in>`);
      lines.push(`            <out>${seg.end_frame}</out>`);
      if (ci === 0 && ri === 0) {
        lines.push(`            <file id="${fileId}">`);
        lines.push(`              <name>${esc(videoFile)}</name>`);
        lines.push(`              <pathurl>${pathUrl}</pathurl>`);
        lines.push(`              <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`);
        lines.push(`              <duration>${totalFrames}</duration>`);
        lines.push(`              <media>`);
        lines.push(`                <video><samplecharacteristics><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><width>${vw}</width><height>${vh}</height></samplecharacteristics></video>`);
        lines.push(`                <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`);
        lines.push(`              </media>`);
        lines.push(`            </file>`);
      } else {
        lines.push(`            <file id="${fileId}"/>`);
      }
      lines.push(`            <comments><mastercomment1>${esc(seg.text.substring(0, 120))}</mastercomment1></comments>`);
      lines.push(`          </clipitem>`);
      cursor += seg.duration_frame;
    });
    lines.push(`        </track>`);
    lines.push(`      </video>`);
    lines.push(`      <audio>`);
    lines.push(`        <track><enabled>TRUE</enabled><locked>FALSE</locked></track>`);
    lines.push(`      </audio>`);
    lines.push(`    </media>`);
    lines.push(`  </sequence>`);
  });
  lines.push('</xmeml>');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────────────────────────

const FPS = 25;
const MIN_CHARS = 20;
const GAP_FRAMES = 60;
const VIDEO_FILE = 'webinar_2024.mp4';
const VIDEO_PATH = '/Users/jan/Videos/webinar_2024.mp4';
const RESOLUTION = '1920x1080';
const PROJECT_NAME = 'Reels';
const MERGE_0 = 0;
const MERGE_12 = 12;

// Parse the SRT
const newSentences = parseSRT(srtText, FPS, MIN_CHARS);
const legSentences = legacyParseSRT(srtText, FPS, MIN_CHARS);

// Test reels — uses clip IDs 2, 3, 4, 5 for reel 1; 7, 8, 9 for reel 2
// Clips 9 and 10 are source-adjacent (gap of 50ms = ~1 frame at 25fps) for merge test
const reelsData = [
  { reel_name: 'Reel 1 - Hook sprzedażowy', clip_ids: [2, 3] },
  { reel_name: 'Reel 2 - Testimonial', clip_ids: [7, 8] },
];

// ─────────────────────────────────────────────────────────────────
// Test 1: parseSRT regression
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 1: parseSRT ──────────────────────────────────────');

assert(newSentences.length === legSentences.length,
  `sentence count matches (${newSentences.length})`);

newSentences.forEach((s, i) => {
  const l = legSentences[i];
  if (!l) return;
  assert(s.id === l.id, `sentence[${i}].id`);
  assert(s.text === l.text, `sentence[${i}].text`);
  assert(s.start_frame === l.start_frame, `sentence[${i}].start_frame (${s.start_frame})`);
  assert(s.end_frame === l.end_frame, `sentence[${i}].end_frame (${s.end_frame})`);
  assert(s.duration_frame === l.duration_frame, `sentence[${i}].duration_frame`);
  assert(s.start_tc === l.start_tc, `sentence[${i}].start_tc (${s.start_tc})`);
  assert(s.end_tc === l.end_tc, `sentence[${i}].end_tc (${s.end_tc})`);
});

// ─────────────────────────────────────────────────────────────────
// Test 2: mergeAdjacentClips
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 2: mergeAdjacentClips ───────────────────────────');

// threshold=0: each clip_id → its own span
const spans0 = mergeAdjacentClips([2, 3], newSentences, 0);
assert(spans0.length === 2, 'threshold=0 produces 2 separate spans for 2 clips');
assert(spans0[0].ids.length === 1, 'span[0] has single id');
assert(spans0[0].ids[0] === 2, 'span[0].ids[0] === 2');
assert(spans0[1].ids[0] === 3, 'span[1].ids[0] === 3');

// clips 9 and 10 in sample SRT:
//   clip 9: 00:00:28,000 --> 00:00:31,300  sf=700 ef=782
//   clip 10: 00:00:31,350 --> 00:00:34,000  sf=783 ef=850
//   gap = 783 - 782 = 1 frame ≤ 12 → should merge
const s9 = newSentences.find(s => s.id === 9);
const s10 = newSentences.find(s => s.id === 10);
if (s9 && s10) {
  const gap = s10.start_frame - s9.end_frame;
  console.log(`  clip 9 end_frame=${s9.end_frame}, clip 10 start_frame=${s10.start_frame}, gap=${gap} frames`);
  const spansAdj = mergeAdjacentClips([9, 10], newSentences, 12);
  assert(spansAdj.length === 1, `clips 9+10 merge into 1 span (gap=${gap} ≤ 12)`);
  if (spansAdj.length === 1) {
    assert(spansAdj[0].ids.join(',') === '9,10', 'merged span.ids === [9,10]');
    assert(spansAdj[0].start_frame === s9.start_frame, 'merged span.start_frame = clip9.start_frame');
    assert(spansAdj[0].end_frame === s10.end_frame, 'merged span.end_frame = clip10.end_frame');
  }
} else {
  console.error('  SKIP: clips 9/10 not found in parsed sentences');
}

// Order preserved — non-consecutive clip IDs
const spansReverse = mergeAdjacentClips([5, 2], newSentences, 12);
assert(spansReverse.length === 2, 'non-adjacent clips not merged even with high threshold');
assert(spansReverse[0].ids[0] === 5, 'order preserved: first span is clip 5');
assert(spansReverse[1].ids[0] === 2, 'order preserved: second span is clip 2');

// ─────────────────────────────────────────────────────────────────
// Test 3: generateEDL regression (threshold=0 → byte-identical to legacy)
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 3: EDL regression (threshold=0) ─────────────────');

const newEDL = generateEDL({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_0,
});

const legEDL = legacyGenerateEDL(reelsData, legSentences, FPS, GAP_FRAMES, VIDEO_FILE);

assertEq(newEDL, legEDL, 'EDL output is byte-identical to legacy');

// Spot-check: segment ID lines
const edlLines = newEDL.split('\n');
const segIdLines = edlLines.filter(l => l.startsWith('* SEGMENT ID:'));
assert(segIdLines.length === reelsData.reduce((a, r) => a + r.clip_ids.length, 0),
  `EDL has correct number of SEGMENT ID lines (${segIdLines.length})`);
assert(segIdLines.every(l => /^\* SEGMENT ID: \d+$/.test(l)),
  'all SEGMENT ID lines have single integer (no comma, threshold=0)');

// ─────────────────────────────────────────────────────────────────
// Test 4: generateXML regression (threshold=0 → byte-identical to legacy)
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 4: XML regression (threshold=0) ─────────────────');

const newXML = generateXML({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  videoFilename: VIDEO_FILE,
  videoPath: VIDEO_PATH,
  videoResolution: RESOLUTION,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});

const legXML = legacyGenerateXML(reelsData, legSentences, FPS, VIDEO_FILE, VIDEO_PATH, RESOLUTION, PROJECT_NAME, GAP_FRAMES);

assertEq(newXML, legXML, 'XML output is byte-identical to legacy');

// Spot-check structure
assert(newXML.startsWith('<?xml version="1.0"'), 'XML starts with declaration');
assert(newXML.includes('<xmeml version="4">'), 'XML has xmeml v4 wrapper');
assert(newXML.includes('<!DOCTYPE xmeml>'), 'XML has DOCTYPE');
assert(newXML.includes('file://localhost' + VIDEO_PATH), 'XML has correct file URL');
const seqMatches = [...newXML.matchAll(/<sequence id="seq_\d+"/g)];
assert(seqMatches.length === reelsData.length, `XML has ${reelsData.length} sequences`);

// ─────────────────────────────────────────────────────────────────
// Test 5: generateLua functional check (threshold=0)
// Lua key format changed intentionally per spec (rNsM vs integer IDs)
// so we verify structure and values, not byte-identity
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 5: Lua functional check (threshold=0) ───────────');

const newLua = generateLua({
  reelsData,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoPath: VIDEO_PATH,
  projectName: PROJECT_NAME,
  mergeThreshold: MERGE_0,
});

assert(newLua.startsWith('-- =='), 'Lua starts with header comment');
assert(newLua.includes(`local VIDEO_PATH = "${VIDEO_PATH}"`), 'Lua has VIDEO_PATH');
assert(newLua.includes(`local FPS = ${FPS}`), 'Lua has FPS');
assert(newLua.includes('local segs = {'), 'Lua has segs table');
assert(newLua.includes('mediaPool:AppendToTimeline(allClips)'), 'Lua has batch append call');
assert(newLua.includes(`CreateEmptyTimeline("${PROJECT_NAME}")`), 'Lua creates timeline with project name');
assert(newLua.includes(`przerwa ${GAP_FRAMES} klatek`), 'Lua has gap comment');

// Each clip in reelsData must appear as a span key in segs
const expectedSpanKeys = ['r1s1', 'r1s2', 'r2s1', 'r2s2'];
expectedSpanKeys.forEach(key => {
  assert(newLua.includes(`"${key}"`), `Lua segs has key "${key}"`);
});

// Frame values should match parsed sentences
const s2 = newSentences.find(s => s.id === 2);
const s3 = newSentences.find(s => s.id === 3);
if (s2 && s3) {
  assert(newLua.includes(`sf=${s2.start_frame}`), `Lua r1s1 has correct start_frame (${s2.start_frame})`);
  assert(newLua.includes(`ef=${s3.end_frame}`), `Lua r1s2 has correct end_frame (${s3.end_frame})`);
}

// ─────────────────────────────────────────────────────────────────
// Test 6: EDL with merge — confirm merged events
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 6: EDL merge-mode sanity check (threshold=12) ───');

const mergedReels = [{ reel_name: 'Reel Merge Test', clip_ids: [9, 10] }];
const mergedEDL = generateEDL({
  reelsData: mergedReels,
  sentences: newSentences,
  fps: FPS,
  gapFrames: GAP_FRAMES,
  videoFilename: VIDEO_FILE,
  mergeThreshold: MERGE_12,
});

const mergedEDLLines = mergedEDL.split('\n');
const eventLines = mergedEDLLines.filter(l => /^\d{3}  AX/.test(l));
const mergedSegIdLines = mergedEDLLines.filter(l => l.startsWith('* SEGMENT ID:'));

assert(eventLines.length === 1, 'merged clips 9+10 produce exactly 1 EDL event');
assert(mergedSegIdLines.length === 1 && mergedSegIdLines[0] === '* SEGMENT ID: 9,10',
  'merged SEGMENT ID line shows "9,10"');

// Compare duration: merged span should span both clips
if (s9 && s10) {
  const expectedDur = s10.end_frame - s9.start_frame;
  const srcIn = legacyFramesToTC(s9.start_frame, FPS);
  const srcOut = legacyFramesToTC(s10.end_frame, FPS);
  assert(eventLines[0].includes(srcIn), `merged event SRC IN = ${srcIn}`);
  assert(eventLines[0].includes(srcOut), `merged event SRC OUT = ${srcOut}`);
}

// ─────────────────────────────────────────────────────────────────
// Test 7: framesToTC — frame math invariant
// ─────────────────────────────────────────────────────────────────

console.log('\n── Test 7: framesToTC invariant ─────────────────────────');

// 1 hour at 25fps = 90000 frames → 01:00:00:00
assert(framesToTC(90000, 25) === '01:00:00:00', 'framesToTC(90000,25) = 01:00:00:00');
assert(framesToTC(0, 25) === '00:00:00:00', 'framesToTC(0,25) = 00:00:00:00');
assert(framesToTC(25, 25) === '00:00:01:00', 'framesToTC(25,25) = 00:00:01:00 (1 second)');
assert(framesToTC(24, 25) === '00:00:00:24', 'framesToTC(24,25) = 00:00:00:24 (last frame of second)');
// 30fps
assert(framesToTC(30, 30) === '00:00:01:00', 'framesToTC(30,30) = 00:00:01:00');
// Negative clamp
assert(framesToTC(-5, 25) === '00:00:00:00', 'framesToTC(-5,25) clamps to 00:00:00:00');
// EDL cursor starts at 1 hour
assert(framesToTC(3600 * 25, 25) === '01:00:00:00', '1-hour EDL offset correct');
// 23.976 treated as 24 NDF
assert(framesToTC(24, 23.976) === '00:00:01:00', 'framesToTC(24,23.976) = 00:00:01:00 (NDF)');

// Drop-frame: 29.97 fps (30 DF, D=2)
// Frame 0 = 00:00:00;00
assert(framesToTC(0, 29.97) === '00:00:00;00', 'DF: frame 0 = 00:00:00;00');
// Frame 1800 = 00:01:00;02 (frames ;00 and ;01 are dropped at 1-minute mark)
assert(framesToTC(1800, 29.97) === '00:01:00;02', 'DF: frame 1800 = 00:01:00;02');
// Frame 17982 = 00:10:00;00 (10-minute mark — no drop)
assert(framesToTC(17982, 29.97) === '00:10:00;00', 'DF: frame 17982 = 00:10:00;00');
// 1 hour at 29.97 = 107892 frames → 01:00:00;00
assert(framesToTC(107892, 29.97) === '01:00:00;00', 'DF: 1 hour (107892 frames) = 01:00:00;00');

// ─────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ${passed} passed  ${failed} failed`);
if (failed > 0) {
  console.log('  STATUS: FAIL');
  process.exit(1);
} else {
  console.log('  STATUS: PASS — Phase 1 regression complete');
}
