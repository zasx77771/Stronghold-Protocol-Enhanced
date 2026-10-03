// Regression tests for in-match UI defects (round-3 hunt): the 暂离 (AI 托管) flag leaking into the next match, game
// shortcuts acting behind the 本局信息 / 敌方情报 drawer, two elimination banners during SETTLE, a right-click /
// long-press detail card that a press outside did not close, and the touch hit areas of the 交流 pager (static
// check here; the in-browser check is in devices.e2e.test.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shortcutBlocked, showDeadPill, closesOnFieldPress, detailPressIsInternal } from '../../public/js/ui/gameLogic.js';
import { PHASE } from '../../shared/constants.js';

describe('暂离 (AI 托管) is scoped to one match', () => {
  test('the flag survives in-match updates and is dropped when the match ends or its state is cleared', async () => {
    const { awayStore, awayEnds } = await import('../../public/js/ui/matchChrome.js');
    const { store, emptyMatch } = await import('../../public/js/store.js');
    const inMatch = (phase) => ({ ...emptyMatch(), public: { phase, players: [] } });
    store.set({ match: inMatch(PHASE.PREP) });
    awayStore.set({ away: true });
    store.patch('match', { public: { phase: PHASE.COMBAT, players: [] } });
    assert.equal(awayStore.get().away, true, 'still away while the match runs');
    // result → 返回同盟 (result.js back): the match slice is cleared
    store.patch('match', { result: { victory: false } });
    assert.equal(awayStore.get().away, false, 'the settlement ends 暂离');
    awayStore.set({ away: true });
    store.set({ match: emptyMatch() });
    assert.equal(awayStore.get().away, false, 'clearing the match (返回同盟 / a new match / room closed) ends 暂离');
    // the next match opens without the overlay flag
    store.set({ match: inMatch(PHASE.INFO_CHECK) });
    assert.equal(awayStore.get().away, false);
    assert.equal(awayEnds({ match: inMatch(PHASE.PREP) }, { match: inMatch(PHASE.PREP) }), false);
    assert.equal(awayEnds({ match: emptyMatch() }, { match: emptyMatch() }), false, 'nothing to end outside a match');
    store.set({ match: emptyMatch() });
  });
});

describe('game shortcuts behind overlays', () => {
  test('the 本局信息 / 敌方情报 drawer swallows R / F / D / Space, Esc still closes it', () => {
    for (const act of ['refresh', 'freeze', 'levelUp', 'ready']) {
      assert.equal(shortcutBlocked(act, { drawer: true }), true, act);
      assert.equal(shortcutBlocked(act, {}), false, act);
      assert.equal(shortcutBlocked(act, { modal: true }), true, act);
    }
    assert.equal(shortcutBlocked('escape', { drawer: true }), false);
    assert.equal(shortcutBlocked('escape', { modal: true }), true, 'a modal handles its own Esc');
    assert.equal(shortcutBlocked(null, {}), true);
  });
});

describe('elimination banners', () => {
  test('the HUD pill shows outside combat only — never during SETTLE, where the combat HUD already says it', () => {
    assert.equal(showDeadPill(false, PHASE.PREP), true);
    assert.equal(showDeadPill(false, PHASE.SP_DRAFT), true);
    assert.equal(showDeadPill(false, PHASE.SETTLE), false);
    for (const p of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) assert.equal(showDeadPill(false, p), false, p);
    assert.equal(showDeadPill(true, PHASE.PREP), false);
  });
});

