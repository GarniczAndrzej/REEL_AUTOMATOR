// Single source of truth for the canonical hook/body/punchline marker LABELS,
// shared by every exporter (EDL / xmeml XML / Lua / FCPXML). A future label
// rename touches one place instead of four. Colors stay format-local: each
// exporter zips these labels with its own color vocabulary (EDL/xmeml/Lua have
// named colors; FCPXML has no color channel and encodes the label in `value`).
//
// Order and labels match the original hard-coded list in edl.js so EDL output
// stays byte-identical (regression Test 3/13).
//
// @type {Array<[key: 'hook'|'body'|'punchline', label: string]>}
export const MARKER_LABELS = [
  ['hook', 'HOOK'],
  ['body', 'BODY'],
  ['punchline', 'PUNCHLINE'],
];
