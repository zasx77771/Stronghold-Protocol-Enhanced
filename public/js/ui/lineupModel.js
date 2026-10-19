// 本地配队 (enhanced, 阶段 E): named loadouts kept on this device — the model of the 本地配队 dialog of the 干员调配
// overlay (screens/loadout.js).
//
// Upstream keeps ONE loadout per browser (`sp.pref.loadout`, ui/loadoutSync.js: `{ v, entries, ops }`) and hands it out
// as a file through 导出 / 导入 (ui/loadoutModel.js exportPayload / parseImport). This adds a short list of named
// snapshots of that same loadout beside it, so switching a squad does not need a copy-paste or a file:
//
//   localStorage `sp.pref.lineups` = { v: 1, items: [{ id, name, at, entries, ops }] }
//
// `entries` / `ops` use the stored loadout's own shape (loadoutModel toStored), so a snapshot is exactly what
// `parseStored` / `parseStoredOps` read back and what `loadoutSync.applyLoadoutEntries` applies — the sanitiser, the
// persistence and the server-side check of `room.loadout` are the loadout's, not a second implementation. Nothing here
// touches the player name (net.js identity), the account, a match record or any server state: 本地配队 is a device
// convenience and the server stays the authority on what a seat may field.
//
// Bounds: LINEUPS_MAX snapshots (the oldest is dropped past it), names of LINEUP_NAME_MAX_LEN characters after the
// cleaning below (control, bidi and zero-width characters removed, whitespace collapsed, an unpaired surrogate never
// split). A snapshot whose payload keeps nothing at all is not stored. Any junk in storage reads as an empty list; a
// newer `v` is never mis-read (the same rule as parseImport).

import { loadPref, savePref } from '../store.js';
import { parseStored, parseStoredOps } from './loadoutModel.js';

/** localStorage key (store.js loadPref/savePref prefix `sp.pref.`) and format version. */
export const LINEUPS_PREF = 'lineups';
export const LINEUPS_VERSION = 1;
/** How many named loadouts a device keeps (the oldest is dropped past it). */
export const LINEUPS_MAX = 20;
/** Longest accepted 配队名称, in characters after cleaning. */
export const LINEUP_NAME_MAX_LEN = 24;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether a code point may appear in a 配队名称: no C0 / C1 control (tabs and newlines included), no line or paragraph
 * separator, no bidi embedding / override / isolate, no zero-width space / joiner / mark, no BOM, no unpaired surrogate.
 * @param {number} cp
 * @returns {boolean}
 */
function nameSafe(cp) {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return false;
  if (cp === 0x2028 || cp === 0x2029 || cp === 0xfeff) return false;
  if (cp >= 0x200b && cp <= 0x200f) return false;
  if (cp >= 0x202a && cp <= 0x202e) return false;
  if (cp >= 0x2066 && cp <= 0x2069) return false;
  return !(cp >= 0xd800 && cp <= 0xdfff);
}

/**
 * A character nameSafe rejects that is really a separator: a control character or a line / paragraph separator. Those
 * become a space, so a pasted multi-line name keeps its words apart; the invisible formatting ones are dropped instead.
 * @param {number} cp
 * @returns {boolean}
 */
const isSeparator = (cp) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;

/**
 * A 配队名称 as it is stored: the characters nameSafe keeps, a control / line separator read as a space, runs of
 * whitespace collapsed to one space, trimmed and cut to LINEUP_NAME_MAX_LEN without splitting a surrogate pair.
 * Junk (null, a number, a non-string) gives ''.
 * @param {any} raw
 * @returns {string}
 */
export function cleanLineupName(raw) {
  if (typeof raw === 'string') {
    let s = '';
    for (const ch of raw) {
      const cp = ch.codePointAt(0);
      if (nameSafe(cp)) s += ch;
      else if (isSeparator(cp)) s += ' ';
    }
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > LINEUP_NAME_MAX_LEN) {
      const cut = s.slice(0, LINEUP_NAME_MAX_LEN);
      // a high surrogate at the cut would be left alone (a lone one) — drop it instead
      return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    }
    return s;
  }
  return '';
}

/**
 * A fresh snapshot id: `lp_<base36 time>_<6 random base36>` (≤ 64 chars, ID_RE-safe). `rand` is injectable for tests.
 * @param {number} [now] @param {() => number} [rand]
 * @returns {string}
 */
export function newLineupId(now = Date.now(), rand = Math.random) {
  const r = Number(rand());
  const suffix = Math.floor((Number.isFinite(r) ? Math.max(0, Math.min(0.999999, r)) : 0) * 36 ** 6).toString(36).padStart(6, '0').slice(-6);
  return `lp_${Math.max(0, Math.floor(Number(now) || 0)).toString(36)}_${suffix}`;
}

/** An empty list. */
export const emptyLineups = () => ({ v: LINEUPS_VERSION, items: [] });