describe('detail card click-away dismissal', () => {
  test('field, shop, item and enemy cards all close outside', () => {
    assert.equal(closesOnFieldPress({ kind: 'piece', uid: 3 }), true);
    assert.equal(closesOnFieldPress({ kind: 'unit', unitId: 7 }), true);
    for (const kind of ['chess', 'item', 'enemy']) assert.equal(closesOnFieldPress({ kind, id: 'x' }), true, kind);
    assert.equal(closesOnFieldPress(null), false);
  });

  test('the field press handler closes the card whether or not a piece is selected', () => {
    const src = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
    const h = src.slice(src.indexOf('const onDown = () => {'), src.indexOf("host.addEventListener('pointerdown', onDown, true)"));
    assert.ok(h.length > 0);
    assert.match(h, /setDetail\(\(d\) => \(closesOnFieldPress\(d\) \? null : d\)\)/);
    assert.doesNotMatch(h, /if \(L\.sel\) \{[^}]*setDetail/, 'not only while a piece is selected');
    assert.match(src, /document\.addEventListener\('pointerdown', onOutside, true\)/, 'blank HUD/page areas close details');
    assert.match(src, /detailPressIsInternal\(e\.target\)/, 'detail and selection controls do not dismiss themselves');
  });

  test('撤退 / 出售 remain mounted through pointerdown so their click can fire', () => {
    const target = (matched) => ({ closest: (selector) => selector.split(/,\s*/).includes(matched) ? {} : null });
    assert.equal(detailPressIsInternal(target('.dpanel')), true, 'detail content');
    assert.equal(detailPressIsInternal(target('.uframe')), true, 'selected-piece controls');
    assert.equal(detailPressIsInternal(target('.shopbar')), false, 'outside click still dismisses');
    const css = readFileSync(new URL('../../public/css/devices.css', import.meta.url), 'utf8');
    assert.match(css, /\.sp-coarse :is\([^}]*\.uframe__btn[^}]*\)::before/s, 'touch buttons receive the expanded hit area');
    assert.doesNotMatch(css, /\.uf__btn/, 'no stale selector typo');
  });

  test('a covenant popup also closes outside, but not while interacting inside it', () => {
    const src = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
    assert.match(src, /document\.addEventListener\('pointerdown', onBondOutside, true\)/);
    assert.match(src, /e\.target\?\.closest\?\.\('\.bpop'\)/);
    assert.match(src, /setBondOpen\(null\)/);
  });
});

describe('packaged Android rendering', () => {
  test('embedded game images load eagerly without waiting for a tap or scroll', async () => {
    const { isPackagedAndroid } = await import('../../public/js/ui/gameComponents.js');
    assert.equal(isPackagedAndroid({ search: '?desktop=1&android=1' }, null), true);
    assert.equal(isPackagedAndroid({ search: '?desktop=1' }, null), false);
    assert.equal(isPackagedAndroid({ search: '' }, {}), true);
    const src = readFileSync(new URL('../../public/js/ui/gameComponents.js', import.meta.url), 'utf8');
    assert.match(src, /isPackagedAndroid\(\) \? 'eager' : 'lazy'/);
  });

  test('fractional CSS viewport pixels are preserved for both render canvases', () => {
    const app = readFileSync(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
    const board = readFileSync(new URL('../../public/js/render/board3d/scene.js', import.meta.url), 'utf8');
    assert.match(app, /host\.getBoundingClientRect\?\.\(\)/);
    assert.doesNotMatch(board, /Math\.round\(w\).*Math\.round\(h\)/);
  });
});

describe('交流 pager touch hit areas (css/devices.css)', () => {
  const css = readFileSync(new URL('../../public/css/devices.css', import.meta.url), 'utf8');
  test('‹ / › hit areas start under the emote cells and grow outwards; dots only up to half the gap', () => {
    assert.match(css, /\.sp-coarse \.ewheel__panel \.ewheel__nav::before \{ top: \.03rem; bottom: -\.15rem; height: auto; transform: none; \}/);
    assert.match(css, /\.sp-coarse \.ewheel__panel \.ewheel__nav\.is-prev::before \{ left: auto; right: 0; \}/);
    assert.match(css, /\.sp-coarse \.ewheel__panel \.ewheel__nav\.is-next::before \{ left: 0; right: auto; \}/);
    assert.match(css, /\.sp-coarse \.ewheel__dot::before \{ inset: -\.02rem -\.05rem -\.2rem;/);
  });
});

describe('dev hook', () => {
  test('useFieldView clears globalThis.__SP_VIEW__ when it destroys the view', () => {
    const src = readFileSync(new URL('../../public/js/ui/fieldHost.js', import.meta.url), 'utf8');
    const cleanup = src.slice(src.indexOf('return () => {', src.indexOf('export function useFieldView')));
    assert.match(cleanup.slice(0, 600), /globalThis\.__SP_VIEW__ === viewRef\.current\) globalThis\.__SP_VIEW__ = null/);
  });
});
