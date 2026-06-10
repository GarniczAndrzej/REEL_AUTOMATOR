import { state, emit } from '../state.js';
import { generateEDL } from '../exporters/edl.js';
import { generateXML } from '../exporters/xml.js';
import { generateLua } from '../exporters/lua.js';
import { mergeAdjacentClips } from '../parser/segments.js';
import { buildReelSrt } from '../render/subtitles.js';
import { expandSpansWithFillerRemoval } from '../render/fillers.js';
import { renderMetadataList, pushUndo, snap } from './step2-analyze.js';
import {
  queue,
  initQueue,
  setRerenderFn,
  enqueueAll,
  cancelJob,
  cancelAll,
  clearDone,
} from '../render/queue.js';
import { PLATFORM_PRESETS } from '../render/settings.js';

// ── F16 — push undo before renderConfig mutations ─────────────────────
function configChange(mutateFn) {
  pushUndo(snap());
  mutateFn();
}

export function init() {
  // Tab switching
  document
    .getElementById('tabBtnEdl')
    .addEventListener('click', () => switchTab('Edl'));
  document
    .getElementById('tabBtnXml')
    .addEventListener('click', () => switchTab('Xml'));
  document
    .getElementById('tabBtnLua')
    .addEventListener('click', () => switchTab('Lua'));
  document
    .getElementById('tabBtnRender')
    .addEventListener('click', () => switchTab('Render'));
  document
    .getElementById('tabBtnMeta')
    .addEventListener('click', () => switchTab('Meta'));

  // Video filename inputs
  document.getElementById('videoFilename2').addEventListener('input', (e) => {
    state.videoFilename2 = e.target.value;
    emit();
  });
  document.getElementById('videoFullPath').addEventListener('input', (e) => {
    state.videoPath = e.target.value;
    emit();
  });
  document
    .getElementById('resolutionSelect')
    .addEventListener('change', (e) => {
      state.videoResolution = e.target.value;
      emit();
    });
  document.getElementById('projectName').addEventListener('input', (e) => {
    state.projectName = e.target.value;
    emit();
  });
  document.getElementById('mergeThreshold').addEventListener('input', (e) => {
    state.mergeThreshold = +e.target.value;
    emit();
  });

  // Browse video
  document
    .getElementById('browseVideoBtn')
    .addEventListener('click', browseVideo);

  // EDL
  document
    .getElementById('generateEdlBtn')
    .addEventListener('click', doGenerateEDL);
  document.getElementById('downloadEdlBtn').addEventListener('click', () => {
    if (state.edlContent)
      downloadFile(
        videoBase() + '_timeline.edl',
        state.edlContent,
        'text/plain',
      );
  });
  document
    .getElementById('copyEdlBtn')
    .addEventListener('click', () => copyEl('edlOutput'));

  // XML
  document
    .getElementById('generateXmlBtn')
    .addEventListener('click', doGenerateXML);
  document.getElementById('downloadXmlBtn').addEventListener('click', () => {
    if (state.xmlContent)
      downloadFile(
        videoBase() + '_timeline.xml',
        state.xmlContent,
        'application/xml',
      );
  });
  document
    .getElementById('copyXmlBtn')
    .addEventListener('click', () => copyEl('xmlOutput'));

  // Lua
  document
    .getElementById('generateLuaBtn')
    .addEventListener('click', doGenerateLua);
  document.getElementById('downloadLuaBtn').addEventListener('click', () => {
    if (state.luaContent)
      downloadFile(
        videoBase() + '_davinci.lua',
        state.luaContent,
        'text/plain',
      );
  });
  document
    .getElementById('copyLuaBtn')
    .addEventListener('click', () => copyEl('luaOutput'));

  // Render basic
  document
    .getElementById('browseOutDirBtn')
    .addEventListener('click', browseOutDir);
  document.getElementById('renderOutDir').addEventListener('input', (e) => {
    state.renderConfig.outDir = e.target.value;
    emit();
  });
  document.getElementById('renderBitrate').addEventListener('change', (e) => {
    configChange(() => {
      state.renderConfig.videoBitrate = e.target.value || '8M';
      emit();
    });
  });

  // F2 — Encoder dropdown
  document
    .getElementById('renderCodecSelect')
    .addEventListener('change', (e) => {
      configChange(() => {
        state.renderConfig.videoCodec = e.target.value;
        emit();
      });
    });
  // Block render buttons until hardware encoder detection resolves (L13)
  const renderAllBtn = document.getElementById('renderAllBtn');
  const renderPreviewBtn = document.getElementById('renderPreviewBtn');
  if (renderAllBtn) renderAllBtn.disabled = true;
  if (renderPreviewBtn) renderPreviewBtn.disabled = true;
  detectHwEncoder().finally(() => {
    if (renderAllBtn) renderAllBtn.disabled = false;
    if (renderPreviewBtn) renderPreviewBtn.disabled = false;
  });

  // F4 — Filler removal
  document
    .getElementById('renderRemoveFillers')
    .addEventListener('change', (e) => {
      state.renderConfig.removeFillers = e.target.checked;
      syncStreamCopyCheckbox();
      emit();
    });

  // F5 — Face tracking mode
  const ftSel = document.getElementById('renderFaceTrackingMode');
  if (ftSel)
    ftSel.addEventListener('change', (e) => {
      state.renderConfig.faceTrackingMode = e.target.value;
      emit();
    });

  // Format radio
  document.querySelectorAll('input[name="renderAspect"]').forEach((r) => {
    r.addEventListener('change', (e) => {
      if (e.target.checked) {
        configChange(() => {
          state.renderConfig.aspect = e.target.value;
          syncStreamCopyCheckbox();
          syncFaceTrackingRow();
          emit();
        });
      }
    });
  });

  // Loudness
  document.getElementById('renderLoudnorm').addEventListener('change', (e) => {
    configChange(() => {
      state.renderConfig.loudnessNormalize = e.target.checked;
      syncStreamCopyCheckbox();
      emit();
    });
  });

  // Concurrency
  document
    .getElementById('renderConcurrency')
    .addEventListener('change', (e) => {
      state.renderConfig.concurrency = +e.target.value;
      queue.concurrency = +e.target.value;
      emit();
    });

  // Burn subtitles
  document
    .getElementById('renderBurnSubtitles')
    .addEventListener('change', (e) => {
      configChange(() => {
        state.renderConfig.burnSubtitles = e.target.checked;
        syncStreamCopyCheckbox();
        emit();
      });
    });

  // Stream copy
  document
    .getElementById('renderStreamCopy')
    .addEventListener('change', (e) => {
      state.renderConfig.streamCopy = e.target.checked;
      emit();
    });

  // Logo toggle
  document
    .getElementById('renderLogoEnable')
    .addEventListener('change', (e) => {
      state.renderConfig.logo = e.target.checked
        ? { path: '', position: 'br', opacity: 1, widthPct: 15 }
        : null;
      syncLogoSection();
      syncStreamCopyCheckbox();
      emit();
    });
  document
    .getElementById('browseLogoBtn')
    .addEventListener('click', browseLogo);

  // Logo position buttons
  document.querySelectorAll('.logo-pos-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.renderConfig.logo) return;
      state.renderConfig.logo.position = btn.dataset.pos;
      syncLogoPosButtons();
      emit();
    });
  });

  // Logo opacity
  document
    .getElementById('renderLogoOpacity')
    .addEventListener('input', (e) => {
      if (!state.renderConfig.logo) return;
      const val = +e.target.value;
      document.getElementById('renderLogoOpacityVal').textContent = val;
      state.renderConfig.logo.opacity = val / 100;
      emit();
    });

  // Logo width
  document.getElementById('renderLogoWidth').addEventListener('input', (e) => {
    if (!state.renderConfig.logo) return;
    const val = +e.target.value;
    document.getElementById('renderLogoWidthVal').textContent = val;
    state.renderConfig.logo.widthPct = val;
    emit();
  });

  // Intro / outro
  document
    .getElementById('browseIntroBtn')
    .addEventListener('click', browseIntro);
  document.getElementById('clearIntroBtn').addEventListener('click', () => {
    state.renderConfig.intro = null;
    document.getElementById('renderIntroPath').value = '';
    syncStreamCopyCheckbox();
    emit();
  });
  document
    .getElementById('browseOutroBtn')
    .addEventListener('click', browseOutro);
  document.getElementById('clearOutroBtn').addEventListener('click', () => {
    state.renderConfig.outro = null;
    document.getElementById('renderOutroPath').value = '';
    syncStreamCopyCheckbox();
    emit();
  });

  // Render buttons
  document
    .getElementById('renderAllBtn')
    .addEventListener('click', () => startRender(false));
  document
    .getElementById('renderPreviewBtn')
    .addEventListener('click', () => startRender(true));

  // Queue controls (event delegation on rows + top buttons)
  document.getElementById('cancelAllBtn').addEventListener('click', cancelAll);
  document.getElementById('clearDoneBtn').addEventListener('click', clearDone);
  document.getElementById('renderQueueRows').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'cancel') cancelJob(id);
    if (btn.dataset.action === 'open-folder') openJobFolder(id);
  });

  // Wire up queue rerender callback
  setRerenderFn(rerenderQueueUI);
  initQueue();

  // F6 metadata tab
  initMetadataTab();

  syncFaceTrackingRow();

  // F12/F17 — preset UI
  document
    .getElementById('applyPlatformPresetBtn')
    .addEventListener('click', applyPlatformPreset);
  document
    .getElementById('saveGlobalPresetBtn')
    .addEventListener('click', saveGlobalPreset);
  document
    .getElementById('deleteGlobalPresetBtn')
    .addEventListener('click', deleteGlobalPreset);
  document
    .getElementById('saveProjectPresetBtn')
    .addEventListener('click', saveProjectPreset);
  document
    .getElementById('deleteProjectPresetBtn')
    .addEventListener('click', deleteProjectPreset);
  document
    .getElementById('presetSelect')
    .addEventListener('change', onPresetSelectChange);
  loadGlobalPresets();

  // F16 — sync UI when undo/redo restores renderConfig
  document.addEventListener('reel:syncRenderConfig', () => updateSummary());
}

