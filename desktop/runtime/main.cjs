'use strict';

// Electron desktop shell for the client-only portable build.  It serves bundled resources from a
// loopback-only random port because the existing browser client uses root-relative ES modules,
// fetches and audio range requests.  No game-server code runs here.

const { app, BrowserWindow, session, ipcMain, clipboard } = require('electron');
const http = require('node:http');
const nodeNet = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CLIENT_ROOT = path.resolve(__dirname, 'client');
const HOST = '127.0.0.1';
const smokeArg = process.argv.find((arg) => arg.startsWith('--smoke-test='));
const smokePathInput = process.env.SP_SMOKE_PATH || (smokeArg ? smokeArg.slice('--smoke-test='.length) : '');
const SMOKE_PATH = smokePathInput ? path.resolve(smokePathInput) : null;

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.atlas': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml; charset=utf-8', '.ico': 'image/x-icon',
  '.skel': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'video/webm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf', '.ttf': 'font/ttf',
});

function plain(res, status, text) {
  const body = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const count = Number(m[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return false;
    return { start: Math.max(0, size - count), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return false;
  return { start, end };
}

async function serve(req, res) {
  if (req.socket.remoteAddress !== HOST && req.socket.remoteAddress !== '::ffff:127.0.0.1' && req.socket.remoteAddress !== '::1') {
    plain(res, 403, 'Forbidden'); return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { plain(res, 405, 'Method Not Allowed'); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
  catch { plain(res, 400, 'Bad Request'); return; }
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) { plain(res, 400, 'Bad Request'); return; }
  const parts = pathname.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))) { plain(res, 404, 'Not Found'); return; }
  if (!parts.length || pathname.endsWith('/')) parts.push('index.html');
  const target = path.resolve(CLIENT_ROOT, ...parts);
  if (target !== CLIENT_ROOT && !target.startsWith(CLIENT_ROOT + path.sep)) { plain(res, 403, 'Forbidden'); return; }

  let stat;
  try { stat = await fsp.stat(target); }
  catch { plain(res, 404, 'Not Found'); return; }
  if (!stat.isFile()) { plain(res, 404, 'Not Found'); return; }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const range = parseRange(req.headers.range, stat.size);
  if (range === false) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0, 'Accept-Ranges': 'bytes' });
    res.end(); return;
  }
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': /\.(?:html|js|css|json)$/i.test(target) ? 'no-cache' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(target, range).pipe(res);
    return;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(target).pipe(res);
}

function startAssetServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { serve(req, res).catch(() => plain(res, 500, 'Internal Error')); });
    server.on('error', reject);
    server.listen(0, HOST, () => resolve(server));
  });
}

let assetServer = null;
let mainWindow = null;
const tcpSockets = new Map();

