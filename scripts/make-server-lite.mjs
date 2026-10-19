#!/usr/bin/env node
// scripts/make-server-lite.mjs — 打一份「精简服务端」Windows 包：**不含素材文件，但保留素材清单 JSON**。
//
//   node scripts/make-server-lite.mjs [--out <dir>] [--no-node] [--force] [--no-zip]
//
// 产物目录（默认 <仓库上一级>\Stronghold-Protocol-Enhanced-<版本>-Windows-Server-Lite）：
//   node\node.exe                官方 Windows x64 便携版 Node（版本与 sha256 钉在 make-windows-bundle.mjs 的 NODE_PIN）
//   node\LICENSE-node.txt        Node 自己的许可证
//   app\                         服务端本体：server / shared / public（无 assets、fonts、vendor）/ data / packs / plugins / scripts / tools / docs
//   启动轻量服务端.bat           SP_ASSET_INDEX=0、SP_STUDIO=off，跑 app\server\index.js
//   README-Lite-Server.md        给服主看的说明
//   LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md
//
// 与 make-windows-bundle.mjs（玩家便携包）的区别，以及为什么这么切：
//   * 玩家包是「本机开服 + 浏览器游戏」，素材是硬成本（约 330 MB），所以精简包不重复发一份素材；
//   * 但客户端要问 `/data/assets.json`（素材清单）才知道哪些文件存在，清单本身只有约 2 MB，
//     所以 `data/assets.json` **必须留在包里** —— 删了它，连「请求素材 json」都会退化。
//   * `public/assets`、`public/fonts`、`public/vendor` 不进包：本地素材路径返回 404，
//     素材索引默认关闭（启动器里 `SP_ASSET_INDEX=0`），不会去扫一张不存在的素材树。
//   * `data/local-assets.json`、`data/local-fx.json` 是本机提取的清单，描述的是不随包发布的本地素材，
//     因此也不带；缺省时服务端对这两个路径返回空清单（server/http/static.js 的 EMPTY_LOCAL_ART），
//     不是 404。
//   * 原生客户端工程（android/、src-tauri/、native/）与测试（test/）对服端没有用处，不进包。
//
// 硬规则（和玩家包一致）：
//   1. app\ 的文件清单来自 `git ls-files`，不是手写的跳过表 —— 本机文件（.env 等）天然进不了包。
//   2. node_modules 用 `npm ci --omit=dev` 重新装，不带 devDependency；装完再按**服务端真实 import** 裁剪
//      （见 pruneServerDeps）：dependencies 里混着 pixi.js / three / preact / htm 这些只有浏览器用的库，
//      整套搬进包里会给服主多出 5,800 多个没用的小文件，解压慢得肉眼可见。@pixi-spine 例外 ——
//      插件解析 Spine 骨架时真的要用，保留。
//   3. node.exe 每次从校验过的官方 zip 重新解压，绝不复用旧解压结果。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NODE_PIN, ensureNodeZip, extractPortableNode, installProductionDeps,
  trackedFiles, dirSize, bat, LEGAL_FILES, outDirIsUnsafe, copyFiles,
} from './make-windows-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** 版本库里有、但服务端包不要的。素材目录本来就不在版本库，另由 FORBIDDEN_DIRS 兜底检查。 */
const SKIP_TRACKED = [
  'test/', 'android/', 'src-tauri/', 'native/', '.github/',
  // 这两份清单描述的是「本机从游戏文件里提取出来的素材」；精简包不带这些素材，
  // 带上清单只会让客户端去请求一堆 404 的路径，不如让服务端按缺省返回空清单。
  'data/local-assets.json', 'data/local-fx.json',
];

/** 这几份不许出现在精简包里（出现了就说明打包路径写错了）。 */
const FORBIDDEN_DIRS = ['public/assets', 'public/fonts', 'public/vendor'];

/** 精简包里**必须**有的清单：客户端靠它知道素材是否存在。 */
const REQUIRED_FILES = ['data/assets.json'];

