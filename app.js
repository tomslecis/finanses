// Finanses UI (vanilla JS). Data comes from the Google Apps Script backend (config.js execUrl);
// in preview mode (?preview or file:) from mock.js sample data.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null; // server state
const ui = {
  view: location.hash.slice(1) || 'overview',
  month: new Date().toISOString().slice(0, 7),
  search: '', filterCat: '', txMonth: 'month',
};

// ---------- API ----------
// In the Mac app the page is loaded with ?app=1 (native title bar area + vibrancy).
if (new URLSearchParams(location.search).has('app')) document.documentElement.classList.add('is-app');
// Preview (sample data from mock.js): above code's side panel adds ?preview=1; also when no backend is configured.
const PREVIEW = !!window.MockAPI && (new URLSearchParams(location.search).has('preview') || (!window.finanses && !window.FIN_CONFIG?.execUrl));

const EXEC_URL = window.FIN_CONFIG?.execUrl;
const TOKEN_KEY = 'fin_token';

// REST-style calls used across the UI, mapped to backend functions (Apps Script doPost { fn, args }).
const ROUTES = [
  ['GET', /^\/api\/state$/, 'state'],
  ['POST', /^\/api\/transactions$/, 'addTransactions'],
  ['PUT', /^\/api\/transactions\/(.+)$/, 'updateTransaction'],
  ['DELETE', /^\/api\/transactions\/(.+)$/, 'deleteTransaction'],
  ['POST', /^\/api\/import$/, 'import'],
  ['PUT', /^\/api\/budget$/, 'budget'],
  ['PUT', /^\/api\/savings\/positions$/, 'positions'],
  ['PUT', /^\/api\/savings\/snapshot$/, 'snapshot'],
  ['PUT', /^\/api\/settings$/, 'settings'],
];

async function api(method, url, body) {
  if (PREVIEW) return window.MockAPI.handle(method, url, body && JSON.parse(JSON.stringify(body)));
  for (const [m, re, fn] of ROUTES) {
    const hit = m === method && url.match(re);
    if (hit) return (await call(fn, hit[1] ? { ...(body || {}), id: decodeURIComponent(hit[1]) } : body || {})).result;
  }
  throw new Error('Nezināma darbība');
}

// One backend call. Mutations also return the fresh state, which saves a second round trip.
async function call(fn, args = {}) {
  if (!EXEC_URL && !window.finanses?.call) throw new Error('Nav iestatīts servera adrese (config.js)');
  const payload = { fn, args, token: localStorage.getItem(TOKEN_KEY) || '' };
  setBusy(true);
  try {
    let data;
    if (window.finanses?.call) data = await window.finanses.call(payload);
    else {
      let res;
      try { res = await fetch(EXEC_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }); }
      catch (e) { throw new Error('Nevar sazināties ar serveri. Pārbaudi internetu.'); }
      data = await res.json().catch(() => ({ ok: false, error: 'Serveris neatbildēja' }));
    }
    if (data.auth) { localStorage.removeItem(TOKEN_KEY); showLogin(); throw new Error(data.error); }
    if (!data.ok) throw new Error(data.error || 'Kļūda');
    if (data.state) S = data.state;
    return data;
  } finally { setBusy(false); }
}

async function refresh() { S = await api('GET', '/api/state'); render(); }
async function mutate(method, url, body, msg) {
  try {
    await api(method, url, body);
    if (PREVIEW) S = window.MockAPI.handle('GET', '/api/state');
    render();
    if (msg) toast(msg);
  } catch (e) { toast(e.message); }
}

let busyCount = 0;
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  document.documentElement.classList.toggle('busy', busyCount > 0);
  if (S) renderSync();
}

// ---------- Login (PIN) ----------
async function showLogin() {
  let pinSet = true;
  try { pinSet = (await call('status')).result.pinSet; } catch (e) {}
  const el = $('#login');
  el.hidden = false;
  el.innerHTML = `<form class="login-card" id="loginForm">
    <img src="icon.svg" alt="" width="64" height="64">
    <h1>Finanses</h1>
    <div class="sub">${pinSet ? 'Ievadi PIN' : 'Izveido PIN (4–8 cipari). To prasīs katrā jaunā ierīcē.'}</div>
    <input id="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]*" maxlength="8" placeholder="••••" autofocus>
    <div class="sub neg" id="loginErr"></div>
    <button class="btn primary" style="width:100%">${pinSet ? 'Ienākt' : 'Izveidot PIN'}</button>
  </form>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      const { result } = await call('login', { pin: $('#pin').value });
      localStorage.setItem(TOKEN_KEY, result.token);
      el.hidden = true;
      await refresh();
      bankSync(true);
    } catch (err) { $('#loginErr').textContent = err.message; $('#pin').select(); }
  };
  setTimeout(() => $('#pin')?.focus(), 50);
}

// ---------- Formatting ----------
const money = (n, opts = {}) => new Intl.NumberFormat('lv-LV', { style: 'currency', currency: S?.settings.currency || 'EUR', maximumFractionDigits: opts.whole ? 0 : 2, minimumFractionDigits: opts.whole ? 0 : 2 }).format(n || 0);
const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
const MONTHS = ['Janvāris', 'Februāris', 'Marts', 'Aprīlis', 'Maijs', 'Jūnijs', 'Jūlijs', 'Augusts', 'Septembris', 'Oktobris', 'Novembris', 'Decembris'];
const monthName = m => `${MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
const monthShort = m => new Date(m + '-15').toLocaleDateString('lv-LV', { month: 'short' }).replace('.', '');
const dayName = d => { const s = new Date(d).toLocaleDateString('lv-LV', { weekday: 'long', day: 'numeric', month: 'long' }); return s; };
const shiftMonth = (m, n) => { const d = new Date(m + '-15'); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 7); };
const sum = arr => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const cat = id => S.categories.find(c => c.id === id);
const pctColor = p => (p > 100 ? 'var(--red)' : p > 85 ? 'var(--orange)' : 'var(--accent)');

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
}

// ---------- Derived data ----------
const monthTx = m => S.transactions.filter(t => t.date.startsWith(m));
function spending(m) {
  const txs = monthTx(m).filter(t => t.type !== 'income');
  const byCat = {};
  txs.forEach(t => (byCat[t.categoryId] = (byCat[t.categoryId] || 0) + t.amount));
  return { total: sum(txs.map(t => t.amount)), byCat, income: sum(monthTx(m).filter(t => t.type === 'income').map(t => t.amount)) };
}
const snapTotal = m => (S.savings.snapshots[m] ? sum(Object.values(S.savings.snapshots[m])) : null);
const prevSnapMonth = m => Object.keys(S.savings.snapshots).filter(k => k < m).sort().pop();

// ---------- Router ----------
function go(view) { ui.view = view; location.hash = view; render(); window.scrollTo(0, 0); }
$('#nav').addEventListener('click', e => { const a = e.target.closest('a'); if (a) go(a.dataset.view); });
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== ui.view) { ui.view = v; render(); } });

function render() {
  if (!S) return;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === ui.view));
  const views = { overview, transactions, budget, savings, settings };
  $('#view').innerHTML = (views[ui.view] || overview)();
  renderSync();
}

