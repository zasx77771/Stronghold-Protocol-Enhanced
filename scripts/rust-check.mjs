#!/usr/bin/env node
// Rust 迭代检查。默认用 debug profile：只做类型检查、不开优化，比 `cargo check --release` 快得多，
// 而且和打包用的 release 目标目录互不影响（打完包仍保留 release 缓存）。
// 只有「要和打包产物对齐」时才加 --release。
//
// 用法：
//   node scripts/rust-check.mjs            # cargo check（debug，日常改 Rust 用这个）
//   node scripts/rust-check.mjs --tests    # 连测试一起检查
//   node scripts/rust-check.mjs --release  # 和打包同 profile（慢，仅提交前对齐）
//   node scripts/rust-check.mjs --build    # 真的编出可执行文件（仍默认 debug）
//   node scripts/rust-check.mjs --time     # 只报耗时

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.join(ROOT, 'src-tauri');

const USAGE = `用法：node scripts/rust-check.mjs [--release] [--tests] [--build] [--time]
  默认：cargo check（debug profile，快）
  --release  和打包同 profile（慢，只用于提交前对齐）
  --tests    连测试一起检查
  --build    换成 cargo build（默认仍是 debug）
  --time     只输出耗时，不刷编译细节`;

function parseArgs(argv) {
  const o = { release: false, tests: false, build: false, time: false, help: false };
  for (const arg of argv) {
    if (arg === '--release') o.release = true;
    else if (arg === '--tests') o.tests = true;
    else if (arg === '--build') o.build = true;
    else if (arg === '--time') o.time = true;
    else if (arg === '-h' || arg === '--help') o.help = true;
    else throw new Error(`不认识的选项：${arg}`);
  }
  return o;
}

export function commandFor({ release = false, tests = false, build = false } = {}) {
  const args = [build ? 'build' : 'check'];
  if (release) args.push('--release');
  if (tests) args.push('--tests');
  return { command: 'cargo', args };
}

export function describe({ release = false, tests = false, build = false } = {}) {
  const profile = release ? 'release' : 'debug';
  const verb = build ? 'build' : 'check';
  return `cargo ${verb}${release ? ' --release' : ''}${tests ? ' --tests' : ''}（${profile} profile）`;
}

function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return 0; }
  const { command, args } = commandFor(o);
  const label = describe(o);
  console.log(`▶ ${label}`);
  if (!o.release) console.log('  （debug 只做类型检查，比 release 快；打包不受影响）');

  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: CRATE,
    stdio: o.time ? ['ignore', 'ignore', 'ignore'] : 'inherit',
  });
  const seconds = (Date.now() - started) / 1000;
  const mmss = `${Math.floor(seconds / 60)}分${String(Math.round(seconds % 60)).padStart(2, '0')}秒`;
  if (result.error) {
    console.error(`✖ 无法执行 cargo：${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    console.error(`✖ ${label} 失败（${mmss}），看上面的输出`);
    return result.status ?? 1;
  }
  console.log(`✔ ${label} 通过，用时 ${mmss}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { process.exitCode = main(); } catch (error) { console.error(`✖ ${error.message}`); process.exitCode = 2; }
}

export { main, parseArgs, USAGE };
