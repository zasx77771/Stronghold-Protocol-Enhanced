// 本地资料 (public/js/ui/profileModel.js): the device-local, account-free player profile — the display name the player
// typed plus the named 干员调配 presets. Covers what the feature must never get wrong: the serialisation round-trip
// (save, then the next client start reads it back), a junk / old-version / corrupt record degrading to a usable one,
// the capacity and 干员 filtering on restore, and that nothing sensitive (a tag, credentials, match or replay data) is
// stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROFILE_PREF, PROFILE_VERSION, PROFILE_MAX_PRESETS, LINEUP_NAME_MAX_LEN,
  cleanName, cleanLineupName, emptyProfile, sanitizeProfile, loadProfile, saveProfile, clearProfile,
  setPlayerName, setRememberName, saveLineup, deleteLineup, lineupOf, markLineupUsed,
} from '../public/js/ui/profileModel.js';
import { applyLoadoutEntries, loadoutStore } from '../public/js/ui/loadoutSync.js';
import { checkLoadout, LOADOUT_LIMITS } from '../shared/protocol.js';
import { NAME_MAX_LEN } from '../shared/constants.js';

const CHESS = JSON.parse(readFileSync(new URL('../data/chess.json', import.meta.url)));
const lookup = (id) => CHESS[id] || null;
// A real normal chess whose second skill is a legal, non-default choice — the entries a preset restores must survive
// checkLoadout, which drops an entry equal to the operator's default.
const CHESS_ID = Object.keys(CHESS).find((id) => {
  const res = checkLoadout({ [id]: { skill: 1 } }, lookup);
  return res.ok && !!res.loadout[id];
});
assert.ok(CHESS_ID, 'the data must have an operator with a selectable second skill');
const CHAR = CHESS[CHESS_ID].charId;
const GONE_CHESS = 'chess_nope_9_99_a';   // structurally valid id, not in chess.json
const GONE_CHAR = 'char_nope_9_99';
// `skill` is never 0: an entry equal to the operator's default is dropped by checkLoadout, so it could not round-trip.
const entriesOf = (skill = 1) => ({ [CHESS_ID]: { skill } });
const opsOf = (potential = 2) => ({ [CHAR]: { potential } });
const isOperator = (id) => id === CHAR;

/**
 * The model reads and writes through store.js loadPref / savePref, i.e. `sp.pref.profile` in localStorage. A real browser
 * is not needed: a Map-backed shim is enough to see the exact bytes the feature leaves on the device.
 * @returns {Map<string, string>} the raw store (key → string value)
 */
