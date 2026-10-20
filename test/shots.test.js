// `scripts/shots.mjs` 的纯函数部分：参数解析、截图命名、空闲端口。
// 真正开 Chrome 的那半段依赖本机 Chrome，属于 e2e 范畴，不在这里跑。

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import test from 'node:test';

const { parseSize, nameFromUrl, freePort, findChrome, CHROME_CANDIDATES } = await import('../scripts/shots.mjs');

test('parseSize 接受 WxH 并忽略大小写', () => {
  deepStrictEqual(parseSize('1920x1080'), { width: 1920, height: 1080 });
  deepStrictEqual(parseSize('800X600'), { width: 800, height: 600 });
  deepStrictEqual(parseSize(' 1280x720 '), { width: 1280, height: 720 });
});

test('parseSize 拒绝含糊的尺寸，免得静默按默认值截图', () => {
  throws(() => parseSize('1920'), /1920x1080/);
  throws(() => parseSize('1920*1080'), /1920x1080/);
  throws(() => parseSize('big'), /1920x1080/);
  throws(() => parseSize('1x1'), /1920x1080/);
  throws(() => parseSize(undefined), /1920x1080/);
});

test('nameFromUrl 用最后一段路径当名字，首页叫 home', () => {
  strictEqual(nameFromUrl('http://127.0.0.1:3000/'), 'home');
  strictEqual(nameFromUrl('http://127.0.0.1:3000/room'), 'room');
  strictEqual(nameFromUrl('http://127.0.0.1:3000/battle/'), 'battle');
  strictEqual(nameFromUrl('http://127.0.0.1:3000/assets/index.html'), 'index');
});

test('nameFromUrl 把不适合当文件名的字符换掉，坏 URL 兜底成 page', () => {
  strictEqual(nameFromUrl('http://host/a%20b/c%20d'), 'c-d');
  strictEqual(nameFromUrl('not a url'), 'page');
});

test('freePort 给出一个当前可被绑定的端口', async () => {
  const port = await freePort();
  ok(Number.isInteger(port) && port > 1024 && port < 65536, `端口应在 1025..65535，收到 ${port}`);
  const net = await import('node:net');
  const again = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
  });
  strictEqual(again, port);
});

test('Chrome 探测：候选表非空，找不到时返回 null 而不是抛错', () => {
  ok(CHROME_CANDIDATES.length > 0);
  const found = findChrome();
  ok(found === null || typeof found === 'string');
});