export function updateSummary() {
  const totalClips = state.reelsData.reduce((a, r) => a + r.clip_ids.length, 0);
  document.getElementById('sumSegs').textContent =
    state.sentences.length + ' segmentów';
  document.getElementById('sumReels').textContent =
    state.reelsData.length + ' reelsów';
  document.getElementById('sumClips').textContent = totalClips + ' klipów';
  document.getElementById('videoFilename2').value = state.videoFilename2 || '';
  document.getElementById('videoFullPath').value = state.videoPath || '';
  document.getElementById('mergeThreshold').value = state.mergeThreshold;
  document.getElementById('projectName').value = state.projectName;

  const rc = state.renderConfig;
  document.getElementById('renderOutDir').value = rc.outDir || '';
  document.getElementById('renderBitrate').value = rc.videoBitrate || '8M';
  document.querySelectorAll('input[name="renderAspect"]').forEach((r) => {
    r.checked = r.value === (rc.aspect || 'source');
  });
  document.getElementById('renderLoudnorm').checked = !!rc.loudnessNormalize;

  // Phase 3 controls
  const concSel = document.getElementById('renderConcurrency');
  if (concSel) {
    concSel.value = String(rc.concurrency ?? 2);
    queue.concurrency = rc.concurrency ?? 2;
  }
  document.getElementById('renderBurnSubtitles').checked = !!rc.burnSubtitles;
  document.getElementById('renderStreamCopy').checked = !!rc.streamCopy;
  syncStreamCopyCheckbox();

  const hasLogo = rc.logo !== null && rc.logo !== undefined;
  document.getElementById('renderLogoEnable').checked = hasLogo;
  syncLogoSection();
  if (hasLogo && rc.logo) {
    document.getElementById('renderLogoPath').value = rc.logo.path || '';
    const opPct = Math.round((rc.logo.opacity ?? 1) * 100);
    document.getElementById('renderLogoOpacity').value = opPct;
    document.getElementById('renderLogoOpacityVal').textContent = opPct;
    const wPct = rc.logo.widthPct ?? 15;
    document.getElementById('renderLogoWidth').value = wPct;
    document.getElementById('renderLogoWidthVal').textContent = wPct;
    syncLogoPosButtons();
  }

  document.getElementById('renderIntroPath').value = rc.intro?.path || '';
  document.getElementById('renderOutroPath').value = rc.outro?.path || '';

  // F2 — encoder dropdown
  const codecSel = document.getElementById('renderCodecSelect');
  if (codecSel) codecSel.value = rc.videoCodec || 'auto';

  // F4 — filler removal
  const fillSel = document.getElementById('renderRemoveFillers');
  if (fillSel) fillSel.checked = !!rc.removeFillers;

  // F5 — face tracking
  const ftSel = document.getElementById('renderFaceTrackingMode');
  if (ftSel) ftSel.value = rc.faceTrackingMode || 'center';
  syncFaceTrackingRow();

  // F6 — metadata tab
  if (state.reelsMetadata.length) renderMetadataList();
  syncMetadataExportBtn();

  // F12/F17 — refresh preset dropdown (project presets may have changed)
  syncPresetDropdown();
}

