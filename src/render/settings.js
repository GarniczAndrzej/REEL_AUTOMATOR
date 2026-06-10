export const PLATFORM_PRESETS = {
  tiktok: {
    label: 'TikTok',
    config: { aspect: 'vertical_9_16', videoBitrate: '8M', loudnessNormalize: true },
  },
  reels: {
    label: 'Instagram Reels',
    config: { aspect: 'vertical_9_16', videoBitrate: '8M', loudnessNormalize: true },
  },
  shorts: {
    label: 'YouTube Shorts',
    config: { aspect: 'vertical_9_16', videoBitrate: '10M', loudnessNormalize: false },
  },
  x: {
    label: 'X / Twitter',
    config: { aspect: 'source', videoBitrate: '5M', loudnessNormalize: false },
  },
};

export const defaultRenderConfig = () => ({
  aspect: 'source',           // 'source' | 'vertical_9_16' | 'both'
  logo: null,                 // null | { path, position, opacity, widthPct }
  intro: null,                // null | { path }
  outro: null,                // null | { path }
  loudnessNormalize: false,
  videoBitrate: '8M',
  outDir: '',
  // Phase 3
  burnSubtitles: false,
  subtitleStyle: null,        // null = use default style
  streamCopy: false,
  concurrency: 2,
  // Phase 4 F2
  videoCodec: 'auto',         // 'auto' | 'libx264' | 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv'
  // Phase 4 F4
  removeFillers: false,
  // Phase 4 F5
  faceTrackingMode: 'center',  // 'center' | 'auto'
});
