// 第 2 项：标题页「左横幅（徽记 + 标题）/ 右完整登录区」布局（静态断言，无浏览器）。
// 任何视口都是左右两栏，绝不纵向堆叠；窄屏收紧横幅占比与间距，登录列自身可纵向滚动，
// 触控目标沿用项目既有 --tap-min（44px）下限；登录区内部保持一列，不重新引入下载/镜像入口。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (p) => readFileSync(join(ROOT, p), 'utf8');

const slice = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));

describe('title layout: banner on the left, the whole login on the right', () => {
  const js = source('public/js/screens/title.js');
  const css = source('public/css/screens/title.css');

  test('the hero (emblem + title) and the login side are separate blocks, hero first', () => {
    assert.match(js, /<div class="title-hero">/);
    assert.match(js, /<div class="title-side">/);
    assert.ok(js.indexOf('class="title-hero"') < js.indexOf('class="title-side"'));
    const hero = slice(js, '<div class="title-hero">', '<div class="title-side">');
    assert.match(hero, /<\$\{Emblem\} \/>/);
    assert.match(hero, /class="title-en"/);
    assert.match(hero, /class="title-cn/);
    assert.match(hero, /class="title-tag"/);
  });

  test('the login side holds the whole login box and the asset buttons, nothing else', () => {
    const side = slice(js, '<div class="title-side">', '</main>');
    assert.match(side, /<div class="title-login">/);
    assert.match(side, /<div class="title-assets">/);
    assert.doesNotMatch(side, /class="title-hero"|class="title-en"|class="title-cn/);
  });

  test('the login box is one column: no inner identity/connection split', () => {
    const login = slice(js, '<div class="title-login">', '<div class="title-assets">');
    assert.doesNotMatch(login, /title-login__grid|title-login__col|<fieldset|<legend/);
    const order = ['class="title-connect__endpoint"', "t('博士代号')", "t('开始')", 'class="title-conn"'];
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(login.indexOf(order[i - 1]) >= 0, `${order[i - 1]} exists`);
      assert.ok(login.indexOf(order[i - 1]) < login.indexOf(order[i]), `${order[i - 1]} comes before ${order[i]}`);
    }
    assert.match(login, /label=\$\{t\('服务器地址'\)\} micro="SERVER"/);
    assert.doesNotMatch(login, /INVITE|邀请链接/);
    assert.doesNotMatch(login, /t\('同盟邀请'\)/, 'the standalone invite field is removed');
  });

  test('css: the main axis is a row at every viewport, no stacking rule and no order swap', () => {
    assert.match(css, /\.title-main \{ flex-direction: row;/);
    assert.doesNotMatch(css, /display: contents/);
    assert.doesNotMatch(css, /@media \(min-width: 1000px\)/);
    assert.doesNotMatch(css, /\border:/, 'nothing may reorder the hero behind the login');
    assert.match(css, /\.title-hero \{[^}]*flex: 1 1 auto;/);
    assert.match(css, /\.title-side \{[^}]*flex: 0 0 auto;[^}]*width: 4\.9rem;/);
  });

  test('css: the login column is scrollable and its children never shrink', () => {
    const side = css.match(/\.title-side \{[^}]*\}/)[0];
    assert.match(side, /max-height:/);
    assert.match(side, /overflow-y: auto;/);
    assert.match(side, /overscroll-behavior: contain;/);
    assert.match(css, /\.title-side > \.title-login, \.title-side > \.title-assets \{[^}]*width: 100%;[^}]*flex: 0 0 auto;/);
    assert.match(css, /\.title-login \{[^}]*width: 4\.9rem;/);
  });

  test('css: narrow screens shrink the banner share and spacing, never the touch targets', () => {
    const start = css.indexOf('@media (max-width: 640px)');
    let depth = 0;
    let end = start;
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const block = css.slice(start, end);
    assert.match(block, /\.title-main \{ gap: \.08rem;/);
    assert.match(block, /\.title-hero \{ max-width: 3\.7rem;/);
    assert.match(block, /\.title-cn \{ font-size: \.46rem;/, 'the title scales down with the banner');
    assert.match(block, /\.title-side \{ width: 4\.4rem;/);
    assert.match(block, /max-height: 96vh;/);
    // The title is not a pannable canvas: a class added by title.js replaces the old :has() selector
    // (upstream's static check rejects `:has()`, and Firefox ESR 115 lacks it).
    assert.match(css, /html\.title-open \{ overflow-x: hidden; touch-action: pan-y; \}/);
    assert.match(css, /html\.title-open body, html\.title-open \.app-root, \.title-screen \{[^}]*overflow-x: hidden;[^}]*touch-action: pan-y;/);
    assert.match(js, /root\.classList\.add\('title-open'\)/);
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /:has\(/);
    // The server address lives in the login panel itself — first row, then the callsign — so it is
    // not a second stacked panel of its own.
    assert.doesNotMatch(js, /class="title-connect"/);
    assert.match(js, /<div class="title-login">\s*<div class="title-connect__endpoint">/);
    assert.match(js, /class="title-connect__endpoint"[\s\S]*class="title-connect__address"[\s\S]*<\$\{Button\} variant="ghost"/);
    assert.match(css, /\.title-connect__endpoint \{[^}]*display: flex;[^}]*align-items: flex-end;[^}]*justify-content: center;/);
    assert.match(css, /\.title-connect__endpoint > \.btn \{[^}]*align-self: flex-end;[^}]*min-width: max\(\.64rem, var\(--tap-min, 44px\)\);[^}]*height: \.56rem;[^}]*border-color: rgba\(255, 255, 255, \.14\);/);
    assert.doesNotMatch(js, /title-connect__modes|title-connect__mode|setTransport/);
  });

  test('the withdrawn two-column legend strings are gone from every locale pack', () => {
    for (const pack of ['en', 'ja', 'ko', 'zh-TW']) {
      const dict = JSON.parse(source(`public/i18n/${pack}.json`));
      assert.equal(dict['身份'], undefined, `${pack}: 身份`);
      assert.equal(dict['连接与邀请'], undefined, `${pack}: 连接与邀请`);
    }
  });

  test('the hero and login carry no remote-asset or pack-download control', () => {
    const main = slice(js, '<main class="title-main">', '</main>');
    assert.doesNotMatch(main, /assetToken|mirror|runtime-assets|index\.json/i);
  });
});