/** 上一次打的精简包长这样（`--force` 只肯删这种目录或空目录）。 */
const LITE_MARKERS = ['README-Lite-Server.md', 'app'];

/**
 * 服务端运行时真正会 import 的代码目录。`public/` 不在这里：那是浏览器代码，bare specifier 由 import map
 * 指到 `/vendor/*`，Node 从不解析它们（精简包连 public/vendor 都不带）。
 */
const SERVER_CODE_DIRS = ['server', 'shared', 'tools', 'scripts'];

/**
 * 裁完 node_modules 的硬上限。当前真实闭包约 1,885 个文件 / 14.7 MB：
 * `ws` / `acorn` / `ses` / `@endo/*`，加上插件包解析 Spine 骨架要用的 `@pixi-spine` 与它 peer 依赖的
 * `@pixi/*`（`@pixi-spine/runtime-3.8` 把 `@pixi/core` 声明成 peer，`server/plugins/pack.js` 会用到）。
 * 纯浏览器库 pixi.js / three / preact / htm 一个都不留。谁再往 dependencies 加浏览器库，这里会先炸。
 */
const DEP_LIMITS = { files: 2300, bytes: 18 * 1024 * 1024 };

const HELP = `node scripts/make-server-lite.mjs — 生成 Windows 精简服务端包（不含素材文件，保留素材清单 JSON）

  --out <dir>        产物目录（默认 <仓库上一级>/Stronghold-Protocol-Enhanced-<版本>-Windows-Server-Lite）
  --no-node          不下载便携版 Node（目标机器需自备 Node 22+）
  --no-zip           只留目录，不打 .zip
  --force            目录已存在时先删掉（只肯删空目录，或上一次打的精简包；其余情况拒绝）

  app\\ 里只放 git 跟踪的文件（去掉 test/、android/、src-tauri/、native/、.github/）+ 生产依赖；
  生产依赖装完会按服务端真实 import 裁剪，只留 ws / acorn / ses 及其依赖（约 130 个文件）；
  public/assets、public/fonts、public/vendor 不进包，data/assets.json 这类清单留在包里。
  压缩包固定写到 --out 同级，名为 Stronghold-Protocol-Server-v<版本>-win-x64.zip（目录名照 --out）。
`;