function renderSync() {
  $('#syncStatus').innerHTML = PREVIEW ? '<span class="dot"></span>Priekšskatījums ar paraugdatiem'
    : busyCount ? '<span class="dot busy"></span>Saglabā Google Sheets…' : '<span class="dot ok"></span>Dati Google Sheets';
}

const monthSwitch = () => `<div class="month-switch"><button data-act="prevMonth" aria-label="Iepriekšējais">‹</button><span>${monthName(ui.month)}</span><button data-act="nextMonth" aria-label="Nākamais">›</button></div>`;

// ---------- Overview ----------
function overview() {
  const sp = spending(ui.month);
  const limit = S.settings.totalLimit || 0;
  const pct = limit ? Math.round((sp.total / limit) * 100) : 0;
  const left = limit - sp.total;
  const now = new Date(); const isCur = ui.month === now.toISOString().slice(0, 7);
  const daysInMonth = new Date(+ui.month.slice(0, 4), +ui.month.slice(5), 0).getDate();
  const daysLeft = isCur ? daysInMonth - now.getDate() + 1 : 0;
  const R = 70, C = 2 * Math.PI * R;
  const savings = snapTotal(ui.month), prevM = prevSnapMonth(ui.month), prevSav = prevM ? snapTotal(prevM) : null;
  const recent = monthTx(ui.month).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const cats = S.categories.map(c => ({ ...c, spent: sp.byCat[c.id] || 0 })).sort((a, b) => b.spent - a.spent || b.limit - a.limit);

  return `
  <div class="head"><h1>Pārskats</h1>${monthSwitch()}</div>
  <div class="grid g-hero">
    <div class="card">
      <h2>Mēneša budžets</h2>
      <div class="ring-wrap">
        <div class="ring">
          <svg width="168" height="168" viewBox="0 0 168 168">
            <circle cx="84" cy="84" r="${R}" fill="none" stroke="var(--fill)" stroke-width="14"/>
            <circle cx="84" cy="84" r="${R}" fill="none" stroke="${pctColor(pct)}" stroke-width="14" stroke-linecap="round"
              stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - Math.min(pct, 100) / 100)}" style="transition:stroke-dashoffset .6s"/>
          </svg>
          <div class="center"><span class="pct num">${pct}%</span><span class="sub">izlietots</span></div>
        </div>
        <div class="kv">
          <div><span class="stat-label">Iztērēts</span><span class="big num">${money(sp.total)}</span><span class="sub">no ${money(limit, { whole: true })} limita</span></div>
          <div><span class="stat-label">${left >= 0 ? 'Vēl atlicis' : 'Pārtērēts'}</span><span class="stat-value num ${left >= 0 ? 'pos' : 'neg'}">${money(Math.abs(left))}</span>
            ${isCur && left > 0 ? `<span class="sub">≈ ${money(left / daysLeft)} dienā vēl ${daysLeft} d.</span>` : ''}</div>
        </div>
      </div>
    </div>
    <div class="grid" style="grid-template-rows:1fr 1fr">
      <div class="card grid g2" style="margin:0">
        <div><span class="stat-label">Ienākumi</span><div class="stat-value num pos">${money(sp.income)}</div></div>
        <div><span class="stat-label">Ienākumi − izdevumi</span><div class="stat-value num ${sp.income - sp.total >= 0 ? 'pos' : 'neg'}">${signed(sp.income - sp.total)}</div></div>
      </div>
      <div class="card" style="margin:0;cursor:pointer" data-go="savings">
        <span class="stat-label">Uzkrājumi</span>
        ${savings == null ? `<div class="sub" style="margin-top:6px">Šim mēnesim vēl nav ievadīti. <span style="color:var(--accent)">Aizpildīt →</span></div>`
          : `<div class="row"><div class="stat-value num">${money(savings)}</div>${prevSav != null ? `<span class="pill ${savings - prevSav >= 0 ? 'pos' : 'neg'} num">${signed(savings - prevSav)}</span>` : ''}</div>
             <div class="sub">${prevSav != null ? `salīdzinot ar ${monthName(prevM).toLowerCase()}` : 'pirmais ieraksts'}</div>`}
      </div>
    </div>
  </div>
  <div class="grid g2">
    <div class="card">
      <div class="row"><h2>Kategorijas</h2><span class="spacer"></span><button class="btn ghost" data-go="budget">Limiti</button></div>
      ${cats.map(c => catRow(c)).join('')}
    </div>
    <div class="card">
      <div class="row"><h2>Pēdējie darījumi</h2><span class="spacer"></span><button class="btn ghost" data-go="transactions">Visi</button></div>
      ${recent.length ? recent.map(txRow).join('') : `<div class="empty"><b>Vēl nav darījumu</b>Importē izrakstu vai pievieno ar roku.<br><br><button class="btn primary" data-go="transactions">Pievienot</button></div>`}
    </div>
  </div>`;
}

function catRow(c) {
  const p = c.limit ? Math.round((c.spent / c.limit) * 100) : (c.spent ? 100 : 0);
  const left = c.limit - c.spent;
  return `<div class="cat-row">
    <div class="cat-name">${emo(c)}${esc(c.name)}</div>
    <div class="num"><b>${money(c.spent)}</b> <span class="sub">/ ${money(c.limit, { whole: true })}</span></div>
    <div class="bar"><i style="width:${Math.min(p, 100)}%;background:${p > 100 ? 'var(--red)' : c.color}"></i></div>
    <div class="sub num">${p}%</div>
    <div class="cat-meta num ${left < 0 ? 'neg' : ''}">${left >= 0 ? `atlicis ${money(left)}` : `pārsniegts par ${money(-left)}`}</div>
  </div>`;
}

// Emoji tile on a soft tint of the category color.
const emo = (c, size = '') => `<span class="emoji ${size}" style="background:color-mix(in srgb, ${c.color} 16%, transparent)">${esc(c.icon || '🏷️')}</span>`;

function txRow(t) {
  const c = cat(t.categoryId);
  return `<div class="tx" data-tx="${t.id}">
    ${t.type === 'income' ? emo({ icon: '💰', color: '#34C759' }, 'lg') : emo(c || { icon: '🏷️', color: '#8E8E93' }, 'lg')}
    <div class="desc"><b>${esc(t.description)}</b><small>${t.type === 'income' ? 'Ienākumi' : esc(c?.name || 'Bez kategorijas')} · ${new Date(t.date).toLocaleDateString('lv-LV', { day: 'numeric', month: 'short' })}${t.source === CASH ? ' · 💶 skaidrā naudā' : ''}</small></div>
    <div class="amt num ${t.type === 'income' ? 'pos' : ''}">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</div>
  </div>`;
}

// ---------- Transactions ----------
const CASH = 'skaidra nauda'; // source of cash transactions entered by hand
// New transactions default to today, or the 1st of the month being viewed.
const defaultDate = () => { const today = new Date().toISOString().slice(0, 10); return today.startsWith(ui.month) ? today : ui.month + '-01'; };

