// `tools/affected.mjs`：按改动挑测试的判定逻辑。
// 不连 git、不跑测试，只验证解析与归类；真实挑选由 `node tools/affected.mjs` 输出。

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  ROOT, parseImports, resolveSpecifier, dependencyClosure, classifyChanges,
} from '../tools/affected.mjs';

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

test('parseImports 只收相对路径，静态/动态/再导出/require 都认', () => {
  const source = `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    import a from '../public/js/a.js';
    import '../shared/side.js';
    export { b } from '../server/b.js';
    const c = await import('../server/c.js');
    const d = require('../tools/d.js');
  `;
  const found = parseImports(source);
  deepStrictEqual(found.sort(), ['../public/js/a.js', '../server/b.js', '../server/c.js', '../shared/side.js', '../tools/d.js']);
});

test('resolveSpecifier 支持省略扩展名与目录 index', () => {
  const from = path.join(ROOT, 'test/shots.test.js');
  strictEqual(rel(resolveSpecifier(from, '../scripts/shots.mjs')), 'scripts/shots.mjs');
  strictEqual(resolveSpecifier(from, '../../no/such/file.js'), null);
});

test('dependencyClosure 顺着 import 把测试真正依赖的文件收全', () => {
  const closure = dependencyClosure(path.join(ROOT, 'test/shots.test.js'));
  ok([...closure].some((f) => rel(f) === 'scripts/shots.mjs'), '应当包含被 import 的 scripts/shots.mjs');
  ok([...closure].some((f) => rel(f) === 'test/shots.test.js'), '应当包含测试自身');
});

test('classifyChanges：改文档只跑文档门禁，不升级全量', () => {
  const graph = new Map([[path.join(ROOT, 'test/a.test.js'), new Set([path.join(ROOT, 'public/js/a.js')])]]);
  const result = classifyChanges(['docs/WINDOWS.md', 'README.md'], { graph });
  strictEqual(result.needsFull, false);
  deepStrictEqual(result.docs, ['docs/WINDOWS.md', 'README.md']);
  deepStrictEqual(result.tests, []);
});

test('classifyChanges：改源文件只跑引用了它的测试', () => {
  const a = path.join(ROOT, 'test/a.test.js');
  const b = path.join(ROOT, 'test/b.test.js');
  const target = path.join(ROOT, 'public/js/a.js');
  const graph = new Map([[a, new Set([target])], [b, new Set([path.join(ROOT, 'public/js/b.js')])]]);
  const result = classifyChanges(['public/js/a.js'], { graph, exists: () => true });
  deepStrictEqual(result.tests, [a]);
  strictEqual(result.needsFull, false);
});

test('classifyChanges：共享核心没人引用时升级全量，不许悄悄跳过', () => {
  const graph = new Map([[path.join(ROOT, 'test/a.test.js'), new Set()]]);
  const result = classifyChanges(['shared/sim.js'], { graph, exists: () => true });
  strictEqual(result.needsFull, true);
  ok(result.reasons.some((line) => line.includes('共享核心')));
});

test('classifyChanges：无法归类的文件升级全量', () => {
  const graph = new Map([[path.join(ROOT, 'test/a.test.js'), new Set()]]);
  const result = classifyChanges(['tools/whatever.mjs'], { graph });
  strictEqual(result.needsFull, true);
  ok(result.unknown.includes('tools/whatever.mjs'));
});

test('classifyChanges：直接改了测试就跑它自己', () => {
  const a = path.join(ROOT, 'test/a.test.js');
  const graph = new Map([[a, new Set()]]);
  const result = classifyChanges(['test/a.test.js'], { graph });
  deepStrictEqual(result.tests, [a]);
});

test('classifyChanges：挑出的测试超过一半时全量更划算', () => {
  const target = path.join(ROOT, 'public/js/core.js');
  const tests = [1, 2, 3].map((n) => path.join(ROOT, `test/t${n}.test.js`));
  const graph = new Map(tests.map((file, i) => [file, new Set(i < 2 ? [target] : []) ]));
  const result = classifyChanges(['public/js/core.js'], { graph, exists: () => true });
  strictEqual(result.needsFull, true);
  ok(result.reasons.some((line) => line.includes('超过一半')));
});

test('classifyChanges：Rust 与界面改动分到各自的附加门禁', () => {
  const graph = new Map([[path.join(ROOT, 'test/a.test.js'), new Set()]]);
  const result = classifyChanges(['src-tauri/src/lib.rs', 'public/css/title.css'], { graph });
  deepStrictEqual(result.rust, ['src-tauri/src/lib.rs']);
  deepStrictEqual(result.ui, ['public/css/title.css']);
  strictEqual(result.needsFull, false);
});
