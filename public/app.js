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
  setupFilters();
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

// ---------- Filters

const PRICE_LABEL = { free: 'Free', freemium: 'Free + paid plans', paid: 'Paid' };
const SOURCE_LABEL = { winget: 'Installs with winget', msstore: 'Installs from the Microsoft Store', choco: 'Installs with Chocolatey', direct: 'Downloads from the developer', manual: 'Download it yourself from the developer’s site' };
const filters = { cat: '', price: '', oss: false, picked: false, auto: false };

function setupFilters() {
  const sel = $('#catFilter');
  for (const c of categories) { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
  sel.addEventListener('change', () => { filters.cat = sel.value; render(); });
  document.querySelectorAll('[data-price]').forEach(b => b.addEventListener('click', () => {
    filters.price = b.dataset.price;
    document.querySelectorAll('[data-price]').forEach(x => x.setAttribute('aria-pressed', x === b));
    render();
  }));
  for (const [id, key] of [['#ossChip', 'oss'], ['#pickedChip', 'picked'], ['#autoChip', 'auto']]) {
    $(id).addEventListener('click', () => { filters[key] = !filters[key]; $(id).setAttribute('aria-pressed', filters[key]); render(); });
  }
  $('#resetFilters').addEventListener('click', resetFilters);
}

function resetFilters() {
  Object.assign(filters, { cat: '', price: '', oss: false, picked: false, auto: false });
  query = ''; $('#search').value = ''; $('#catFilter').value = '';
  document.querySelectorAll('[data-price]').forEach(x => x.setAttribute('aria-pressed', x.dataset.price === ''));
  for (const id of ['#ossChip', '#pickedChip', '#autoChip']) $(id).setAttribute('aria-pressed', 'false');
  render(); updateTray();
}

const filtersActive = () => !!(query || filters.cat || filters.price || filters.oss || filters.picked || filters.auto);

function matches(a) {
  if (filters.cat && a.category !== filters.cat) return false;
  if (filters.price && a.price !== filters.price) return false;
  if (filters.oss && !a.open_source) return false;
  if (filters.picked && !selected.has(a.key)) return false;
  if (filters.auto && a.source === 'manual') return false;
  if (!query) return true;
  const hay = (a.name + ' ' + a.note + ' ' + a.category + ' ' + (a.description || '')).toLowerCase();
  return query.split(/\s+/).every(w => hay.includes(w));
}

function render() {
  hideTip();
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
    p.textContent = query ? `No apps match “${query}” with these filters.` : 'No apps match these filters.';
    grid.appendChild(p);
  }
  $('#showing').textContent = filtersActive() ? `Showing ${shown} of ${apps.length} apps` : `${apps.length} apps`;
  $('#resetFilters').hidden = !filtersActive();
}

function badges(a) {
  const frag = document.createDocumentFragment();
  if (a.price && a.price !== 'free') { const b = document.createElement('span'); b.className = 'badge ' + a.price; b.textContent = a.price === 'paid' ? 'Paid' : 'Paid plans'; frag.appendChild(b); }
  return frag;
}

function infoButton(a) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'info'; b.textContent = 'i';
  b.setAttribute('aria-label', 'About ' + a.name);
  b.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    clearTimeout(tipTimer);
    if (tipFor === a && $('#tip').dataset.pinned) hideTip(); else showTip(a, b.closest('.app'), true);
  });
  b.addEventListener('focus', () => { if (b.matches(':focus-visible')) showTip(a, b.closest('.app')); });
  b.addEventListener('blur', () => { if (!$('#tip').dataset.pinned) hideTip(); });
  if (canHover) {
    b.addEventListener('mouseenter', () => { clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(a, b.closest('.app')), 120); });
    b.addEventListener('mouseleave', () => { clearTimeout(tipTimer); if (!$('#tip').dataset.pinned) hideTip(); });
  }
  return b;
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
  const n = document.createElement('span'); n.className = 'n'; n.textContent = a.name; n.appendChild(badges(a)); t.appendChild(n);
  if (a.note) { const d = document.createElement('span'); d.className = 'd'; d.textContent = a.note; t.appendChild(d); }
  label.append(cb, t, infoButton(a));
  return label;
}