function transactions() {
  let list = ui.txMonth === 'month' ? monthTx(ui.month) : [...S.transactions];
  const q = ui.search.toLowerCase();
  if (q) list = list.filter(t => t.description.toLowerCase().includes(q) || String(t.amount).includes(q));
  if (ui.filterCat === 'income') list = list.filter(t => t.type === 'income');
  else if (ui.filterCat === 'cash') list = list.filter(t => t.source === CASH);
  else if (ui.filterCat) list = list.filter(t => t.categoryId === ui.filterCat);
  list.sort((a, b) => b.date.localeCompare(a.date));
  const groups = {};
  list.forEach(t => (groups[t.date] = groups[t.date] || []).push(t));
  const exp = sum(list.filter(t => t.type !== 'income').map(t => t.amount));
  const cash = list.filter(t => t.source === CASH);
  const cashNet = sum(cash.map(t => (t.type === 'income' ? t.amount : -t.amount)));

  return `
  <div class="head"><h1>Darījumi</h1>
    <div class="row">${ui.txMonth === 'month' ? monthSwitch() : ''}<button class="btn" data-act="addCash">💶 Skaidra nauda</button><button class="btn primary" data-act="addTx">+ Pievienot</button></div></div>
  <label class="dropzone" id="dz">
    <div class="ico">⤓</div>
    <div><b>Importēt izrakstu</b><div class="sub">Ievelc vai izvēlies XML (FiDAViSta, ISO 20022), PDF, CSV vai ekrānuzņēmumu. Var arī ielīmēt ar ⌘V. Claude sašķiros pa kategorijām.</div></div>
    <input type="file" id="fileIn" multiple accept=".xml,.pdf,.csv,.txt,image/*" hidden>
  </label>
  <div class="card">
    <div class="toolbar">
      <input type="text" id="search" placeholder="Meklēt…" value="${esc(ui.search)}">
      <select id="filterCat"><option value="">Visas kategorijas</option><option value="income" ${ui.filterCat === 'income' ? 'selected' : ''}>Ienākumi</option><option value="cash" ${ui.filterCat === 'cash' ? 'selected' : ''}>💶 Skaidra nauda</option>
        ${S.categories.map(c => `<option value="${c.id}" ${ui.filterCat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <div class="seg"><button data-act="txMonth" data-v="month" class="${ui.txMonth === 'month' ? 'on' : ''}">Mēnesis</button><button data-act="txMonth" data-v="all" class="${ui.txMonth === 'all' ? 'on' : ''}">Visi</button></div>
    </div>
    <div class="sub">${list.length} darījumi · izdevumi ${money(exp)}${cash.length ? ` · skaidrā naudā ${signed(cashNet)}` : ''}</div>
    ${list.length ? Object.entries(groups).map(([d, txs]) => `<div class="day">${dayName(d)}</div>${txs.map(txRow).join('')}`).join('')
      : `<div class="empty"><b>Nav darījumu</b>Importē izrakstu vai pievieno darījumu ar roku.</div>`}
  </div>`;
}

const catOptions = sel => S.categories.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

function openModal(html, wide) {
  $('#modalBody').className = 'sheet' + (wide ? ' wide' : '');
  $('#modalBody').innerHTML = html; $('#modal').hidden = false;
  setTimeout(() => $('#modalBody input:not([type=checkbox]), #modalBody select')?.focus(), 30);
}
const closeModal = () => ($('#modal').hidden = true);
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function txForm(t) {
  const isNew = !t.id;
  // Payment method only for hand-entered transactions; bank and statement ones keep their source.
  const manual = isNew || !t.source || t.source === 'manuāli' || t.source === CASH;
  let source = t.source === CASH ? CASH : 'manuāli';
  openModal(`<h2>${isNew ? (source === CASH ? 'Skaidra nauda' : 'Jauns darījums') : 'Labot darījumu'}</h2>
  <form class="form" id="txForm">
    <div class="row" style="flex-wrap:wrap;gap:10px">
      <div class="seg"><button type="button" data-type="expense" class="${t.type !== 'income' ? 'on' : ''}">Izdevumi</button><button type="button" data-type="income" class="${t.type === 'income' ? 'on' : ''}">Ienākumi</button></div>
      ${manual ? `<div class="seg"><button type="button" data-src="manuāli" class="${source !== CASH ? 'on' : ''}">Karte / konts</button><button type="button" data-src="${CASH}" class="${source === CASH ? 'on' : ''}">💶 Skaidrā naudā</button></div>` : ''}
    </div>
    <label class="field">Apraksts<input type="text" name="description" value="${esc(t.description || '')}" placeholder="${t.type === 'income' ? 'piem. Pārdots velosipēds' : 'piem. Tirgus'}" required></label>
    <div class="grid g2"><label class="field">Summa (€)<input type="number" name="amount" step="0.01" min="0" value="${t.amount ?? ''}" required></label>
    <label class="field">Datums<input type="date" name="date" value="${t.date || defaultDate()}" required></label></div>
    <label class="field" id="catField" ${t.type === 'income' ? 'hidden' : ''}>Kategorija<select name="categoryId">${catOptions(t.categoryId)}</select></label>
    <div class="actions">${isNew ? '' : `<button type="button" class="btn danger" data-del="${t.id}">Dzēst</button>`}<span class="spacer"></span>
      <button type="button" class="btn" data-close>Atcelt</button><button class="btn primary">Saglabāt</button></div>
  </form>`);
  let type = t.type || 'expense';
  const f = $('#txForm');
  $$('[data-type]', f).forEach(b => b.onclick = () => { type = b.dataset.type; $$('[data-type]', f).forEach(x => x.classList.toggle('on', x === b)); $('#catField').hidden = type === 'income'; });
  $$('[data-src]', f).forEach(b => b.onclick = () => { source = b.dataset.src; $$('[data-src]', f).forEach(x => x.classList.toggle('on', x === b)); });
  f.onsubmit = async e => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(f)), type, ...(manual ? { source } : {}) };
    closeModal();
    ui.month = body.date.slice(0, 7); // show the month the transaction went into
    if (isNew) await mutate('POST', '/api/transactions', body, 'Darījums pievienots');
    else await mutate('PUT', `/api/transactions/${t.id}`, body, 'Saglabāts');
  };
}

// ---------- Import ----------
// Photos from a phone are large: shrink images to max 2000 px JPEG before upload.
async function prepareFile(f) {
  const name = f.name || 'ekranuznemums.png';
  if (/^image\//.test(f.type) && f.size > 1.5e6) {
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return { name: name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.88).split(',')[1] };
    } catch (e) { /* fall back to the original file */ }
  }
  return { name, type: f.type || '', data: await readFile(f) };
}
const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });

async function importFiles(files) {
  if (!files.length) return;
  openModal(`<div class="row" style="gap:14px"><span class="spinner"></span><div><b>Apstrādāju ${files.length > 1 ? files.length + ' failus' : esc(files[0].name)}…</b>
    <div class="sub">Claude lasa izrakstu un šķiro pa kategorijām. Tas var aizņemt līdz minūtei.</div></div></div>`);
  try {
    const payload = await Promise.all(files.map(prepareFile));
    const res = window.finanses?.importLocal && !PREVIEW
      ? await window.finanses.importLocal(payload, { categories: S.categories, rules: S.rules, transactions: S.transactions })
      : await api('POST', '/api/import', { files: payload });
    if (res.error) throw new Error(res.error);
    reviewImport(res);
  } catch (e) { closeModal(); toast(e.message); }
}

function reviewImport({ transactions: txs, warnings }) {
  if (!txs.length) { closeModal(); toast(warnings[0] || 'Darījumi netika atrasti'); return; }
  openModal(`<h2>Pārbaudi importu</h2>
    <div class="sub" style="margin-bottom:14px">Atrasti ${txs.length} darījumi. Vari mainīt kategorijas pirms saglabāšanas.${txs.some(t => t.duplicate) ? ' Iespējamie dublikāti ir atzīmēti pelēki un neatķeksēti.' : ''}</div>
    ${warnings.length ? `<div class="sub warn" style="margin-bottom:10px">${warnings.map(esc).join('<br>')}</div>` : ''}
    <table><thead><tr><th style="width:30px"><input type="checkbox" id="allChk" checked></th><th>Datums</th><th>Apraksts</th><th>Kategorija</th><th class="r">Summa</th></tr></thead>
    <tbody>${txs.map((t, i) => `<tr class="${t.duplicate ? 'dup' : ''}" data-i="${i}">
      <td><input type="checkbox" class="chk" ${t.duplicate ? '' : 'checked'}></td>
      <td><input type="date" class="d" value="${t.date}"></td>
      <td><input type="text" class="ds" value="${esc(t.description)}"></td>
      <td>${t.type === 'income' ? '<span class="pos">Ienākumi</span>' : `<select class="c">${catOptions(t.categoryId)}</select>`}</td>
      <td class="r num ${t.type === 'income' ? 'pos' : ''}" style="white-space:nowrap">${t.type === 'income' ? '+' : '−'}${money(t.amount)}</td></tr>`).join('')}</tbody></table>
    <div class="actions"><button class="btn" data-close>Atcelt</button><button class="btn primary" id="saveImport">Saglabāt</button></div>`, true);
  const upd = () => { $('#saveImport').textContent = `Saglabāt ${$$('.chk:checked').length}`; };
  upd();
  $('#allChk').onchange = e => { $$('.chk').forEach(c => (c.checked = e.target.checked)); upd(); };
  $$('.chk').forEach(c => (c.onchange = upd));
  $('#saveImport').onclick = async () => {
    const chosen = $$('#modalBody tbody tr').filter(tr => $('.chk', tr).checked).map(tr => {
      const t = txs[tr.dataset.i];
      return { ...t, date: $('.d', tr).value, description: $('.ds', tr).value, categoryId: $('.c', tr)?.value || null };
    });
    closeModal();
    if (chosen.length) {
      ui.month = chosen[0].date.slice(0, 7);
      await mutate('POST', '/api/transactions', { transactions: chosen }, `Saglabāti ${chosen.length} darījumi`);
    }
  };
}

// Drag & drop and paste anywhere
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; importFiles([...e.dataTransfer.files]); });
window.addEventListener('paste', e => {
  if (e.target.matches('input, textarea')) return;
  const files = [...e.clipboardData.items].filter(i => i.kind === 'file').map(i => i.getAsFile());
  if (files.length) importFiles(files);
});

// ---------- Budget ----------
function budget() {
  const sp = spending(ui.month);
  const catSum = sum(S.categories.map(c => c.limit));
  const lim = S.settings.totalLimit;
  return `
  <div class="head"><h1>Budžets</h1>${monthSwitch()}</div>
  <div class="card">
    <div class="row" style="flex-wrap:wrap;gap:20px">
      <label class="field" style="width:220px">Kopējais mēneša limits (€)<input type="number" id="totalLimit" min="0" step="10" value="${lim}"></label>
      <div><span class="stat-label">Kategoriju limitu summa</span><div class="stat-value num ${catSum > lim ? 'warn' : ''}">${money(catSum, { whole: true })}</div></div>
      <div><span class="stat-label">Iztērēts ${monthName(ui.month).toLowerCase()}</span><div class="stat-value num">${money(sp.total)}</div></div>
    </div>
    ${catSum > lim ? `<div class="sub warn" style="margin-top:10px">Kategoriju limiti kopā pārsniedz kopējo limitu par ${money(catSum - lim, { whole: true })}.</div>` : ''}
  </div>
  <div class="card">
    <div class="row"><h2>Kategorijas un limiti</h2><span class="spacer"></span><button class="btn" data-act="addCat">+ Kategorija</button></div>
    <table id="catTable"><thead><tr><th style="width:84px"></th><th>Nosaukums</th><th class="r" style="width:150px">Limits (€)</th><th class="r" style="width:130px">Iztērēts</th><th class="r" style="width:70px">%</th><th style="width:36px"></th></tr></thead>
    <tbody>${S.categories.map(c => {
      const s = sp.byCat[c.id] || 0; const p = c.limit ? Math.round((s / c.limit) * 100) : 0;
      return `<tr data-id="${c.id}"><td><div class="row" style="gap:6px"><button class="emoji-btn" data-emoji="${c.id}" data-icon="${esc(c.icon || '🏷️')}" title="Mainīt emoji">${emo(c, 'lg')}</button><input type="color" class="cc" value="${c.color}" title="Krāsa"></div></td><td><input type="text" class="cn" value="${esc(c.name)}"></td>
        <td><input type="number" class="cl" min="0" step="5" value="${c.limit}"></td><td class="r num">${money(s)}</td>
        <td class="r num" style="color:${pctColor(p)}">${p}%</td><td><button class="icon-btn" data-delcat="${c.id}" title="Dzēst">×</button></td></tr>`;
    }).join('')}</tbody></table>
    <div class="sub" style="margin-top:12px">Izmaiņas saglabājas automātiski. Dzēšot kategoriju, tās darījumi pāriet uz “Citi”.</div>
  </div>`;
}

function collectCats() {
  return $$('#catTable tbody tr').map(tr => ({ id: tr.dataset.id, icon: $('.emoji-btn', tr).dataset.icon, name: $('.cn', tr).value, color: $('.cc', tr).value, limit: $('.cl', tr).value }));
}
// Only send categories when the budget table is on screen, so a stray call can never wipe them.
const saveBudget = (extra = {}) => {
  if (!$('#catTable')) return;
  return mutate('PUT', '/api/budget', { totalLimit: $('#totalLimit').value, categories: collectCats(), ...extra });
};

// ---------- Emoji picker ----------
const EMOJI_SETS = {
  'Bieži': '🛒🍎🥖🥩🧀🍷🍺☕️🍔🍕🍣🍜🥗🍰🍽️🚗🚕🚌🚆🚲🛴⛽️🅿️✈️🏠🏡💡💧🔥📶🛋️🧹🛠️🛍️👕👟👜💄💊🏥🦷💪🧘🎬🎮🎵🎟️📚🎓💻📱🎧🎁🎉🐶🐱👶💇✂️🧾💳🏦💰💵💶📈📉🪙🏷️📦❤️⭐️',
  'Ēdiens': '🍏🍊🍋🍌🍉🍇🍓🫐🍒🥑🥦🥕🌽🥔🍞🥐🥯🧇🥞🧈🍳🥓🍗🍖🌭🍟🌮🌯🥙🧆🥘🍝🍲🍛🍱🥟🍤🍙🍚🍦🍩🍪🎂🧁🍫🍬🍿🥤🧃🧋🍵🥛🍾🥂🍸🍹',
  'Lietas': '⌚️📷🖥️⌨️🖨️💾📀🔋🔌💡🕯️🧯🛢️💸🧳🌂👓🕶️🎒👛👗👖🧥🧣🧤🧢👒💍💎🪑🛏️🚿🛁🧴🧼🪥🧺🧻🪴🎨🧵🧶🎸🎹🥁🏀⚽️🎾🏐🏓🎿🏂🏋️🚴🏊⛳️🎣',
  'Ceļš': '🚙🚐🛻🚚🏎️🏍️🛵🚂🚇🚊🚢⛴️🛳️🚁🛫🛬🏨🏖️🏝️⛰️🏕️🗺️🧭🎡🎢🏛️🗽🗼🏰⛪️🕌',
  'Simboli': '✅❌⚠️🔴🟠🟡🟢🔵🟣⚫️⚪️🟤💯🔔🔒🔑🧩♻️⚡️☀️🌙🌈❄️🌊🍀🌸🌻🌳🐾🦄👑🎯🏆🥇',
};

function emojiPicker(catId) {
  const sets = Object.entries(EMOJI_SETS).map(([name, str]) =>
    `<div class="sub" style="margin:12px 0 6px">${name}</div><div class="emoji-grid">${[...new Intl.Segmenter().segment(str)].map(g => `<button data-pick="${g.segment}">${g.segment}</button>`).join('')}</div>`).join('');
  openModal(`<h2>Izvēlies emoji</h2>
    <div class="row"><input type="text" id="emojiInput" class="input" placeholder="Ielīmē vai ieraksti jebkuru emoji" style="flex:1;font-size:20px">
      <button class="btn" id="allEmoji">Visi emoji…</button></div>
    <div class="sub" style="margin-top:6px">“Visi emoji” atver Mac emoji paneli (arī ar ⌃⌘ Atstarpe).</div>
    ${sets}
    <div class="actions"><button class="btn" data-close>Atcelt</button></div>`);
  const choose = icon => {
    closeModal();
    saveBudget({ categories: collectCats().map(c => (c.id === catId ? { ...c, icon } : c)) });
  };
  $$('[data-pick]', $('#modalBody')).forEach(b => (b.onclick = () => choose(b.dataset.pick)));
  const input = $('#emojiInput');
  input.addEventListener('input', () => {
    const emojis = [...new Intl.Segmenter().segment(input.value)].map(g => g.segment).filter(g => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g));
    if (emojis.length) choose(emojis[emojis.length - 1]);
  });
  $('#allEmoji').onclick = () => { input.focus(); window.finanses?.showEmojiPanel(); };
}

// ---------- Savings ----------
const TYPE_COLORS = ['#34C759', '#007AFF', '#FF9500', '#AF52DE', '#5AC8FA', '#FF2D55', '#A2845E', '#8E8E93'];

function savings() {
  const m = ui.month;
  const snap = S.savings.snapshots[m] || {};
  const prevM = prevSnapMonth(m);
  const prev = prevM ? S.savings.snapshots[prevM] : null;
  const total = snapTotal(m), prevTotal = prevM ? snapTotal(prevM) : null;
  const pos = S.savings.positions;

  // allocation by asset type
  const byType = {};
  pos.forEach(p => { if (snap[p.id] != null) byType[p.assetType] = (byType[p.assetType] || 0) + snap[p.id]; });
  const typeColor = t => TYPE_COLORS[Math.max(0, S.savings.assetTypes.indexOf(t)) % TYPE_COLORS.length];

  // history: up to 12 recorded months up to selected one
  const months = Object.keys(S.savings.snapshots).filter(k => k <= m).sort().slice(-12);
  const maxV = Math.max(1, ...months.map(snapTotal));

  const allMonths = Object.keys(S.savings.snapshots).sort();
  const compare = allMonths.map((mm, i) => {
    const t = snapTotal(mm), p = i ? snapTotal(allMonths[i - 1]) : null, sp = spending(mm);
    return { mm, t, delta: p == null ? null : t - p, exp: sp.total, inc: sp.income };
  }).reverse();

  return `
  <div class="head"><h1>Uzkrājumi</h1>${monthSwitch()}</div>
  <div class="grid g3">
    <div class="card"><span class="stat-label">Kopā ${monthName(m).toLowerCase()}</span><div class="big num">${total == null ? '—' : money(total)}</div>
      <div class="sub">${pos.length} pozīcijas</div></div>
    <div class="card"><span class="stat-label">Izmaiņa pret ${prevM ? monthName(prevM).toLowerCase() : 'iepriekšējo'}</span>
      <div class="big num ${total != null && prevTotal != null ? (total - prevTotal >= 0 ? 'pos' : 'neg') : ''}">${total != null && prevTotal != null ? signed(total - prevTotal) : '—'}</div>
      <div class="sub">${total != null && prevTotal ? `${((total - prevTotal) / prevTotal * 100).toFixed(1)}%` : 'nav ar ko salīdzināt'}</div></div>
    <div class="card"><span class="stat-label">Šī mēneša bilance</span>${verdict(m, total, prevTotal)}</div>
  </div>
  <div class="card">
    <div class="row" style="flex-wrap:wrap"><h2 style="margin:0">Pozīcijas · ${monthName(m)}${S.savings.snapshotDates?.[m] ? ` <span class="sub">(ievadīts ${S.savings.snapshotDates[m].split('-').reverse().join('.')})</span>` : ''}</h2><span class="spacer"></span>
      ${prevM ? `<button class="btn" data-act="copyPrev">Kopēt no ${monthShort(prevM)}</button>` : ''}
      <button class="btn" data-act="addPos">+ Pozīcija</button></div>
    ${pos.length ? `<table id="posTable" style="margin-top:14px"><thead><tr><th>Pozīcija</th><th style="width:170px">Aktīva veids</th><th style="width:160px">Kur</th>
      <th class="r" style="width:120px">${prevM ? monthShort(prevM) : 'Iepriekš'}</th><th class="r" style="width:150px">Vērtība (€)</th><th class="r" style="width:110px">Izmaiņa</th><th style="width:36px"></th></tr></thead>
      <tbody>${pos.map(p => {
        const v = snap[p.id], pv = prev?.[p.id]; const d = v != null && pv != null ? v - pv : null;
        return `<tr data-id="${p.id}"><td><input type="text" class="pn" value="${esc(p.name)}"></td>
          <td><select class="pt">${S.savings.assetTypes.map(t => `<option ${t === p.assetType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></td>
          <td><input type="text" class="pp" value="${esc(p.place)}" placeholder="piem. Swedbank"></td>
          <td class="r num sub">${pv != null ? money(pv) : '—'}</td>
          <td><input type="number" class="pv" step="0.01" value="${v ?? ''}" placeholder="0,00"></td>
          <td class="r num ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d != null ? signed(d) : ''}</td>
          <td><button class="icon-btn" data-delpos="${p.id}" title="Dzēst">×</button></td></tr>`;
      }).join('')}</tbody></table>`
      : `<div class="empty"><b>Vēl nav pozīciju</b>Pievieno, kur glabā naudu: krājkonts, ETF, kripto, pensija…</div>`}
  </div>
  ${Object.keys(byType).length ? `<div class="card"><h2>Sadalījums</h2>
    <div class="alloc">${Object.entries(byType).map(([t, v]) => `<i style="flex:${v};background:${typeColor(t)}" title="${esc(t)}"></i>`).join('')}</div>
    <div class="legend">${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, v]) => `<span><span class="dot" style="background:${typeColor(t)}"></span>${esc(t)} <b class="num">${money(v, { whole: true })}</b> <span class="sub">${Math.round(v / total * 100)}%</span></span>`).join('')}</div></div>` : ''}
  ${months.length > 1 ? `<div class="grid g2">
    <div class="card"><h2>Vēsture</h2><div class="chart">${months.map(mm => `<div class="col ${mm === m ? 'cur' : ''}"><small class="num">${(snapTotal(mm) / 1000).toFixed(1).replace('.', ',')}k</small><div class="b" style="height:${(snapTotal(mm) / maxV) * 130}px"></div><small>${monthShort(mm)}</small></div>`).join('')}</div></div>
    <div class="card"><h2>Mēnešu salīdzinājums</h2><table><thead><tr><th>Mēnesis</th><th class="r">Uzkrājumi</th><th class="r">Izmaiņa</th><th class="r">Iztērēts</th></tr></thead>
      <tbody>${compare.map(r => `<tr><td>${monthName(r.mm)}</td><td class="r num">${money(r.t, { whole: true })}</td>
        <td class="r num">${r.delta == null ? '—' : `<span class="pill ${r.delta >= 0 ? 'pos' : 'neg'}">${signed(r.delta)}</span>`}</td><td class="r num">${money(r.exp, { whole: true })}</td></tr>`).join('')}</tbody></table></div>
  </div>` : ''}`;
}

