export function buildPrompt(
  userPrompt,
  sentences,
  sources = null,
  primaryFilename = '',
) {
  const formatSentence = (s) => ({
    id: s.id,
    text: s.text,
    start_tc: s.start_tc,
    end_tc: s.end_tc,
    duration_frames: s.duration_frame,
  });

  let segmentsBlock;
  const hasMultipleSources = sources && sources.length > 0;

  if (hasMultipleSources) {
    // Group sentences by source_idx
    const sourceCount = sources.length + 1; // +1 for primary source (idx 0)
    const grouped = Array.from({ length: sourceCount }, () => []);
    for (const s of sentences) {
      const si = s.source_idx ?? 0;
      if (si < grouped.length) grouped[si].push(s);
    }
    const blocks = grouped
      .map((group, si) => {
        const label =
          si === 0
            ? `[ŹRÓDŁO 1]${primaryFilename ? ' — ' + primaryFilename : ''}`
            : `[ŹRÓDŁO ${si + 1}]${sources[si - 1]?.videoFilename ? ' — ' + sources[si - 1].videoFilename : ''}`;
        return `${label}\n${JSON.stringify(group.map(formatSentence), null, 2)}`;
      })
      .filter((_, si) => grouped[si].length > 0);
    segmentsBlock = blocks.join('\n\n');
  } else {
    segmentsBlock = JSON.stringify(sentences.map(formatSentence), null, 2);
  }

  const multiSourceNote = hasMultipleSources
    ? '\nWAŻNE: Nie łącz segmentów z różnych źródeł w jednym Reelu — każde [ŹRÓDŁO N] to osobny plik wideo.\n'
    : '';

  return `${userPrompt}
${multiSourceNote}
DOSTĘPNE SEGMENTY (plik SRT zamieniony na zdania z timecodes):
${segmentsBlock}

OCZEKIWANY FORMAT ODPOWIEDZI — zwróć TYLKO czysty JSON, zero komentarzy, zero markdown:
[
  {
    "reel_name": "Reel 1 - Tytuł tematu",
    "clip_ids": [1, 2, 5, 6]
  },
  {
    "reel_name": "Reel 2 - Tytuł tematu",
    "clip_ids": [10, 11, 3]
  }
]`;
}
