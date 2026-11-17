const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let apps = [], categories = [], byKey = new Map();
let selected = new Set(store.get('ei.selection', []));
let presets = store.get('ei.presets', []);
let query = '';
let config = { kofiUrl: '', googleClientId: '' };
let signedIn = false;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2400);
}

// ---------- Catalog

async function load() {
  // A shared link (#apps=a+b+c) replaces the remembered selection.
  const m = location.hash.match(/^#apps=([a-z0-9+-]+)$/);
  if (m) selected = new Set(m[1].split('+'));
  try {
    const [cat, cfg] = await Promise.all([fetch('/api/catalog').then(r => r.json()), fetch('/api/config').then(r => r.json())]);
    apps = cat.apps; categories = cat.categories; config = cfg;
  } catch {
    $('#grid').innerHTML = '<p class="empty">The app list couldn’t load. Check your connection and reload the page.</p>';
    return;
  }
  byKey = new Map(apps.map(a => [a.key, a]));
  selected = new Set([...selected].filter(k => byKey.has(k)));
  setupKofi();
  render();
  updateTray();
  if (config.googleClientId) setupGoogle();
  else refreshMe();
}

function setupKofi() {
  document.querySelectorAll('[data-kofi]').forEach(a => {
    if (config.kofiUrl) { a.href = config.kofiUrl; a.target = '_blank'; a.rel = 'noopener'; a.hidden = false; }
  });
  document.querySelectorAll('[data-nokofi]').forEach(s => (s.hidden = !!config.kofiUrl));
}

function matches(a) {
  if (!query) return true;
  return (a.name + ' ' + a.note + ' ' + a.category).toLowerCase().includes(query);
}

function render() {
  const grid = $('#grid');
  grid.textContent = '';
  let shown = 0;
  for (const cat of categories) {
    const list = apps.filter(a => a.category === cat && matches(a));
    if (!list.length) continue;
    shown += list.length;
    const sec = document.createElement('section');
    sec.className = 'cat';
    const h = document.createElement('h2');
    h.textContent = cat;
    const picked = list.filter(a => selected.has(a.key)).length;
    if (picked) { const s = document.createElement('small'); s.textContent = picked + ' picked'; h.appendChild(s); }
    sec.appendChild(h);
    for (const a of list) sec.appendChild(a.source === 'manual' ? manualRow(a) : appRow(a));
    grid.appendChild(sec);
  }
  if (!shown) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = `No apps match “${query}”.`;
    grid.appendChild(p);
  }
}

function appRow(a) {
  const label = document.createElement('label');
  label.className = 'app';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.id = 'app-' + a.key; cb.checked = selected.has(a.key);
  cb.addEventListener('change', () => {
    cb.checked ? selected.add(a.key) : selected.delete(a.key);
    saveSelection();
    const h = label.closest('.cat').querySelector('h2');
    const n = [...label.closest('.cat').querySelectorAll('input')].filter(i => i.checked).length;
    let s = h.querySelector('small');
    if (n) { if (!s) { s = document.createElement('small'); h.appendChild(s); } s.textContent = n + ' picked'; } else if (s) s.remove();
  });
  const t = document.createElement('span'); t.className = 't';
  const n = document.createElement('span'); n.className = 'n'; n.textContent = a.name; t.appendChild(n);
  if (a.note) { const d = document.createElement('span'); d.className = 'd'; d.textContent = a.note; t.appendChild(d); }
  label.append(cb, t);
  return label;
}

function manualRow(a) {
  const div = document.createElement('div');
  div.className = 'app manual';
  const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = '↗'; ico.setAttribute('aria-hidden', 'true');
  const t = document.createElement('span'); t.className = 't';
  const link = document.createElement('a'); link.href = a.homepage; link.target = '_blank'; link.rel = 'noopener'; link.textContent = a.name;
  const d = document.createElement('span'); d.className = 'd'; d.textContent = (a.note ? a.note + '. ' : '') + 'Download it yourself.';
  t.append(link, d);
  div.append(ico, t);
  return div;
}

function saveSelection() {
  store.set('ei.selection', [...selected]);
  if (location.hash) history.replaceState(null, '', location.pathname);
  updateTray();
}

function updateTray() {
  const n = selected.size;
  $('#tray').hidden = n === 0;
  $('#count').textContent = n;
  $('#countLabel').textContent = n === 1 ? 'app selected' : 'apps selected';
  $('#clearBtn').disabled = n === 0;
}

// Keep the selection in catalog order so the same picks always make the same link.
const orderedSelection = () => apps.filter(a => selected.has(a.key)).map(a => a.key);

// ---------- Get installer

function openInstaller() {
  const keys = orderedSelection();
  if (!keys.length) return;
  const sel = keys.join('+');
  const origin = location.origin;
  $('#getSummary').textContent = `${keys.length} ${keys.length === 1 ? 'app' : 'apps'}: ${keys.map(k => byKey.get(k).name).join(', ')}.`;
  $('#dlLink').href = `/dl/${sel}.cmd`;
  $('#oneLiner').textContent = `irm ${origin}/i/${sel} | iex`;
  const share = `${origin}/#apps=${sel}`;
  $('#shareLink').href = share; $('#shareLink').textContent = share;
  $('#manualBox').hidden = true;
  $('#getDlg').showModal();
}