function verdict(m, total, prevTotal) {
  const sp = spending(m), lim = S.settings.totalLimit;
  const lines = [];
  if (total != null && prevTotal != null) {
    const d = total - prevTotal;
    lines.push(d >= 0 ? `<div class="stat-value pos">Uzkrāji ${money(d)}</div>` : `<div class="stat-value neg">Uzkrājumi samazinājās par ${money(-d)}</div>`);
  }
  if (sp.total) lines.push(`<div class="sub">${sp.total > lim ? `Iztērēts vairāk par limitu (${money(sp.total - lim)})` : `Izdevumi limitā, atlicis ${money(lim - sp.total)}`}</div>`);
  const pm = shiftMonth(m, -1), ps = spending(pm).total;
  if (ps && sp.total) lines.push(`<div class="sub">Izdevumi ${sp.total > ps ? 'pieauga' : 'samazinājās'} par ${money(Math.abs(sp.total - ps))} pret ${monthShort(pm)}</div>`);
  return lines.join('') || '<div class="sub" style="margin-top:6px">Ievadi uzkrājumus vismaz 2 mēnešiem, lai redzētu salīdzinājumu.</div>';
}

function collectPositions() {
  return $$('#posTable tbody tr').map(tr => ({ id: tr.dataset.id, name: $('.pn', tr).value, assetType: $('.pt', tr).value, place: $('.pp', tr).value }));
}
function collectValues() {
  const v = { ...(S.savings.snapshots[ui.month] || {}) };
  $$('#posTable tbody tr').forEach(tr => { const x = $('.pv', tr).value; if (x === '') delete v[tr.dataset.id]; else v[tr.dataset.id] = x; });
  return v;
}