function tcpFrame(text) {
  const body = Buffer.from(String(text), 'utf8');
  if (!body.length || body.length > 64 * 1024) throw new RangeError('invalid TCP frame size');
  const out = Buffer.allocUnsafe(body.length + 4);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function validTcpSender(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

function emitTcp(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sp-tcp-event', payload);
}

function closeTcpSocket(id) {
  const entry = tcpSockets.get(id);
  if (!entry) return;
  tcpSockets.delete(id);
  try { entry.socket.destroy(); } catch { /* ignore */ }
}

ipcMain.on('sp-tcp-connect', (event, value = {}) => {
  if (!validTcpSender(event)) return;
  const id = typeof value.id === 'string' && /^[a-z0-9-]{1,80}$/i.test(value.id) ? value.id : '';
  const host = typeof value.host === 'string' ? value.host.trim() : '';
  const port = Number(value.port);
  if (!id || !host || host.length > 253 || /[\s/\\]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    emitTcp({ id, type: 'error', message: 'TCP 地址格式不正确' });
    emitTcp({ id, type: 'close', code: 1006, reason: 'invalid endpoint' });
    return;
  }
  closeTcpSocket(id);
  const entry = { socket: null, buffer: Buffer.alloc(0), code: 1006, reason: '' };
  const socket = nodeNet.createConnection({ host, port });
  entry.socket = socket;
  tcpSockets.set(id, entry);
  socket.setNoDelay(true);
  socket.on('connect', () => emitTcp({ id, type: 'open' }));
  socket.on('data', (chunk) => {
    entry.buffer = entry.buffer.length ? Buffer.concat([entry.buffer, chunk]) : chunk;
    while (entry.buffer.length >= 4) {
      const length = entry.buffer.readUInt32BE(0);
      if (!length || length > 64 * 1024) { entry.reason = 'invalid frame'; socket.destroy(); return; }
      if (entry.buffer.length < length + 4) return;
      const data = entry.buffer.subarray(4, length + 4).toString('utf8');
      entry.buffer = entry.buffer.subarray(length + 4);
      let control = null;
      try { const parsed = JSON.parse(data); if (parsed && typeof parsed._sp === 'string') control = parsed; } catch { /* app handles invalid JSON */ }
      if (control?._sp === 'ping') { try { socket.write(tcpFrame(JSON.stringify({ _sp: 'pong' }))); } catch { socket.destroy(); } continue; }
      if (control?._sp === 'close') {
        entry.code = Number(control.code) || 1000;
        entry.reason = String(control.reason || '');
        socket.end();
        continue;
      }
      emitTcp({ id, type: 'message', data });
    }
  });
  socket.on('error', (err) => emitTcp({ id, type: 'error', message: String(err?.message || 'TCP connection error') }));
  socket.on('close', () => {
    if (tcpSockets.get(id) === entry) tcpSockets.delete(id);
    emitTcp({ id, type: 'close', code: entry.code, reason: entry.reason });
  });
});

ipcMain.on('sp-tcp-send', (event, value = {}) => {
  if (!validTcpSender(event)) return;
  const entry = tcpSockets.get(String(value.id || ''));
  if (!entry || typeof value.data !== 'string') return;
  try { entry.socket.write(tcpFrame(value.data)); }
  catch (err) { emitTcp({ id: value.id, type: 'error', message: String(err?.message || err) }); entry.socket.destroy(); }
});

ipcMain.on('sp-tcp-close', (event, value = {}) => {
  if (!validTcpSender(event)) return;
  const id = String(value.id || '');
  const entry = tcpSockets.get(id);
  if (!entry) return;
  entry.code = Number(value.code) || 1000;
  entry.reason = String(value.reason || '').slice(0, 120);
  try { entry.socket.write(tcpFrame(JSON.stringify({ _sp: 'close', code: entry.code, reason: entry.reason }))); } catch { /* ignore */ }
  entry.socket.end();
});

ipcMain.handle('sp-read-clipboard', (event) => validTcpSender(event) ? clipboard.readText() : '');

async function createWindow() {
  assetServer = await startAssetServer();
  const port = assetServer.address().port;
  const localOrigin = `http://${HOST}:${port}`;

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow = new BrowserWindow({
    title: '卫戍协议：盟约',
    width: 1440,
    height: 810,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#0c0f0e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(localOrigin + '/')) event.preventDefault();
  });
  if (!SMOKE_PATH) mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { for (const id of [...tcpSockets.keys()]) closeTcpSocket(id); mainWindow = null; });
  await mainWindow.loadURL(`${localOrigin}/?desktop=1`);
  if (SMOKE_PATH) {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const page = await mainWindow.webContents.executeJavaScript(`(() => ({
      title: document.title,
      labels: [...document.querySelectorAll('.field__label')].map((el) => el.childNodes[0]?.textContent?.trim()),
      inputs: [...document.querySelectorAll('.field__input')].map((el) => ({ value: el.value, placeholder: el.placeholder })),
      button: document.querySelector('.title-login .btn--primary')?.textContent?.trim(),
      bootVisible: !!document.querySelector('#boot'),
      appText: document.querySelector('#app')?.textContent?.slice(0, 300),
    }))()`);
    await fsp.mkdir(path.dirname(SMOKE_PATH), { recursive: true });
    await fsp.writeFile(SMOKE_PATH, JSON.stringify(page, null, 2));
    const image = await mainWindow.webContents.capturePage();
    await fsp.writeFile(SMOKE_PATH.replace(/\.json$/i, '') + '.png', image.toPNG());
    app.quit();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(createWindow).catch(async (err) => {
    console.error(err);
    if (SMOKE_PATH) {
      try { await fsp.writeFile(`${SMOKE_PATH}.error.txt`, String(err?.stack || err)); } catch { /* ignore */ }
    }
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { try { assetServer?.close(); } catch { /* ignore */ } });
}