// ── F2 encoder detection ───────────────────────────────────────────

async function detectHwEncoder() {
  const label = document.getElementById('detectedEncoderLabel');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const codec = await invoke('detect_hw_encoder');
    state.detectedHwEncoder = codec;
    if (label) {
      label.textContent =
        codec === 'libx264'
          ? 'Wykryto: libx264 (CPU, brak akceleracji sprzętowej)'
          : `Wykryto: ${codec} ✓`;
    }
  } catch (e) {
    state.detectedHwEncoder = 'libx264';
    if (label)
      label.textContent = 'Nie udało się wykryć enkodera — użyję libx264';
  }
}

// ── helpers ────────────────────────────────────────────────────────

function syncLogoSection() {
  const show = !!state.renderConfig.logo;
  document.getElementById('renderLogoSection').style.display = show
    ? ''
    : 'none';
}

function syncLogoPosButtons() {
  const pos = state.renderConfig.logo?.position || 'br';
  document.querySelectorAll('.logo-pos-btn').forEach((b) => {
    const active = b.dataset.pos === pos;
    b.style.borderColor = active ? 'var(--accent)' : '';
    b.style.color = active ? 'var(--accent2)' : '';
  });
}

function syncStreamCopyCheckbox() {
  const rc = state.renderConfig;
  const eligible =
    rc.aspect === 'source' &&
    !rc.logo &&
    !rc.intro &&
    !rc.outro &&
    !rc.burnSubtitles &&
    !rc.loudnessNormalize &&
    !rc.removeFillers;
  const checkbox = document.getElementById('renderStreamCopy');
  if (!checkbox) return;
  checkbox.disabled = !eligible;
  if (!eligible && rc.streamCopy) {
    state.renderConfig.streamCopy = false;
    checkbox.checked = false;
    emit();
  }
}

