import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRegistry } from '../server/net.js';
import { createAssetTokenIssuer, verifyAssetToken } from '../server/http/assetToken.js';

const SECRET = 'this-is-a-test-only-asset-token-secret-32b';

test('asset token issuer exchanges a live welcome token for a constrained JWT', () => {
  const registry = new SessionRegistry({ now: () => 1_000_000 });
  const session = registry.create('Doctor');
  const issuer = createAssetTokenIssuer({ registry, secret: SECRET, ttlSec: 600 });
  const response = issuer.issueAuthorization(`Bearer ${session.token}`, 1000);
  assert.equal(response.status, 200);
  const claims = verifyAssetToken(response.body.token, { secret: SECRET, nowSec: 1001 });
  assert.equal(claims.sub, session.playerId);
  assert.equal(claims.scope, 'assets:read');
  assert.equal(claims.prefix, 'runtime-assets/');
  assert.equal(claims.exp, 1600);
});

test('asset token issuer rejects a missing session, disabled secret, and expired JWT', () => {
  const registry = new SessionRegistry({ now: () => 1_000_000 });
  const session = registry.create('Doctor');
  assert.equal(createAssetTokenIssuer({ registry, secret: 'short' }).issueAuthorization(`Bearer ${session.token}`).status, 503);
  const issuer = createAssetTokenIssuer({ registry, secret: SECRET });
  assert.equal(issuer.issueAuthorization().status, 401);
  const token = issuer.issueAuthorization(`Bearer ${session.token}`, 1000).body.token;
  assert.equal(verifyAssetToken(token, { secret: SECRET, nowSec: 1600 }), null);
  assert.equal(verifyAssetToken(token, { secret: SECRET, audience: 'wrong', nowSec: 1001 }), null);
});
