import { test } from 'node:test';
import { strictEqual, throws, ok } from 'node:assert/strict';

import { commandFor, isSuccess, parseArgs } from '../scripts/win-copy.mjs';

test('默认复制参数包含递归与多线程', () => {
  const plan = commandFor({ source: 'a', destination: 'b' });
  ok(plan.args.includes('/E'), '需要 /E 复制子目录');
  ok(plan.args.includes('/MT:16'), '默认 16 线程');
  strictEqual(plan.command, 'robocopy');
});

test('--threads 会进入 /MT 参数', () => {
  const plan = commandFor({ source: 'a', destination: 'b', threads: 32 });
  ok(plan.args.includes('/MT:32'));
});

test('--dry-run 只加 /L，不改其它参数', () => {
  const dry = commandFor({ source: 'a', destination: 'b', dryRun: true });
  ok(dry.args.includes('/L'));
  const real = commandFor({ source: 'a', destination: 'b' });
  ok(!real.args.includes('/L'));
});

test('robocopy 退出码 0-7 算成功，8 及以上算失败', () => {
  for (const code of [0, 1, 2, 3, 4, 5, 6, 7]) ok(isSuccess(code), `${code} 应算成功`);
  for (const code of [8, 9, 16]) ok(!isSuccess(code), `${code} 应算失败`);
  ok(!isSuccess(undefined));
});

test('参数解析：两个路径 + 选项', () => {
  const args = parseArgs(['src', 'dst', '--threads', '8', '--quiet']);
  strictEqual(args.source, 'src');
  strictEqual(args.destination, 'dst');
  strictEqual(args.threads, 8);
  strictEqual(args.quiet, true);
});

test('参数解析：路径不足或选项非法时报错', () => {
  throws(() => parseArgs(['only-one']), /两个路径/);
  throws(() => parseArgs(['a', 'b', '--nope']), /未知选项/);
  throws(() => parseArgs(['a', 'b', '--threads', '0']), /1-128/);
});
