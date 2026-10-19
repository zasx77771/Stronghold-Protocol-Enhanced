// shared/nameWidth.js — the callsign limit is measured in display units, not code points.
//
// A wide character (CJK ideograph, kana, Hangul, full-width form, emoji) takes two columns in every
// font the client ships, so NAME_MAX_UNITS = 16 accepts either 16 Latin characters or 8 Hanzi (or a
// mix that adds up to 16 columns). Both the browser screen (public/js/ui/playerName.js) and the
// server's hello validation (server/net.js) clamp with the same functions, so a name the client
// accepts is never truncated differently by the server.

// East Asian Wide / Fullwidth code points plus emoji ranges (Unicode 15 EastAsianWidth W/F).
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** @param {unknown} text @returns {number} display columns (wide = 2) */
export function nameWidth(text) {
  let n = 0;
  for (const ch of String(text ?? '')) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/**
 * Longest prefix of `text` whose display width does not exceed `maxUnits`. Iterating with for…of
 * keeps surrogate pairs whole, so a clamp never leaves half an emoji behind.
 * @param {unknown} text
 * @param {number} maxUnits
 * @returns {string}
 */
export function clampName(text, maxUnits) {
  let out = '';
  let n = 0;
  for (const ch of String(text ?? '')) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (n + w > maxUnits) break;
    out += ch;
    n += w;
  }
  return out;
}
