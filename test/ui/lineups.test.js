// test/ui/lineups.test.js — 本地配队 (enhanced, 阶段 E): the named-loadout list kept on this device beside upstream's
// single `sp.pref.loadout` (public/js/ui/lineupModel.js):
//   the stored shape `{ v: 1, items: [{ id, name, at, entries, ops }] }` and its version guard,
//   name cleaning (control / bidi / zero-width characters, whitespace, the 24-character cap without splitting a
//   surrogate pair), the 20-snapshot cap and the same-name overwrite, refusing an empty name or an empty payload,
//   junk / hostile storage, deleting one and clearing all, a refused write (private mode),
//   that it never writes `sp.pref.loadout` or `sp.name`, and that applying a snapshot through the loadout's own
//   `applyLoadoutEntries` produces exactly the storage the upstream sync already writes (no second sanitiser).
//
// localStorage is faked per test (Node has none), the way test/ui/stats.test.js does it.
//
// Run: node --test test/ui/lineups.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LINEUPS_PREF, LINEUPS_VERSION, LINEUPS_MAX, LINEUP_NAME_MAX_LEN,
  cleanLineupName, newLineupId, emptyLineups, sanitizeLineups, loadLineups, saveLineups, saveLineup,
  removeLineup, clearLineups, lineupOf, lineupPayload, lineupSize,
} from '../../public/js/ui/lineupModel.js';
import { parseStored, parseStoredOps } from '../../public/js/ui/loadoutModel.js';
import { applyLoadoutEntries, setEntries, loadoutStore } from '../../public/js/ui/loadoutSync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHESS = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
const get = (id) => (Object.hasOwn(CHESS, id) ? CHESS[id] : null);
const INSIDE = 'chess_char_1_01_a';
const SWIRE = 'chess_char_3_04_a';
const INSIDE_CHAR = CHESS[INSIDE].charId;
const LINEUPS_KEY = `sp.pref.${LINEUPS_PREF}`;

