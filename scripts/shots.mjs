// 前端改动的一分钟自检：起一个有调试端口的系统 Chrome，用 CDP 打开页面、截图、报错与横向溢出，
// 可选的 `--compare` 把这次的图和上一版逐像素比一遍。全程不打包、不装机、不依赖额外 npm 包。
//
// 为什么不用 puppeteer.launch()：它用管道与 Chrome 通信，在受限环境（如 DSH 沙箱）里 spawn 管道会被拒绝
// （EPERM）。这里自己以 `stdio: 'ignore'` 起 Chrome，再 puppeteer.connect 到它的调试端口 —— 只用 TCP。
// 即便如此，Chrome 自己要用 Mojo 命名管道，某些沙箱仍会拒绝（`platform_channel.cc:112 Check failed: 访问被拒绝`），
// 那种情况下需要在沙箱外运行，或对该条命令放行。
//
// 用法：
//   node scripts/shots.mjs --out test/e2e/out/shots --name title --url http://127.0.0.1:3000/
//   node scripts/shots.mjs --name title --compare test/e2e/out/baseline
//   node scripts/shots.mjs --url "file:///…/index.html" --name offline --size 1280x720 --full-page
// 选项：--out/--url/--name/--size WxH/--wait ms/--timeout ms/--full-page/--compare <目录>/--json

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/* global document, Image, ImageData */ // 下面 page.evaluate 的回调在浏览器里执行

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');

/** 各处装 Chrome 的常见位置；`CHROME_PATH` 优先。 */
export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export const findChrome = () => CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从一个 URL 取截图用的默认名字：`http://host/room?id=2` → `room`，`/` → `home`。 */
export function nameFromUrl(url) {
  try {
    const { pathname } = new URL(url);
    const last = decodeURIComponent(pathname).replace(/\/+$/, '').split('/').pop();
    const clean = (last ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '-');
    return clean || (pathname.replace(/\/+$/, '') === '' ? 'home' : 'page');
  } catch {
    return 'page';
  }
}

/** `1920x1080` → `{ width: 1920, height: 1080 }`；坏值抛错，免得静默按默认尺寸截图。 */
export function parseSize(text) {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(String(text ?? '').trim());
  if (!m) throw new Error(`--size 要写成 1920x1080，收到的是 ${JSON.stringify(text)}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 找一个空闲的本地端口给 Chrome 的调试接口用（`--remote-debugging-port=0` 不告诉端口，只能自己先探）。 */
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 起 Chrome 并连上它的调试端口。返回 `{ browser, close }`；调用方负责 `close()`。
 * 启动失败时把 exit code 与 stderr 的尾巴带出来，不要只说一句「连不上」。
 */
export async function launchChrome({ width = 1920, height = 1080, timeoutMs = 30000 } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome：设置 CHROME_PATH 指向可执行文件');
  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), 'sp-shots-'));
  const child = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const deadline = Date.now() + timeoutMs;
  let version = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome 启动即退出（exit ${child.exitCode}）：${chrome}`);
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch { await sleep(200); }
  }
  if (!version) {
    child.kill();
    throw new Error(`Chrome 的调试端口 ${port} 在 ${timeoutMs} ms 内没有就绪（受限环境常见：Chrome 需要 Mojo 命名管道）`);
  }

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: { width, height, deviceScaleFactor: 1 },
  });
  return {
    browser,
    chrome,
    version: version.Browser ?? '',
    close: async () => { try { await browser.disconnect(); } catch { /* 已断开 */ } child.kill(); },
  };
}

