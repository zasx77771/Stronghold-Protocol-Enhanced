// `scripts/rust-check.mjs`：只验证命令行拼装，不真的调 cargo（编译很慢，交给人跑）。

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import test from 'node:test';

import { commandFor, describe, parseArgs } from '../scripts/rust-check.mjs';

test('默认是 debug 的 cargo check', () => {
  deepStrictEqual(commandFor({}), { command: 'cargo', args: ['check'] });
  strictEqual(describe({}), 'cargo check（debug profile）');
});

test('--release 才加 --release，用于和打包对齐', () => {
  deepStrictEqual(commandFor({ release: true }), { command: 'cargo', args: ['check', '--release'] });
  strictEqual(describe({ release: true }), 'cargo check --release（release profile）');
});

test('--tests 连测试一起检查', () => {
  deepStrictEqual(commandFor({ tests: true }), { command: 'cargo', args: ['check', '--tests'] });
});

test('--build 换成 cargo build，profile 仍默认 debug', () => {
  deepStrictEqual(commandFor({ build: true }), { command: 'cargo', args: ['build'] });
  deepStrictEqual(commandFor({ build: true, release: true, tests: true }), {
    command: 'cargo',
    args: ['build', '--release', '--tests'],
  });
});

test('parseArgs 收齐开关，未知选项直接报错', () => {
  deepStrictEqual(parseArgs(['--release', '--tests', '--time']), {
    release: true, tests: true, build: false, time: true, help: false,
  });
  throws(() => parseArgs(['--fast']), /不认识的选项/);
});