function syncFaceTrackingRow() {
  const rc = state.renderConfig;
  const needsVertical = rc.aspect === 'vertical_9_16' || rc.aspect === 'both';
  const row = document.getElementById('faceTrackingRow');
  if (row) row.style.display = needsVertical ? '' : 'none';
}

function switchTab(name) {
  document
    .querySelectorAll('.export-tab')
    .forEach((b) => b.classList.remove('active'));
  document
    .querySelectorAll('.export-panel')
    .forEach((p) => p.classList.remove('active'));
  document.getElementById('tabBtn' + name).classList.add('active');
  document.getElementById('tab' + name).classList.add('active');
}

function spansFor(reel) {
  const threshold = reel.mergeThreshold ?? state.mergeThreshold;
  const merged = mergeAdjacentClips(reel.clip_ids, state.sentences, threshold);
  if (state.renderConfig.removeFillers) {
    return expandSpansWithFillerRemoval(merged, state.sentences, state.fps);
  }
  return merged.map((s) => ({
    in_s: s.start_frame / state.fps,
    out_s: s.end_frame / state.fps,
    source_idx: s.source_idx ?? 0,
  }));
}

// ── exporters ──────────────────────────────────────────────────────

function doGenerateEDL() {
  if (!state.reelsData.length) {
    alert('Brak danych reelsów! Wróć do kroku 2.');
    return;
  }
  const videoFile = state.videoFilename2 || 'source_video.mp4';
  state.edlContent = generateEDL({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoFilename: videoFile,
    mergeThreshold: state.mergeThreshold,
  });
  document.getElementById('edlOutput').textContent = state.edlContent;
  document.getElementById('edlCard').style.display = 'block';
  document.getElementById('statusEdl').textContent = 'gotowy';
  updateSummary();
  emit();
}

function doGenerateXML() {
  if (!state.reelsData.length) {
    alert('Brak danych reelsów!');
    return;
  }
  const videoFile = state.videoFilename2 || 'source_video.mp4';
  const videoPath = state.videoPath || videoFile;
  state.xmlContent = generateXML({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    videoFilename: videoFile,
    videoPath,
    videoResolution: state.videoResolution,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
  const preview =
    state.xmlContent.substring(0, 3000) +
    (state.xmlContent.length > 3000 ? '\n… (skrócono podgląd)' : '');
  document.getElementById('xmlOutput').textContent = preview;
  document.getElementById('xmlCard').style.display = 'block';
  document.getElementById('xmlSeqCount').textContent =
    state.reelsData.length + ' sekwencji';
  updateSummary();
  emit();
}

function doGenerateLua() {
  if (!state.reelsData.length) {
    alert('Brak danych reelsów!');
    return;
  }
  const videoPath = state.videoPath;
  if (!videoPath) {
    alert('Wpisz pełną ścieżkę do pliku wideo (pole "Pełna ścieżka" powyżej)!');
    return;
  }
  state.luaContent = generateLua({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoPath,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
  document.getElementById('luaOutput').textContent = state.luaContent;
  document.getElementById('luaCard').style.display = 'block';
  const totalClips = state.reelsData.reduce((a, r) => a + r.clip_ids.length, 0);
  document.getElementById('luaInfo').textContent =
    '1 timeline · ' +
    totalClips +
    ' klipów · ' +
    state.reelsData.length +
    ' reelsów';
  updateSummary();
  emit();
}

// ── file pickers ────────────────────────────────────────────────────

async function browseVideo() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [
        {
          name: 'Wideo',
          extensions: ['mp4', 'mov', 'mkv', 'avi', 'mxf', 'r3d'],
        },
      ],
    });
    if (!path) return;
    state.videoPath = path;
    const name = path.split('/').pop().split('\\').pop();
    state.videoFilename2 = name;
    document.getElementById('videoFilename2').value = name;
    document.getElementById('videoFilename').value = name;
    document.getElementById('videoFullPath').value = path;
    emit();
  } catch (e) {
    alert('Nie udało się wybrać pliku: ' + e);
  }
}

