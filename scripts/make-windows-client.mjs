#!/usr/bin/env node
// scripts/make-windows-client.mjs — 打「Windows 原生客户端」便携目录 + zip（Tauri 壳，素材随包）。
//
//   node scripts/make-windows-client.mjs [--out <dir>] [--exe <path>] [--skip-build] [--force] [--no-zip]
//
// 默认流程：先 `cargo tauri build --no-bundle -c tauri.release.conf.json`（在 src-tauri 里跑，
// 用 release-frontend 占位页，避免把 1 GB 的 public/ 嵌进 exe），再把 exe 与 client/ 目录组装成
// 一个解压即用的目录：
//
//   Stronghold Protocol.exe   壳：sp:// 自定义协议 + TCP 桥 + 素材导入
//   client\                   窗口加载的网页本体（index.html 在 client\ 根上）
//     index.html / js / css / i18n …   ← public\
//     data\                            ← data\
//     shared\                          ← shared\
//     sim\                             ← server/sim\（去掉只给 Node 用的 nodeData.js）
//     data.js                          ← native/web/data.js
//     assets\ fonts\ vendor\           ← public\（随包素材，约 1.06 GB）
//   README-Windows.md
//   LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
//
// 为什么 client\ 放在 exe 旁边：src-tauri/src/protocol.rs 的 client_root() 先看 resource_dir()\client，
// 再看 exe 所在目录的 client\（以 index.html 存在为准）。便携包没有安装器、没有 resources，所以走第二条。
//
// 这是**客户端**：它连接用户填的服务端地址，自己不开服。素材随包，启动不联网准备。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const IS_WIN = process.platform === 'win32';

const PRODUCT = 'Stronghold Protocol';
const LEGAL_FILES = ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md'];
const TAURI_CONF = 'tauri.release.conf.json';
const BUNDLE_MARKERS = ['README-Windows.md', 'client'];

/** client\ 里放什么：`[源目录/文件, 目标]`，最后一项是排除表。 */
const CLIENT_MAP = [
  { from: 'public', to: 'client', skip: [] },
  { from: 'data', to: 'client/data', skip: [] },
  { from: 'shared', to: 'client/shared', skip: [] },
  // nodeData.js 只在 Node 里能跑（读 gamedata 缓存），浏览器侧由 data.js 提供同一份数据的精简版。
  { from: 'server/sim', to: 'client/sim', skip: ['nodeData.js'] },
  { from: 'native/web/data.js', to: 'client/data.js', file: true },
];

const HELP = `node scripts/make-windows-client.mjs — 打 Windows 原生客户端（Tauri）便携目录 + zip

  --out <dir>     产物目录（默认 <仓库上一级>/Stronghold-Protocol-Enhanced-<版本>-Windows-Portable）
  --exe <path>    跳过构建，直接用这份 exe 组装
  --skip-build    不构建，直接用 src-tauri\\target\\release 里已有的 exe
  --no-zip        只留目录，不打 .zip
  --force         目录已存在时先删掉（只肯删空目录或上一次打的客户端包）

压缩包写到 --out 的同级目录，文件名固定为 Stronghold-Protocol-Client-v<版本>-win-x64.zip
（目录名不变，方便脚本和文档指向同一个位置）。
`;

function parseArgs(argv) {
  const o = { out: '', exe: '', build: true, zip: true, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--out') o.out = String(val() || '');
    else if (k === '--exe') { o.exe = String(val() || ''); o.build = false; }
    else if (a === '--skip-build') o.build = false;
    else if (a === '--no-zip') o.zip = false;
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

function outDirIsUnsafe(out) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const o = norm(out);
  const root = norm(ROOT);
  return o === root || o === path.dirname(root) || root.startsWith(`${o}${path.sep}`);
}

function deleteVerdict(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'refuse';
  }
  if (entries.length === 0) return 'empty';
  const looks = BUNDLE_MARKERS.every((n) => entries.some((e) => e.name === n));
  return looks ? 'bundle' : 'refuse';
}

async function dirSize(dir) {
  let bytes = 0; let files = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { files++; try { bytes += (await fsp.stat(p)).size; } catch { /* ignore */ } }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/** 递归复制目录：跟随 junction/符号链接（worktree 的 public/assets 等是 junction），
 *  用 realpath 去重防止链接成环，跳过点开头的条目与给定的相对路径。 */
async function copyTree(src, dst, skip = []) {
  const seen = new Set();
  const walk = async (from, to, rel) => {
    const real = await fsp.realpath(from);
    if (seen.has(real)) return { files: 0, bytes: 0 };
    seen.add(real);
    const entries = await fsp.readdir(from, { withFileTypes: true });
    await fsp.mkdir(to, { recursive: true });
    let files = 0; let bytes = 0;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (skip.includes(childRel) || skip.includes(e.name)) continue;
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      let dir = e.isDirectory();
      let file = e.isFile();
      if (e.isSymbolicLink()) {
        const st = await fsp.stat(a);
        dir = st.isDirectory();
        file = st.isFile();
      }
      if (dir) {
        const sub = await walk(a, b, childRel);
        files += sub.files; bytes += sub.bytes;
      } else if (file) {
        await fsp.copyFile(a, b);
        files += 1; bytes += (await fsp.stat(a)).size;
      }
    }
    return { files, bytes };
  };
  return walk(src, dst, '');
}

