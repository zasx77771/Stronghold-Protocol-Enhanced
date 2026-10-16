import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listTestFiles } from '../tools/test.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the test runner discovers test files without executing JavaScript fixtures', () => {
  const files = listTestFiles(ROOT);
  assert.ok(files.includes(path.join(ROOT, 'test', 'lobby.test.js')));
  assert.equal(files.some((file) => file.includes(`${path.sep}fixtures${path.sep}`)), false);
  assert.ok(files.every((file) => file.endsWith('.test.js')));
});