async function browseOutDir() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ directory: true });
    if (!path) return;
    state.renderConfig.outDir = path;
    document.getElementById('renderOutDir').value = path;
    emit();
  } catch (e) {
    alert('Nie udało się wybrać katalogu: ' + e);
  }
}

async function browseLogo() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (!path) return;
    if (!state.renderConfig.logo) {
      state.renderConfig.logo = {
        path: '',
        position: 'br',
        opacity: 1,
        widthPct: 15,
      };
    }
    state.renderConfig.logo.path = path;
    document.getElementById('renderLogoPath').value = path;
    emit();
  } catch (e) {
    alert('Nie udało się wybrać pliku: ' + e);
  }
}

async function browseIntro() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [{ name: 'Wideo', extensions: ['mp4', 'mov', 'mkv'] }],
    });
    if (!path) return;
    state.renderConfig.intro = { path };
    document.getElementById('renderIntroPath').value = path;
    syncStreamCopyCheckbox();
    emit();
  } catch (e) {
    alert('Nie udało się wybrać pliku: ' + e);
  }
}

async function browseOutro() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [{ name: 'Wideo', extensions: ['mp4', 'mov', 'mkv'] }],
    });
    if (!path) return;
    state.renderConfig.outro = { path };
    document.getElementById('renderOutroPath').value = path;
    syncStreamCopyCheckbox();
    emit();
  } catch (e) {
    alert('Nie udało się wybrać pliku: ' + e);
  }
}

// ── render ─────────────────────────────────────────────────────────

function remapKeyframes(allKfs, spans) {
  const result = [];
  let outputTime = 0;
  for (const span of spans) {
    const spanKfs = allKfs.filter(
      (kf) => kf.t >= span.in_s - 0.5 && kf.t <= span.out_s + 0.5,
    );
    for (const kf of spanKfs) {
      result.push({ t: outputTime + Math.max(0, kf.t - span.in_s), x: kf.x });
    }
    outputTime += span.out_s - span.in_s;
  }
  if (result.length === 0 && allKfs.length > 0) {
    const sorted = [...allKfs].sort((a, b) => a.t - b.t);
    result.push({ t: 0, x: sorted[Math.floor(sorted.length / 2)].x });
  }
  return result.length > 0 ? result : null;
}

function buildJobs(preview, faceKfsRaw = null) {
  const rc = state.renderConfig;
  const sourcePath = state.videoPath;
  const isWindows = /win/i.test(navigator.platform);
  const sep = isWindows ? '\\' : '/';
  const projBase = (state.projectName || 'reels').replace(
    /[^a-zA-Z0-9_\-]/g,
    '_',
  );
  const slug = (s) => s.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 30);
  const srcW =
    parseInt((state.videoResolution || '1920x1080').split('x')[0]) || 1920;

  const resolvedCodec = preview
    ? state.detectedHwEncoder === 'h264_videotoolbox'
      ? 'h264_videotoolbox'
      : 'libx264'
    : rc.videoCodec === 'auto'
      ? state.detectedHwEncoder || 'libx264'
      : rc.videoCodec || 'libx264';

  // F18 — build source_paths array: [primaryVideo, ...additionalSources]
  const sourcePaths =
    state.sources && state.sources.length > 0
      ? [
          sourcePath,
          ...state.sources.map((s) => s.videoPath || '').filter(Boolean),
        ]
      : [];

  const makeReq = (reel, aspect, outPath, reelId, outputW) => {
    const spans = spansFor(reel);
    const logoArg = rc.logo
      ? {
          path: rc.logo.path,
          position: rc.logo.position,
          opacity: rc.logo.opacity,
          width_pct: rc.logo.widthPct,
        }
      : null;

    const srtContent =
      !preview && rc.burnSubtitles
        ? buildReelSrt(
            reel,
            state.sentences,
            state.fps,
            reel.mergeThreshold ?? state.mergeThreshold,
          )
        : null;

    const faceKeyframes =
      !preview && aspect === 'vertical_9_16' && faceKfsRaw
        ? remapKeyframes(faceKfsRaw, spans)
        : null;

    return {
      reel_id: reelId,
      source_path: sourcePath,
      source_paths: sourcePaths, // F18
      spans,
      out_path: outPath,
      video_bitrate: rc.videoBitrate || '8M',
      fps: state.fps,
      aspect,
      logo: logoArg,
      intro: rc.intro || null,
      outro: rc.outro || null,
      loudness_normalize: rc.loudnessNormalize,
      output_w: outputW,
      burn_subtitles: !preview && rc.burnSubtitles,
      subtitle_srt: srtContent,
      subtitle_style: rc.subtitleStyle || null,
      preview,
      stream_copy: !preview && rc.streamCopy,
      video_codec: resolvedCodec,
      face_keyframes: faceKeyframes,
    };
  };

  const jobs = [];
  state.reelsData.forEach((reel, ri) => {
    const base = `${rc.outDir}${sep}${projBase}_${ri + 1}_${slug(reel.reel_name)}`;
    const suffix = preview ? '_preview' : '';

    if (rc.aspect === 'source' || rc.aspect === 'both') {
      const id = `${ri}__source`;
      jobs.push({
        id,
        reelIdx: ri,
        reelName: reel.reel_name,
        aspect: 'source',
        status: 'pending',
        percent: 0,
        error: null,
        outPath: null,
        req: makeReq(reel, 'source', `${base}${suffix}.mp4`, id, srcW),
      });
    }
    if (rc.aspect === 'vertical_9_16' || rc.aspect === 'both') {
      const id = `${ri}__vertical_9_16`;
      jobs.push({
        id,
        reelIdx: ri,
        reelName: reel.reel_name,
        aspect: 'vertical_9_16',
        status: 'pending',
        percent: 0,
        error: null,
        outPath: null,
        req: makeReq(
          reel,
          'vertical_9_16',
          `${base}${suffix}_9x16.mp4`,
          id,
          1080,
        ),
      });
    }
  });
  return jobs;
}

