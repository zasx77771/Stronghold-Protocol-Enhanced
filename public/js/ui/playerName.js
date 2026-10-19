import { NAME_MAX_LEN, NAME_MAX_UNITS } from '../../../shared/constants.js';
import { clampName } from '../../../shared/nameWidth.js';

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_UNITS display columns — the
 * protocol's `hello.name` limit (a wide character counts two, so 16 Latin or 8 Hanzi) — without
 * splitting a surrogate pair. NAME_MAX_LEN still caps the code-point count.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  s = clampName(s, NAME_MAX_UNITS);
  if (s.length > NAME_MAX_LEN) s = s.slice(0, NAME_MAX_LEN);
  // Don't leave half a surrogate pair at the end.
  if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
  return s.trim();
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;
