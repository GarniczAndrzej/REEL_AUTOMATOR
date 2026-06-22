import { mergeAdjacentClips } from '../parser/segments.js';
import { MARKER_LABELS } from './markers.js';

// hook/body/punchline → DaVinci Resolve marker color name. Labels come from the
// shared MARKER_LABELS; colors stay Lua-local.
const LUA_MARKER_COLORS = { hook: 'Green', body: 'Blue', punchline: 'Red' };

export function generateLua({
  reelsData,
  sentences,
  fps,
  gapFrames,
  videoPath,
  projectName,
  mergeThreshold,
}) {
  const lines = [];
  lines.push('-- ================================================');
  lines.push('-- Reels EDL Automator — DaVinci Resolve Lua Script');
  lines.push('-- Wygenerowano automatycznie');
  lines.push('-- ================================================');
  lines.push('-- Jak uruchomić:');
  lines.push('--   1. Otwórz DaVinci Resolve');
  lines.push('--   2. Workspace → Console (lub Ctrl+F12 / Cmd+F12)');
  lines.push('--   3. Wklej ten skrypt i kliknij Run');
  lines.push('-- ================================================');
  lines.push('');
  lines.push(
    `local VIDEO_PATH = "${videoPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  lines.push(`local FPS = ${fps}`);
  lines.push('');
  lines.push('local resolve = Resolve()');
  lines.push(
    'if not resolve then print("BŁĄD: Nie można połączyć z DaVinci Resolve!") return end',
  );
  lines.push('');
  lines.push('local projectManager = resolve:GetProjectManager()');
  lines.push('local project = projectManager:GetCurrentProject()');
  lines.push(
    'if not project then print("BŁĄD: Brak otwartego projektu!") return end',
  );
  lines.push('');
  lines.push('local mediaPool = project:GetMediaPool()');
  lines.push('');
  lines.push('-- Import pliku wideo do Media Pool');
  lines.push('print("Importuję plik wideo...")');
  lines.push('local clipList = mediaPool:ImportMedia({VIDEO_PATH})');
  lines.push('if not clipList or #clipList == 0 then');
  lines.push('  print("BŁĄD: Nie można załadować pliku: " .. VIDEO_PATH)');
  lines.push('  print("Sprawdź czy ścieżka jest poprawna i plik istnieje.")');
  lines.push('  return');
  lines.push('end');
  lines.push('local sourceClip = clipList[1]');
  lines.push('print("Załadowano: " .. sourceClip:GetName())');
  lines.push('');

  // Build segs table keyed by "rNsM" span index
  lines.push('-- Tabela segmentów');
  lines.push('local segs = {');
  reelsData.forEach((reel, ri) => {
    const spans = mergeAdjacentClips(
      reel.clip_ids,
      sentences,
      reel.mergeThreshold ?? mergeThreshold,
    );
    spans.forEach((span, si) => {
      const key = `r${ri + 1}s${si + 1}`;
      const txt = span.text
        .substring(0, 60)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, "'");
      lines.push(
        `  ["${key}"] = {sf=${span.start_frame}, ef=${span.end_frame}, d=${span.duration_frame}, t="${txt}"},`,
      );
    });
  });
  lines.push('}');
  lines.push('');

  const tlName = projectName.replace(/"/g, "'");

  lines.push(`print("\\nTworzę timeline: ${tlName}...")`);
  lines.push('');
  lines.push(`local timeline = mediaPool:CreateEmptyTimeline("${tlName}")`);
  lines.push(`if not timeline then`);
  lines.push(`  print("BŁĄD: Nie można utworzyć timeline!")`);
  lines.push(`  return`);
  lines.push(`end`);
  lines.push(`project:SetCurrentTimeline(timeline)`);
  lines.push('');
  lines.push('-- Budujemy listę klipów — wszystkie reelsy na jednym timelinie');
  lines.push(`-- Przerwa między reelsami: ${gapFrames} klatek`);
  lines.push('local allClips = {}');
  lines.push('local cursor = 0');
  lines.push('');

  const totalClips = reelsData.reduce(
    (a, r) =>
      a +
      mergeAdjacentClips(
        r.clip_ids,
        sentences,
        r.mergeThreshold ?? mergeThreshold,
      ).length,
    0,
  );

  // JS-side mirror of the Lua `cursor`, used to compute marker record frames at
  // generation time (merging + gaps are deterministic). markerCalls collects the
  // timeline:AddMarker(...) lines to emit after the batched append.
  let recCursor = 0;
  const markerCalls = [];
  reelsData.forEach((reel, ri) => {
    const spans = mergeAdjacentClips(
      reel.clip_ids,
      sentences,
      reel.mergeThreshold ?? mergeThreshold,
    );
    const reelName = reel.reel_name.replace(/"/g, "'").replace(/\\/g, '\\\\');
    lines.push(`-- REEL ${ri + 1}: ${reelName}`);
    lines.push(
      `print("  Dodaję reel ${ri + 1}/${reelsData.length}: ${reelName}")`,
    );
    const recordFrameById = new Map();
    spans.forEach((span, si) => {
      for (const id of span.ids) {
        const s = sentences.find((x) => x.id === id);
        if (s)
          recordFrameById.set(
            id,
            recCursor + (s.start_frame - span.start_frame),
          );
      }
      const key = `r${ri + 1}s${si + 1}`;
      lines.push(`if segs["${key}"] then`);
      lines.push(
        `  table.insert(allClips, {mediaPoolItem=sourceClip, startFrame=segs["${key}"].sf, endFrame=segs["${key}"].ef, recordFrame=cursor})`,
      );
      lines.push(`  cursor = cursor + segs["${key}"].d`);
      lines.push(`end`);
      recCursor += span.duration_frame;
    });
    // Collect markers for this reel (gated on reel.markers) — emitted after the
    // append so the timeline exists.
    if (reel.markers) {
      for (const [key, label] of MARKER_LABELS) {
        const cid = reel.markers[key];
        if (cid == null) continue;
        const recFrame = recordFrameById.get(cid);
        if (recFrame == null) continue;
        const safeLabel = label.replace(/"/g, "'");
        markerCalls.push(
          `timeline:AddMarker(${recFrame}, "${LUA_MARKER_COLORS[key]}", "${safeLabel}", "", 1, "")`,
        );
      }
    }
    if (ri < reelsData.length - 1) {
      lines.push(
        `cursor = cursor + ${gapFrames}  -- przerwa ${gapFrames} klatek`,
      );
      recCursor += gapFrames;
    }
    lines.push('');
  });

  lines.push('-- Dodaj wszystkie klipy do timeline jednym wywołaniem');
  lines.push('local ok = mediaPool:AppendToTimeline(allClips)');
  lines.push('if ok then');
  lines.push(`  print("\\n=================================")`);
  lines.push(`  print("GOTOWE! Timeline '${tlName}' gotowy.")`);
  lines.push(
    `  print("Reelsy: ${reelsData.length}  |  Klipy łącznie: ${totalClips}")`,
  );
  lines.push(`  print("Przerwy między reelsami: ${gapFrames} klatek")`);
  lines.push(`  print("=================================")`);
  lines.push('else');
  lines.push(
    `  print("BŁĄD: Nie udało się dodać klipów. Sprawdź czy plik wideo jest w Media Pool.")`,
  );
  lines.push('end');

  // Markery hook/body/punchline (jeśli reel je niesie). Gated — marker-free
  // runs add nothing and stay functionally identical to the legacy baseline.
  if (markerCalls.length) {
    lines.push('');
    lines.push('-- Markery hook/body/punchline');
    markerCalls.forEach((call) => lines.push(call));
  }

  return lines.join('\n');
}
