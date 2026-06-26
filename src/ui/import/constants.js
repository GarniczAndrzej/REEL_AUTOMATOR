// Import-section constants, kept in a dependency-free leaf module so the value is
// fully initialized before any consumer's module namespace is assembled. This
// matters in the production bundle (S-09 Electron target): transcribe.js is
// dynamically imported by export-srt.js, so Rollup builds its namespace object
// eagerly — and transcribe.js re-exports MIN_CHARS across the
// segments.js <-> transcribe.js import cycle. Sourcing MIN_CHARS from this leaf
// (no imports, no cycle) avoids the "Cannot access 'MIN_CHARS' before
// initialization" temporal-dead-zone crash that the `vite dev` server hid.

/** Minimum sentence length (chars) for SRT/VTT/word segmentation. */
export const MIN_CHARS = 20;
