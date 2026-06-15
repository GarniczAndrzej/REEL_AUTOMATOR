// Step-1 orchestrator. Wires the import-section submodules (segments,
// transcription, project I/O) and preserves the public surface main.js depends
// on: init. (S-16 Phase 3a — structural split; 3b dropped the multi-source
// repeater.)

import { initSegments } from './import/segments.js';
import { initTranscribe } from './import/transcribe.js';
import { initProjectIO } from './import/project-io.js';

export function init() {
  initSegments();
  initTranscribe();
  initProjectIO();
}
