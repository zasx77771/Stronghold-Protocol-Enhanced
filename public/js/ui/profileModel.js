// Device-local player profile (no account): the display name the player types on the title screen plus the NAMED
// 配队 list (干员调配 presets), so a client restart restores what the player set up last time.
//
// Storage (store.js loadPref / savePref, localStorage prefix `sp.pref.`): `sp.pref.profile` =
//   { schemaVersion: 1, name, rememberName, presets: [{ id, name, entries, ops, savedAt }], lastPresetId, updatedAt }
// Every field is non-sensitive and device-local: a display name, and the operator choices that are still meaningful
// in the next match (技能 / 模组 = `entries`, 潜能 / 练度 = `ops`, the same shape as `sp.pref.loadout`). Never stored
// here: authentication credentials or tokens, the four-digit account tag, server-side identity, match results or
// replay data. The server stays the authority: a restored 配队 is passed through the ordinary
// loadoutSync.applyLoadoutEntries path (sanitiseEntries / sanitizeOps against the loaded data), so an operator that
// disappeared, a choice that became illegal or a capacity change filters the preset down instead of sending it.
//
// Compatibility: the display name used to live only in `sp.name` / `sp.rememberName` (public/js/net.js identity).
// loadProfile() takes those as `legacyName` / `legacyRemember` so an existing install keeps its name; the caller
// mirrors every write back into the legacy keys, so older readers and the opt-in browser suites keep working.
//
// Safe degradation: any junk (`null`, a string, a corrupt object, a future schemaVersion, unknown fields, a
// `__proto__` id) parses into a structurally valid profile, never throws, and never blocks client startup.

import { loadPref, savePref } from '../store.js';
import { LOADOUT_VERSION, parseStored, parseStoredOps } from './loadoutModel.js';
import { NAME_MAX_LEN } from '../../../shared/constants.js';

/** localStorage key (store.js loadPref / savePref prefix `sp.pref.`) and format version. */
export const PROFILE_PREF = 'profile';
export const PROFILE_VERSION = 1;
/** Most 配队 kept on the device (the oldest is dropped when the list is full). */
export const PROFILE_MAX_PRESETS = 20;
/** Longest 配队 name accepted (a label, not an identity). */
export const LINEUP_NAME_MAX_LEN = 24;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const PRESET_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A label the player typed: printable text only, no control characters (`__proto__`-style ids are not ids here).
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Truncate to `max` UTF-16 code units (what `hello.name` is measured in, shared/protocol.js) without cutting a
 *  surrogate pair in half, then drop a trailing space the cut may have left. */
function clip(s, max) {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out.trim();
}

/**
 * The display name to store: printable, single-spaced, `NAME_MAX_LEN` code points, empty when there is nothing usable.
 * @param {any} raw
 * @returns {string}
 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return clip(raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), NAME_MAX_LEN);
}

/**
 * The 配队 label to store (same rules as the display name, `LINEUP_NAME_MAX_LEN`).
 * @param {any} raw
 * @returns {string}
 */
export function cleanLineupName(raw) {
  if (typeof raw !== 'string') return '';
  return clip(raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), LINEUP_NAME_MAX_LEN);
}

