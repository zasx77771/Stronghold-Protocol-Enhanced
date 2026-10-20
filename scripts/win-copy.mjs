// Copy a packaged client tree with robocopy (Windows) instead of Explorer / Copy-Item.
//
// Why: the portable client is tens of thousands of small files. Explorer copies them with a
// single worker and stops to paint a progress dialog; robocopy /MT fans out and never touches
// the desktop. On a 31k-file / 1.1 GB tree that is the difference between ~2.5 minutes and
// well under a minute.
//
// Usage:
//   node scripts/win-copy.mjs <source> <destination> [--threads 16] [--dry-run]
//
// Exit codes follow robocopy: 0-7 mean "files copied / already in sync", 8+ mean failure.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const USAGE = `node scripts/win-copy.mjs <source> <destination> [options]

  --threads N   并行线程数（默认 16）
  --dry-run     只列出会复制什么，不动文件
  --quiet       不在结束时打印汇总
`;

/** robocopy args for a full tree copy: recurse, quiet-ish, multi-threaded. */
export function commandFor({ source, destination, threads = 16, dryRun = false }) {
  const args = [resolve(source), resolve(destination), '/E', `/MT:${threads}`, '/NFL', '/NDL', '/NJH', '/NP', '/R:2', '/W:1'];
  if (dryRun) args.push('/L');
  return { command: 'robocopy', args };
}

/** robocopy reports success with 0-7; 8 means at least one file failed. */
export function isSuccess(code) {
  return Number.isInteger(code) && code >= 0 && code < 8;
}

/** Fallback for machines without robocopy: plain recursive copy. */
export function fallbackCopy(source, destination) {
  cpSync(resolve(source), resolve(destination), { recursive: true, force: true });
}

export function parseArgs(argv) {
  const args = { source: null, destination: null, threads: 16, dryRun: false, quiet: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--threads') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 128) throw new Error('--threads 需要 1-128 的整数');
      args.threads = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') throw new Error(USAGE);
    else if (arg.startsWith('--')) throw new Error(`未知选项 ${arg}`);
    else rest.push(arg);
  }
  if (rest.length !== 2) throw new Error('需要 <source> 和 <destination> 两个路径');
  args.source = rest[0];
  args.destination = rest[1];
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!existsSync(options.source)) throw new Error(`源目录不存在：${options.source}`);
  const plan = commandFor(options);
  const started = Date.now();
  const result = spawnSync(plan.command, plan.args, { stdio: 'inherit' });
  let code = result.status;
  if (result.error && result.error.code === 'ENOENT') {
    process.stderr.write('没找到 robocopy，退回普通递归复制\n');
    fallbackCopy(options.source, options.destination);
    code = 0;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (!options.quiet) process.stdout.write(`\n用时 ${seconds}s（robocopy 退出码 ${code}）\n`);
  if (!isSuccess(code)) {
    process.stderr.write('robocopy 报告有文件失败（退出码 >= 8），请检查上面的错误\n');
    process.exitCode = 1;
  }
  return code;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
