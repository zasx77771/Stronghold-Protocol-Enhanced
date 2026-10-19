// scripts/make-android-client.mjs — 把 Gradle 打好的 release APK 收成正式发布用的那个文件。
//
// Gradle 只会留下 `app/build/outputs/apk/release/app-release.apk`，而发布产物一直用
// `Stronghold-Protocol-Client-v<版本>-android.apk` 这个名字（2.x 起就是这个口径）。这个脚本只做
// 搬运与命名，不构建、不签名、不改 APK 内容：签名与对齐仍由 `assembleRelease` 和 `apksigner` /
// `zipalign` 负责，本脚本只核一下它拿到的确实是一个 APK 包。
//
//   node scripts/make-android-client.mjs [--apk <path>] [--out <dir>] [--force]
//
// 默认 APK：android/app/build/outputs/apk/release/app-release.apk
// 默认输出：<仓库上一级>/Stronghold-Protocol-Client-v<版本>-android/
// 输出文件：<out>/Stronghold-Protocol-Client-v<版本>-android.apk

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_APK = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

const HELP = `node scripts/make-android-client.mjs — 把 release APK 收成正式发布用的文件名

  --apk <path>    已打好的 release APK（默认 android/app/build/outputs/apk/release/app-release.apk）
  --out <dir>     产物目录（默认 <仓库上一级>/Stronghold-Protocol-Client-v<版本>-android）
  --force         输出目录已存在时先删掉（只肯删空目录或上一次的客户端包）
  -h, --help      显示这段说明

输出文件固定为 Stronghold-Protocol-Client-v<版本>-android.apk（目录名与压缩包口径无关）。
`;

function parseArgs(argv) {
  const o = { apk: '', out: '', force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--apk') o.apk = String(val() || '');
    else if (k === '--out') o.out = String(val() || '');
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数：${a}（--help 看用法）`);
  }
  return o;
}

/** A release APK is a zip with a central directory listing `AndroidManifest.xml` (dex files can sit far from it). */
async function looksLikeApk(file) {
  const size = (await fsp.stat(file)).size;
  if (size < 1024) return false;
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    if (head.toString('latin1') !== 'PK\u0003\u0004') return false;
    // Entry names live in the central directory at the end of the archive; the tail is enough here.
    const tailLen = Math.min(size, 256 * 1024);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const text = tail.toString('latin1');
    return text.includes('PK\u0005\u0006') && text.includes('AndroidManifest.xml');
  } finally {
    await fh.close();
  }
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => h.update(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return h.digest('hex').toUpperCase();
}

/** Refuse to write inside the repository (the release tree lives next to it, outside). */
function outDirIsUnsafe(dir) {
  const up = path.relative(ROOT, dir);
  if (up === '') return true;
  return !up.startsWith('..') && !path.isAbsolute(up);
}

/** Is this directory something a previous run of this script produced? */
async function ownArtifact(dir) {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.length === 0) return 'empty';
    return entries.every((n) => n === 'README-android.md' || /^Stronghold-Protocol-Client-v.+-android\.apk$/.test(n))
      ? 'previous'
      : 'refuse';
  } catch {
    return 'missing';
  }
}

const MB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return 0; }

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const apk = path.resolve(o.apk || DEFAULT_APK);
  const out = path.resolve(o.out || path.join(path.dirname(ROOT), `Stronghold-Protocol-Client-v${version}-android`));
  const target = path.join(out, `Stronghold-Protocol-Client-v${version}-android.apk`);

  console.log(`\n卫戍协议 · Android 客户端 ${version}\n  源 APK：${apk}\n  产物：  ${out}\n`);

  if (!fs.existsSync(apk)) {
    console.error(`✖ 找不到 APK：${apk}\n  先跑 android/gradlew assembleRelease（记得签名环境变量）。`);
    return 1;
  }
  if (outDirIsUnsafe(out)) { console.error(`✖ --out 指向仓库本身或它的上级目录：${out}`); return 1; }

  if (!(await looksLikeApk(apk))) {
    console.error(`✖ 这不像一个 APK（缺 AndroidManifest.xml 或 classes*.dex）：${apk}`);
    return 1;
  }

  const verdict = await ownArtifact(out);
  if (verdict !== 'missing') {
    if (!o.force) { console.error(`✖ ${out} 已存在。要覆盖请加 --force（只删空目录或上一次的客户端包）。`); return 1; }
    if (verdict === 'refuse') { console.error(`✖ ${out} 已存在且不像上一次的客户端产物（里面有别的文件）。`); return 1; }
    await fsp.rm(out, { recursive: true, force: true });
    console.log(`  · 清掉 ${out}（${verdict === 'empty' ? '空目录' : '上一次的客户端产物'}）`);
  }
  await fsp.mkdir(out, { recursive: true });

  await fsp.copyFile(apk, target);
  const size = (await fsp.stat(target)).size;
  console.log(`✔ APK：${path.basename(target)}（${MB(size)}）`);
  console.log(`  SHA-256：${await sha256(target)}`);
  console.log('\n发布前还要跑：android/build-tools 的 apksigner verify --print-certs 与 zipalign -c -p 4。');
  return 0;
}

function isMain() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`✖ ${err?.message || err}`);
    process.exit(1);
  });
}

export { looksLikeApk, outDirIsUnsafe, sha256 };