// ---------- Banks (Enable Banking, see apps-script/Bank.gs) ----------
let BANK = null;
const fmtDate = d => (d ? new Date(d).toLocaleDateString('lv-LV', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const daysTo = d => Math.ceil((new Date(d) - Date.now()) / 86400000);

function bankCard(b) {
  if (!b) return `<div class="card"><h2>Bankas</h2><div class="sub">Ielādē…</div></div>`;
  if (!b.configured) {
    const site = window.FIN_CONFIG?.webUrl || 'https://tomslecis.github.io/finanses/';
    return `<div class="card">
    <h2>Bankas</h2>
    <div class="sub">Pieslēdz Swedbank un Revolut, lai darījumi ielādējas paši. Savienojums iet caur Enable Banking (licencēts ES starpnieks, saviem kontiem bez maksas). Vienreizēja iestatīšana:</div>
    <ol class="steps">
      <li>Reģistrējies <a href="https://enablebanking.com/cp/" target="_blank">enablebanking.com</a> un atver <b>API applications → Add a new application</b>.</li>
      <li>Izvēlies <b>Production</b>, nosaukums “Finanses”. Laukā <b>Allowed redirect URLs</b> ielīmē šo adresi:
        <div class="copy"><code>${esc(EXEC_URL)}</code><button type="button" class="btn ghost" data-act="copyRedirect">Kopēt</button></div></li>
      <li>Privacy un Terms URL vari likt <code>${esc(site)}</code>, e-pastu savu. Nospied <b>Register</b>, un pārlūks lejupielādēs <code>.pem</code> failu.</li>
      <li>Pie lietotnes nospied <b>Activate by linking accounts</b> un piesaisti savus Swedbank un Revolut kontus.</li>
      <li>Šeit ielīmē <b>Application ID</b> un izvēlies lejupielādēto .pem failu.</li>
    </ol>
    <form class="row" id="bankSetup" style="flex-wrap:wrap;gap:10px;margin-top:14px">
      <input type="text" id="ebApp" placeholder="Application ID" style="flex:1;min-width:240px" autocomplete="off">
      <label class="btn"><span id="ebKeyName">Izvēlēties .pem…</span><input type="file" id="ebKey" accept=".pem,.key,.txt" hidden></label>
      <button class="btn primary">Saglabāt</button>
    </form>
  </div>`;
  }
  const conns = b.connections;
  return `<div class="card">
    <div class="row"><h2 style="margin:0">Bankas</h2><span class="spacer"></span>
      ${conns.length ? '<button class="btn" data-act="bankSync">Ielādēt tagad</button>' : ''}
      <button class="btn primary" data-act="bankAdd">+ Pieslēgt banku</button></div>
    ${conns.map(c => {
      const d = daysTo(c.validUntil), late = c.error || d < 14;
      return `<div class="bank">
        <div class="row"><b>${esc(c.bank)}</b><span class="spacer"></span>
          <button class="btn ghost" data-bankrenew="${esc(c.bank)}" data-country="${esc(c.country)}">Atjaunot atļauju</button>
          <button class="icon-btn" data-bankdel="${esc(c.id)}" title="Atvienot">×</button></div>
        ${c.accounts.map(a => `<div class="bank-acc"><span>${esc(a.name || 'Konts')} <span class="sub">${esc(a.iban)}</span></span>
          <span class="num">${a.balance != null ? money(a.balance) : ''}</span></div>`).join('')}
        <div class="sub ${late ? 'warn' : ''}">${c.error ? esc(c.error) + ' · ' : ''}${c.syncedAt ? 'Ielādēts ' + new Date(c.syncedAt).toLocaleString('lv-LV', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Vēl nav ielādēts'}
          · atļauja līdz ${fmtDate(c.validUntil)}${d < 14 ? ` (vēl ${Math.max(0, d)} d.)` : ''}</div>
      </div>`;
    }).join('') || '<div class="sub" style="margin-top:10px">Vēl nav pieslēgta neviena banka.</div>'}
    <div class="sub" style="margin-top:12px">${b.daily ? `Jaunie darījumi Google Sheets ielādējas paši katru dienu ap 6:00, arī ja programma nav atvērta${b.lastDaily ? ` (pēdējoreiz ${new Date(b.lastDaily.at).toLocaleString('lv-LV', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, +${b.lastDaily.added})` : ''}, un vēl atverot programmu.` : 'Jaunie darījumi ielādējas, kad atver programmu (ne biežāk kā reizi 6 stundās).'} Tie tiek sašķiroti kategorijās. Pārskaitījumi starp taviem kontiem un Revolut papildināšana netiek skaitīti kā izdevumi. Bankas atļauja jāatjauno ik pēc 180 dienām.</div>
  </div>`;
}

async function bankPicker() {
  if (PREVIEW) return toast('Priekšskatījumā bankas nav pieejamas');
  openModal(`<div class="row" style="gap:14px"><span class="spinner"></span><b>Ielādē banku sarakstu…</b></div>`);
  let banks;
  try { banks = (await call('bankBanks', { country: 'LV' })).result; } catch (e) { closeModal(); return toast(e.message); }
  const top = n => (/swedbank/i.test(n) ? 0 : /revolut/i.test(n) ? 1 : 2);
  banks.sort((a, b) => top(a.name) - top(b.name) || a.name.localeCompare(b.name));
  const list = q => banks.filter(b => b.name.toLowerCase().includes(q.toLowerCase())).map(b =>
    `<button class="bank-pick" data-bankpick="${esc(b.name)}" data-country="${esc(b.country)}" data-days="${b.days}">
      ${b.logo ? `<img src="${esc(b.logo)}" alt="">` : '<span class="emoji">🏦</span>'}<span>${esc(b.name)}</span></button>`).join('') || '<div class="sub">Nav atrasts</div>';
  openModal(`<h2>Pieslēgt banku</h2>
    <input type="text" id="bankQ" class="input" placeholder="Meklēt banku…" style="width:100%">
    <div class="bank-list" id="bankList">${list('')}</div>
    <div class="sub">Atvērsies bankas lapa, kur apstiprināsi piekļuvi ar Smart-ID vai bankas lietotni. Programma redz tikai darījumus un atlikumu, maksājumus veikt nevar.</div>
    <div class="actions"><button class="btn" data-close>Atcelt</button></div>`);
  $('#bankQ').oninput = e => ($('#bankList').innerHTML = list(e.target.value));
}

async function bankConnect(name, country, days) {
  if (PREVIEW) return toast('Priekšskatījumā bankas nav pieejamas');
  const isMac = !!window.finanses;
  try {
    const back = isMac ? '' : location.origin + location.pathname + '#settings';
    const { result } = await call('bankConnect', { name, country, days, back });
    closeModal();
    if (isMac) { window.open(result.url, '_blank'); ui.bankWait = true; toast('Apstiprini piekļuvi bankas lapā pārlūkā'); }
    else location.href = result.url;
  } catch (e) { closeModal(); toast(e.message); }
}

// auto: on app start / window focus; the server skips banks synced in the last few hours.
async function bankSync(auto) {
  if (PREVIEW) { if (!auto) toast('Priekšskatījumā bankas nav pieejamas'); return; }
  try {
    const { result } = await call('bankSync', { auto });
    BANK = result.bank;
    if (result.synced.length) ui.bankWait = false;
    render();
    const soon = BANK.connections.find(c => daysTo(c.validUntil) <= 7);
    if (result.added) toast(`Ielādēti ${result.added} jauni darījumi no bankas`);
    else if (result.errors.length) toast(result.errors[0]);
    else if (soon) toast(`${soon.bank} atļauja beigsies pēc ${Math.max(0, daysTo(soon.validUntil))} d. Atjauno to Iestatījumos.`);
    else if (!auto) toast('Jaunu darījumu nav');
  } catch (e) { if (!auto) toast(e.message); }
}
window.addEventListener('focus', () => { if (ui.bankWait && S) bankSync(true); });

// ---------- Settings ----------
let INFO = null;
let OLD = null;
if (window.finanses?.oldData && !PREVIEW) window.finanses.oldData().then(d => { OLD = d; if (S && ui.view === 'settings') render(); });
function settings() {
  if (!INFO && !PREVIEW) call('info').then(r => { INFO = r.result; BANK = BANK || INFO.bank; if (ui.view === 'settings') render(); }).catch(() => {});
  const info = INFO || {};
  const bank = PREVIEW ? window.MockAPI.bank : BANK || info.bank;
  const isMac = !!window.finanses;
  const webUrl = window.FIN_CONFIG?.webUrl;
  return `
  <div class="head"><h1>Iestatījumi</h1></div>
  ${OLD ? `<div class="card">
    <h2>Pārnest datus no vecās versijas</h2>
    <div class="sub">Šajā Mac datorā ir dati no iepriekšējās programmas versijas: ${OLD.transactions?.length || 0} darījumi, ${Object.keys(OLD.savings?.snapshots || {}).length} uzkrājumu mēneši, ${OLD.categories?.length || 0} kategorijas. Pārnes tos uz Google Sheets vienreiz.</div>
    <div class="actions" style="justify-content:flex-start"><button class="btn primary" data-act="migrate">Pārnest uz Google Sheets</button></div>
  </div>` : ''}
  <div class="card">
    <h2>Dati</h2>
    <div class="sub">Visi dati (darījumi, budžets, uzkrājumi) glabājas tavā Google Sheets tabulā kontā toms.teo.t@gmail.com. Tabulā ir arī lasāmi pārskati “Uzkrājumi pārskats” un “Mēneši”.</div>
    <div class="actions" style="justify-content:flex-start">${info.sheetUrl ? `<a class="btn" href="${esc(info.sheetUrl)}" target="_blank">Atvērt tabulu ↗</a>` : '<span class="sub">Ielādē…</span>'}</div>
  </div>
  ${bankCard(bank)}
  <div class="card">
    <h2>Izrakstu lasīšana ar Claude</h2>
    <div class="sub">${isMac ? 'Šajā Mac programmā izrakstus un ekrānuzņēmumus lasa tavs Claude Code (bez papildu maksas).' : 'Telefonā un pārlūkā izrakstus lasa Claude caur API atslēgu.'}
      ${info.claudeKey === false ? ' Claude API atslēga Google pusē vēl nav pievienota, tāpēc telefonā imports darbojas tikai XML failiem.' : info.claudeKey ? ' Claude API atslēga ir pievienota.' : ''}</div>
  </div>
  ${webUrl ? `<div class="card">
    <h2>Lietot telefonā</h2>
    <div class="sub">Atver <a href="${esc(webUrl)}" target="_blank">${esc(webUrl)}</a> telefonā, ienāc ar PIN un Safari izvēlnē izvēlies <b>Kopīgot → Pievienot sākuma ekrānam</b>.</div>
  </div>` : ''}
  <div class="card">
    <h2>Drošība</h2>
    <form class="row" id="pinForm" style="flex-wrap:wrap;gap:10px">
      <input type="password" id="oldPin" inputmode="numeric" placeholder="Pašreizējais PIN" style="width:170px">
      <input type="password" id="newPin" inputmode="numeric" placeholder="Jaunais PIN" style="width:170px">
      <button class="btn">Mainīt PIN</button>
      <span class="spacer"></span>
      <button type="button" class="btn danger" data-act="logout">Iziet</button>
    </form>
    <div class="sub" style="margin-top:8px">Mainot PIN, visas ierīces tiek izrakstītas.</div>
  </div>`;
}

// ---------- Events ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act],[data-go],[data-tx],[data-close],[data-del],[data-delcat],[data-delpos],[data-emoji],[data-bankpick],[data-bankrenew],[data-bankdel]');
  if (!el) return;
  if (el.dataset.go) return go(el.dataset.go);
  if (el.dataset.tx) return txForm(S.transactions.find(t => t.id === el.dataset.tx));
  if (el.hasAttribute('data-close')) return closeModal();
  if (el.dataset.del) { closeModal(); return mutate('DELETE', `/api/transactions/${el.dataset.del}`, null, 'Darījums dzēsts'); }
  if (el.dataset.emoji) return emojiPicker(el.dataset.emoji);
  if (el.dataset.bankpick) return bankConnect(el.dataset.bankpick, el.dataset.country, +el.dataset.days);
  if (el.dataset.bankrenew) return bankConnect(el.dataset.bankrenew, el.dataset.country);
  if (el.dataset.bankdel) {
    if (PREVIEW) return toast('Priekšskatījumā bankas nav pieejamas');
    if (!confirmInline(el)) return;
    try { BANK = (await call('bankRemove', { id: el.dataset.bankdel })).result; render(); toast('Banka atvienota'); } catch (err) { toast(err.message); }
    return;
  }
  if (el.dataset.delcat) {
    const c = cat(el.dataset.delcat);
    if (!confirmInline(el)) return;
    return saveBudget({ categories: collectCats().filter(x => x.id !== c.id) });
  }
  if (el.dataset.delpos) {
    if (!confirmInline(el)) return;
    return mutate('PUT', '/api/savings/positions', { positions: collectPositions().filter(p => p.id !== el.dataset.delpos) }, 'Pozīcija dzēsta');
  }
  switch (el.dataset.act) {
    case 'prevMonth': ui.month = shiftMonth(ui.month, -1); return render();
    case 'nextMonth': ui.month = shiftMonth(ui.month, 1); return render();
    case 'txMonth': ui.txMonth = el.dataset.v; return render();
    case 'addTx': return txForm({ type: 'expense', categoryId: S.categories[0]?.id });
    case 'addCash': return txForm({ type: 'expense', categoryId: S.categories[0]?.id, source: CASH });
    case 'addCat': return saveBudget({ categories: [...collectCats(), { name: 'Jauna kategorija', icon: '🏷️', color: '#8E8E93', limit: 0 }] });
    case 'addPos': return mutate('PUT', '/api/savings/positions', { positions: [...collectPositions(), { name: 'Jauna pozīcija', assetType: S.savings.assetTypes[0], place: '' }] });
    case 'copyPrev': {
      const prev = S.savings.snapshots[prevSnapMonth(ui.month)] || {};
      return mutate('PUT', '/api/savings/snapshot', { month: ui.month, values: { ...prev, ...(S.savings.snapshots[ui.month] || {}) } }, 'Vērtības nokopētas, atjauno tās, kas mainījās');
    }
    case 'migrate': {
      el.disabled = true; el.innerHTML = '<span class="spinner"></span>';
      try {
        const r = (await call('migrate', { state: OLD })).result; // refuses if the sheet already has data
        await window.finanses.oldDataDone(); OLD = null;
        toast(`Pārnesti ${r.transactions} darījumi un ${r.months} uzkrājumu mēneši`);
        render();
      } catch (err) { toast(err.message); render(); }
      return;
    }
    case 'bankAdd': return bankPicker();
    case 'bankSync': return bankSync(false);
    case 'copyRedirect': navigator.clipboard.writeText(EXEC_URL); return toast('Adrese nokopēta');
    case 'logout':
      try { await call('logout'); } catch (err) {}
      localStorage.removeItem(TOKEN_KEY); S = null; $('#view').innerHTML = '';
      return showLogin();
  }
});

// Two-step delete without browser dialogs: first click arms, second click confirms.
function confirmInline(el) {
  if (el.dataset.armed) return true;
  el.dataset.armed = '1'; el.textContent = 'Dzēst?'; el.style.color = 'var(--red)'; el.style.fontSize = '12px';
  setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = '×'; el.style = ''; } }, 2500);
  return false;
}

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'fileIn') return importFiles([...t.files]);
  if (t.id === 'ebKey') { $('#ebKeyName').textContent = t.files[0]?.name || 'Izvēlēties .pem…'; return; }
  if (t.id === 'filterCat') { ui.filterCat = t.value; return render(); }
  if (t.closest('#catTable') || t.id === 'totalLimit') return saveBudget();
  if (t.closest('#posTable')) {
    if (t.classList.contains('pv')) return mutate('PUT', '/api/savings/snapshot', { month: ui.month, values: collectValues() });
    return mutate('PUT', '/api/savings/positions', { positions: collectPositions() });
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'search') {
    ui.search = e.target.value;
    const pos = e.target.selectionStart; render();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});

