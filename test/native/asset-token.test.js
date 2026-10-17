import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssetTokenIssuer, verifyAssetToken, ASSET_PREFIX, ASSET_SCOPE } from '../../server/http/assetToken.js';

const SECRET = 'test-asset-token-secret-0123456789abcdef';
const SESSION = 'a'.repeat(32);
const registry = { byToken: (token) => (token === SESSION ? { playerId: 'player-1' } : null) };

test('asset token issuer is disabled without a 32-byte secret', () => {
  const issuer = createAssetTokenIssuer({ registry, secret: 'short' });
  assert.equal(issuer.enabled, false);
  assert.deepEqual(issuer.issueAuthorization(`Bearer ${SESSION}`), {
    status: 503,
    body: { ok: false, error: 'asset_token_unavailable' },
  });
});

test('asset token issuer requires the game session token', () => {
  const issuer = createAssetTokenIssuer({ registry, secret: SECRET });
  assert.deepEqual(issuer.issueAuthorization(undefined), {
    status: 401,
    body: { ok: false, error: 'session_required' },
  });
  assert.equal(issuer.issueAuthorization(`Bearer ${'b'.repeat(32)}`).status, 401);
});

test('asset token issuer mints a verifiable, short-lived, asset-scoped JWT', () => {
  const nowSec = 1_700_000_000;
  const issuer = createAssetTokenIssuer({ registry, secret: SECRET, ttlSec: 600 });
  const answer = issuer.issueAuthorization(`Bearer ${SESSION}`, nowSec);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.expiresIn, 600);
  assert.equal(answer.body.token.split('.').length, 3);
  const payload = verifyAssetToken(answer.body.token, { secret: SECRET, nowSec });
  assert.equal(payload.sub, 'player-1');
  assert.equal(payload.scope, ASSET_SCOPE);
  assert.equal(payload.prefix, ASSET_PREFIX);
  assert.equal(payload.exp, nowSec + 600);
});

test('verifyAssetToken rejects tampering, expiry and the wrong audience/prefix', () => {
  const nowSec = 1_700_000_000;
  const issuer = createAssetTokenIssuer({ registry, secret: SECRET, ttlSec: 600 });
  const token = issuer.issueAuthorization(`Bearer ${SESSION}`, nowSec).body.token;
  const [header, payload, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forged = `${header}.${Buffer.from(JSON.stringify({ ...decoded, scope: 'assets:write' })).toString('base64url')}.${signature}`;
  assert.equal(verifyAssetToken(forged, { secret: SECRET, nowSec }), null);
  assert.equal(verifyAssetToken(token, { secret: SECRET, nowSec: nowSec + 601 }), null);
  assert.equal(verifyAssetToken(token, { secret: SECRET, nowSec, prefix: 'other/' }), null);
  assert.equal(verifyAssetToken(token, { secret: SECRET, nowSec, audience: 'other' }), null);
  assert.equal(verifyAssetToken(`${token}x`, { secret: SECRET, nowSec }), null);
});
