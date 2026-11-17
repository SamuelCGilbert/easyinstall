import { buildScript, buildCmd } from './installer.js';
import { verifyJwt, signSession, readSession } from './auth.js';

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SOURCES = ['winget', 'msstore', 'choco', 'direct', 'manual'];
const MAX_SELECTION = 150;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/api/config' && req.method === 'GET') return json({ kofiUrl: env.KOFI_URL || '', googleClientId: env.GOOGLE_CLIENT_ID || '' });
      if (p === '/api/catalog' && req.method === 'GET') return catalog(env);
      if (p.startsWith('/i/')) return installer(req, env, ctx, url, false);
      if (p.startsWith('/dl/')) return installer(req, env, ctx, url, true);

      if (p === '/api/auth/google' && req.method === 'POST') return googleSignIn(req, env);
      if (p === '/api/auth/logout' && req.method === 'POST') return json({ ok: true }, 200, { 'set-cookie': 'ei_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
      if (p === '/api/me' && req.method === 'GET') { const s = await readSession(req, env); return json(s ? { signedIn: true, email: s.email } : { signedIn: false }); }
      if (p === '/api/presets') return presets(req, env);
      if (p === '/api/account' && req.method === 'DELETE') return deleteAccount(req, env);

      if (p === '/admin' || p.startsWith('/admin/') || p === '/admin.html' || p === '/admin.js' || p.startsWith('/api/admin/')) {
        const who = await adminIdentity(req, env);
        if (!who) return text('Admin access requires signing in through Cloudflare Access.', 403);
        if (p.startsWith('/api/admin/')) return admin(req, env, p, who);
        const asset = p === '/admin.js' ? '/admin.js' : '/admin';
        const res = await env.ASSETS.fetch(new Request(new URL(asset, url), req));
        const h = new Headers(res.headers); h.set('cache-control', 'no-store');
        return new Response(res.body, { status: res.status, headers: h });
      }
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong on the server. Try again in a minute.' }, 500);
    }
  },
};

// ---------- Public catalog

async function catalog(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, name, category, source, note, homepage, requires, description, price, open_source FROM apps WHERE enabled = 1 ORDER BY category, sort, name"
  ).all();
  const order = await categoryOrder(env);
  return json({ apps: results, categories: order }, 200, { 'cache-control': 'public, max-age=60' });
}

async function categoryOrder(env) {
  const { results } = await env.DB.prepare('SELECT category, MIN(rowid) AS r FROM apps GROUP BY category ORDER BY r').all();
  return results.map(r => r.category);
}

// ---------- Installer script and .cmd launcher

