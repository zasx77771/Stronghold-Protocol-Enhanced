const PREFIX = 'runtime-assets/';
const AUDIENCE = 'stronghold-assets';
const ISSUER = 'stronghold-protocol';
const SCOPE = 'assets:read';
const allowed = (name) => name === 'assets-index.json' || /^assets-(?:base|delta)-[0-9A-Za-z.+-]+\.zip$/.test(name);
const unauthorized = () => new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
const textEncoder = new TextEncoder();
const b64url = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function verify(request, secret) {
  const token = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get('Authorization') || '')?.[1];
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
    if (header.alg !== 'HS256' || payload.iss !== ISSUER || payload.aud !== AUDIENCE || payload.scope !== SCOPE || payload.prefix !== PREFIX) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= now || payload.iat > now + 60) return null;
    const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, b64url(parts[2]), textEncoder.encode(`${parts[0]}.${parts[1]}`)) ? payload : null;
  } catch { return null; }
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const name = new URL(request.url).pathname.replace(/^\/+/, '');
    if (!allowed(name)) return new Response('Not Found', { status: 404 });
    if (!await verify(request, env.ASSET_TOKEN_SECRET)) return unauthorized();
    const object = await env.ASSETS.get(PREFIX + name);
    if (!object) return new Response('Not Found', { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', name === 'assets-index.json' ? 'private, max-age=60, must-revalidate' : 'private, max-age=31536000, immutable');
    headers.set('Content-Type', name === 'assets-index.json' ? 'application/json; charset=utf-8' : 'application/zip');
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }
};