async function startRender(preview) {
  if (!state.reelsData.length) {
    alert('Brak danych reelsów!');
    return;
  }
  if (!state.videoPath) {
    alert('Wybierz plik wideo (pole "Pełna ścieżka")!');
    return;
  }
  if (!state.renderConfig.outDir) {
    alert('Wybierz katalog wyjściowy!');
    return;
  }
  if (state.renderConfig.logo && !state.renderConfig.logo.path) {
    alert('Wybierz plik logo PNG!');
    return;
  }

  const rc = state.renderConfig;
  let faceKfsRaw = null;
  const needsVertical = rc.aspect === 'vertical_9_16' || rc.aspect === 'both';

  if (!preview && needsVertical && rc.faceTrackingMode === 'auto') {
    setFaceTrackingProgress(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      faceKfsRaw = await invoke('detect_face_keyframes', {
        sourcePath: state.videoPath,
      });
      state._faceKfsCache = faceKfsRaw;
    } catch (e) {
      console.warn('Face detection failed, using center crop:', e);
    } finally {
      setFaceTrackingProgress(false);
    }
  }

  document.getElementById('renderQueuePanel').style.display = 'block';
  queue.concurrency = rc.concurrency ?? 2;
  await enqueueAll(buildJobs(preview, faceKfsRaw));
}

function setFaceTrackingProgress(active) {
  const box = document.getElementById('faceTrackingProgress');
  if (!box) return;
  box.style.display = active ? '' : 'none';
}

// ── queue UI ────────────────────────────────────────────────────────

const STATUS_LABEL = {
  pending: 'oczekuje',
  running: 'renderowanie…',
  done: 'gotowe ✓',
  cancelled: 'anulowano',
  error: 'błąd ✗',
};
const ASPECT_LABEL = {
  source: 'Źródłowy',
  vertical_9_16: '9:16',
};

function rerenderQueueUI() {
  const container = document.getElementById('renderQueueRows');
  if (!container) return;

  if (!queue.jobs.length) {
    container.innerHTML =
      '<div style="padding:12px;color:var(--text3);font-size:12px;">Brak zadań.</div>';
    return;
  }

  container.innerHTML = queue.jobs
    .map((job) => {
      const statusLabel = STATUS_LABEL[job.status] || job.status;
      const aspectLabel = ASPECT_LABEL[job.aspect] || job.aspect;
      const pct = (job.percent || 0).toFixed(0);

      const cancelBtn =
        job.status === 'running'
          ? `<button class="btn btn-secondary" style="padding:2px 8px;font-size:11px;" data-action="cancel" data-id="${job.id}">Anuluj</button>`
          : '';
      const openBtn =
        job.status === 'done'
          ? `<button class="btn btn-secondary" style="padding:2px 8px;font-size:11px;" data-action="open-folder" data-id="${job.id}">Otwórz folder</button>`
          : '';
      const errorMsg =
        job.status === 'error'
          ? `<div style="font-size:10px;color:var(--red);margin-top:4px;">${escHtml(job.error || '')}</div>`
          : '';

      return `
<div class="render-reel-row">
  <div class="render-reel-meta">
    <span class="render-reel-label">Reel ${job.reelIdx + 1}: ${escHtml(job.reelName)}</span>
    <span class="aspect-badge">${escHtml(aspectLabel)}</span>
  </div>
  <div class="render-progress-bar">
    <div class="render-progress-fill" style="width:${pct}%"></div>
  </div>
  <div class="render-reel-meta" style="margin-top:4px;">
    <span class="status-pill status-${job.status}">${statusLabel}</span>
    <span class="render-progress-pct">${pct}%</span>
    ${cancelBtn}
    ${openBtn}
  </div>
  ${errorMsg}
</div>`;
    })
    .join('');
}