function parseArgs(argv) {
  const o = { out: '', node: true, zip: true, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--out') o.out = String(val() || '');
    else if (a === '--no-node') o.node = false;
    else if (a === '--no-zip') o.zip = false;
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

/** `--force` 允不允许删这个目录？只认「不存在 / 空目录 / 上一次的精简包」，其余一律拒绝。 */
function liteDeleteVerdict(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return e?.code === 'ENOENT' ? 'missing' : 'refuse';
  }
  if (entries.length === 0) return 'empty';
  const app = entries.find((e) => e.name === 'app');
  const isDir = (e) => e.isDirectory() || e.isSymbolicLink();
  // 上一次跑到一半失败（只留下 app\，说明还没写 README）：也算自己人，允许 --force 清掉。
  if (entries.length === 1 && app && isDir(app)) return 'partial';
  const looksLike = LITE_MARKERS.every((n) => entries.some((e) => e.name === n)) && !!app && isDir(app);
  return looksLike ? 'bundle' : 'refuse';
}

/** 包内说明（纯文本，中文）。 */
function liteReadme({ version, withNode, nodeVersion }) {
  const nodeLine = withNode
    ? `包内自带便携版 Node ${nodeVersion}（\`node\\node.exe\`），目标机器**不需要安装 Node**。`
    : '这个包**没有带便携版 Node**：请先在这台机器上安装 Node 22 或 24（LTS），并让 `node` 在 PATH 里。';
  const tree = withNode
    ? `node\\node.exe            便携版 Node ${nodeVersion}（官方 x64，已 sha256 校验）
node\\LICENSE-node.txt    Node 自己的许可证（MIT）
app\\                     服务端本体（server / shared / public / data / packs / plugins / scripts / tools / docs）
启动轻量服务端.bat       设置 SP_ASSET_INDEX=0、SP_STUDIO=off 后启动 app\\server\\index.js
README-Lite-Server.md    本文件
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md`
    : `app\\                     服务端本体（server / shared / public / data / packs / plugins / scripts / tools / docs）
启动轻量服务端.bat       设置 SP_ASSET_INDEX=0、SP_STUDIO=off 后启动 app\\server\\index.js
README-Lite-Server.md    本文件
LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md`;

  return `# 卫戍协议：盟约 · 精简版服务端 ${version}（Windows）

这是一个**只给服主用**的对局服务器包：把目录解压到任意位置，双击 \`启动轻量服务端.bat\` 即可开服。
${nodeLine}

## 包里有什么、没有什么

- **有**：服务器代码（HTTP / WebSocket / TCP）、游戏数据、盟约与插件目录、语言包、脚本工具与文档。
- **有**：素材清单 JSON（\`app\\data\\assets.json\`）。客户端会请求 \`/data/assets.json\`、\`/data/local-assets.json\`
  来判断素材是否存在；精简包照样能应答（\`data/assets.json\` 是完整清单，本地清单缺失时返回空清单而不是 404）。
- **没有**：美术 / 音频 / 字体文件（\`public/assets\`、\`public/fonts\`）和浏览器前端库（\`public/vendor\`）。
  因此本地素材路径一律 404，素材索引默认关闭（启动器设置了 \`SP_ASSET_INDEX=0\`，省掉扫描一张不存在的素材树）。
- **没有**：原生客户端工程（\`android\`、\`src-tauri\`、\`native\`）与测试代码 —— 对服端没有用处。
- **所以它不是「浏览器可玩客户端包」**：要用网页界面玩，请用完整的玩家便携包，或者把 \`public/assets\`、
  \`public/fonts\`、\`public/vendor\` 放进 \`app\\public\\\` 下再启动。原生客户端（Windows / Android）自带素材，不需要服务端提供。

## 包内结构

\`\`\`
${tree}
\`\`\`

## 怎么开服

先把压缩包**解出来**，再双击启动器。解压方式会实质影响耗时（包里小文件多）：

- 用 \`tar.exe\`（Windows 10 1803 起自带）：\`tar -xf Stronghold-Protocol-Server-v${version}-win-x64.zip\`。
  同一个包，本机实测 \`tar.exe\` 约 23 秒，资源管理器右键「全部解压」要 66 秒。装了 7-Zip 的话右键「7-Zip → 提取到此处」也很快。
- **不要解到** 网络盘（SMB / NFS / rclone / 映射驱动器）或会被实时同步、实时扫描的目录：
  大量小文件会被网络往返和同步器拖慢。
- 建议把这个目录加进杀软排除（管理员 PowerShell，路径换成你自己的）：
  \`Add-MpPreference -ExclusionPath 'D:\\sp-server'\`。
- \`app\\node_modules\` 已经是**裁剪过**的运行时依赖（只有 \`ws\` / \`acorn\` / \`ses\` 及其 \`@endo/*\` 依赖，约 130 个文件）：
  不要在包内跑 \`npm install\`，也不要指望包里的 \`tools\` 构建脚本能跑 —— 那些需要浏览器库，属于源码仓库的事。

\`\`\`
双击 启动轻量服务端.bat
\`\`\`

控制台会打印监听地址（默认 \`http://<本机>:3000\`，TCP 对局端口 \`3001\`）。可用的环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| \`PORT\` | \`3000\` | HTTP / WebSocket 端口 |
| \`TCP_PORT\` | \`3001\` | 原生客户端的 TCP 对局端口（只用网页客户端时可以不开放） |
| \`HOST\` | \`::\`（双栈） | 监听地址；\`127.0.0.1\` 只允许本机，\`0.0.0.0\` 只监听 IPv4 |
| \`SP_ASSET_INDEX\` | 启动器设成 \`0\` | 素材内容哈希索引；精简包没有素材，关掉更快 |
| \`SP_STUDIO\` | 启动器设成 \`off\` | 插件工作台（\`/studio/\`）；精简包默认不对外提供 |

第一次开服时 Windows 防火墙可能弹窗，勾选**允许专用网络**（否则局域网里的朋友连不上）。

## 数据与备份

- 对局数据、插件、盟约都在 \`app\\\` 下：\`app\\data\\\`（只会读取，不要手改生成的数据）、\`app\\packs\\\`、\`app\\plugins\\\`。
- 升级服务端时，**先备份 \`app\\data\\\`、\`app\\packs\\\`、\`app\\plugins\\\` 和 \`app\\plugins\\config.json\`**，
  再用新包覆盖 \`app\\\`；\`node\\\` 与启动器可以直接沿用新包。
- 卸载＝直接删掉整个文件夹（不写注册表、不放系统目录）。

## 声明

> [!IMPORTANT]
> - 本项目是玩家自制的**非官方同人作品**，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方**没有任何关系**，未获其授权或认可。
> - 《明日方舟》及「卫戍协议」相关的名称、角色、美术、音乐、音效、文本与数据等素材，版权归原权利人所有。这些素材**不适用**本项目的 GPL-3.0 许可证；GPL 只覆盖本项目自己编写的代码。
> - 仅供学习交流与个人非商业使用。**严禁任何形式的盈利**，包括但不限于：售卖本项目或整合包、付费下载或付费分发、收费服务器或收费代开、广告 / 打赏 / 会员等变现方式，以及其他任何商业用途。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。完整条款见 [NOTICE.md](NOTICE.md)。

包内 [LICENSE](LICENSE) 里的 GPL-3.0-or-later 覆盖的是**本项目自己编写的代码**；内置 Node.js（MIT）以及其它
第三方组件的许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
`;
}

/** 打 zip（Windows 与 macOS 的 bsdtar 支持 `-a` 自动按扩展名选格式；Linux 走 zip 命令）。 */
function makeZip(srcDir, zipPath) {
  const parent = path.dirname(srcDir);
  const name = path.basename(srcDir);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  const attempts = [
    { cmd: 'tar', args: ['-a', '-cf', zipPath, '-C', parent, name], cwd: undefined },
    { cmd: 'zip', args: ['-qr', zipPath, name], cwd: parent },
  ];
  for (const { cmd, args, cwd } of attempts) {
    const r = spawnSync(cmd, args, { cwd, stdio: 'ignore' });
    if (!r.error && r.status === 0 && fs.existsSync(zipPath)) return cmd;
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  }
  throw new Error('打 zip 失败（需要 tar -a 或 zip）');
}

/** 抓出源码里的模块说明符：`from 'x'`、`import 'x'`、`import('x')`、`require('x')` 都算。 */
const SPECIFIER_RE = /\b(?:from|import|require)\s*\(?\s*(['"])([^'"\n]+)\1/g;

/** 裸包名（`ws`、`@endo/cache-map/sub.js` → `@endo/cache-map`）；相对路径、URL、内置模块返回 null。 */
function packageNameOf(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0];
  // 正则同样会命中字符串里的 `from '…'`（PNG 块名、i18n 片段之类），这里只认长得像包名的。
  if (!name || !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return null;
  return name;
}

/** 服务端包内所有**由 Node 执行**的代码引用的裸包名。 */
async function scanServerImports(appDir) {
  const names = new Set();
  const walk = async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(?:mjs|cjs|js)$/.test(entry.name)) continue;
      const text = await fsp.readFile(full, 'utf8');
      for (const m of text.matchAll(SPECIFIER_RE)) {
        const name = packageNameOf(m[2]);
        if (name) names.add(name);
      }
    }
  };
  for (const dir of SERVER_CODE_DIRS) await walk(path.join(appDir, dir));
  return names;
}

/**
 * 从这些包出发，按 package.json 的 dependencies + peerDependencies 求传递闭包；只收真实装到盘上的包。
 * peer 也要跟：`@pixi-spine/runtime-3.8` 把 `@pixi/core` 声明成 peer（由 pixi.js 提供），漏掉它插件包解析
 * Spine 骨架时会 `Cannot find module '@pixi/core'`。
 */
function depClosure(nodeModules, roots) {
  const keep = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (!name || keep.has(name)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(nodeModules, name, 'package.json'), 'utf8'));
    } catch { continue; /* 没装到（扫描误报或可选依赖）：忽略 */ }
    keep.add(name);
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const dep of Object.keys(pkg[field] || {})) queue.push(dep);
    }
  }
  return keep;
}

