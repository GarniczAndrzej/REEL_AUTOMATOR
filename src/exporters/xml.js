import { mergeAdjacentClips } from '../parser/segments.js';
import { MARKER_LABELS } from './markers.js';

// hook/body/punchline → xmeml marker color name (record-frame markers). Labels
// come from the shared MARKER_LABELS; colors stay xmeml-local.
const XML_MARKER_COLORS = { hook: 'Green', body: 'Blue', punchline: 'Red' };

export function generateXML({
  reelsData,
  sentences,
  fps,
  videoFilename,
  videoPath,
  videoResolution,
  projectName,
  mergeThreshold,
}) {
  const [vw, vh] = videoResolution.split('x');

  const pathUrl = videoPath.startsWith('/')
    ? 'file://localhost' + videoPath.replace(/ /g, '%20')
    : 'file://localhost/' + videoPath.replace(/\\/g, '/').replace(/ /g, '%20');

  const totalFrames = sentences.length
    ? Math.max(...sentences.map((s) => s.end_frame)) + fps * 10
    : 90000;

  const esc = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE xmeml>');
  lines.push('<xmeml version="4">');

  const fileId = 'source_file_1';
  let firstClipItem = true;

  reelsData.forEach((reel, ri) => {
    const spans = mergeAdjacentClips(
      reel.clip_ids,
      sentences,
      reel.mergeThreshold ?? mergeThreshold,
    );
    const reelDur = spans.reduce((a, s) => a + s.duration_frame, 0);
    const reelName = esc(reel.reel_name);
    const ntsc = fps === 24 || fps === 30 || fps === 60 ? 'TRUE' : 'FALSE';

    lines.push(`  <sequence id="seq_${ri + 1}">`);
    lines.push(`    <name>${reelName}</name>`);
    lines.push(`    <duration>${reelDur}</duration>`);
    lines.push(
      `    <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`,
    );
    lines.push(
      `    <timecode><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    );
    lines.push(`    <media>`);
    lines.push(`      <video>`);
    lines.push(
      `        <format><samplecharacteristics><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><width>${vw}</width><height>${vh}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`,
    );
    lines.push(`        <track>`);

    // clip_id → per-sequence record frame, built while walking spans (cursor
    // from 0, no CMX-3600 offset). Mirrors edl.js's recordFrameById.
    const recordFrameById = new Map();

    let cursor = 0;
    spans.forEach((span, ci) => {
      for (const id of span.ids) {
        const s = sentences.find((x) => x.id === id);
        if (s)
          recordFrameById.set(id, cursor + (s.start_frame - span.start_frame));
      }
      const clipId = `clip_r${ri + 1}_c${ci + 1}`;
      const clipName = esc(
        `#${span.ids.join(',')} ${span.text.substring(0, 55)}`,
      );
      lines.push(`          <clipitem id="${clipId}">`);
      lines.push(`            <masterclipid>${clipId}_master</masterclipid>`);
      lines.push(`            <name>${clipName}</name>`);
      lines.push(`            <duration>${span.duration_frame}</duration>`);
      lines.push(
        `            <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`,
      );
      lines.push(`            <start>${cursor}</start>`);
      lines.push(`            <end>${cursor + span.duration_frame}</end>`);
      lines.push(`            <in>${span.start_frame}</in>`);
      lines.push(`            <out>${span.end_frame}</out>`);

      if (firstClipItem) {
        lines.push(`            <file id="${fileId}">`);
        lines.push(`              <name>${esc(videoFilename)}</name>`);
        lines.push(`              <pathurl>${pathUrl}</pathurl>`);
        lines.push(
          `              <rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`,
        );
        lines.push(`              <duration>${totalFrames}</duration>`);
        lines.push(`              <media>`);
        lines.push(
          `                <video><samplecharacteristics><rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate><width>${vw}</width><height>${vh}</height></samplecharacteristics></video>`,
        );
        lines.push(
          `                <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`,
        );
        lines.push(`              </media>`);
        lines.push(`            </file>`);
        firstClipItem = false;
      } else {
        lines.push(`            <file id="${fileId}"/>`);
      }

      lines.push(
        `            <comments><mastercomment1>${esc(span.text.substring(0, 120))}</mastercomment1></comments>`,
      );
      lines.push(`          </clipitem>`);
      cursor += span.duration_frame;
    });

    lines.push(`        </track>`);
    lines.push(`      </video>`);
    lines.push(`      <audio>`);
    lines.push(
      `        <track><enabled>TRUE</enabled><locked>FALSE</locked></track>`,
    );
    lines.push(`      </audio>`);
    lines.push(`    </media>`);
    // Sequence-level markers (record-frame), gated on reel.markers so a
    // marker-free reel stays byte-identical to the legacy baseline.
    if (reel.markers) {
      for (const [key, label] of MARKER_LABELS) {
        const cid = reel.markers[key];
        if (cid == null) continue;
        const recFrame = recordFrameById.get(cid);
        if (recFrame == null) continue;
        lines.push(`    <marker>`);
        lines.push(`      <name>${esc(label)}</name>`);
        lines.push(`      <in>${recFrame}</in>`);
        lines.push(`      <out>${recFrame + 1}</out>`);
        lines.push(`      <color>${XML_MARKER_COLORS[key]}</color>`);
        lines.push(`    </marker>`);
      }
    }
    lines.push(`  </sequence>`);
  });

  lines.push('</xmeml>');
  return lines.join('\n');
}
