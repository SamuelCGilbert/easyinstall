const $ = s => document.querySelector(s);
let apps = [], categories = [], query = '', onlyOff = false, editing = null, confirmDelete = false;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2400);
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || (data.errors || []).join(' ') || 'Request failed'), { errors: data.errors });
  return data;
}

async function load() {
  try {
    const d = await api('GET', '/api/admin/apps');
    apps = d.apps; categories = d.categories;
    $('#who').textContent = 'Signed in as ' + d.you;
    $('#catList').innerHTML = '';
    for (const c of categories) { const o = document.createElement('option'); o.value = c; $('#catList').appendChild(o); }
    render();
  } catch (e) {
    $('#rows').innerHTML = '<tr><td colspan="5">The catalog couldn’t load. Reload the page.</td></tr>';
  }
}

const pkgText = a => a.source === 'manual' ? a.homepage : a.source === 'direct' ? (a.url_pattern ? a.url + '  → /' + a.url_pattern + '/' : a.url) : a.pkg;

function render() {
  const tb = $('#rows'); tb.textContent = '';
  const list = apps.filter(a => (!onlyOff || !a.enabled) && (!query || (a.name + ' ' + a.pkg + ' ' + a.category + ' ' + a.key).toLowerCase().includes(query)));
  for (const cat of categories) {
    const rows = list.filter(a => a.category === cat);
    if (!rows.length) continue;
    const tr = document.createElement('tr'); tr.className = 'cat';
    const td = document.createElement('td'); td.colSpan = 5; td.textContent = cat; tr.appendChild(td); tb.appendChild(tr);
    for (const a of rows) tb.appendChild(row(a));
  }
  if (!list.length) tb.innerHTML = '<tr><td colspan="5">No apps match.</td></tr>';
  const on = apps.filter(a => a.enabled).length;
  $('#stats').textContent = `${on} shown, ${apps.length - on} hidden`;
}

function row(a) {
  const tr = document.createElement('tr'); if (!a.enabled) tr.className = 'off';
  const t1 = document.createElement('td');
  const sw = document.createElement('input'); sw.type = 'checkbox'; sw.className = 'switch'; sw.checked = !!a.enabled; sw.setAttribute('aria-label', 'Show ' + a.name);
  sw.onchange = async () => {
    try { await api('PATCH', '/api/admin/apps/' + a.key, { enabled: sw.checked }); a.enabled = sw.checked ? 1 : 0; tr.className = a.enabled ? '' : 'off'; render(); toast(`${a.name} ${a.enabled ? 'shown' : 'hidden'}`); }
    catch (e) { sw.checked = !sw.checked; toast('Couldn’t save: ' + e.message); }
  };
  t1.appendChild(sw);
  const t2 = document.createElement('td');
  const b = document.createElement('b'); b.textContent = a.name; t2.appendChild(b);
  if (a.note) { const d = document.createElement('div'); d.className = 'muted small'; d.textContent = a.note; t2.appendChild(d); }
  const t3 = document.createElement('td');
  const s = document.createElement('span'); s.className = 'src' + (a.source === 'manual' ? ' manual' : ''); s.textContent = a.source + (a.requires ? ' · ' + a.requires : ''); t3.appendChild(s);
  const t4 = document.createElement('td'); const c = document.createElement('code'); c.textContent = pkgText(a); t4.appendChild(c);
  const t5 = document.createElement('td'); const e = document.createElement('button'); e.className = 'btn ghost sm'; e.type = 'button'; e.textContent = 'Edit'; e.onclick = () => openEdit(a); t5.appendChild(e);
  tr.append(t1, t2, t3, t4, t5);
  return tr;
}

const FIELDS = ['name', 'key', 'category', 'source', 'pkg', 'url', 'url_pattern', 'args', 'detect', 'requires', 'sort', 'note', 'homepage'];
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function syncSourceFields() {
  const src = $('#f-source').value;
  document.querySelectorAll('[data-for]').forEach(l => (l.hidden = !l.dataset.for.split(' ').includes(src)));
  $('#pkgHelp').textContent = {
    winget: 'Find it with: winget search <name>, then copy the ID column.',
    msstore: 'The 12-character ID from the app’s Microsoft Store link, e.g. 9NKSQGP7F2NH.',
    choco: 'Find it at community.chocolatey.org/packages, e.g. rustdesk.',
  }[src] || '';
}

function openEdit(a) {
  editing = a; confirmDelete = false;
  $('#editTitle').textContent = a ? 'Edit ' + a.name : 'Add app';
  const v = a || { source: 'winget', category: categories[0] || '', sort: 1000, enabled: 1 };
  for (const f of FIELDS) $('#f-' + f).value = v[f] ?? '';
  $('#f-enabled').checked = !!v.enabled;
  $('#delBtn').hidden = !a; $('#delBtn').textContent = 'Delete';
  $('#errors').hidden = true;
  syncSourceFields();
  $('#editDlg').showModal();
}

$('#f-source').addEventListener('change', syncSourceFields);
$('#f-name').addEventListener('input', () => { if (!editing) $('#f-key').value = slug($('#f-name').value); });

$('#saveBtn').addEventListener('click', async () => {
  const body = { enabled: $('#f-enabled').checked };
  for (const f of FIELDS) body[f] = $('#f-' + f).value;
  const oldKey = editing ? editing.key : body.key;
  if (!editing && apps.some(a => a.key === body.key)) { showErrors(['That key is already used by another app.']); return; }
  try {
    await api('PUT', '/api/admin/apps/' + encodeURIComponent(oldKey), body);
    $('#editDlg').close(); toast(`Saved ${body.name}`); await load();
  } catch (e) { showErrors(e.errors || [e.message]); }
});

$('#delBtn').addEventListener('click', async () => {
  if (!confirmDelete) { confirmDelete = true; $('#delBtn').textContent = 'Click again to delete'; return; }
  try { await api('DELETE', '/api/admin/apps/' + editing.key); $('#editDlg').close(); toast(`Deleted ${editing.name}`); await load(); }
  catch (e) { showErrors([e.message]); }
});

function showErrors(list) {
  const ul = $('#errors'); ul.textContent = '';
  for (const m of list) { const li = document.createElement('li'); li.textContent = m; ul.appendChild(li); }
  ul.hidden = false;
}

$('#q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); render(); });
$('#showOff').addEventListener('click', () => { onlyOff = !onlyOff; $('#showOff').setAttribute('aria-pressed', onlyOff); $('#showOff').textContent = onlyOff ? 'Show all apps' : 'Only hidden apps'; render(); });
$('#addBtn').addEventListener('click', () => openEdit(null));
load();