/** 打开一个页面并截一张图；同时收控制台错误、页面异常、HTTP 状态与横向溢出。 */
export async function capture(browser, { url, waitMs = 2500, timeoutMs = 60000, fullPage = false }) {
  // 视口大小在 launchChrome 里定好（defaultViewport），这里不再逐页设置
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`.trim()));

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    const status = response?.status() ?? null;
    await sleep(waitMs);
    const metrics = await page.evaluate(() => ({
      title: document.title,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    const png = await page.screenshot({ fullPage });
    return { status, png, metrics, errors, url };
  } finally {
    await page.close();
  }
}

/**
 * 两张 PNG 的差异：在页面里用 canvas 比，避免为了解码 PNG 引依赖。
 * 返回 `{ changed, total, ratio, diffPng }`；`diffPng` 是把不同的像素涂红的图，可用于肉眼定位。
 */
export async function diffPng(browser, beforePng, afterPng) {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0"></body>');
    return await page.evaluate(async (a, b) => {
      const load = (bytes) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = `data:image/png;base64,${bytes}`;
      });
      const [left, right] = await Promise.all([load(a), load(b)]);
      const width = Math.max(left.width, right.width);
      const height = Math.max(left.height, right.height);
      const paint = (img) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const l = paint(left), r = paint(right);
      const out = new ImageData(width, height);
      let changed = 0;
      for (let i = 0; i < l.length; i += 4) {
        const same = l[i] === r[i] && l[i + 1] === r[i + 1] && l[i + 2] === r[i + 2];
        if (!same) {
          changed++;
          out.data[i] = 255; out.data[i + 1] = 0; out.data[i + 2] = 0; out.data[i + 3] = 255;
        } else {
          // 没变的像素压暗，红点才看得清
          out.data[i] = l[i] >> 2; out.data[i + 1] = l[i + 1] >> 2; out.data[i + 2] = l[i + 2] >> 2; out.data[i + 3] = 255;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').putImageData(out, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      return {
        changed,
        total: (l.length / 4),
        ratio: changed / (l.length / 4),
        size: { width, height },
        sizes: { before: { width: left.width, height: left.height }, after: { width: right.width, height: right.height } },
        diffPng: dataUrl.slice(dataUrl.indexOf(',') + 1),
      };
    }, beforePng.toString('base64'), afterPng.toString('base64'));
  } finally {
    await page.close();
  }
}

function parseArgs(argv) {
  const o = {
    url: 'http://127.0.0.1:3000/',
    name: '',
    out: path.join(ROOT, 'test/e2e/out/shots'),
    size: { width: 1920, height: 1080 },
    wait: 2500,
    timeout: 60000,
    fullPage: false,
    compare: '',
    json: false,
  };
  const value = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = value(i++);
    else if (a === '--name') o.name = value(i++);
    else if (a === '--out') o.out = path.resolve(value(i++));
    else if (a === '--size') o.size = parseSize(value(i++));
    else if (a === '--wait') o.wait = Number(value(i++));
    else if (a === '--timeout') o.timeout = Number(value(i++));
    else if (a === '--compare') o.compare = path.resolve(value(i++));
    else if (a === '--full-page') o.fullPage = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--')) throw new Error(`不认识的选项：${a}`);
  }
  o.name ||= nameFromUrl(o.url);
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const chrome = await launchChrome({ ...o.size, timeoutMs: Math.min(o.timeout, 30000) });
  const report = { name: o.name, url: o.url, chrome: chrome.version, screenshot: '', bytes: 0, status: null, title: '', errors: [], overflow: null, compare: null };
  try {
    const shot = await capture(chrome.browser, { url: o.url, ...o.size, waitMs: o.wait, timeoutMs: o.timeout, fullPage: o.fullPage });
    // 先把基线读进内存再写新图：`--compare` 与 `--out` 指向同一目录时，比的就是「上一次 vs 这一次」，而不是自己比自己。
    const base = o.compare ? path.join(o.compare, `${o.name}.png`) : '';
    const baseBytes = base && existsSync(base) ? readFileSync(base) : null;
    mkdirSync(o.out, { recursive: true });
    const file = path.join(o.out, `${o.name}.png`);
    writeFileSync(file, shot.png);
    report.screenshot = file;
    report.bytes = shot.png.length;
    report.status = shot.status;
    report.title = shot.metrics.title;
    report.errors = shot.errors.slice(0, 8);
    report.overflow = shot.metrics.scrollWidth > shot.metrics.clientWidth
      ? { scrollWidth: shot.metrics.scrollWidth, clientWidth: shot.metrics.clientWidth }
      : null;

    if (o.compare) {
      if (!baseBytes) {
        report.compare = { baseline: base, exists: false };
      } else {
        const diff = await diffPng(chrome.browser, baseBytes, shot.png);
        const diffFile = path.join(o.out, `${o.name}.diff.png`);
        writeFileSync(diffFile, Buffer.from(diff.diffPng, 'base64'));
        report.compare = {
          baseline: base,
          exists: true,
          changed: diff.changed,
          total: diff.total,
          ratio: Number(diff.ratio.toFixed(4)),
          diff: diffFile,
        };
      }
    }
  } finally {
    await chrome.close();
  }

  if (o.json) {
    console.log(JSON.stringify(report));
    return report;
  }
  console.log(`${report.name}: ${report.bytes} B  ${report.status ?? '?'}  「${report.title}」`);
  console.log(`  截图：${report.screenshot}`);
  if (report.overflow) console.log(`  ⚠ 横向溢出：scrollWidth ${report.overflow.scrollWidth} > clientWidth ${report.overflow.clientWidth}`);
  if (report.errors.length) {
    console.log(`  控制台/请求错误 ${report.errors.length} 条：`);
    for (const e of report.errors) console.log(`    - ${e}`);
  }
  if (report.compare) {
    if (!report.compare.exists) console.log(`  对比：没有基线 ${report.compare.baseline}`);
    else console.log(`  对比：${report.compare.changed}/${report.compare.total} 像素不同（${(report.compare.ratio * 100).toFixed(2)}%），差异图 ${report.compare.diff}`);
  }
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((report) => {
    // 横向溢出、控制台报错、基线有差异都算失败，好让 CI 或脚本直接拿去当门禁
    const bad = report.errors.length > 0 || report.overflow !== null || (report.compare?.exists && report.compare.changed > 0);
    process.exitCode = bad ? 1 : 0;
  }).catch((error) => {
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
  });
}
