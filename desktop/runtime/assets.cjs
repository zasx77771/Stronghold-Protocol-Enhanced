'use strict';

// Private R2 runtime assets for the portable Electron client. The browser never receives either
// the game session token or the short-lived Worker token; both stay in the main process.

const { createWriteStream } = require('node:fs');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');

const MAX_REDIRECTS = 3;
const SESSION_TOKEN = /^[0-9a-f]{32}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function configuredUrl(value, { allowHttp = false } = {}) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return null; }
  if ((!allowHttp && parsed.protocol !== 'https:') || (allowHttp && !['https:', 'http:'].includes(parsed.protocol))) return null;
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  return parsed;
}

function readConfig(clientRoot, packages) {
  const file = path.join(clientRoot, 'asset-config.json');
  if (!fs.existsSync(file)) return { enabled: false, reason: 'no configuration' };
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { enabled: false, reason: 'invalid configuration' }; }
  const problems = packages.checkConfig(config);
  const indexUrl = configuredUrl(config.indexUrl, { allowHttp: Boolean(config.allowHttp) });
  const tokenUrl = configuredUrl(config.tokenUrl, { allowHttp: false });
  if (!tokenUrl) problems.push('config: tokenUrl must be an HTTPS URL without credentials or query');
  if (problems.length || !indexUrl) return { enabled: false, reason: problems.join('; ') || 'invalid index URL' };
  return {
    enabled: true,
    indexUrl: indexUrl.toString(),
    tokenUrl: tokenUrl.toString(),
    allowHttp: Boolean(config.allowHttp),
    maxChain: Number(config.maxChain) || packages.DEFAULT_MAX_CHAIN,
    maxIndexBytes: Number(config.maxIndexBytes) || packages.DEFAULT_MAX_INDEX_BYTES,
    maxDownloadBytes: Number(config.maxDownloadBytes) || packages.DEFAULT_MAX_DOWNLOAD_BYTES,
    maxExtractBytes: Number(config.maxExtractBytes) || packages.DEFAULT_MAX_EXTRACT_BYTES,
  };
}

class RuntimeAssetUpdater {
  constructor({ clientRoot, stateRoot, packageModule, log = console, onChanged = null }) {
    this.clientRoot = clientRoot;
    this.stateRoot = stateRoot;
    this.packageModule = packageModule;
    this.log = log;
    this.onChanged = onChanged;
    this.packages = null;
    this.config = null;
    this.active = null;
  }

  async initialize() {
    if (this.packages) return this.config;
    this.packages = await import(pathToFileURL(this.packageModule).href);
    this.config = readConfig(this.clientRoot, this.packages);
    if (this.config.enabled) await fsp.mkdir(this.stateRoot, { recursive: true });
    this.log.info?.(`[assets] ${this.config.enabled ? `private R2 enabled (${this.config.indexUrl})` : this.config.reason}`);
    return this.config;
  }

  async lookup(rel) {
    const config = await this.initialize();
    if (!config.enabled || !this.packages.isAssetPath(rel)) return null;
    try { return this.packages.lookupAsset(this.stateRoot, rel)?.file || null; }
    catch (error) { this.log.warn?.(`[assets] local store unavailable: ${error.message}`); return null; }
  }

  update(sessionToken) {
    if (!SESSION_TOKEN.test(String(sessionToken || ''))) return Promise.resolve({ status: 'waiting', changed: false });
    if (this.active) return this.active;
    this.active = this.updateOnce(sessionToken)
      .catch((error) => {
        this.log.warn?.(`[assets] update failed: ${error.message}`);
        return { status: 'failed', changed: false, error: error.message };
      })
      .finally(() => { this.active = null; });
    return this.active;
  }

  async updateOnce(sessionToken) {
    const config = await this.initialize();
    if (!config.enabled) return { status: 'disabled', changed: false };
    const assetToken = await this.exchangeToken(config, sessionToken);
    const indexBytes = await this.fetchBytes(config.indexUrl, config.maxIndexBytes, config, assetToken);
    const indexFile = path.join(this.stateRoot, 'asset-index.json');
    await fsp.writeFile(`${indexFile}.tmp`, indexBytes);
    await fsp.rename(`${indexFile}.tmp`, indexFile);
    const index = this.packages.readIndex(indexFile);
    const local = this.packages.loadInventory(this.stateRoot);
    const plan = this.packages.planRoute(index, { version: local.version, inventory: local.inventory }, { maxChain: config.maxChain });
    this.log.info?.(`[assets] ${plan.status} local=${local.version || 'none'} latest=${index.latest} (${plan.reason})`);
    if (!plan.route) return { status: plan.status, changed: false };
    const packageFile = path.join(this.stateRoot, 'asset-package.zip');
    try {
      for (const step of plan.route.steps) {
        await this.fetchFile(new URL(step.name, config.indexUrl).toString(), packageFile, config.maxDownloadBytes, config, assetToken);
        const applied = this.packages.applyPackage(this.stateRoot, packageFile, {
          expectedSha256: step.sha256, maxExtractBytes: config.maxExtractBytes,
        });
        this.log.info?.(`[assets] applied ${applied.applied}`);
      }
    } finally {
      await fsp.rm(packageFile, { force: true });
    }
    this.onChanged?.();
    return { status: plan.status, changed: true };
  }

  async exchangeToken(config, sessionToken) {
    const body = await this.fetchBytes(config.tokenUrl, config.maxIndexBytes, config, sessionToken);
    let token;
    try { token = JSON.parse(body.toString('utf8')).token; } catch { throw new Error('asset token response is invalid'); }
    if (!JWT.test(String(token || ''))) throw new Error('asset token response is invalid');
    return token;
  }

  async request(url, config, authorization) {
    const origin = configuredUrl(url, { allowHttp: config.allowHttp })?.origin;
    if (!origin) throw new Error(`invalid asset URL: ${url}`);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = configuredUrl(current, { allowHttp: config.allowHttp });
      if (!parsed) throw new Error(`invalid asset URL: ${current}`);
      const response = await fetch(parsed, {
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'StrongholdProtocolAssets/1', Authorization: `Bearer ${authorization}` },
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`redirect without a location from ${current}`);
        const next = new URL(location, parsed);
        if (next.origin !== origin) throw new Error(`cross-origin asset redirect is refused from ${url}`);
        current = next.toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${current}`);
      return response;
    }
    throw new Error(`too many redirects from ${url}`);
  }

  async fetchBytes(url, limit, config, authorization) {
    const response = await this.request(url, config, authorization);
    const declared = Number(response.headers.get('content-length') || -1);
    if (declared > limit) throw new Error(`document is ${declared} bytes, above the ${limit} byte limit`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error(`document is ${bytes.length} bytes, above the ${limit} byte limit`);
    return bytes;
  }

  async fetchFile(url, target, limit, config, authorization) {
    const response = await this.request(url, config, authorization);
    const declared = Number(response.headers.get('content-length') || -1);
    if (declared > limit) throw new Error(`package is ${declared} bytes, above the ${limit} byte limit`);
    if (!response.body) throw new Error('package has no response body');
    let total = 0;
    const guard = new Transform({ transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > limit ? new Error(`package is larger than the ${limit} byte limit`) : null, chunk);
    }});
    try {
      await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(target));
      if (declared >= 0 && total !== declared) throw new Error(`package is ${total} bytes, the server announced ${declared}`);
    } catch (error) {
      await fsp.rm(target, { force: true });
      throw error;
    }
  }
}

module.exports = { RuntimeAssetUpdater, configuredUrl, readConfig };
