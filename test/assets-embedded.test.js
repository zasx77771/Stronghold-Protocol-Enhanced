// Tests for the embedded-asset release guard (tools/check-embedded-assets.mjs).
// The guard exists so a release build cannot ship a client whose manifest points
// at art the download never produced; these run on a throwaway fixture tree.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifestUrls, urlPath, missingFiles, dirSummary, check } from '../tools/check-embedded-assets.mjs';

function fixture(manifest, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sp-embedded-assets-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'assets.json'), JSON.stringify(manifest));
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, ...relative.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

describe('manifestUrls', () => {
  test('collects nested /assets/ and /fonts/ URLs once, in order', () => {
    const manifest = {
      chars: { a: { art: '/assets/a.png' }, b: { art: '/assets/a.png' } },
      lists: [['/fonts/f.woff2'], { deep: '/assets/b.png' }],
    };
    assert.deepEqual(manifestUrls(manifest), ['/assets/a.png', '/fonts/f.woff2', '/assets/b.png']);
  });

  test('ignores non-asset strings, other prefixes and non-strings', () => {
    const manifest = { name: 'assets/a.png', url: '/client/a.png', n: 1, nothing: null, list: [] };
    assert.deepEqual(manifestUrls(manifest), []);
  });
});

describe('urlPath', () => {
  test('maps a client URL under public/ with forward slashes', () => {
    const root = join('tmp', 'root');
    assert.equal(urlPath(root, '/assets/a/b.png'), join(root, 'public', 'assets', 'a', 'b.png'));
    assert.equal(urlPath(root, '/fonts/f.woff2'), join(root, 'public', 'fonts', 'f.woff2'));
  });
});

describe('missingFiles and dirSummary', () => {
  test('lists absent files and skips present ones', () => {
    const root = fixture({}, { 'public/assets/a.png': 'x' });
    try {
      assert.deepEqual(missingFiles(['/assets/a.png', '/assets/b.png'], root), ['/assets/b.png']);
      assert.deepEqual(dirSummary(join(root, 'public', 'assets')), { files: 1, bytes: 1 });
      assert.deepEqual(dirSummary(join(root, 'public', 'nope')), { files: 0, bytes: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check', () => {
  test('passes when every manifest file is embedded', () => {
    const root = fixture({ art: '/assets/a.png', font: '/fonts/f.woff2', stats: { files: 1 } }, {
      'public/assets/a.png': 'png',
      'public/fonts/f.woff2': 'woff',
    });
    try {
      const result = check({ root, strict: true });
      assert.equal(result.ok, true, result.problems.join('; '));
      assert.equal(result.urls, 2);
      // dirSummary covers public/assets only, so the font under public/fonts is not counted here.
      assert.equal(result.assets.files, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails on a missing manifest file, an empty asset tree and a stale count', () => {
    const root = fixture({ art: '/assets/a.png', stats: { files: 2 } }, { 'public/assets/a.png': 'png' });
    try {
      let result = check({ root });
      assert.equal(result.ok, true);
      rmSync(join(root, 'public', 'assets', 'a.png'));
      result = check({ root, strict: true });
      assert.equal(result.ok, false);
      assert.match(result.problems.join('\n'), /is empty or absent/);
      assert.match(result.problems.join('\n'), /1 manifest file\(s\) missing/);
      writeFileSync(join(root, 'public', 'assets', 'a.png'), 'png');
      result = check({ root, strict: true });
      assert.match(result.problems.join('\n'), /stats\.files \(2\) disagrees/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