/** 在 src-tauri 里跑 release 构建（不打包，只要 exe），返回 exe 路径。 */
function buildExe() {
  const env = { ...process.env };
  const tauriBin = path.join(process.env.USERPROFILE || '', '.cargo', 'bin');
  if (IS_WIN && fs.existsSync(tauriBin)) env.PATH = `${tauriBin};${env.PATH}`;
  console.log('  · cargo tauri build --no-bundle（首次要编译 Rust 依赖，几分钟）…');
  const r = spawnSync('cargo', ['tauri', 'build', '--no-bundle', '-c', TAURI_CONF], {
    cwd: path.join(ROOT, 'src-tauri'), stdio: 'inherit', env, shell: IS_WIN,
  });
  if (r.error || r.status !== 0) throw new Error('cargo tauri build 失败（看上面的编译输出）');
  return findExe();
}

/** target\release 里哪个是我们的 exe：排除构建脚本与依赖产物，选最大的 .exe。 */
function findExe() {
  const dir = path.join(ROOT, 'src-tauri', 'target', 'release');
  let best = '';
  let bestSize = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.exe')) continue;
    if (/^(build-script|tauri-build)/.test(e.name)) continue;
    const size = fs.statSync(path.join(dir, e.name)).size;
    if (size > bestSize) { best = path.join(dir, e.name); bestSize = size; }
  }
  if (!best || bestSize < 512 * 1024) throw new Error(`在 ${dir} 里没找到客户端 exe（是不是没构建？）`);
  return best;
}

/** Written next to the exe: removes the "downloaded from the Internet" mark SmartScreen keys on. */
export const UNBLOCK_BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'echo 正在清除此目录下文件的「来自 Internet」标记。清除后 SmartScreen 不会再拦这个程序。',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath \'%~dp0\' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue"',
  'echo.',
  'echo 完成。现在可以双击 Stronghold Protocol.exe；如果仍然被拦，点「更多信息」再点「仍要运行」。',
  'pause',
  '',
].join('\r\n');

export function readme({ version }) {
  return `# 卫戍协议：盟约 · Windows 客户端 ${version}

解压到任意目录，双击 \`${PRODUCT}.exe\` 就能玩。**不需要安装**，也不写注册表、不放系统目录。

## 这是什么

这是**客户端**：它连接你填的服务端地址（TCP 端口默认 3001），自己不开服。游戏素材已经随包带上了，
启动不会去联网下载资源；第一次打开如果提示没有 WebView2，装一次
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Windows 10/11 一般已自带）。

## 目录

\`\`\`
${PRODUCT}.exe        客户端主程序
client\\               窗口加载的网页本体与随包素材（index.html、js、i18n、assets、fonts、vendor …）
解除锁定.bat          被 SmartScreen 拦住时双击一次（见下）
README-Windows.md     本文件
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
\`\`\`

\`client\\\` 必须和 exe 放在同一层，删了或改名客户端会打不开。

## 怎么玩

1. 双击 \`${PRODUCT}.exe\`。
2. 在服务器地址栏填对方给的地址，例如 \`192.168.1.10\` 或 \`example.com:3001\`；网页客户端也能连同一台服务器。
3. 房间编码可以直接粘进同一个输入框（自动识别邀请码 / 地址）。

服务端用精简版服务端包（\`启动轻量服务端.bat\`）或完整便携包开，端口默认 HTTP/WS 3000、TCP 3001。

## 被 SmartScreen 拦住（「Windows 已保护你的电脑 / 无法识别的应用」）

这是**没有代码签名**的可执行文件 + 文件带有「来自 Internet」标记时的正常提示，不是病毒报告。

- **最快**：弹窗里点「更多信息」→「仍要运行」。
- **一劳永逸**：双击包内的 \`解除锁定.bat\`（会清除本目录所有文件的 Internet 标记），之后就不会再弹。
- **解压前先解锁**：右键下载到的 zip → 属性 → 勾「解除锁定」→ 确定，再解压。
- 想自己核对完整性：Release 页面公布的 SHA-256 与包内文件一致即可（\`Get-FileHash .\\Stronghold*.zip -Algorithm SHA256\`）。

> 想彻底消掉这个提示只能给 exe 做**代码签名**（EV 证书可立即生效，OV 证书要积累下载信誉）；
> 自签名证书不会被 SmartScreen 认可，所以本项目暂不签名，改为在包里提供上面那个解锁脚本。

## 打不开怎么办

- **解压到普通用户目录**（桌面、文档、D 盘之类），不要放在 \`Program Files\`、系统目录、只读盘，
  也不要直接在压缩包里双击 exe。目录权限不对时程序会闪退，而「以管理员身份运行」反而能开 —— 那不是客户端的问题，是目录权限。
- 启动失败会弹一个错误框，同时把原因写进 \`%LOCALAPPDATA%\\Stronghold Protocol\\client.log\`（WebView2 的缓存也在同目录下的 \`WebView2\\\`）。
  把那个日志发出来就能定位。
- 如果提示缺 WebView2，装一次上面的运行时即可（Windows 10/11 通常已自带）。

## 声明

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**，未获其授权或认可。
> - 《明日方舟》及「卫戍协议」相关的名称、角色、美术、音乐、音效、文本与数据等素材，版权归原权利人所有；这些素材**不适用**本项目的 GPL-3.0 许可证。
> - 仅供学习交流与个人非商业使用。**严禁任何形式的盈利**，包括售卖本项目或整合包、付费分发、收费服务器或收费代开、广告 / 打赏 / 会员等变现，以及其他任何商业用途。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。完整条款见 [NOTICE.md](NOTICE.md)。

内置第三方组件（Tauri / WebView2 等）的许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
`;
}

