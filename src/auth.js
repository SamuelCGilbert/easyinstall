// RS256 JWT verification (Google sign-in and Cloudflare Access) and signed session cookies.

const enc = new TextEncoder();
const dec = new TextDecoder();
const jwksCache = new Map();

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getKeys(jwksUrl) {
  const hit = jwksCache.get(jwksUrl);
  if (hit && hit.exp > Date.now()) return hit.keys;
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error('JWKS fetch failed');
  const { keys } = await res.json();
  jwksCache.set(jwksUrl, { keys, exp: Date.now() + 60 * 60 * 1000 });
  return keys;
}

export async function verifyJwt(token, jwksUrl) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(dec.decode(b64urlToBytes(h)));
  if (header.alg !== 'RS256') throw new Error('Unexpected algorithm');
  let keys = await getKeys(jwksUrl);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { jwksCache.delete(jwksUrl); keys = await getKeys(jwksUrl); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk) throw new Error('Unknown signing key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), enc.encode(h + '.' + p));
  if (!ok) throw new Error('Bad signature');
  const claims = JSON.parse(dec.decode(b64urlToBytes(p)));
  const now = Date.now() / 1000;
  if (claims.exp && claims.exp < now - 60) throw new Error('Expired');
  if (claims.nbf && claims.nbf > now + 60) throw new Error('Not yet valid');
  return claims;
}

const SESSION_DAYS = 90;

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToB64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signSession({ sub, email }, env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const body = bytesToB64url(enc.encode(JSON.stringify({ sub, email, exp })));
  const sig = await hmac(env.SESSION_SECRET, body);
  return `ei_session=${body}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

export async function readSession(req, env) {
  if (!env.SESSION_SECRET) return null;
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)ei_session=([^;]+)/);
  if (!m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  const expected = await hmac(env.SESSION_SECRET, body);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff) return null;
  const data = JSON.parse(dec.decode(b64urlToBytes(body)));
  if (!data.exp || data.exp < Date.now() / 1000) return null;
  return data;
}