async function openJobFolder(id) {
  const job = queue.jobs.find((j) => j.id === id);
  if (!job || !job.outPath) return;
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    const dir = job.outPath.replace(/[/\\][^/\\]+$/, '');
    await open(dir);
  } catch (e) {
    alert('Nie udało się otworzyć folderu: ' + e);
  }
}

// ── F6 Metadata export + thumbnail extraction ───────────────────────

function syncMetadataExportBtn() {
  const btn = document.getElementById('downloadMetadataBtn');
  const thumbBtn = document.getElementById('extractThumbsBtn');
  if (btn) btn.disabled = !state.reelsMetadata.length;
  if (thumbBtn) thumbBtn.disabled = !state.reelsMetadata.length;
}

export function initMetadataTab() {
  const dlBtn = document.getElementById('downloadMetadataBtn');
  if (dlBtn) dlBtn.addEventListener('click', downloadMetadataJSON);
  const thumbBtn = document.getElementById('extractThumbsBtn');
  if (thumbBtn) thumbBtn.addEventListener('click', extractAllThumbnails);
}

function downloadMetadataJSON() {
  if (!state.reelsMetadata.length) {
    alert('Brak metadanych — wygeneruj w Kroku 2!');
    return;
  }
  const filename = videoBase() + '_metadata.json';
  downloadFile(
    filename,
    JSON.stringify(state.reelsMetadata, null, 2),
    'application/json',
  );
}

async function extractAllThumbnails() {
  if (!state.reelsMetadata.length) {
    alert('Brak metadanych!');
    return;
  }
  if (!state.renderConfig.outDir) {
    alert('Ustaw katalog wyjściowy w zakładce Render MP4!');
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const isWindows = /win/i.test(navigator.platform);
  const sep = isWindows ? '\\' : '/';
  const projBase = (state.projectName || 'reels').replace(
    /[^a-zA-Z0-9_\-]/g,
    '_',
  );
  const slug = (s) => s.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 30);

  const doneJobs = queue.jobs.filter((j) => j.status === 'done' && j.outPath);

  let extracted = 0;
  let skipped = 0;
  for (const [ri, meta] of state.reelsMetadata.entries()) {
    if (!meta || meta.error) continue;
    const ts = meta.thumbnailTimestamp ?? 0;
    const reelName = meta.reelName || '';
    // Collect all done jobs for this reel (may be >1 when aspect='both')
    const reelJobs = doneJobs.filter((j) => j.reelIdx === ri);
    if (!reelJobs.length) {
      skipped++;
      continue;
    }
    for (const job of reelJobs) {
      const outPath = `${state.renderConfig.outDir}${sep}${projBase}_${ri + 1}_${slug(reelName)}_${job.aspect}_thumb.jpg`;
      try {
        await invoke('extract_thumbnail', {
          videoPath: job.outPath,
          timestamp: ts,
          outPath,
        });
        extracted++;
      } catch (e) {
        console.warn('Thumbnail failed for reel', ri, e);
      }
    }
  }
  if (skipped > 0) {
    alert(
      `Miniatury wyodrębnione: ${extracted}. Pominięto ${skipped} reelsów bez wyrenderowanego MP4.`,
    );
  } else {
    alert('Miniatury wyodrębnione do katalogu wyjściowego.');
  }
}

// ── F12 / F17 — render presets ────────────────────────────────────────

let _globalPresetNames = [];

async function loadGlobalPresets() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    _globalPresetNames = await invoke('list_render_presets');
  } catch {
    _globalPresetNames = [];
  }
  syncPresetDropdown();
}