$('#getBtn').addEventListener('click', openInstaller);
$('#copyBtn').addEventListener('click', async () => {
  const text = $('#oneLiner').textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into PowerShell.'); }
  catch { const r = document.createRange(); r.selectNodeContents($('#oneLiner')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Press Ctrl+C to copy'); }
});
$('#search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); render(); });
$('#clearBtn').addEventListener('click', () => { selected.clear(); saveSelection(); render(); toast('Selection cleared'); });

// ---------- Presets (saved in this browser; synced when signed in)

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 36);

function renderPresets() {
  const ul = $('#presetList'); ul.textContent = '';
  const list = presets.filter(p => !p.deleted).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) {
    const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No presets yet. Tick some apps and save them below.'; ul.appendChild(li);
  }
  for (const p of list) {
    const li = document.createElement('li');
    const pn = document.createElement('div'); pn.className = 'pn';
    const b = document.createElement('b'); b.textContent = p.name;
    const known = p.apps.filter(k => byKey.has(k));
    const s = document.createElement('span'); s.textContent = `${known.length} ${known.length === 1 ? 'app' : 'apps'}`;
    pn.append(b, s);
    const load = document.createElement('button'); load.type = 'button'; load.className = 'btn primary sm'; load.textContent = 'Load';
    load.onclick = () => { selected = new Set(known); saveSelection(); render(); $('#presetsDlg').close(); toast(`Loaded “${p.name}”`); };
    const del = document.createElement('button'); del.type = 'button'; del.className = 'btn ghost sm'; del.textContent = 'Delete';
    del.onclick = () => { p.deleted = true; p.updated = Date.now(); savePresets(); renderPresets(); toast(`Deleted “${p.name}”`); };
    li.append(pn, load, del);
    ul.appendChild(li);
  }
  $('#presetHint').textContent = selected.size ? `Saving stores the ${selected.size} apps you have ticked now.` : 'Tick some apps first, then save them as a preset.';
  $('#presetSave').disabled = !selected.size;
}

function openPresets() { renderPresets(); $('#presetsDlg').showModal(); }
$('#presetsBtn').addEventListener('click', openPresets);
$('#savePresetBtn').addEventListener('click', () => { openPresets(); $('#presetName').focus(); });
$('#presetForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#presetName').value.trim();
  if (!name || !selected.size) return;
  const existing = presets.find(p => !p.deleted && p.name.toLowerCase() === name.toLowerCase());
  if (existing) { existing.apps = orderedSelection(); existing.updated = Date.now(); }
  else presets.push({ id: newId(), name, apps: orderedSelection(), updated: Date.now() });
  $('#presetName').value = '';
  savePresets(); renderPresets();
  toast(existing ? `Updated “${name}”` : `Saved “${name}”`);
});

let pushTimer;
function savePresets() {
  store.set('ei.presets', presets);
  if (signedIn) { clearTimeout(pushTimer); pushTimer = setTimeout(pushPresets, 400); }
}

// Deleted presets are kept as tombstones so a delete on one device wins over an older copy on another.
function merge(a, b) {
  const m = new Map();
  for (const p of [...a, ...b]) { const cur = m.get(p.id); if (!cur || (p.updated || 0) > (cur.updated || 0)) m.set(p.id, p); }
  return [...m.values()];
}

async function pushPresets() {
  try {
    const r = await fetch('/api/presets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presets }) });
    if (r.status === 401) { setSignedIn(false); return; }
    if (!r.ok) throw new Error((await r.json()).error);
    syncError('');
  } catch (e) { syncError(e.message || 'Presets couldn’t sync. They’re still saved in this browser.'); }
}

async function pullAndMerge() {
  try {
    const r = await fetch('/api/presets');
    if (!r.ok) return;
    const { presets: remote } = await r.json();
    presets = merge(presets, remote.map(p => ({ ...p, deleted: p.deleted || false })));
    store.set('ei.presets', presets);
    await pushPresets();
    if ($('#presetsDlg').open) renderPresets();
  } catch {}
}

function syncError(msg) { const e = $('#syncError'); e.textContent = msg; e.hidden = !msg; }

function setSignedIn(on, email) {
  signedIn = on;
  $('#syncSignedIn').hidden = !on;
  $('#syncSignedOut').hidden = on;
  if (on) $('#syncEmail').textContent = email || 'your Google account';
}

async function refreshMe() {
  try {
    const me = await fetch('/api/me').then(r => r.json());
    if (me.signedIn) { setSignedIn(true, me.email); pullAndMerge(); }
  } catch {}
}

function setupGoogle() {
  $('#syncBox').hidden = false;
  setSignedIn(false);
  refreshMe();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: async ({ credential }) => {
        try {
          const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }) });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error);
          setSignedIn(true, data.email); syncError('');
          await pullAndMerge();
          toast('Signed in. Presets will sync.');
        } catch (e) { syncError(e.message || 'Sign-in failed. Try again.'); }
      },
    });
    google.accounts.id.renderButton($('#gsiButton'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
  };
  document.head.appendChild(s);
}

$('#signOutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setSignedIn(false);
  toast('Signed out. Presets stay in this browser.');
});

load();
