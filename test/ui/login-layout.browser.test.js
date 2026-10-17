// SP_E2E=1 CHROME_PATH=<chrome> node --test test/ui/login-layout.browser.test.js
//
// The title screen keeps its two-column composition — hero on the left, login panel on the right — at desktop
// and packaged-Android landscape sizes, and falls back to a stacked column on a narrow phone screen. The
// full-asset buttons stay inside the login column, under the panel, instead of forming a third column.
//
// Set SP_LOGIN_SHOTS=<dir> to write title-<case>.png screenshots of every checked composition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { CHROME, hasChrome } from '../e2e/client.mjs';

const SHOTS = process.env.SP_LOGIN_SHOTS;

/** Bounding boxes of the title composition, or null for an element that is not rendered. */
const measure = (page) => page.evaluate(() => {
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  return {
    main: box('.title-main'),
    hero: box('.title-hero'),
    side: box('.title-side'),
    login: box('.title-login'),
    assets: box('.title-assets'),
    fields: [...document.querySelectorAll('.title-login input')].length,
    connect: Boolean(document.querySelector('.title-login .btn--primary')),
  };
});

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

test('title screen is two columns on desktop and Android landscape, stacked on narrow screens', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 180000,
}, async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false });
  t.after(() => srv.close());
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const cases = [
    { label: 'desktop', width: 1280, height: 900, query: '?desktop=1', columns: true },
    { label: 'android-landscape', width: 844, height: 390, query: '?desktop=1&android=1', columns: true },
    { label: 'narrow-landscape', width: 700, height: 400, query: '?desktop=1', columns: false },
    { label: 'narrow-portrait', width: 390, height: 844, query: '?desktop=1', columns: false },
  ];

  for (const item of cases) {
    await page.setViewport({ width: item.width, height: item.height });
    await page.goto(new URL(item.query, srv.url).toString(), { waitUntil: 'load' });
    await page.waitForSelector('.title-main .title-hero', { timeout: 30000 });
    // Settle the entry animations: the panel's `rise-in` still translates it while it runs, and these checks
    // describe the resting composition. Looping/ambient animations are left alone (they never finish).
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        const timing = animation.effect?.getComputedTiming?.();
        if (!timing || timing.iterations === Infinity) continue;
        try { animation.finish(); } catch { /* an animation that cannot finish keeps its current frame */ }
      }
    });
    const box = await measure(page);
    const where = `${item.label} (${item.width}x${item.height})`;

    assert.ok(box.hero && box.side && box.login && box.assets, `${where}: the whole title composition renders`);
    assert.ok(box.main.width > 0 && box.main.height > 0, `${where}: .title-main has a layout box`);
    // The login panel keeps its interactive content at every size.
    assert.equal(box.fields, 2, `${where}: callsign + server fields stay in the panel`);
    assert.equal(box.connect, true, `${where}: the connect button stays in the panel`);

    if (item.columns) {
      assert.ok(box.hero.right <= box.side.x + 1,
        `${where}: the hero must end where the login column begins (hero.right=${box.hero.right}, side.x=${box.side.x})`);
      assert.ok(box.hero.x < box.side.x, `${where}: the login column is the right-hand column`);
      assert.ok(overlap(box.hero.y, box.hero.bottom, box.side.y, box.side.bottom) > 0,
        `${where}: both columns share vertical space`);
    } else {
      assert.ok(box.hero.bottom <= box.side.y + 1,
        `${where}: a narrow screen stacks the login column under the hero (hero.bottom=${box.hero.bottom}, side.y=${box.side.y})`);
      assert.ok(overlap(box.hero.x, box.hero.right, box.side.x, box.side.right) > 0,
        `${where}: the stacked column keeps the hero's horizontal band`);
    }

    // The asset buttons belong to the login column at every size, below the panel — never a third column.
    assert.ok(box.assets.x >= box.side.x - 1 && box.assets.right <= box.side.right + 1,
      `${where}: the full-asset buttons stay inside the login column`);
    assert.ok(box.assets.y >= box.login.bottom - 1, `${where}: the buttons sit under the login panel`);

    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `title-${item.label}.png`) });
  }

  const broken = errors.filter((message) => /Failed to (resolve|fetch)|SyntaxError|is not defined|not a function/i.test(message));
  assert.deepEqual(broken, [], `the title screen loaded without module errors: ${errors.join(' | ')}`);
});