function installLocalStorage() {
  const map = new Map();
  const shim = {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
  return map;
}
const storedRaw = () => globalThis.localStorage.getItem(`sp.pref.${PROFILE_PREF}`);
const setStoredRaw = (text) => globalThis.localStorage.setItem(`sp.pref.${PROFILE_PREF}`, text);
const setStored = (value) => setStoredRaw(JSON.stringify(value));
const stored = () => { const raw = storedRaw(); return raw == null ? null : JSON.parse(raw); };

test('profile: a saved 配队 round-trips through localStorage and is restored on the next client start', () => {
  installLocalStorage();
  const r = saveLineup(setPlayerName(emptyProfile(), '博士A'), { name: '快攻', entries: entriesOf(1), ops: opsOf(2) });
  assert.ok(r, 'a 配队 with entries is saved');
  saveProfile(r.profile);

  // what is on the device: one JSON record, the current schema version, the name and the 配队
  assert.equal(stored().schemaVersion, PROFILE_VERSION);
  assert.equal(stored().name, '博士A');
  assert.equal(stored().presets.length, 1);
  assert.equal(stored().lastPresetId, r.preset.id);

  // the next client start: no arguments, straight from `sp.pref.profile`
  const back = loadProfile();
  assert.equal(back.name, '博士A');
  assert.equal(back.rememberName, true);
  assert.equal(back.presets.length, 1);
  assert.equal(back.presets[0].id, r.preset.id);
  assert.equal(back.presets[0].name, '快攻');
  assert.deepEqual(back.presets[0].entries, entriesOf(1));
  assert.deepEqual(back.presets[0].ops, opsOf(2));
  assert.equal(lineupOf(back, r.preset.id).name, '快攻');
  assert.equal(lineupOf(back, 'lp_missing'), null);
});

test('profile: the device record holds no tag, credential, match or replay data', () => {
  const map = installLocalStorage();
  const r = saveLineup(setPlayerName(emptyProfile(), '博士A'), { name: 'A', entries: entriesOf(), ops: {} });
  saveProfile(r.profile);
  assert.deepEqual([...map.keys()], [`sp.pref.${PROFILE_PREF}`], 'only the profile key is written');
  assert.doesNotMatch(storedRaw(), /tag|token|password|userId|replay|match/i);
});

test('profile: junk, a string, a list or a future schemaVersion never throws and degrades to an empty profile', () => {
  installLocalStorage();
  const empty = emptyProfile();
  for (const raw of [null, 'not json at all', '"a string"', '[]', '0', 'true']) {
    if (raw == null) globalThis.localStorage.removeItem(`sp.pref.${PROFILE_PREF}`); else setStoredRaw(raw);
    assert.deepEqual(loadProfile(), empty, `raw ${String(raw)}`);
  }
  // a structurally wrong record claiming a future version: read structurally, every bad field falls back, nothing throws
  setStored({
    schemaVersion: 999,
    name: 123,
    rememberName: 'yes',
    presets: 'nope',
    lastPresetId: { id: 'x' },
    updatedAt: 'now',
    extra: { nested: true },
  });
  assert.deepEqual(loadProfile(), empty);
  assert.deepEqual(sanitizeProfile(undefined), empty);
  assert.deepEqual(sanitizeProfile('nope'), empty);
  assert.deepEqual(sanitizeProfile([]), empty);
  // an older shape (the pre-model key names) is ignored rather than half-read
  setStored({ v: 0, loadouts: [{ name: 'old' }] });
  assert.deepEqual(loadProfile(), empty);
});

test('profile: a corrupt 配队 list keeps the usable 配队 and drops the junk', () => {
  installLocalStorage();
  setStored({
    schemaVersion: 1,
    name: ' 博士   甲 ',
    rememberName: false,
    presets: [
      { id: 'a', name: 'A', entries: entriesOf(2), ops: opsOf(3), savedAt: 5 },
      { id: 'a', name: 'A 重复 id', entries: entriesOf(1) },            // duplicate id: dropped
      'junk',                                                          // not an object: dropped
      { id: 'b', name: '   ' },                                        // no label: dropped
      { id: 'c', name: 'C', entries: { [GONE_CHESS]: { skill: 1 } } },  // unknown chess: stored, filtered on restore
      { id: '__proto__', name: 'proto', entries: entriesOf(1) },        // never used as an object key elsewhere
    ],
  });
  const p = loadProfile();
  assert.equal(p.name, '博士 甲');
  assert.equal(p.rememberName, false);
  assert.deepEqual(p.presets.map((x) => x.name), ['A', 'C', 'proto']);
  assert.deepEqual(p.presets[0].entries, entriesOf(2));
  assert.deepEqual(p.presets[0].ops, opsOf(3));
  assert.equal(p.presets[0].savedAt, 5);
  assert.notEqual(p.presets[2].id, '__proto__', 'a 配队 id that is not a plain key is replaced');
  assert.equal(Object.prototype.polluted, undefined, 'nothing reaches Object.prototype');
  // an unknown lastPresetId is dropped
  setStored({ schemaVersion: 1, presets: [{ id: 'a', name: 'A', entries: entriesOf() }], lastPresetId: 'zz' });
  assert.equal(loadProfile().lastPresetId, null);
});

test('profile: an over-long name or label is clipped to the limit in UTF-16 code units, safely', () => {
  assert.equal(cleanName('  a   b  '), 'a b');
  assert.equal(cleanName('a\u0000b\u001fc'), 'a b c');
  assert.equal(cleanName(null), '');
  assert.equal(cleanName(123), '');
  assert.equal(cleanName('x'.repeat(200)).length, NAME_MAX_LEN);
  assert.equal(cleanLineupName('y'.repeat(200)).length, LINEUP_NAME_MAX_LEN);
  const emoji = cleanName('😀'.repeat(200));
  assert.ok(emoji.length <= NAME_MAX_LEN, 'a surrogate pair is never left half cut');
  assert.doesNotMatch(emoji, /[\ud800-\udbff]$/);
  assert.equal(sanitizeProfile({ name: 'z'.repeat(200) }).name.length, NAME_MAX_LEN);
  assert.equal(cleanLineupName('配队'.repeat(200)).length, LINEUP_NAME_MAX_LEN);
});

test('profile: at most PROFILE_MAX_PRESETS 配队 are kept, and saving the same name replaces that one', () => {
  installLocalStorage();
  let profile = emptyProfile();
  for (let i = 0; i < PROFILE_MAX_PRESETS + 5; i++) {
    const r = saveLineup(profile, { name: `配队 ${i}`, entries: entriesOf(), ops: {} });
    assert.ok(r);
    profile = r.profile;
  }
  saveProfile(profile);
  const p = loadProfile();
  assert.equal(p.presets.length, PROFILE_MAX_PRESETS, 'the list is capped');
  assert.equal(p.presets.some((x) => x.name === '配队 0'), false, 'the oldest 配队 is dropped');
  assert.ok(p.presets.some((x) => x.name === `配队 ${PROFILE_MAX_PRESETS + 4}`));
  // the same label replaces the 配队 instead of adding a second one
  const again = saveLineup(p, { name: `配队 ${PROFILE_MAX_PRESETS + 4}`, entries: entriesOf(2), ops: {} });
  assert.equal(again.profile.presets.length, PROFILE_MAX_PRESETS);
  assert.deepEqual(lineupOf(again.profile, again.preset.id).entries, entriesOf(2));
});

test('profile: a 配队 with no label or nothing reusable is refused, and clearing leaves nothing behind', () => {
  installLocalStorage();
  const p = setPlayerName(emptyProfile(), '博士A');
  assert.equal(saveLineup(p, { name: '', entries: entriesOf(), ops: {} }), null, 'no label');
  assert.equal(saveLineup(p, { name: '   ', entries: entriesOf(), ops: {} }), null, 'blank label');
  assert.equal(saveLineup(p, { name: '空', entries: {}, ops: {} }), null, 'nothing reusable');
  const r = saveLineup(p, { name: 'A', entries: entriesOf(), ops: {} });
  assert.ok(r);
  saveProfile(r.profile);
  assert.equal(loadProfile().presets.length, 1);

  // clear: the name and every 配队 are gone, and only an empty record is left on the device
  assert.deepEqual(clearProfile(), emptyProfile());
  assert.deepEqual(stored(), emptyProfile());
  assert.deepEqual(loadProfile(), emptyProfile());
});

test('profile: the pre-model sp.name / sp.rememberName of an existing install is adopted, once', () => {
  installLocalStorage();
  // an install that only has the legacy keys keeps the name it remembered
  assert.equal(loadProfile({ legacyName: '老博士', legacyRemember: true }).name, '老博士');
  assert.equal(loadProfile({ legacyName: '老博士', legacyRemember: false }).name, '老博士');
  assert.equal(loadProfile({ legacyName: '老博士', legacyRemember: false }).rememberName, false);
  assert.equal(loadProfile({ legacyName: '', legacyRemember: true }).name, '');
  // the legacy name is cleaned like any other
  assert.equal(loadProfile({ legacyName: ' a\u0000b ' }).name, 'a b');
  // a profile that already has a name wins over the legacy key
  saveProfile(setPlayerName(emptyProfile(), '新博士'));
  assert.equal(loadProfile({ legacyName: '老博士', legacyRemember: true }).name, '新博士');
});

test('profile: setPlayerName / setRememberName keep the 配队 list', () => {
  installLocalStorage();
  const r = saveLineup(emptyProfile(), { name: 'A', entries: entriesOf(), ops: {} });
  const changed = setPlayerName(setRememberName(r.profile, false), ' 博士   乙 ');
  assert.equal(changed.name, '博士 乙');
  assert.equal(changed.rememberName, false);
  assert.equal(changed.presets.length, 1);
  saveProfile(changed);
  const back = loadProfile();
  assert.equal(back.name, '博士 乙');
  assert.equal(back.rememberName, false);
  assert.equal(back.presets.length, 1);
});

test('profile: markLineupUsed / deleteLineup keep lastPresetId consistent with the list', () => {
  installLocalStorage();
  const r = saveLineup(emptyProfile(), { name: 'A', entries: entriesOf(), ops: {} });
  const p = r.profile;
  assert.equal(p.lastPresetId, r.preset.id);
  assert.equal(markLineupUsed(p, 'nope').lastPresetId, null);
  assert.equal(markLineupUsed(p, r.preset.id).lastPresetId, r.preset.id);
  const gone = deleteLineup(p, r.preset.id);
  assert.deepEqual(gone.presets, []);
  assert.equal(gone.lastPresetId, null);
  assert.deepEqual(deleteLineup(p, 'nope').presets, p.presets, 'an unknown id changes nothing');
});

// ---- restoring into the live 干员调配 (the same path 导入 uses: sanitise, then persist) -----------------------------

test('restore: an operator that no longer exists is filtered out, the legal ones are applied', () => {
  installLocalStorage();
  const entries = { ...entriesOf(1), [GONE_CHESS]: { skill: 0 } };
  const ops = { ...opsOf(2), [GONE_CHAR]: { potential: 3 } };
  const r = applyLoadoutEntries(entries, lookup, { ops, isOperator });
  assert.equal(r.applied, 1, 'the chess that still exists is applied');
  assert.equal(r.dropped, 2, 'the chess and the operator that are gone are dropped');
  assert.equal(r.ops, 1, 'the operator settings that still resolve are applied');
  assert.deepEqual(loadoutStore.get().entries, entriesOf(1));
  assert.deepEqual(loadoutStore.get().ops, opsOf(2));
});

test('restore: a 配队 that resolves to nothing changes nothing at all', () => {
  installLocalStorage();
  const before = loadoutStore.get().entries;
  const r = applyLoadoutEntries({ [GONE_CHESS]: { skill: 1 } }, lookup, { ops: { [GONE_CHAR]: { potential: 1 } }, isOperator: () => false });
  assert.deepEqual(r, { applied: 0, dropped: 2, ops: 0 });
  assert.deepEqual(loadoutStore.get().entries, before, 'the current 干员调配 is untouched');
});

test('restore: an illegal choice is dropped instead of being applied, a legal one is kept', () => {
  installLocalStorage();
  // a skill index and a 潜能 outside the legal range: sanitizeEntries / sanitizeOps drop them one by one
  const bad = applyLoadoutEntries({ [CHESS_ID]: { skill: 99 } }, lookup, { ops: { [CHAR]: { potential: 99 } }, isOperator });
  assert.deepEqual(bad, { applied: 0, dropped: 2, ops: 0 });
  const good = applyLoadoutEntries(entriesOf(1), lookup, { ops: opsOf(2), isOperator });
  assert.deepEqual(good, { applied: 1, dropped: 0, ops: 1 });
  assert.deepEqual(loadoutStore.get().entries, entriesOf(1));
  assert.deepEqual(loadoutStore.get().ops, opsOf(2));
});

test('restore: more entries than a preset may carry are trimmed to the capacity, never refused', () => {
  installLocalStorage();
  // every structurally valid id that is not in chess.json: sanitiseEntries drops them one by one, without refusing
  const many = {};
  for (let i = 0; i < 400; i++) many[`chess_nope_${i}_01_a`] = { skill: 1 };
  const r = applyLoadoutEntries(many, lookup, {});
  assert.equal(r.applied, 0);
  assert.equal(r.dropped, Object.keys(many).length);
  // the stored 配队 is capped at the 干员调配 capacity in the first place (a preset may never exceed the mode)
  const huge = saveLineup(emptyProfile(), { name: 'huge', entries: many, ops: {} });
  assert.ok(huge);
  assert.equal(Object.keys(huge.preset.entries).length, LOADOUT_LIMITS.entries);
  saveProfile(huge.profile);
  assert.equal(Object.keys(loadProfile().presets[0].entries).length, LOADOUT_LIMITS.entries);
});