function parseSelection(segment) {
  const raw = decodeURIComponent(segment || '').replace(/\.(cmd|ps1)$/i, '');
  const keys = raw.split(/[+ ,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(keys)].slice(0, MAX_SELECTION);
}

async function installer(req, env, ctx, url, asCmd) {
  const segment = url.pathname.split('/')[2] || '';
  const keys = parseSelection(segment);
  const valid = keys.filter(k => KEY_RE.test(k));
  if (!valid.length) return text('No apps selected. Pick apps at ' + env.SITE_URL, 400);
  const site = env.SITE_URL || url.origin;

  const placeholders = valid.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT * FROM apps WHERE enabled = 1 AND source != 'manual' AND key IN (${placeholders})`
  ).bind(...valid).all();
  const byKey = new Map(results.map(r => [r.key, r]));
  const apps = valid.map(k => byKey.get(k)).filter(Boolean);
  const unknown = keys.filter(k => !byKey.has(k));
  const selfUrl = `${url.origin}/i/${apps.map(a => a.key).join('+')}`;
  if (!apps.length) return text('None of those apps are available to install automatically any more. Pick apps at ' + site, 404);

  if (asCmd) {
    const name = apps.length === 1 ? `EasyInstall-${apps[0].key}.cmd` : `EasyInstall-${apps.length}-apps.cmd`;
    return new Response(buildCmd({ selfUrl, count: apps.length }), {
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' },
    });
  }

  for (const a of apps) if (a.source === 'direct') await resolveDirect(a, ctx);
  const script = buildScript({ apps, selfUrl, siteUrl: site, kofiUrl: env.KOFI_URL || '', dryRun: url.searchParams.get('dry') === '1', unknown });
  return text(script, 200, { 'cache-control': 'no-store' });
}

// Direct downloads: a fixed URL, or a vendor page scraped for the current installer link.
// Results are cached for 6 hours so the vendor page isn't fetched on every run.
async function resolveDirect(app, ctx) {
  if (!app.url_pattern) { app.resolvedUrl = app.url; return; }
  const cache = caches.default;
  const cacheKey = new Request(`https://resolve.easyinstall.internal/${app.key}?v=${encodeURIComponent(app.url + app.url_pattern)}`);
  const hit = await cache.match(cacheKey);
  if (hit) { app.resolvedUrl = await hit.text(); return; }
  try {
    const res = await fetch(app.url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EasyInstall' } });
    const body = await res.text();
    const m = body.match(new RegExp(app.url_pattern));
    if (!m) { app.resolveError = 'No download link found on the vendor page'; return; }
    app.resolvedUrl = m[0];
    ctx.waitUntil(cache.put(cacheKey, new Response(m[0], { headers: { 'cache-control': 'max-age=21600' } })));
  } catch (e) {
    app.resolveError = 'Vendor page could not be reached';
  }
}

// ---------- Google sign-in and presets

async function googleSignIn(req, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) return json({ error: 'Sign-in is not set up on this site.' }, 404);
  const { credential } = await req.json().catch(() => ({}));
  if (!credential) return json({ error: 'Missing Google credential.' }, 400);
  let claims;
  try {
    claims = await verifyJwt(credential, 'https://www.googleapis.com/oauth2/v3/certs');
  } catch {
    return json({ error: 'Google sign-in could not be verified. Try again.' }, 401);
  }
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) {
    return json({ error: 'Google sign-in could not be verified. Try again.' }, 401);
  }
  await env.DB.prepare('INSERT INTO users (sub, email) VALUES (?, ?) ON CONFLICT(sub) DO UPDATE SET email = excluded.email')
    .bind(claims.sub, claims.email || '').run();
  const cookie = await signSession({ sub: claims.sub, email: claims.email || '' }, env);
  return json({ signedIn: true, email: claims.email || '' }, 200, { 'set-cookie': cookie });
}