function manualRow(a) {
  const div = document.createElement('div');
  div.className = 'app manual';
  const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = '↗'; ico.setAttribute('aria-hidden', 'true');
  const t = document.createElement('span'); t.className = 't';
  const nm = document.createElement('span'); nm.className = 'n';
  const link = document.createElement('a'); link.href = a.homepage; link.target = '_blank'; link.rel = 'noopener'; link.textContent = a.name;
  nm.append(link, badges(a));
  const d = document.createElement('span'); d.className = 'd'; d.textContent = (a.note ? a.note + '. ' : '') + 'Download it yourself.';
  t.append(nm, d);
  div.append(ico, t, infoButton(a));
  return div;
}

// ---------- App details: only from the (i) button (hover it, click to pin, or tab to it)

let tipFor = null, tipTimer = 0;
const canHover = matchMedia('(hover: hover)').matches;

function showTip(a, anchor, pinned) {
  const tip = $('#tip');
  tip.textContent = '';
  const h = document.createElement('b'); h.textContent = a.name;
  const p = document.createElement('p'); p.textContent = a.description || a.note || 'No description yet.';
  const meta = document.createElement('div'); meta.className = 'meta';
  const bits = [PRICE_LABEL[a.price] || 'Free'];
  if (a.open_source) bits.push('Open source');
  if (a.requires) bits.push({ 'gpu:nvidia': 'NVIDIA GPUs only', 'gpu:amd': 'AMD GPUs only', 'gpu:intel': 'Intel graphics only', 'cpu:intel': 'Intel CPUs only', 'cpu:amd': 'AMD CPUs only' }[a.requires] || a.requires);
  meta.textContent = bits.join(' · ');
  const how = document.createElement('div'); how.className = 'how'; how.textContent = SOURCE_LABEL[a.source] || '';
  tip.append(h, p, meta, how);
  tip.hidden = false;
  tipFor = a;
  tip.dataset.pinned = pinned ? '1' : '';
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const left = Math.max(8, Math.min(r.left, innerWidth - tw - 8));
  const below = r.bottom + 6 + th < innerHeight - 90;
  tip.style.left = left + 'px';
  tip.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - th - 6)) + 'px';
}

function hideTip() { const t = $('#tip'); if (t) t.hidden = true; tipFor = null; }
document.addEventListener('click', e => { if (tipFor && !e.target.closest('#tip, .info')) hideTip(); });
addEventListener('scroll', () => { if (tipFor) hideTip(); }, { passive: true });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });

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
  $('#clearBtn').disabled = n === 0 && !query;
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
$('#search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); render(); updateTray(); });
$('#clearBtn').addEventListener('click', () => {
  const had = selected.size;
  selected.clear(); query = ''; $('#search').value = '';
  saveSelection(); render();
  toast(had ? 'Selection and search cleared' : 'Search cleared');
});

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

// Google draws its own button; pick its dark or light style to match the page.
function renderGoogleButton() {
  if (!window.google?.accounts?.id) return;
  const el = $('#gsiButton');
  el.textContent = '';
  const dark = window.eiTheme ? window.eiTheme.isDark() : matchMedia('(prefers-color-scheme: dark)').matches;
  google.accounts.id.renderButton(el, { theme: dark ? 'filled_black' : 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
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
    renderGoogleButton();
    addEventListener('ei-theme', renderGoogleButton);
  };
  document.head.appendChild(s);
}

$('#signOutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setSignedIn(false);
  toast('Signed out. Presets stay in this browser.');
});

let confirmDelete = false;
$('#deleteDataBtn').addEventListener('click', async () => {
  const btn = $('#deleteDataBtn');
  if (!confirmDelete) { confirmDelete = true; btn.textContent = 'Click again to delete'; return; }
  try {
    const r = await fetch('/api/account', { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error);
    setSignedIn(false); confirmDelete = false; btn.textContent = 'Delete my synced data';
    toast('Synced data deleted. Presets stay in this browser.');
  } catch (e) { syncError(e.message || 'Couldn’t delete your data. Try again.'); }
});

load();
