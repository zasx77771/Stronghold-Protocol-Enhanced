import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_SEC = 10 * 60;
const DEFAULT_AUDIENCE = 'stronghold-assets';
const DEFAULT_ISSUER = 'stronghold-protocol';
const ASSET_SCOPE = 'assets:read';
const ASSET_PREFIX = 'runtime-assets/';

const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const sign = (input, secret) => createHmac('sha256', secret).update(input).digest('base64url');

function bearerValue(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function createAssetTokenIssuer({ registry, secret = process.env.SP_ASSET_TOKEN_SECRET,
  ttlSec = DEFAULT_TTL_SEC, audience = DEFAULT_AUDIENCE, issuer = DEFAULT_ISSUER } = {}) {
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.alloc(0);
  const enabled = !!registry && key.length >= 32 && Number.isInteger(ttlSec) && ttlSec >= 60 && ttlSec <= 3600;
  function issueAuthorization(authorization, nowSec = Math.floor(Date.now() / 1000)) {
    if (!enabled) return { status: 503, body: { ok: false, error: 'asset_token_unavailable' } };
    const sessionToken = bearerValue(authorization);
    const session = sessionToken ? registry.byToken(sessionToken) : null;
    if (!session) return { status: 401, body: { ok: false, error: 'session_required' } };
    const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      iss: issuer, aud: audience, sub: session.playerId, scope: ASSET_SCOPE, prefix: ASSET_PREFIX,
      iat: nowSec, exp: nowSec + ttlSec, jti: randomUUID()
    })}`;
    return { status: 200, body: { ok: true, token: `${input}.${sign(input, key)}`, expiresIn: ttlSec } };
  }
  return Object.freeze({ enabled, issueAuthorization, audience, issuer, ttlSec, prefix: ASSET_PREFIX, scope: ASSET_SCOPE });
}

export function verifyAssetToken(token, { secret, audience = DEFAULT_AUDIENCE, issuer = DEFAULT_ISSUER,
  nowSec = Math.floor(Date.now() / 1000), prefix = ASSET_PREFIX } = {}) {
  if (typeof token !== 'string' || typeof secret !== 'string' || Buffer.byteLength(secret) < 32) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, Buffer.from(secret, 'utf8')));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.iss !== issuer || payload.aud !== audience || payload.scope !== ASSET_SCOPE || payload.prefix !== prefix) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= nowSec || payload.iat > nowSec + 60) return null;
    return payload;
  } catch {
    return null;
  }
}

export { ASSET_PREFIX, ASSET_SCOPE, bearerValue };
