import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestHandler } from '../../server/http/routes.js';
import { createAssetTokenIssuer } from '../../server/http/assetToken.js';

const SECRET = 'route-test-asset-secret-0123456789abcdef';
const SESSION = 'c'.repeat(32);

function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value);
    },
    end(chunk) { if (chunk) this.body += String(chunk); },
  };
  return res;
}

function handlerWith(assetToken) {
  return createRequestHandler({
    serveStatic: async () => { throw new Error('static handler must not run for /api/assets/token'); },
    health: {
      startedAt: Date.now(),
      network: { connectionCount: 0 },
      registry: { size: 0 },
      lobby: { stats: () => ({}), plugins: { unofficial: () => 0, contentInUse: () => 0 } },
      content: null,
    },
    log: { error() {} },
    assetToken,
  });
}

function tokenRequest(res, authorization) {
  handlerWith(createAssetTokenIssuer({
    registry: { byToken: (token) => (token === SESSION ? { playerId: 'p1' } : null) },
    secret: SECRET,
  }))({ method: 'GET', url: '/api/assets/token', headers: authorization ? { authorization } : {} }, res);
}

test('GET /api/assets/token exchanges the session token for an asset JWT', async () => {
  const res = fakeResponse();
  tokenRequest(res, `Bearer ${SESSION}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.expiresIn, 600);
  assert.equal(body.token.split('.').length, 3);
});

test('GET /api/assets/token refuses a missing or unknown session token', async () => {
  for (const authorization of [undefined, `Bearer ${'d'.repeat(32)}`]) {
    const res = fakeResponse();
    tokenRequest(res, authorization);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'session_required');
  }
});

test('GET /api/assets/token answers 503 when the deployment has no signing secret', async () => {
  const res = fakeResponse();
  const handler = handlerWith(null);
  handler({ method: 'GET', url: '/api/assets/token', headers: {} }, res);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'asset_token_unavailable');
});