function syncPresetDropdown() {
  const sel = document.getElementById('presetSelect');
  if (!sel) return;
  const cur = sel.value;

  // Platform presets (built-in)
  const platformOpts = Object.entries(PLATFORM_PRESETS)
    .map(([k, v]) => `<option value="platform:${k}">🌐 ${v.label}</option>`)
    .join('');

  // Global user presets
  const globalOpts = _globalPresetNames.length
    ? _globalPresetNames
        .map((n) => `<option value="global:${n}">💾 ${escHtml(n)}</option>`)
        .join('')
    : '';

  // Project presets (F17)
  const projectOpts = Object.keys(state.namedPresets || {}).length
    ? Object.keys(state.namedPresets)
        .map((n) => `<option value="project:${n}">📁 ${escHtml(n)}</option>`)
        .join('')
    : '';

  const divider1 = globalOpts
    ? '<option disabled>── Własne globalne ──</option>'
    : '';
  const divider2 = projectOpts
    ? '<option disabled>── Presetów projektu ──</option>'
    : '';

  sel.innerHTML = `<option value="">— wybierz preset —</option>
${platformOpts}
${divider1}${globalOpts}
${divider2}${projectOpts}`;

  if (cur) sel.value = cur;
  onPresetSelectChange();
}

function onPresetSelectChange() {
  const sel = document.getElementById('presetSelect');
  const val = sel?.value || '';
  const isGlobal = val.startsWith('global:');
  const isProject = val.startsWith('project:');
  const delGlob = document.getElementById('deleteGlobalPresetBtn');
  const delProj = document.getElementById('deleteProjectPresetBtn');
  if (delGlob) delGlob.style.display = isGlobal ? '' : 'none';
  if (delProj) delProj.style.display = isProject ? '' : 'none';
}

function applyPlatformPreset() {
  const val = document.getElementById('presetSelect')?.value || '';
  if (!val) return;

  let cfg = null;
  if (val.startsWith('platform:')) {
    const key = val.slice('platform:'.length);
    cfg = PLATFORM_PRESETS[key]?.config;
  } else if (val.startsWith('global:')) {
    const name = val.slice('global:'.length);
    // Loaded synchronously from a snapshot — use async version
    applyGlobalPresetAsync(name);
    return;
  } else if (val.startsWith('project:')) {
    const name = val.slice('project:'.length);
    cfg = state.namedPresets?.[name];
  }

  if (!cfg) return;
  pushUndo(snap());
  Object.assign(state.renderConfig, cfg);
  updateSummary();
  emit();
}

async function applyGlobalPresetAsync(name) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke('load_render_preset', { name });
    const cfg = JSON.parse(raw);
    pushUndo(snap());
    Object.assign(state.renderConfig, cfg);
    updateSummary();
    emit();
  } catch (e) {
    alert('Nie udało się załadować presetu: ' + e);
  }
}

async function saveGlobalPreset() {
  const name = document.getElementById('globalPresetName')?.value.trim();
  if (!name) {
    alert('Podaj nazwę presetu!');
    return;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_render_preset', {
      name,
      content: JSON.stringify(state.renderConfig),
    });
    if (!_globalPresetNames.includes(name)) _globalPresetNames.push(name);
    syncPresetDropdown();
    document.getElementById('globalPresetName').value = '';
    alert(`Preset "${name}" zapisany.`);
  } catch (e) {
    alert('Nie udało się zapisać presetu: ' + e);
  }
}

async function deleteGlobalPreset() {
  const val = document.getElementById('presetSelect')?.value || '';
  if (!val.startsWith('global:')) return;
  const name = val.slice('global:'.length);
  if (!confirm(`Usunąć preset globalny "${name}"?`)) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_render_preset', { name });
    _globalPresetNames = _globalPresetNames.filter((n) => n !== name);
    syncPresetDropdown();
  } catch (e) {
    alert('Nie udało się usunąć presetu: ' + e);
  }
}

function saveProjectPreset() {
  const name = document.getElementById('projectPresetName')?.value.trim();
  if (!name) {
    alert('Podaj nazwę presetu projektu!');
    return;
  }
  if (!state.namedPresets) state.namedPresets = {};
  state.namedPresets[name] = JSON.parse(JSON.stringify(state.renderConfig));
  syncPresetDropdown();
  document.getElementById('projectPresetName').value = '';
  emit();
  alert(`Preset projektu "${name}" zapisany (zostanie zachowany w .reelproj).`);
}

function deleteProjectPreset() {
  const val = document.getElementById('presetSelect')?.value || '';
  if (!val.startsWith('project:')) return;
  const name = val.slice('project:'.length);
  if (!confirm(`Usunąć preset projektu "${name}"?`)) return;
  delete state.namedPresets[name];
  syncPresetDropdown();
  emit();
}

// ── utilities ──────────────────────────────────────────────────────

function videoBase() {
  const name = state.videoFilename2 || 'reels';
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  return base || 'reels';
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function copyEl(elId) {
  const el = document.getElementById(elId);
  navigator.clipboard
    .writeText(el.textContent)
    .then(() => {
      const btn = document.activeElement;
      const orig = btn.textContent;
      btn.textContent = '✓ Skopiowano!';
      setTimeout(() => (btn.textContent = orig), 1800);
    })
    .catch(() => alert('Nie udało się skopiować — zaznacz i skopiuj ręcznie.'));
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