/**
 * The structurally valid list of a raw stored value: junk, an older shape, a newer `v` or a `__proto__` id drops out;
 * a snapshot that keeps neither an entry nor a setting is not a loadout and is dropped. Ids are made unique (a repeat
 * is dropped) and at most LINEUPS_MAX items are kept, in stored order (newest first).
 * @param {any} raw
 * @returns {{ v: number, items: { id: string, name: string, at: number, entries: Record<string, any>, ops: Record<string, any> }[] }}
 */
export function sanitizeLineups(raw) {
  const out = emptyLineups();
  if (!isObj(raw) || raw.v !== LINEUPS_VERSION || !Array.isArray(raw.items)) return out;
  const seen = new Set();
  for (const it of raw.items) {
    if (out.items.length >= LINEUPS_MAX) break;
    if (!isObj(it) || typeof it.id !== 'string' || !ID_RE.test(it.id) || UNSAFE_IDS.has(it.id) || seen.has(it.id)) continue;
    const name = cleanLineupName(it.name);
    if (!name) continue;
    const entries = parseStored({ entries: it.entries });
    const ops = parseStoredOps({ ops: it.ops });
    if (!Object.keys(entries).length && !Object.keys(ops).length) continue;
    seen.add(it.id);
    out.items.push({ id: it.id, name, at: Number.isFinite(it.at) && it.at > 0 ? Math.floor(it.at) : 0, entries, ops });
  }
  return out;
}

/** The list stored on this device (any junk reads as empty). @returns {ReturnType<typeof sanitizeLineups>} */
export function loadLineups() {
  return sanitizeLineups(loadPref(LINEUPS_PREF, null));
}

/**
 * Store a list (sanitised first; a refused write — private mode, full quota — keeps the session's copy only).
 * @param {any} raw @returns {ReturnType<typeof sanitizeLineups>} what was stored
 */
export function saveLineups(raw) {
  const doc = sanitizeLineups(raw);
  savePref(LINEUPS_PREF, doc);
  return doc;
}

/**
 * Save the current loadout as a named snapshot. A name already in the list overwrites that snapshot (its content and
 * time; the id is kept) and the list stays newest-first; past LINEUPS_MAX the oldest is dropped. Nothing is written
 * when the name is empty or the payload keeps nothing.
 * @param {any} raw the loaded list @param {{ name?: any, entries?: any, ops?: any, now?: number, rand?: () => number }} [o]
 * @returns {{ ok: true, doc: ReturnType<typeof sanitizeLineups>, item: { id: string, name: string, at: number, entries: Record<string, any>, ops: Record<string, any> }, replaced: boolean } | { ok: false, error: 'NAME_REQUIRED' | 'EMPTY' }}
 */
export function saveLineup(raw, { name, entries, ops = {}, now = Date.now(), rand = Math.random } = {}) {
  const list = sanitizeLineups(raw);
  const clean = cleanLineupName(name);
  if (!clean) return { ok: false, error: 'NAME_REQUIRED' };
  const keptEntries = parseStored({ entries });
  const keptOps = parseStoredOps({ ops });
  if (!Object.keys(keptEntries).length && !Object.keys(keptOps).length) return { ok: false, error: 'EMPTY' };
  const at = Math.max(0, Math.floor(Number(now) || 0));
  const prev = list.items.find((it) => it.name === clean) || null;
  const item = { id: prev ? prev.id : newLineupId(at, rand), name: clean, at, entries: keptEntries, ops: keptOps };
  const items = [item, ...list.items.filter((it) => it !== prev && it.name !== clean)].slice(0, LINEUPS_MAX);
  return { ok: true, doc: saveLineups({ v: LINEUPS_VERSION, items }), item, replaced: !!prev };
}

/**
 * Drop one snapshot by id; a list without it is returned unchanged (still stored).
 * @param {any} raw @param {any} id @returns {ReturnType<typeof sanitizeLineups>}
 */
export function removeLineup(raw, id) {
  const list = sanitizeLineups(raw);
  return saveLineups({ v: LINEUPS_VERSION, items: list.items.filter((it) => it.id !== id) });
}

/** Delete every snapshot on this device (the loadout itself is untouched). @returns {ReturnType<typeof sanitizeLineups>} */
export const clearLineups = () => saveLineups(emptyLineups());

/** The snapshot of `id`, or null. @param {any} raw @param {any} id */
export function lineupOf(raw, id) {
  return sanitizeLineups(raw).items.find((it) => it.id === id) || null;
}

/**
 * What a snapshot applies: its entries and settings, copied (applying never aliases the stored object).
 * @param {{ entries?: any, ops?: any }} item
 * @returns {{ entries: Record<string, any>, ops: Record<string, any> }}
 */
export function lineupPayload(item) {
  return {
    entries: parseStored({ entries: item?.entries }),
    ops: parseStoredOps({ ops: item?.ops }),
  };
}

/**
 * How many operators a snapshot touches: the operators with a chosen skill / module plus those with 潜能 / 练度.
 * @param {{ entries?: any, ops?: any }} item
 * @returns {number}
 */
export function lineupSize(item) {
  const ids = new Set([...Object.keys(parseStored({ entries: item?.entries })), ...Object.keys(parseStoredOps({ ops: item?.ops }))]);
  return ids.size;
}
