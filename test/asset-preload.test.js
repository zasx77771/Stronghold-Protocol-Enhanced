// assetPreload.js: the queue is best effort, so the tests pin only what can silently break the screens —
// duplicates, the cap, and the manifest lookups the briefing relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { preloadArt, preloadChessArt, resetPreloadQueue } from '../public/js/assetPreload.js';

/** Minimal Image stand-in: records every src and settles on the next tick. */
function stubImage() {
  const loaded = [];
  class FakeImage {
    set src(value) {
      loaded.push(value);
      setTimeout(() => this.onload?.(), 0);
    }
    get src() {
      return loaded.at(-1);
    }
  }
  const previous = globalThis.Image;
  globalThis.Image = FakeImage;
  return { loaded, restore: () => { globalThis.Image = previous; } };
}

test('preloadArt queues a URL once and reports how many were new', () => {
  const { loaded, restore } = stubImage();
  try {
    resetPreloadQueue();
    assert.equal(preloadArt(['a.png', 'a.png', 'b.png', '']), 2);
    assert.equal(preloadArt(['a.png', 'c.png']), 1);
    assert.deepEqual(new Set(loaded), new Set(['a.png', 'b.png', 'c.png']));
  } finally {
    restore();
  }
});

test('preloadArt honours the cap per call', () => {
  const { loaded, restore } = stubImage();
  try {
    resetPreloadQueue();
    const urls = Array.from({ length: 10 }, (_, i) => `n${i}.png`);
    assert.equal(preloadArt(urls, { max: 3 }), 3);
    assert.deepEqual(loaded, ['n0.png', 'n1.png', 'n2.png']);
  } finally {
    restore();
  }
});

test('preloadChessArt resolves the avatar and the portrait of each chess', () => {
  const { loaded, restore } = stubImage();
  try {
    resetPreloadQueue();
    const m = {
      chars: {
        c1: { avatar: '/assets/char/avatar/c1.png', portrait: '/assets/char/portrait/c1_1.png' },
      },
    };
    const chess = [{ id: 'ops', charId: 'c1', assets: { avatar: 'c1', portrait: 'c1_1' } }];
    assert.equal(preloadChessArt(m, chess), 2);
    assert.deepEqual(new Set(loaded), new Set(['/assets/char/avatar/c1.png', '/assets/char/portrait/c1_1.png']));
  } finally {
    restore();
  }
});

test('preloadChessArt skips records the manifest cannot resolve', () => {
  const { loaded, restore } = stubImage();
  try {
    resetPreloadQueue();
    assert.equal(preloadChessArt(null, [{ id: 'x' }, null]), 0);
    assert.deepEqual(loaded, []);
  } finally {
    restore();
  }
});