/** Fake localStorage: Map-backed, optional key(s) that throw like a full quota. */
function fakeStorage({ failOn = null } = {}) {
  const m = new Map();
  const bad = failOn == null ? [] : [].concat(failOn);
  return {
    get raw() { return m; },
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { if (bad.includes(k) || bad.includes('*')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Run `fn` with a fake localStorage installed. */
function withStorage(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const ls = fakeStorage(opts);
  globalThis.localStorage = ls;
  try { return fn(ls); } finally { delete globalThis.localStorage; }
}

/** A saved snapshot through the public API. */
const save = (name, entries = { [INSIDE]: { skill: 0 } }, o = {}) => saveLineup(loadLineups(), { name, entries, ...o });

// ---- 配队名称 --------------------------------------------------------------------------------------------------------

test('cleanLineupName: keeps ordinary text, drops control / bidi / zero-width characters, collapses space, trims', () => {
  assert.equal(cleanLineupName('高台连携'), '高台连携');
  assert.equal(cleanLineupName('  高台连携  '), '高台连携');
  assert.equal(cleanLineupName('高台\u0000连携'), '高台 连携', 'a NUL reads as a space, not as a join');
  assert.equal(cleanLineupName('a\tb\nc'), 'a b c', 'tab / newline become one space');
  assert.equal(cleanLineupName('a\u2028b\u2029c'), 'a b c', 'line and paragraph separators too');
  assert.equal(cleanLineupName('a\u202Eb'), 'ab', 'the bidi override is dropped');
  assert.equal(cleanLineupName('a\u200Bb\u200Fc'), 'abc', 'zero-width space and RLM are dropped');
  assert.equal(cleanLineupName('a\uFEFFb'), 'ab', 'BOM is dropped');
  assert.equal(cleanLineupName('  a   b  '), 'a b', 'runs of spaces collapse');
  assert.equal(cleanLineupName(''), '');
  assert.equal(cleanLineupName('   '), '');
  assert.equal(cleanLineupName('\u0000\u202E'), '', 'only a separator and an invisible character: empty');
  for (const junk of [null, undefined, 42, {}, [], true]) assert.equal(cleanLineupName(junk), '', `${String(junk)} → ''`);
});

test('cleanLineupName: the cap cuts to LINEUP_NAME_MAX_LEN characters and never leaves half a surrogate pair', () => {
  assert.equal(LINEUP_NAME_MAX_LEN, 24);
  assert.equal(cleanLineupName('甲'.repeat(24)), '甲'.repeat(24), 'exactly the cap is kept');
  assert.equal(cleanLineupName('甲'.repeat(30)), '甲'.repeat(24), 'longer is cut');
  // 23 BMP characters + one astral one (2 code units): the cut would land inside the pair — drop it instead
  const mixed = cleanLineupName('a'.repeat(23) + '\u{1D538}');
  assert.equal(mixed, 'a'.repeat(23));
  assert.equal([...mixed].every((ch) => ch.codePointAt(0) <= 0xffff), true, 'no lone surrogate');
  assert.equal(cleanLineupName('\u{1D538}'.repeat(30)).length, 24, 'astral characters count as one each up to the cap');
});

test('newLineupId: `lp_<base36 time>_<6 base36>`, id-safe and injectable', () => {
  const id = newLineupId(1700000000000, () => 0);
  assert.match(id, /^lp_[0-9a-z]+_[0-9a-z]{6}$/);
  assert.equal(id, `lp_${(1700000000000).toString(36)}_000000`);
  assert.notEqual(newLineupId(1, () => 0.5), newLineupId(1, () => 0.25), 'the suffix keeps two saves apart in the same ms');
  assert.match(newLineupId(0, () => 0.999999), /^lp_0_/);
  assert.match(newLineupId(Number.NaN, () => Number.NaN), /^lp_0_000000$/, 'junk input is still a valid id');
});

// ---- 读取与存储 ------------------------------------------------------------------------------------------------------

test('loadLineups: no storage, junk, an older / newer shape — an empty list every time', () => {
  withStorage((ls) => {
    assert.deepEqual(loadLineups(), emptyLineups());
    const bad = ['', 'not json', 'null', '[]', '"x"', '42', '{"items":[]}', JSON.stringify({ v: 2, items: [{ id: 'lp_1', name: 'x', entries: { [INSIDE]: { skill: 0 } } }] }),
      JSON.stringify({ v: 1, items: 'nope' })];
    for (const raw of bad) {
      ls.getItem = () => raw;
      assert.deepEqual(loadLineups(), emptyLineups(), raw.slice(0, 40));
    }
  });
});

test('saveLineup: round trip through storage; newest first; exactly the stored shape', () => {
  withStorage((ls) => {
    const a = saveLineup(loadLineups(), { name: 'A', entries: { [INSIDE]: { skill: 0 } }, now: 1000, rand: () => 0 });
    assert.equal(a.ok, true);
    assert.equal(a.replaced, false);
    const b = saveLineup(loadLineups(), { name: 'B', entries: { [SWIRE]: { skill: 0 } }, now: 2000, rand: () => 0 });
    assert.equal(b.ok, true);
    const doc = loadLineups();
    assert.deepEqual(doc.items.map((it) => it.name), ['B', 'A'], 'newest first');
    assert.deepEqual(doc.v, LINEUPS_VERSION);
    assert.deepEqual(Object.keys(doc).sort(), ['items', 'v']);
    assert.deepEqual(Object.keys(doc.items[1]).sort(), ['at', 'entries', 'id', 'name', 'ops']);
    assert.deepEqual(doc.items[1].entries, { [INSIDE]: { skill: 0 } });
    assert.deepEqual(doc.items[1].ops, {});
    assert.equal(doc.items[1].at, 1000);
    const stored = JSON.parse(ls.getItem(LINEUPS_KEY));
    assert.deepEqual(stored, doc, 'what is in localStorage is the sanitised list');
    assert.equal(stored.v, 1);
  });
});

test('saveLineup: an empty name is refused (NAME_REQUIRED) and nothing is written', () => {
  withStorage((ls) => {
    for (const name of ['', '   ', null, undefined, '\u0000\u202E']) {
      assert.deepEqual(saveLineup(loadLineups(), { name }), { ok: false, error: 'NAME_REQUIRED' }, String(name));
    }
    assert.equal(ls.getItem(LINEUPS_KEY), null);
  });
});

test('saveLineup: a payload that keeps nothing is refused (EMPTY); junk inside one entry is sanitised away', () => {
  withStorage((ls) => {
    for (const entries of [{}, null, undefined, { [INSIDE]: {} }, { [INSIDE]: { skill: 99 } }, { 'bad id': { skill: 0 } }, { [INSIDE]: 'x' }]) {
      assert.deepEqual(saveLineup(loadLineups(), { name: 'A', entries }), { ok: false, error: 'EMPTY' }, JSON.stringify(entries));
    }
    assert.equal(ls.getItem(LINEUPS_KEY), null);
    // a mixed payload keeps the valid part
    const r = saveLineup(loadLineups(), { name: 'A', entries: { [INSIDE]: { skill: 0, junk: 1 }, [SWIRE]: { skill: 99 } } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.item.entries, { [INSIDE]: { skill: 0 } }, 'only the structurally valid entry is stored');
  });
});

test('saveLineup: a snapshot may hold 潜能 / 练度 settings only (no chosen skill)', () => {
  withStorage(() => {
    const r = saveLineup(loadLineups(), { name: '练度', entries: {}, ops: { [INSIDE_CHAR]: { potential: 1, cultivate: 2 } } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.item.entries, {});
    assert.deepEqual(r.item.ops, { [INSIDE_CHAR]: { potential: 1, cultivate: 2 } });
    assert.equal(lineupSize(r.item), 1);
  });
});

test('saveLineup: the same name overwrites in place — one snapshot, its id kept, the content and time replaced', () => {
  withStorage(() => {
    const first = saveLineup(loadLineups(), { name: '主力', entries: { [INSIDE]: { skill: 0 } }, now: 1000, rand: () => 0 });
    const second = saveLineup(loadLineups(), { name: '主力', entries: { [SWIRE]: { skill: 0 } }, now: 2000, rand: () => 0.5 });
    assert.equal(second.ok, true);
    assert.equal(second.replaced, true);
    assert.equal(second.item.id, first.item.id, 'the snapshot keeps its id');
    const doc = loadLineups();
    assert.equal(doc.items.length, 1);
    assert.equal(doc.items[0].name, '主力');
    assert.equal(doc.items[0].at, 2000);
    assert.deepEqual(doc.items[0].entries, { [SWIRE]: { skill: 0 } }, 'the newer content wins');
  });
});

test(`saveLineup: at most ${LINEUPS_MAX} snapshots — the oldest one goes`, () => {
  withStorage(() => {
    assert.equal(LINEUPS_MAX, 20);
    for (let i = 1; i <= LINEUPS_MAX; i++) {
      assert.equal(saveLineup(loadLineups(), { name: `L${i}`, entries: { [INSIDE]: { skill: 0 } }, now: i * 1000, rand: () => 0 }).ok, true);
    }
    let doc = loadLineups();
    assert.equal(doc.items.length, LINEUPS_MAX);
    assert.equal(doc.items[0].name, `L${LINEUPS_MAX}`, 'newest first');
    assert.equal(doc.items.at(-1).name, 'L1');
    // one past the cap: the list is full, so the oldest (L1) is dropped — not the new one
    assert.equal(saveLineup(loadLineups(), { name: 'L21', entries: { [INSIDE]: { skill: 0 } }, now: 21000, rand: () => 0 }).ok, true);
    doc = loadLineups();
    assert.equal(doc.items.length, LINEUPS_MAX);
    assert.equal(doc.items[0].name, 'L21');
    assert.deepEqual(doc.items.map((it) => it.name).includes('L1'), false, 'the oldest is gone');
  });
});

test('sanitizeLineups: hostile / duplicate ids and unknown fields are dropped, valid siblings kept', () => {
  const raw = {
    v: 1,
    items: [
      { id: '__proto__', name: 'hostile', entries: { [INSIDE]: { skill: 0 } } },
      { id: 'lp_1', name: 'one', at: 500, entries: { [INSIDE]: { skill: 0 } }, evil: 'ignored' },
      { id: 'lp_1', name: 'duplicate', entries: { [INSIDE]: { skill: 0 } } },
      { id: 'bad id!', name: 'bad', entries: { [INSIDE]: { skill: 0 } } },
      { id: 'lp_2', name: '   ', entries: { [INSIDE]: { skill: 0 } } },
      { id: 'lp_3', name: 'empty payload', entries: {}, ops: {} },
      { id: 'lp_4', name: 'no at', entries: { [SWIRE]: { skill: 0 } }, at: 'yesterday' },
      { id: 'lp_5', name: 'fine', ops: { [INSIDE_CHAR]: { potential: 1 } } },
    ],
  };
  const doc = sanitizeLineups(raw);
  assert.deepEqual(doc.items.map((it) => it.name), ['one', 'no at', 'fine']);
  assert.deepEqual(Object.keys(doc.items[0]).sort(), ['at', 'entries', 'id', 'name', 'ops'], 'unknown fields are not kept');
  assert.equal(doc.items[1].at, 0, 'a junk time reads as 0');
  assert.deepEqual(doc.items[2].entries, {});
  assert.deepEqual(doc.items[2].ops, { [INSIDE_CHAR]: { potential: 1 } });
  assert.equal({}.name, undefined, 'Object.prototype was not polluted');
});

test('removeLineup / clearLineups / lineupOf: delete one, clear all, both stored; the loadout is untouched', () => {
  withStorage((ls) => {
    const a = save('A');
    const b = save('B', { [SWIRE]: { skill: 0 } }, { now: 2000 });
    assert.equal(lineupOf(loadLineups(), a.item.id).name, 'A');
    assert.equal(lineupOf(loadLineups(), 'lp_missing'), null);
    const afterRemove = removeLineup(loadLineups(), a.item.id);
    assert.deepEqual(afterRemove.items.map((it) => it.name), ['B']);
    assert.deepEqual(JSON.parse(ls.getItem(LINEUPS_KEY)).items.map((it) => it.name), ['B'], 'the removal is stored');
    assert.equal(removeLineup(loadLineups(), 'lp_missing').items.length, 1, 'an unknown id changes nothing');
    const cleared = clearLineups();
    assert.deepEqual(cleared, emptyLineups());
    assert.deepEqual(JSON.parse(ls.getItem(LINEUPS_KEY)), { v: LINEUPS_VERSION, items: [] }, 'an empty list is stored, not a removed key');
    assert.equal(lineupOf(b.ok && b.item.id ? {} : b, b.item.id), null);
    assert.equal(ls.getItem('sp.pref.loadout'), null, '本地配队 never writes the loadout');
    assert.equal(ls.getItem('sp.name'), null, 'nor the player name');
  });
});

test('saveLineups: a refused write (private mode / full quota) keeps the session copy and never throws', () => {
  withStorage({ failOn: '*' }, (ls) => {
    const doc = saveLineups(emptyLineups());
    assert.deepEqual(doc, emptyLineups(), 'the value is still returned');
    assert.equal(ls.raw.size, 0, 'nothing was written');
    const r = saveLineup(loadLineups(), { name: 'A', entries: { [INSIDE]: { skill: 0 } } });
    assert.equal(r.ok, true, 'the save itself still succeeds');
    assert.equal(r.doc.items.length, 1, 'the in-memory list keeps it');
    assert.equal(ls.raw.size, 0, 'but the device keeps nothing — the next loadLineups is empty');
  });
  // only the 本地配队 key is full: saving it must not throw either, and must not touch other keys
  withStorage({ failOn: LINEUPS_KEY }, (ls) => {
    assert.doesNotThrow(() => saveLineups(emptyLineups()));
    assert.deepEqual(ls.raw.size, 0);
  });
});

// ---- 与现有调配存储 / 同步的兼容 ---------------------------------------------------------------------------------------

test('lineupPayload / lineupSize: a copy of the payload, not an alias; the size counts operators and settings', () => {
  const item = { entries: { [INSIDE]: { skill: 0 } }, ops: { [INSIDE_CHAR]: { potential: 1 }, [CHESS[SWIRE].charId]: { cultivate: 2 } } };
  const p = lineupPayload(item);
  assert.deepEqual(p.entries, { [INSIDE]: { skill: 0 } });
  assert.deepEqual(p.ops, { [INSIDE_CHAR]: { potential: 1 }, [CHESS[SWIRE].charId]: { cultivate: 2 } });
  p.entries[INSIDE].skill = 1;
  assert.equal(item.entries[INSIDE].skill, 0, 'the stored snapshot is not mutated by the caller');
  assert.equal(lineupSize(item), 3);
  assert.equal(lineupSize({}), 0);
  assert.equal(lineupSize(null), 0);
});

test('the stored payload is exactly what the loadout’s own parser reads (one format, no second sanitiser)', () => {
  withStorage(() => {
    const r = saveLineup(loadLineups(), {
      name: 'A',
      entries: { [INSIDE]: { skill: 0, module: null, junk: 1 }, 'bad id': { skill: 1 } },
      ops: { [INSIDE_CHAR]: { potential: 1, junk: 1 } },
    });
    assert.equal(r.ok, true);
    const payload = lineupPayload(r.item);
    assert.deepEqual(parseStored({ entries: payload.entries }), payload.entries, 'entries are stored in loadoutModel’s own shape');
    assert.deepEqual(parseStoredOps({ ops: payload.ops }), payload.ops, 'settings too');
    for (const it of loadLineups().items) {
      assert.deepEqual(parseStored({ entries: it.entries }), it.entries);
      assert.deepEqual(parseStoredOps({ ops: it.ops }), it.ops);
    }
  });
});

test('reading a snapshot goes through applyLoadoutEntries: the storage the upstream sync already writes, no extra fields', () => {
  const before = { entries: loadoutStore.get().entries, ops: loadoutStore.get().ops };
  withStorage((ls) => {
    try {
      setEntries({}); // a clean `sp.pref.loadout`
      const saved = saveLineup(loadLineups(), {
        name: 'A',
        entries: { [INSIDE]: { skill: 0 }, chess_nope_999: { skill: 0 } },
        ops: { [INSIDE_CHAR]: { potential: 1 } },
      });
      const payload = lineupPayload(saved.item);
      const res = applyLoadoutEntries(payload.entries, get, { ops: payload.ops, isOperator: (id) => id === INSIDE_CHAR });
      assert.equal(res.applied, 1, 'the unknown chess is dropped by the loadout’s sanitiser');
      assert.equal(res.dropped, 1);
      assert.equal(res.ops, 1);
      const stored = JSON.parse(ls.getItem('sp.pref.loadout'));
      assert.deepEqual(stored, { v: 1, entries: { [INSIDE]: { skill: 0 } }, ops: { [INSIDE_CHAR]: { potential: 1 } } });
      assert.deepEqual(loadoutStore.get().entries, { [INSIDE]: { skill: 0 } }, 'the store (and the sync) got the sanitiser’s output');
      // a snapshot saved with no settings restores the defaults, like an import that carries `ops: {}`
      const plain = saveLineup(loadLineups(), { name: 'B', entries: { [SWIRE]: { skill: 0 } } });
      applyLoadoutEntries(lineupPayload(plain.item).entries, get, { ops: {}, isOperator: () => true });
      assert.deepEqual(JSON.parse(ls.getItem('sp.pref.loadout')).ops, {}, 'the settings are cleared');
      assert.equal(lineupSize(plain.item), 1);
    } finally {
      setEntries(before.entries);
      loadoutStore.set({ ops: before.ops });
    }
  });
});

test('an imported loadout can be saved as a snapshot: 导入 → 保存 → 读取 keeps the same entries', () => {
  const before = { entries: loadoutStore.get().entries, ops: loadoutStore.get().ops };
  withStorage(() => {
    try {
      applyLoadoutEntries({ [INSIDE]: { skill: 0 }, [SWIRE]: { skill: 0 } }, get);
      const r = saveLineup(loadLineups(), { name: 'after import', entries: loadoutStore.get().entries });
      assert.deepEqual(r.item.entries, loadoutStore.get().entries);
    } finally {
      setEntries(before.entries);
      loadoutStore.set({ ops: before.ops });
    }
  });
});
