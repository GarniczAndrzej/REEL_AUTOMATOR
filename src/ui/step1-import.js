// Step-1 orchestrator. Wires the import-section submodules (segments,
// transcription, project I/O, multi-source) and preserves the public surface
// main.js depends on: init. (S-16 Phase 3a — structural split, no behavior
// change.)

import { initSegments } from './import/segments.js';
import { initTranscribe } from './import/transcribe.js';
import { initProjectIO } from './import/project-io.js';
import { initMultiSource } from './import/multi-source.js';

export function init() {
  initSegments();
  initTranscribe();
  initProjectIO();
  initMultiSource();
}