/**
 * 只留服务端真正会加载的运行时依赖，其余（pixi / three / preact / htm 这些浏览器库及其依赖树）删掉。
 * 返回裁剪结果，并在超过 DEP_LIMITS 时直接抛错——防止以后又往 dependencies 里加浏览器库。
 */
async function pruneServerDeps(appDir) {
  const nodeModules = path.join(appDir, 'node_modules');
  const roots = await scanServerImports(appDir);
  roots.add('ses'); // 沙箱是 `import('ses')` 动态加载的，静态扫描能抓到，这里再兜一层
  const keep = depClosure(nodeModules, roots);
  const removed = [];

  for (const entry of await fsp.readdir(nodeModules, { withFileTypes: true })) {
    const name = entry.name;
    if (name === '.package-lock.json') continue;
    if (name === '.bin') {
      await fsp.rm(path.join(nodeModules, name), { recursive: true, force: true });
      continue;
    }
    if (name.startsWith('@')) {
      const scopeDir = path.join(nodeModules, name);
      for (const child of await fsp.readdir(scopeDir)) {
        const full = `${name}/${child}`;
        if (keep.has(full)) continue;
        await fsp.rm(path.join(scopeDir, child), { recursive: true, force: true });
        removed.push(full);
      }
      if ((await fsp.readdir(scopeDir)).length === 0) await fsp.rm(scopeDir, { recursive: true, force: true });
      continue;
    }
    if (keep.has(name)) continue;
    await fsp.rm(path.join(nodeModules, name), { recursive: true, force: true });
    removed.push(name);
  }

  const size = await dirSize(nodeModules);
  for (const required of ['ws', 'acorn', 'ses']) {
    if (!keep.has(required)) throw new Error(`✖ 依赖闭包里没有 ${required}：服务端启动会直接失败，检查扫描结果`);
  }
  if (size.files > DEP_LIMITS.files || size.bytes > DEP_LIMITS.bytes) {
    throw new Error(`✖ 裁剪后的 app/node_modules 仍有 ${size.files} 个文件 / ${MB(size.bytes)}，超过上限 ${DEP_LIMITS.files} / ${MB(DEP_LIMITS.bytes)}：dependencies 里大概又混进了只在浏览器里用的库`);
  }
  return { keep: [...keep].sort(), removed, size };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const out = path.resolve(o.out || path.join(path.dirname(ROOT), `Stronghold-Protocol-Enhanced-${version}-Windows-Server-Lite`));
  const appDir = path.join(out, 'app');
  const nodeDir = path.join(out, 'node');

  console.log(`\n卫戍协议 · 精简版服务端 ${version}（Windows）\n  源仓库：${ROOT}\n  产物：  ${out}\n`);

  if (outDirIsUnsafe(out)) {
    console.error(`✖ --out 指向仓库本身或它的上级目录：${out}\n  加 --force 会把仓库删掉，请换一个仓库之外的目录。`);
    return 1;
  }
  const verdict = liteDeleteVerdict(out);
  if (verdict !== 'missing') {
    if (!o.force) {
      console.error(`✖ ${out} 已存在。要覆盖请加 --force —— 它只会删空目录或上一次打的精简包，其余情况一律拒绝。`);
      return 1;
    }
    if (verdict === 'refuse') {
      console.error(`✖ ${out} 已存在，但它既不是空目录，也不像上一次打的精简包（包根要有 README-Lite-Server.md 和 app\\）。`);
      return 1;
    }
    await fsp.rm(out, { recursive: true, force: true });
    console.log(`  · 清掉 ${out}（${{ empty: '空目录', partial: '上一次没打完的目录', bundle: '上一次的精简包' }[verdict]}）`);
  }
  await fsp.mkdir(out, { recursive: true });

  // 1) 服务端代码：git 跟踪的文件，去掉与服端无关的目录
  const all = trackedFiles();
  const wanted = all.filter((rel) => !SKIP_TRACKED.some((p) => rel === p || rel.startsWith(p)));
  console.log(`  · 复制服务端本体（git 跟踪 ${all.length} 个文件，取 ${wanted.length} 个）…`);
  const copied = await copyFiles(wanted, appDir);
  console.log(`    完成：${copied.files} 个文件 / ${MB(copied.bytes)}`);

  // 2) 兜底检查：素材不许进包，清单必须在
  for (const rel of FORBIDDEN_DIRS) {
    if (fs.existsSync(path.join(appDir, rel))) throw new Error(`✖ ${rel} 不该进精简包：检查 SKIP_TRACKED / 素材是否被误当作跟踪文件`);
  }
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(appDir, rel))) throw new Error(`✖ 缺少 ${rel}：客户端要靠它请求素材清单，请先在仓库里生成（node tools/build-data.mjs）`);
  }
  console.log(`  · 已确认不含素材文件，且保留 ${REQUIRED_FILES.join('、')}`);

  // 3) 运行时依赖：先按锁文件装生产依赖，再按服务端真实 import 裁剪掉浏览器库
  await installProductionDeps(appDir);
  const installed = await dirSize(path.join(appDir, 'node_modules'));
  const deps = await pruneServerDeps(appDir);
  console.log(`    完成：${deps.size.files} 个文件 / ${MB(deps.size.bytes)}`);
  console.log(`    裁剪：装好 ${installed.files} 个 → 留 ${deps.keep.join('、')}（去掉 ${deps.removed.length} 个包）`);

  // 4) 便携版 Node
  const nodeVersion = NODE_PIN.version;
  if (o.node) {
    console.log(`  · 准备便携版 Node ${nodeVersion}…`);
    await fsp.mkdir(nodeDir, { recursive: true });
    const zipPath = await ensureNodeZip(nodeVersion, NODE_PIN.sha256);
    const info = await extractPortableNode(nodeDir, nodeVersion, zipPath);
    console.log(`    完成：Node ${info.version} / ${MB(info.bytes)} + LICENSE`);
  }

  // 5) 法律文件
  for (const f of LEGAL_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) { console.log(`    ! 版本库里没有 ${f}，包根将缺少这份声明`); continue; }
    await fsp.copyFile(src, path.join(out, f));
  }

  // 6) 启动器与说明
  const launcher = bat([
    'if not defined PORT set "PORT=3000"',
    'if not defined TCP_PORT set "TCP_PORT=3001"',
    'set "SP_ASSET_INDEX=0"',
    'set "SP_STUDIO=off"',
    '"%NODE%" "%HERE%app\\server\\index.js" %*',
  ].join('\r\n'));
  await fsp.writeFile(path.join(out, '启动轻量服务端.bat'), launcher, 'latin1');
  await fsp.writeFile(path.join(out, 'README-Lite-Server.md'), liteReadme({ version, withNode: !!o.node, nodeVersion }), 'utf8');

  const total = await dirSize(out);
  console.log(`\n✔ 精简服务端已生成：${out}\n  ${total.files} 个文件 / ${MB(total.bytes)}`);

  if (o.zip) {
    // The archive name is fixed (the old release line used the same shape); only the directory keeps --out's name.
    const zipPath = path.join(path.dirname(out), `Stronghold-Protocol-Server-v${version}-win-x64.zip`);
    const tool = makeZip(out, zipPath);
    const zipBytes = (await fsp.stat(zipPath)).size;
    console.log(`✔ 压缩包：${zipPath}（${MB(zipBytes)}，${tool}）`);
  }
  console.log('  双击「启动轻量服务端.bat」即可开服（默认 3000 / TCP 3001）。');
  return 0;
}

function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) main().then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