async function presets(req, env) {
  const s = await readSession(req, env);
  if (!s) return json({ error: 'Sign in to sync presets.' }, 401);
  if (req.method === 'GET') {
    const row = await env.DB.prepare('SELECT data FROM presets WHERE sub = ?').bind(s.sub).first();
    return json({ presets: row ? JSON.parse(row.data) : [] });
  }
  if (req.method === 'PUT') {
    if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Send JSON.' }, 415);
    const body = await req.text();
    if (body.length > 64 * 1024) return json({ error: 'Too many presets to save. Delete a few and try again.' }, 413);
    let list;
    try { list = JSON.parse(body).presets; } catch { return json({ error: 'Send JSON.' }, 400); }
    if (!Array.isArray(list) || list.length > 100) return json({ error: 'Save at most 100 presets.' }, 400);
    const clean = list.map(x => ({
      id: String(x.id || '').slice(0, 40),
      name: String(x.name || 'Preset').slice(0, 80),
      apps: (Array.isArray(x.apps) ? x.apps : []).map(String).filter(k => KEY_RE.test(k)).slice(0, MAX_SELECTION),
      updated: Number(x.updated) || Date.now(),
      ...(x.deleted ? { deleted: true, apps: [] } : {}),
    })).filter(x => x.id);
    await env.DB.prepare('INSERT INTO presets (sub, data, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(sub) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .bind(s.sub, JSON.stringify(clean)).run();
    return json({ presets: clean });
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function deleteAccount(req, env) {
  const s = await readSession(req, env);
  if (!s) return json({ error: 'Sign in first.' }, 401);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM presets WHERE sub = ?').bind(s.sub),
    env.DB.prepare('DELETE FROM users WHERE sub = ?').bind(s.sub),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': 'ei_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
}

// ---------- Admin (protected by Cloudflare Access)

async function adminIdentity(req, env) {
  if (env.DEV_ADMIN === '1') return 'local-dev';
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  try {
    const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const claims = await verifyJwt(token, `https://${team}/cdn-cgi/access/certs`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD) || claims.iss !== `https://${team}`) return null;
    return claims.email || 'admin';
  } catch {
    return null;
  }
}

function validateApp(a) {
  const errors = [];
  const s = v => (v == null ? '' : String(v).trim());
  const app = {
    key: s(a.key).toLowerCase(), name: s(a.name), category: s(a.category), source: s(a.source), pkg: s(a.pkg),
    url: s(a.url), url_pattern: s(a.url_pattern), args: s(a.args), detect: s(a.detect), requires: s(a.requires),
    note: s(a.note), homepage: s(a.homepage), description: s(a.description), price: s(a.price) || 'free', open_source: a.open_source ? 1 : 0, enabled: a.enabled ? 1 : 0, sort: Number.isFinite(+a.sort) ? Math.round(+a.sort) : 0,
  };
  if (!KEY_RE.test(app.key)) errors.push('Key must be lowercase letters, digits and hyphens.');
  if (!app.name || app.name.length > 80) errors.push('Name is required (80 characters at most).');
  if (!app.category || app.category.length > 60) errors.push('Category is required.');
  if (!SOURCES.includes(app.source)) errors.push('Source must be one of ' + SOURCES.join(', ') + '.');
  // These values end up inside the PowerShell script, so keep them to safe characters.
  if (['winget', 'choco'].includes(app.source) && !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(app.pkg)) errors.push('Package ID can only use letters, digits and . + _ -');
  if (app.source === 'msstore' && !/^[0-9A-Z]{12}$/.test(app.pkg)) errors.push('Store IDs are 12 capital letters and digits.');
  if (app.source === 'direct') {
    if (!/^https:\/\/[^\s'"`$]+$/.test(app.url)) errors.push('Direct apps need an https URL.');
    if (app.url_pattern) { try { new RegExp(app.url_pattern); } catch { errors.push('URL pattern is not a valid regular expression.'); } }
    if (/['"`$;&|<>]/.test(app.args)) errors.push('Installer switches cannot contain quotes or $ ; & | < >');
  }
  if (app.detect) { try { new RegExp(app.detect); } catch { errors.push('Detect pattern is not a valid regular expression.'); } }
  if (app.requires && !/^(gpu|cpu):(nvidia|amd|intel)$/.test(app.requires)) errors.push('Requires must be like gpu:nvidia, gpu:amd, gpu:intel, cpu:intel or cpu:amd.');
  if (app.homepage && !/^https?:\/\/\S+$/.test(app.homepage)) errors.push('Homepage must be a web address.');
  if (!['free', 'freemium', 'paid'].includes(app.price)) errors.push('Price must be free, freemium or paid.');
  if (app.description.length > 300) errors.push('Description can be 300 characters at most.');
  if (app.source === 'manual' && !app.homepage) errors.push('Manual apps need a homepage link.');
  return { app, errors };
}

async function admin(req, env, p, who) {
  if (p === '/api/admin/apps' && req.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM apps ORDER BY category, sort, name').all();
    return json({ apps: results, categories: await categoryOrder(env), you: who });
  }
  const m = p.match(/^\/api\/admin\/apps\/([a-z0-9-]+)$/);
  if (m && req.method === 'PUT') {
    const body = await req.json().catch(() => null);
    if (!body) return json({ errors: ['Send JSON.'] }, 400);
    const { app, errors } = validateApp({ ...body, key: body.key || m[1] });
    if (errors.length) return json({ errors }, 400);
    if (app.key !== m[1]) await env.DB.prepare('DELETE FROM apps WHERE key = ?').bind(m[1]).run();
    await env.DB.prepare(`INSERT INTO apps (key, name, category, source, pkg, url, url_pattern, args, detect, requires, note, homepage, description, price, open_source, enabled, sort, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET name=excluded.name, category=excluded.category, source=excluded.source, pkg=excluded.pkg, url=excluded.url,
        url_pattern=excluded.url_pattern, args=excluded.args, detect=excluded.detect, requires=excluded.requires, note=excluded.note,
        homepage=excluded.homepage, description=excluded.description, price=excluded.price, open_source=excluded.open_source, enabled=excluded.enabled, sort=excluded.sort, updated_at=unixepoch()`)
      .bind(app.key, app.name, app.category, app.source, app.pkg, app.url, app.url_pattern, app.args, app.detect, app.requires, app.note, app.homepage, app.description, app.price, app.open_source, app.enabled, app.sort).run();
    return json({ app });
  }
  if (m && req.method === 'PATCH') {
    const body = await req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return json({ errors: ['Send {"enabled": true|false}.'] }, 400);
    await env.DB.prepare('UPDATE apps SET enabled = ?, updated_at = unixepoch() WHERE key = ?').bind(body.enabled ? 1 : 0, m[1]).run();
    return json({ ok: true });
  }
  if (m && req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM apps WHERE key = ?').bind(m[1]).run();
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}