/** @param {number} [now] @returns {string} a fresh 配队 id (never a real identity, just a local key) */
export function newPresetId(now = Date.now()) {
  return `lp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {{ schemaVersion: number, name: string, rememberName: boolean, presets: any[], lastPresetId: string|null, updatedAt: number }} */
export function emptyProfile() {
  return { schemaVersion: PROFILE_VERSION, name: '', rememberName: true, presets: [], lastPresetId: null, updatedAt: 0 };
}

/**
 * Structurally valid profile from anything (junk → the empty profile): names are cleaned, every 配队 keeps only what
 * `parseStored` / `parseStoredOps` accept (id shape, integer skill, module id, 潜能 / 练度 ranges, per-map caps), the
 * list is capped and deduplicated, an unknown `schemaVersion` is simply read structurally and reported as the current
 * version. Never throws.
 * @param {any} raw
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function sanitizeProfile(raw) {
  const out = emptyProfile();
  if (!isObj(raw)) return out;
  out.name = cleanName(raw.name);
  out.rememberName = raw.rememberName !== false;
  const seen = new Set();
  const list = Array.isArray(raw.presets) ? raw.presets : [];
  for (const p of list) {
    if (out.presets.length >= PROFILE_MAX_PRESETS) break;
    if (!isObj(p)) continue;
    const label = cleanLineupName(p.name);
    if (!label) continue;
    const id = typeof p.id === 'string' && PRESET_ID.test(p.id) && p.id !== '__proto__' ? p.id : newPresetId();
    if (seen.has(id)) continue;
    seen.add(id);
    out.presets.push({
      id,
      name: label,
      entries: parseStored(isObj(p.entries) ? { v: LOADOUT_VERSION, entries: p.entries } : null),
      ops: parseStoredOps(isObj(p.ops) ? { v: LOADOUT_VERSION, ops: p.ops } : null),
      savedAt: Number.isFinite(p.savedAt) ? p.savedAt : 0,
    });
  }
  out.lastPresetId = typeof raw.lastPresetId === 'string' && seen.has(raw.lastPresetId) ? raw.lastPresetId : null;
  out.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  return out;
}

/**
 * The stored profile, with the pre-model `sp.name` / `sp.rememberName` values of an existing install folded in once
 * (public/js/net.js identity owns those keys; the caller passes them in). `legacyRemember === null` means “no legacy
 * value”, so the stored preference stays.
 * @param {{ legacyName?: string, legacyRemember?: boolean|null }} [legacy]
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function loadProfile({ legacyName = '', legacyRemember = null } = {}) {
  const stored = loadPref(PROFILE_PREF, null);
  const prof = sanitizeProfile(stored);
  const old = cleanName(legacyName);
  if (!old) return prof;
  if (!isObj(stored) || !prof.name) {
    // First run after the upgrade (or a profile whose name field is empty): keep the name the player already had.
    return { ...prof, name: old, rememberName: legacyRemember === false ? false : prof.rememberName };
  }
  return prof;
}

/**
 * Persist a profile (sanitised first, so nothing invalid ever reaches localStorage).
 * @param {any} profile
 * @param {{ now?: number }} [o]
 * @returns {ReturnType<typeof emptyProfile>} the stored value
 */
export function saveProfile(profile, { now = Date.now() } = {}) {
  const clean = { ...sanitizeProfile(profile), updatedAt: now };
  savePref(PROFILE_PREF, clean);
  return clean;
}

/** Clear everything this feature stores on the device (配队 list and the stored display name). */
export function clearProfile() {
  savePref(PROFILE_PREF, emptyProfile());
  return emptyProfile();
}

/**
 * Set the display name (an empty string clears it).
 * @param {any} profile @param {any} name
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function setPlayerName(profile, name) {
  return { ...sanitizeProfile(profile), name: cleanName(name) };
}

/**
 * Set whether the display name is remembered on this device.
 * @param {any} profile @param {boolean} on
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function setRememberName(profile, on) {
  return { ...sanitizeProfile(profile), rememberName: on !== false };
}

/**
 * Save the current 干员调配 as a named device-local 配队. Saving the same name again replaces that entry; a payload with
 * nothing reusable (no 技能 / 模组 and no 潜能 / 练度) is refused so a meaningless entry is never created.
 * @param {any} profile
 * @param {{ name?: string, entries?: Record<string, any>, ops?: Record<string, any>, now?: number }} o
 * @returns {{ profile: ReturnType<typeof emptyProfile>, preset: { id: string, name: string, entries: any, ops: any, savedAt: number } }|null}
 */
export function saveLineup(profile, { name, entries = {}, ops = {}, now = Date.now() } = {}) {
  const base = sanitizeProfile(profile);
  const label = cleanLineupName(name);
  if (!label) return null;
  const cleanEntries = parseStored(isObj(entries) ? { v: LOADOUT_VERSION, entries } : null);
  const cleanOps = parseStoredOps(isObj(ops) ? { v: LOADOUT_VERSION, ops } : null);
  if (!Object.keys(cleanEntries).length && !Object.keys(cleanOps).length) return null;
  const same = base.presets.find((p) => p.name === label);
  const preset = { id: same?.id || newPresetId(now), name: label, entries: cleanEntries, ops: cleanOps, savedAt: now };
  const presets = [...base.presets.filter((p) => p.id !== preset.id), preset];
  while (presets.length > PROFILE_MAX_PRESETS) presets.shift();
  return { profile: { ...base, presets, lastPresetId: preset.id }, preset };
}

/**
 * Remove one 配队.
 * @param {any} profile @param {string} id
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function deleteLineup(profile, id) {
  const base = sanitizeProfile(profile);
  const presets = base.presets.filter((p) => p.id !== id);
  if (presets.length === base.presets.length) return base;
  return { ...base, presets, lastPresetId: base.lastPresetId === id ? null : base.lastPresetId };
}

/**
 * One stored 配队 (`null` when the id is unknown).
 * @param {any} profile @param {string} id
 * @returns {{ id: string, name: string, entries: any, ops: any, savedAt: number }|null}
 */
export function lineupOf(profile, id) {
  const base = sanitizeProfile(profile);
  return base.presets.find((p) => p.id === id) || null;
}

/**
 * Remember which 配队 the player applied last (so the UI can mark it); an unknown id clears the mark.
 * @param {any} profile @param {string|null} id
 * @returns {ReturnType<typeof emptyProfile>}
 */
export function markLineupUsed(profile, id) {
  const base = sanitizeProfile(profile);
  return { ...base, lastPresetId: base.presets.some((p) => p.id === id) ? id : null };
}
