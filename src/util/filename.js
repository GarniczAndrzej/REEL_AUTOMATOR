// Shared filename-stem helper. Several export paths (single-video, batch,
// export popover) need to derive an output base name from a source file name —
// keep that logic in one place so the stem rules stay consistent.

/**
 * Strip the extension from a file name, returning the stem.
 * Falls back to `'reels'` for an empty/extensionless input so callers always
 * get a usable default base name.
 * @param {string} name
 * @returns {string} filename stem (extension stripped)
 */
export function stripExt(name) {
  const dot = (name || '').lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base || 'reels';
}
