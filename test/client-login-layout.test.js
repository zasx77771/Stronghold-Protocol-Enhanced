// Static contract for the title screen's two-column composition (hero left, login panel right) and its
// narrow-screen fallback.
//
// The upstream v0.3.0 re-merge put the new full-asset buttons (`ui/assetDownload.js`, `ui/assetImport.js`)
// straight into `<main class="title-main">`, which made them a third grid child; the workaround replaced the
// grid with a centred flex column. The composition is rebuilt so `.title-main` has exactly two children — the
// hero and a `.title-side` wrapper that owns the login panel with the asset buttons underneath it.
//
// Pure source text on purpose: no browser and no generated `public/vendor/` bundle, so this runs anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('public/css/screens/title.css');
const TITLE_JS = read('public/js/screens/title.js');

/** The declaration body of the rule whose selector is exactly `selector`. */
function declarationBody(source, selector) {
  const at = source.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `missing rule ${selector}`);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  assert.ok(close > open, `unbalanced rule ${selector}`);
  return source.slice(open + 1, close);
}

/** The text inside `@media <query> { … }`, brace-matched. */
function mediaBlock(source, query) {
  const at = source.indexOf(`@media ${query} {`);
  assert.notEqual(at, -1, `missing @media ${query}`);
  const start = source.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (!depth) return source.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced @media ${query}`);
}

/** The `<main class="title-main"> … </main>` region of the title screen template. */
function mainRegion(source) {
  const open = source.indexOf('<main class="title-main">');
  assert.notEqual(open, -1, 'title.js lost <main class="title-main">');
  const close = source.indexOf('</main>', open);
  assert.notEqual(close, -1, 'title.js lost </main>');
  return source.slice(open, close);
}

/**
 * The element opens indented by exactly `indent` spaces — i.e. the direct children of an element in the
 * (consistently indented) htm template. Deeper lines are excluded, closing tags never match.
 */
function childrenAt(source, indent) {
  const pad = ' '.repeat(indent);
  return source
    .split('\n')
    .filter((line) => line.startsWith(pad) && !line.startsWith(`${pad} `))
    .map((line) => line.trim().match(/^<([a-z]+)([^>]*)>/))
    .filter(Boolean)
    .map((match) => `${match[1]}${match[2]}`);
}

const decl = (source, selector, property) => new RegExp(`(^|;|\\{)\\s*${property}\\s*:`).test(declarationBody(source, selector));

test('title-main is a two-column grid: hero left, login column right', () => {
  const main = declarationBody(CSS, '.title-main');
  assert.match(main, /display:\s*grid/, '.title-main must lay its two children out as a grid');
  assert.match(main, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*4\.9rem\s*;/, 'the login column keeps its 4.9rem track');
  assert.doesNotMatch(main, /flex-direction:\s*column/, 'the centred flex column was the regression, not the layout');
  assert.match(main, /align-items:\s*center/);
  assert.match(main, /width:\s*min\(13\.6rem,\s*calc\(100vw - 1\.2rem\)\)/);
});

test('the two grid children are .title-hero and .title-side, both shrinkable', () => {
  for (const selector of ['.title-hero', '.title-side']) {
    assert.ok(decl(CSS, selector, 'min-width'), `${selector} must be able to shrink inside the grid track`);
  }
  assert.match(declarationBody(CSS, '.title-hero'), /text-align:\s*center/);
  assert.match(declarationBody(CSS, '.title-side'), /flex-direction:\s*column/);
  // The login panel fills the second track, so the panel and its column stay the same width.
  assert.match(declarationBody(CSS, '.title-login'), /width:\s*min\(4\.9rem,\s*calc\(100vw - 1\.2rem\)\)/);
  assert.match(declarationBody(CSS, '.title-login'), /margin-top:\s*0/);
});

test('main.title-main holds exactly two children: the hero and the login column', () => {
  const children = childrenAt(mainRegion(TITLE_JS), 6);
  assert.deepEqual(children, ['section class="title-hero"', 'div class="title-side"'],
    'the full-asset buttons must never be a third grid child of .title-main');
});

test('the full-asset buttons sit inside the login column, below the login panel', () => {
  const region = mainRegion(TITLE_JS);
  const sideAt = region.indexOf('<div class="title-side">');
  assert.notEqual(sideAt, -1, 'missing <div class="title-side">');
  const closeAt = region.indexOf('\n      </div>', sideAt);
  assert.notEqual(closeAt, -1, 'unterminated <div class="title-side">');
  const side = region.slice(sideAt, closeAt);
  assert.deepEqual(childrenAt(side, 8), ['div class="title-login"', 'div class="title-assets"'],
    '.title-side must stack the login panel above the asset buttons');
  assert.doesNotMatch(side, /title-hero/, 'the hero is a sibling of the login column, not a child of it');
  assert.match(TITLE_JS, /<div class="title-assets">[\s\S]{0,200}AssetDownloadButton[\s\S]{0,200}AssetImportButton/);
});

test('narrow screens stack the columns and keep the login panel usable', () => {
  const narrow = mediaBlock(CSS, '(max-width: 960px)');
  const main = declarationBody(narrow, '.title-main');
  assert.match(main, /display:\s*flex/);
  assert.match(main, /flex-direction:\s*column/);
  assert.match(declarationBody(narrow, '.title-side'), /width:\s*min\(4\.9rem,\s*calc\(100vw - 1\.2rem\)\)/);
  // A packaged Android client keeps the two-column composition in landscape, at the same track sizes.
  const android = declarationBody(narrow, '.title-screen--android .title-main');
  assert.match(android, /display:\s*grid/);
  assert.match(android, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*4\.9rem/);
  assert.match(declarationBody(narrow, '.title-screen--android .title-login'), /margin-top:\s*0/);
});

test('short and very short viewports scale the composition without reordering it', () => {
  assert.match(declarationBody(CSS, '@media (max-height: 820px)') || mediaBlock(CSS, '(max-height: 820px)'), /\.title-main\s*\{[^}]*transform:\s*scale\(\.88\)/);
  const tiny = mediaBlock(CSS, '(max-width: 960px) and (max-height: 460px)');
  assert.match(declarationBody(tiny, '.title-main'), /transform:\s*scale\(\.8\)/);
  assert.match(declarationBody(tiny, '.title-screen--android .title-main'), /transform:\s*none/);
});

test('the login panel keeps its accessible controls after the rebuild', () => {
  const login = declarationBody(CSS, '.title-login');
  assert.match(login, /flex-direction:\s*column/, 'the panel stacks its rows');
  for (const selector of ['.title-transport', '.title-server-row', '.title-actions', '.title-remember', '.title-bottom-tools', '.title-conn--compact']) {
    assert.notEqual(CSS.indexOf(`${selector} {`), -1, `${selector} lost its styles in the re-merge`);
  }
  // Transport switch, remember switch, paste action, guide and settings triggers, connect button.
  assert.match(TITLE_JS, /class="title-transport" role="group" aria-label=/);
  assert.match(TITLE_JS, /class=\$\{`title-remember\$\{rememberName \? ' is-on' : ''\}`\} role="switch"[\s\S]{0,120}aria-checked=/);
  assert.match(TITLE_JS, /class="title-paste"/);
  assert.match(TITLE_JS, /class="title-settings fsbtn tapx" aria-label=/);
  assert.match(TITLE_JS, /<div class="title-bottom-tools">[\s\S]{0,400}GuideButton[\s\S]{0,400}<\/div>/);
  assert.match(TITLE_JS, /variant="primary" size="xl" block=\$\{true\}/);
  assert.match(TITLE_JS, /label=\$\{t\('博士代号'\)\}/);
});