document.addEventListener('submit', async e => {
  if (e.target.id === 'bankSetup') {
    e.preventDefault();
    if (PREVIEW) return toast('Priekšskatījumā bankas nav pieejamas');
    const file = $('#ebKey').files[0];
    if (!file) return toast('Izvēlies lejupielādēto .pem failu');
    try {
      BANK = (await call('bankSetup', { appId: $('#ebApp').value, key: await file.text(), redirect: EXEC_URL })).result;
      render(); toast('Enable Banking pieslēgts. Tagad pieslēdz banku.');
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id !== 'pinForm') return;
  e.preventDefault();
  try {
    await call('changePin', { oldPin: $('#oldPin').value, newPin: $('#newPin').value });
    localStorage.removeItem(TOKEN_KEY);
    toast('PIN nomainīts, ienāc ar jauno PIN');
    showLogin();
  } catch (err) { toast(err.message); }
});

// Start: preview uses sample data; otherwise sign in first if this device has no session.
if (PREVIEW || localStorage.getItem(TOKEN_KEY)) {
  refresh().then(() => bankSync(true)).catch(e => { if (!$('#login').hidden) return; $('#view').innerHTML = `<div class="empty"><b>Neizdevās ielādēt</b>${esc(e.message)}</div>`; });
} else showLogin();