function makeZip(srcDir, zipPath) {
  const parent = path.dirname(srcDir);
  const name = path.basename(srcDir);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  for (const { cmd, args, cwd } of [
    { cmd: 'tar', args: ['-a', '-cf', zipPath, '-C', parent, name], cwd: undefined },
    { cmd: 'zip', args: ['-qr', zipPath, name], cwd: parent },
  ]) {
    const r = spawnSync(cmd, args, { cwd, stdio: 'ignore' });
    if (!r.error && r.status === 0 && fs.existsSync(zipPath)) return cmd;
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  }
  throw new Error('打 zip 失败（需要 tar -a 或 zip）');
}

function zipName(version) {
  // The release artifact keeps the name players have always downloaded (2.x used the same pattern),
  // while the folder next to it stays the plain `windows-client` the build scripts point at.
  return `Stronghold-Protocol-Client-v${version}-win-x64.zip`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const out = path.resolve(o.out || path.join(path.dirname(ROOT), `Stronghold-Protocol-Enhanced-${version}-Windows-Portable`));

  console.log(`\n卫戍协议 · Windows 客户端 ${version}\n  源仓库：${ROOT}\n  产物：  ${out}\n`);

  if (outDirIsUnsafe(out)) { console.error(`✖ --out 指向仓库本身或它的上级目录：${out}`); return 1; }
  const verdict = deleteVerdict(out);
  if (verdict !== 'missing') {
    if (!o.force) { console.error(`✖ ${out} 已存在。要覆盖请加 --force（只删空目录或上一次的客户端包）。`); return 1; }
    if (verdict === 'refuse') { console.error(`✖ ${out} 已存在且不像上一次的客户端包（包根要有 README-Windows.md 和 client\\）。`); return 1; }
    await fsp.rm(out, { recursive: true, force: true });
    console.log(`  · 清掉 ${out}（${verdict === 'empty' ? '空目录' : '上一次的客户端包'}）`);
  }
  await fsp.mkdir(out, { recursive: true });

  // 1) exe
  const exe = o.exe ? path.resolve(o.exe) : (o.build ? buildExe() : findExe());
  if (!fs.existsSync(exe)) throw new Error(`找不到 exe：${exe}`);
  const exeName = `${PRODUCT}.exe`;
  await fsp.copyFile(exe, path.join(out, exeName));
  const exeBytes = (await fsp.stat(exe)).size;
  console.log(`  · exe：${path.basename(exe)} → ${exeName}（${MB(exeBytes)}）`);

  // 2) client/
  for (const m of CLIENT_MAP) {
    const from = path.join(ROOT, m.from);
    const to = path.join(out, m.to);
    if (!fs.existsSync(from)) throw new Error(`缺少 ${m.from}：客户端要把它放进 ${m.to}（素材先跑 node tools/setup.mjs）`);
    if (m.file) {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      console.log(`  · ${m.from} → ${m.to}`);
      continue;
    }
    const info = await copyTree(from, to, m.skip || []);
    console.log(`  · ${m.from} → ${m.to}（${info.files} 个文件 / ${MB(info.bytes)}）`);
  }
  if (!fs.existsSync(path.join(out, 'client', 'index.html'))) throw new Error('client\\index.html 不存在：窗口会 404');

  // 3) 法律文件与说明
  for (const f of LEGAL_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) { console.log(`    ! 版本库里没有 ${f}`); continue; }
    await fsp.copyFile(src, path.join(out, f));
  }
  await fsp.writeFile(path.join(out, 'README-Windows.md'), readme({ version }), 'utf8');
  await fsp.writeFile(path.join(out, '解除锁定.bat'), UNBLOCK_BAT, 'utf8');

  const total = await dirSize(out);
  console.log(`\n✔ 客户端已生成：${out}\n  ${total.files} 个文件 / ${MB(total.bytes)}`);

  if (o.zip) {
    const zipPath = path.join(path.dirname(out), zipName(version));
    const tool = makeZip(out, zipPath);
    console.log(`✔ 压缩包：${zipPath}（${MB((await fsp.stat(zipPath)).size)}，${tool}）`);
    if (os.tmpdir && !zipPath.startsWith(os.tmpdir())) { /* 只是读一下 tmpdir，保持跨平台路径都正常 */ }
  }
  return 0;
}

function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
