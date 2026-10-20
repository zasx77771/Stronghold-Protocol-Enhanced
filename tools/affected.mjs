// 按改动挑测试：从 git 里读出这次改了哪些文件，据此列出必须跑的测试，避免每次都全量 85 个文件。
//
// 用法：
//   node tools/affected.mjs                       # 对 origin/ds-enhanced-mode 之后的改动给出测试清单
//   node tools/affected.mjs --base HEAD~3         # 指定基线
//   node tools/affected.mjs --staged              # 只看已暂存
//   node tools/affected.mjs --run                 # 顺便依次跑这些测试
//   node tools/affected.mjs --json                # 机器可读
//
// 判定方式：测试文件 → 递归解析它的相对 import → 反向索引。改到某个源文件，就跑引用了它的测试。
// 宁可多跑不可漏跑：改到共享核心、测试图解析不出的文件、或挑出的测试占比过高时，直接升级为全量。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_DIR = path.join(ROOT, 'test');

/**
 * 跑 git 并拿到 stdout。刻意用「stdout 重定向到文件」而不是管道：
 * 受限沙箱（如 DSH）里子进程的管道读写会被拒绝（EPERM），重定向到普通文件不受影响。
 */
export function runGit(args, { cwd = ROOT } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-affected-'));
  const out = path.join(dir, 'out');
  const fd = openSync(out, 'w');
  const result = spawnSync('git', args, { cwd, stdio: ['ignore', fd, 'ignore'] });
  closeSync(fd);
  try {
    const text = readFileSync(out, 'utf8').trim();
    if (result.error) throw new Error(`git ${args.join(' ')} 无法执行：${result.error.message}`);
    if (result.status !== 0) {
      const error = new Error(`git ${args.join(' ')} 退出码 ${result.status}`);
      error.status = result.status;
      throw error;
    }
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** import/require 里出现的相对路径；裸模块名（node:、第三方）不算依赖。 */
export function parseImports(source) {
  const found = new Set();
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // import x from '…'
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, // import '…'
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require
    /(?:^|\n)\s*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // re-export
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.add(m[1]);
  }
  return [...found].filter((specifier) => specifier.startsWith('.'));
}

/** 把相对 specifier 解析成仓库内的绝对路径；解析不出来返回 null。 */
export function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 某个文件递归依赖到的所有仓库内文件（含自身）。 */
export function dependencyClosure(entry, { seen = new Set(), maxFiles = 4000 } = {}) {
  const stack = [entry];
  while (stack.length && seen.size < maxFiles) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    for (const specifier of parseImports(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target && !seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

/** 扫出 test/ 目录下所有以 .test.js 结尾的测试文件。 */
export function listTests(dir = TEST_DIR) {
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (name.endsWith('.test.js')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * 建立「文件 → 依赖」和「依赖 → 引用者」两张表。
 * 用引用者反向查，比「每个测试各算一次依赖闭包」快两个数量级
 * （870 个测试的仓库实测：逐测试闭包 1m38s，反向索引约 1s）。
 */
export function buildGraph(tests = listTests()) {
  const edges = new Map();
  const importers = new Map();
  const queue = [...tests];
  const seen = new Set(tests);
  while (queue.length) {
    const file = queue.pop();
    if (edges.has(file)) continue;
    let source = '';
    try { source = readFileSync(file, 'utf8'); } catch { /* 读不到就当没有依赖 */ }
    const deps = new Set();
    for (const specifier of parseImports(source)) {
      const target = resolveSpecifier(file, specifier);
      if (!target) continue;
      deps.add(target);
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
    edges.set(file, deps);
  }
  return { tests: [...tests], edges, importers };
}

/** 允许调用方传老形态 Map（测试文件 → 依赖集合），自动补出反向索引。 */
function normalizeGraph(graph) {
  if (!(graph instanceof Map)) return graph;
  const importers = new Map();
  for (const [file, deps] of graph) {
    for (const dep of deps ?? []) {
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep).add(file);
    }
  }
  return { tests: [...graph.keys()], edges: graph, importers };
}

/** 沿「谁引用了它」往上爬，找出最终会加载这个文件的测试。 */
export function testsReaching(file, graph, maxNodes = 20000) {
  const { importers } = normalizeGraph(graph);
  const hit = new Set();
  const seen = new Set([file]);
  const stack = [...(importers.get(file) ?? [])];
  while (stack.length && seen.size < maxNodes) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current.endsWith('.test.js')) hit.add(current);
    for (const up of importers.get(current) ?? []) if (!seen.has(up)) stack.push(up);
  }
  return hit;
}

/** 改这些文件很可能影响全局（版本号、脚本、lint 配置），一律跑全量。 */
const ROOT_CONFIG = new Set(['package.json', 'package-lock.json', 'eslint.config.js', 'jsconfig.json', 'tsconfig.json']);

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

/**
 * 改动分类。返回 `{ tests, rust, docs, ui, unknown, needsFull, reasons, all }`：
 * - `tests`：要跑的 Node 测试
 * - `rust` / `docs` / `ui`：需要额外跑的其它门禁
 * - `needsFull`：改动落在共享核心、项目配置或无法归类的地方
 */
export function classifyChanges(changed, { graph = buildGraph(), exists = (file) => existsSync(file) } = {}) {
  const g = normalizeGraph(graph);
  const tests = new Set();
  const rust = [];
  const docs = [];
  const ui = [];
  const unknown = [];
  const reasons = [];
  let needsFull = false;

  for (const file of changed) {
    const rel = file.split(path.sep).join('/');
    if (rel.startsWith('test/') && rel.endsWith('.test.js')) {
      tests.add(path.join(ROOT, rel));
      reasons.push(`${rel}：直接改了测试`);
      continue;
    }
    if (rel.startsWith('src-tauri/')) { rust.push(rel); continue; }
    if (rel.startsWith('docs/') || /\.md$/i.test(rel)) { docs.push(rel); continue; }
    if (/^(ui|public\/css|public\/assets\/ui)\//.test(rel) || /\.(css|scss|html)$/i.test(rel)) { ui.push(rel); continue; }
    if (ROOT_CONFIG.has(rel)) {
      needsFull = true;
      reasons.push(`${rel}：项目配置改动，跑全量`);
      continue;
    }

    const absolute = path.join(ROOT, rel);
    if (!exists(absolute)) { unknown.push(rel); continue; }

    const hit = testsReaching(absolute, g);
    if (hit.size) {
      for (const test of hit) tests.add(test);
      reasons.push(`${rel}：被 ${hit.size} 个测试引用`);
    } else if (/^(shared|server|public\/js)\//.test(rel)) {
      // 共享核心却没人引用，多半是索引不全（测试用 readFileSync 按路径读源文件）——不许悄悄跳过
      needsFull = true;
      reasons.push(`${rel}：共享核心但没有测试引用，升级为全量`);
    } else {
      unknown.push(rel);
    }
  }

  if (unknown.length) {
    needsFull = true;
    reasons.push(`${unknown.length} 个文件无法归类（${unknown.slice(0, 3).join('、')}${unknown.length > 3 ? ' 等' : ''}），升级为全量`);
  }
  // 挑出的测试超过全量一半时，全量反而更快更省心
  if (!needsFull && tests.size > g.tests.length * 0.5) {
    needsFull = true;
    reasons.push(`挑出 ${tests.size}/${g.tests.length} 个测试，超过一半，升级为全量`);
  }

  return {
    tests: [...tests].sort(),
    rust,
    docs,
    ui,
    unknown,
    needsFull,
    reasons,
    all: g.tests,
  };
}

/** 从 git 读改动文件（相对仓库根，已归一化为 `/`）。 */
export function gitChanged({ base, staged = false, cwd = ROOT } = {}) {
  const files = new Set();
  const add = (output) => {
    for (const line of String(output).split('\n')) {
      const rel = line.trim();
      if (rel) files.add(rel);
    }
  };
  if (staged) {
    add(runGit(['diff', '--name-only', '--cached', '--diff-filter=ACMR'], { cwd }));
  } else {
    const from = base ?? defaultBase(cwd);
    if (from) add(runGit(['diff', '--name-only', '--diff-filter=ACMR', `${from}...HEAD`], { cwd }));
    add(runGit(['diff', '--name-only', '--diff-filter=ACMR'], { cwd })); // 工作区未暂存
    add(runGit(['diff', '--name-only', '--cached', '--diff-filter=ACMR'], { cwd })); // 已暂存
    add(runGit(['ls-files', '--others', '--exclude-standard'], { cwd })); // 未跟踪
  }
  return [...files].sort();
}

/** 默认基线：先试集成分支，再退到 upstream/master，都没有就用 HEAD~1。 */
export function defaultBase(cwd = ROOT) {
  for (const ref of ['origin/ds-enhanced-mode', 'upstream/master', 'HEAD~1']) {
    try {
      runGit(['rev-parse', '--verify', '--quiet', ref], { cwd });
      return ref;
    } catch { /* 试下一个 */ }
  }
  return '';
}

function parseArgs(argv) {
  const o = { base: undefined, staged: false, run: false, json: false, uncommitted: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--staged') o.staged = true;
    else if (a === '--uncommitted') o.uncommitted = true;
    else if (a === '--run') o.run = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--')) throw new Error(`不认识的选项：${a}`);
  }
  if (o.uncommitted) o.base = 'HEAD'; // 只看工作区与未跟踪文件
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const changed = gitChanged({ base: o.base, staged: o.staged });
  const graph = buildGraph();
  const result = classifyChanges(changed, { graph });
  const report = {
    base: o.base ?? defaultBase(),
    changed: changed.length,
    ...result,
    tests: result.tests.map(relative),
    rust: result.rust,
    docs: result.docs,
    ui: result.ui,
    unknown: result.unknown,
    totalTests: result.all.length,
  };
  delete report.all; // JSON 里给个数就够了，870 条路径没人看

  if (o.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`基线 ${report.base || '(无)'} 改动 ${report.changed} 个文件 全量测试 ${result.all.length} 个`);
    if (!changed.length) console.log('没有改动，不必跑测试');
    else if (result.needsFull) console.log('→ 跑全量');
    else if (report.tests.length) {
      console.log('→ 跑这些测试：');
      for (const test of report.tests) console.log(`   ${test}`);
    } else console.log('→ 不需要跑 Node 测试（只改了文档/资源）');
    for (const line of new Set(result.reasons)) console.log(`   · ${line}`);
    if (report.rust.length) console.log('\n顺带要跑（Rust）：cargo test --lib（不要带 --release，debug 快得多）');
    if (report.docs.length) console.log('\n顺带要跑（文档）：node test/docs-consistency.test.js、node test/docs-paths.test.js');
    if (report.ui.length) console.log('\n顺带要跑（界面）：npm start 后 node scripts/shots.mjs --name <名字>');
  }

  if (o.run) {
    // 只跑 Node 测试；cargo 与截图仍由人决定，避免挑测试的工具顺手触发长时间编译
    const files = report.tests;
    if (!files.length) { console.log('\n没有要跑的 Node 测试'); return report; }
    console.log(`\n开始跑 ${files.length} 个测试…`);
    for (const file of files) {
      const started = Date.now();
      try {
        execFileSync(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, stdio: 'inherit' });
        console.log(`✔ ${file}（${Math.round((Date.now() - started) / 1000)}s）`);
      } catch {
        console.error(`✖ ${file} 失败`);
        process.exitCode = 1;
      }
    }
  }
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { main(); } catch (error) { console.error(`✖ ${error.message}`); process.exitCode = 1; }
}
