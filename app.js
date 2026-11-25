// Finanses UI (vanilla JS). Data comes from the Google Apps Script backend (config.js execUrl);
// in preview mode (?preview or file:) from mock.js sample data.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null; // server state
const ui = {
  view: location.hash.slice(1) || 'overview',
  month: new Date().toISOString().slice(0, 7),
  search: '', filterCat: '', filterAcc: '', txMonth: 'month', txType: '',
};

// ---------- API ----------
// In the Mac app the page is loaded with ?app=1 (native title bar area + vibrancy).
if (new URLSearchParams(location.search).has('app')) document.documentElement.classList.add('is-app');
// Light / dark / auto (system), kept per device.
const THEME_KEY = 'finanses-theme';
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  // Browser bar colour: fixed for an explicit choice, else the system-dependent pair from index.html.
  const [base, darkMeta] = document.querySelectorAll('meta[name="theme-color"]');
  base.content = t === 'dark' ? '#000000' : '#F5F5F7';
  darkMeta.media = t ? 'not all' : '(prefers-color-scheme: dark) and (min-width: 861px)';
  window.finanses?.setTheme?.(t || 'system');
}
applyTheme(localStorage.getItem(THEME_KEY) || '');
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
  ['POST', /^\/api\/voice$/, 'voice'],
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
    // While optimistic changes are still being saved, the local state is newer than the server's.
    if (data.state && !saving) S = data.state;
    return data;
  } finally { setBusy(false); }
}

async function refresh() { S = await api('GET', '/api/state'); render(); }
// Changes show at once (applied locally), then are saved to Google Sheets in the background, one at a time.
// When the last save finishes, the server's state replaces the local one (re-rendered only if it differs).
let saving = 0, saveQueue = Promise.resolve(), saveFailed = false, deferredRender = false;
async function mutate(method, url, body, msg) {
  if (PREVIEW) {
    try { await api(method, url, body); S = window.MockAPI.handle('GET', '/api/state'); render(); if (msg) toast(msg); } catch (e) { toast(e.message); }
    return;
  }
  let local = null;
  try { local = applyLocal(structuredClone(S), method, url, body); } catch (e) { return toast(e.message); }
  if (!local) { // no local version of this change: wait for the server
    try { await api(method, url, body); render(); if (msg) toast(msg); } catch (e) { toast(e.message); }
    return;
  }
  // Render on the next tick, after focus has moved to the field the user tapped or tabbed to.
  S = local; setTimeout(render, 0); if (msg) toast(msg);
  saving++;
  saveQueue = saveQueue.then(async () => {
    let server = null;
    try { server = (await callFor(method, url, body)).state; }
    catch (e) { saveFailed = true; toast('Neizdevās saglabāt: ' + e.message); }
    if (--saving) return;
    if (saveFailed) { saveFailed = false; server = (await call('state').catch(() => null))?.result; }
    if (server && stateKey(server) !== stateKey(S)) {
      S = server;
      // Don't re-render under the user's fingers; wait until they leave the field.
      if (document.activeElement?.closest('#view') && document.activeElement.matches('input, select')) deferredRender = true; else render();
    }
  });
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (deferredRender && !document.activeElement?.matches('#view input, #view select')) { deferredRender = false; render(); }
}, 0));

async function callFor(method, url, body) {
  for (const [m, re, fn] of ROUTES) {
    const hit = m === method && url.match(re);
    if (hit) return call(fn, hit[1] ? { ...(body || {}), id: decodeURIComponent(hit[1]) } : body || {});
  }
  throw new Error('Nezināma darbība');
}
// Comparable form of the state: what is shown on screen, independent of key order.
const stableStr = v => (v && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(stableStr).join(',') + ']'
  : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}') : JSON.stringify(v ?? null));
const stateKey = s => stableStr([s.settings, s.categories, s.savings, [...s.transactions].sort((a, b) => (a.id < b.id ? -1 : 1))
  .map(t => [t.id, t.date, t.description, t.amount, t.type, t.categoryId || null, t.source || ''])]);

// Local copy of the server's changes (apps-script/Api.gs), so the screen updates without waiting.
// Gives new items their id here; the server keeps it. Returns null for changes it can't mirror.
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const newId = () => Math.random().toString(36).slice(2, 10);
function applyLocal(st, method, url, b = {}) {
  const [, , res, rawId] = url.split('/');
  const id = rawId && decodeURIComponent(rawId);
  const cleanTx = t => {
    const type = t.type === 'income' || t.type === 'transfer' ? t.type : 'expense';
    return { ...t, date: String(t.date || '').slice(0, 10), description: String(t.description || '').trim().slice(0, 200) || 'Darījums',
      amount: Math.abs(round2(t.amount)), type, categoryId: type === 'expense' ? t.categoryId || null : null,
      source: t.source || 'manuāli', note: t.note || '' };
  };
  switch (method + ' ' + res + (res === 'savings' ? '/' + id : '')) {
    case 'POST transactions':
      (Array.isArray(b.transactions) ? b.transactions : [b]).forEach(t => { t.id = newId(); st.transactions.push(cleanTx(t)); });
      return st;
    case 'PUT transactions': {
      const tx = st.transactions.find(t => t.id === id);
      if (!tx) throw new Error('Darījums nav atrasts');
      Object.assign(tx, cleanTx({ ...tx, ...b, id }));
      return st;
    }
    case 'DELETE transactions':
      st.transactions = st.transactions.filter(t => t.id !== id);
      return st;
    case 'PUT budget':
      if (b.totalLimit != null) st.settings.totalLimit = Math.max(0, round2(b.totalLimit));
      if (Array.isArray(b.categories)) {
        if (!b.categories.length && st.categories.length > 1) throw new Error('Nevar izdzēst visas kategorijas');
        st.categories = b.categories.map(c => ({
          id: c.id || (c.id = newId()), name: String(c.name || 'Kategorija').slice(0, 60), icon: String(c.icon || '🏷️').slice(0, 16),
          color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#8E8E93', limit: Math.max(0, round2(c.limit)),
        }));
        const ids = new Set(st.categories.map(c => c.id));
        const other = st.categories.find(c => c.name === 'Citi') || st.categories[0];
        st.transactions.forEach(t => { if (t.categoryId && !ids.has(t.categoryId)) t.categoryId = other ? other.id : null; });
      }
      return st;
    case 'PUT savings/positions':
      st.savings.positions = (b.positions || []).map(p => ({ id: p.id || (p.id = newId()), name: String(p.name || 'Pozīcija').slice(0, 80),
        assetType: String(p.assetType || 'Cits').slice(0, 40), place: String(p.place || '').slice(0, 80) }));
      if (Array.isArray(b.assetTypes)) st.savings.assetTypes = b.assetTypes.map(String).filter(Boolean);
      return st;
    case 'PUT savings/snapshot': {
      const values = {};
      Object.entries(b.values || {}).forEach(([k, v]) => { if (v !== '' && v != null && !isNaN(v)) values[k] = round2(v); });
      if (Object.keys(values).length) {
        st.savings.snapshots[b.month] = values;
        const today = new Date().toISOString().slice(0, 10);
        st.savings.snapshotDates[b.month] ||= today.startsWith(b.month) ? today : b.month + '-01';
      } else { delete st.savings.snapshots[b.month]; delete st.savings.snapshotDates[b.month]; }
      return st;
    }
  }
  return null;
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
// Transfers between own accounts (type 'transfer') count as neither income nor spending.
const monthTx = m => S.transactions.filter(t => t.date.startsWith(m));
function spending(m) {
  const txs = monthTx(m).filter(t => t.type === 'expense');
  const byCat = {};
  txs.forEach(t => (byCat[t.categoryId] = (byCat[t.categoryId] || 0) + t.amount));
  return { total: sum(txs.map(t => t.amount)), byCat, income: sum(monthTx(m).filter(t => t.type === 'income').map(t => t.amount)) };
}
const snapTotal = m => (S.savings.snapshots[m] ? sum(Object.values(S.savings.snapshots[m])) : null);
const prevSnapMonth = m => Object.keys(S.savings.snapshots).filter(k => k < m).sort().pop();

// ---------- Router ----------
function go(view) { closeMenu(); ui.view = view; location.hash = view; render(); window.scrollTo(0, 0); }

// Phone menu: the sidebar slides in from the left.
const openMenu = () => { document.body.classList.add('menu-open'); $('#menuBtn').setAttribute('aria-expanded', 'true'); };
function closeMenu() { document.body.classList.remove('menu-open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); }
$('#menuBtn').addEventListener('click', openMenu);
$('#scrim').addEventListener('click', closeMenu);
let swipeX = null;
$('.sidebar').addEventListener('touchstart', e => (swipeX = e.touches[0].clientX), { passive: true });
$('.sidebar').addEventListener('touchend', e => { if (swipeX != null && e.changedTouches[0].clientX - swipeX < -50) closeMenu(); swipeX = null; });
const VIEW_TITLES = { overview: 'Pārskats', transactions: 'Darījumi', budget: 'Budžets', savings: 'Uzkrājumi', settings: 'Iestatījumi' };
$('#nav').addEventListener('click', e => { const a = e.target.closest('a'); if (a) go(a.dataset.view); });
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v && v !== ui.view) { ui.view = v; render(); } });

function render() {
  if (!S) return;
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === ui.view));
  const views = { overview, transactions, budget, savings, settings };
  const focus = focusKey();
  $('#view').innerHTML = (views[ui.view] || overview)();
  restoreFocus(focus);
  $('#topTitle').textContent = VIEW_TITLES[ui.view] || VIEW_TITLES.overview;
  $('#topAct').innerHTML = ['overview', 'transactions'].includes(ui.view) || !VIEW_TITLES[ui.view]
    ? '<button class="top-add" data-act="voice" aria-label="Pateikt ar balsi"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button><button class="top-add" data-act="addTx" aria-label="Pievienot darījumu">+</button>' : '';
  renderSync();
}

// Keep the field the user moved to (tap or Tab) focused across a re-render.
function focusKey() {
  const a = document.activeElement;
  if (!a || !a.closest('#view') || !a.matches('input, select, button')) return null;
  return { id: a.id, row: a.closest('[data-id]')?.dataset.id, cls: a.classList[0], pos: a.selectionStart ?? null };
}
function restoreFocus(k) {
  if (!k) return;
  const el = k.id ? document.getElementById(k.id) : k.row && k.cls ? $(`#view [data-id="${CSS.escape(k.row)}"] .${CSS.escape(k.cls)}`) : null;
  if (!el) return;
  el.focus({ preventScroll: true });
  try { if (k.pos != null) el.setSelectionRange(k.pos, k.pos); } catch (e) {}
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
          <div class="link" data-act="showType" data-v="expense"><span class="stat-label">Iztērēts ›</span><span class="big num">${money(sp.total)}</span><span class="sub">no ${money(limit, { whole: true })} limita</span></div>
          <div><span class="stat-label">${left >= 0 ? 'Vēl atlicis' : 'Pārtērēts'}</span><span class="stat-value num ${left >= 0 ? 'pos' : 'neg'}">${money(Math.abs(left))}</span>
            ${isCur && left > 0 ? `<span class="sub">≈ ${money(left / daysLeft)} dienā vēl ${daysLeft} d.</span>` : ''}</div>
        </div>
      </div>
    </div>
    <div class="grid" style="grid-template-rows:1fr 1fr">
      <div class="card grid g2" style="margin:0">
        <div class="link" data-act="showType" data-v="income"><span class="stat-label">Ienākumi ›</span><div class="stat-value num pos">${money(sp.income)}</div></div>
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
    <div class="cat-name">${emo(c)}<span>${esc(c.name)}</span></div>
    <div class="num"><b>${money(c.spent)}</b> <span class="sub">/ ${money(c.limit, { whole: true })}</span></div>
    <div class="bar"><i style="width:${Math.min(p, 100)}%;background:${p > 100 ? 'var(--red)' : c.color}"></i></div>
    <div class="sub num">${p}%</div>
    <div class="cat-meta num ${left < 0 ? 'neg' : ''}">${left >= 0 ? `atlicis ${money(left)}` : `pārsniegts par ${money(-left)}`}</div>
  </div>`;
}

// Emoji tile on a soft tint of the category color.
const emo = (c, size = '') => `<span class="emoji ${size}" style="background:color-mix(in srgb, ${c.color} 16%, transparent)">${esc(c.icon || '🏷️')}</span>`;

const TRANSFER = { icon: '🔁', color: '#8E8E93' };
// Where a transaction came from: bank account, cash or typed in by hand.
const accLabel = s => (s === CASH ? '💶 Skaidra nauda' : !s || s === 'manuāli' ? 'Ievadīts ar roku' : s);

function txRow(t) {
  const c = cat(t.categoryId);
  const icon = t.type === 'income' ? emo({ icon: '💰', color: '#34C759' }, 'lg') : t.type === 'transfer' ? emo(TRANSFER, 'lg') : emo(c || { icon: '🏷️', color: '#8E8E93' }, 'lg');
  const what = t.type === 'income' ? 'Ienākumi' : t.type === 'transfer' ? 'Starp saviem kontiem' : esc(c?.name || 'Bez kategorijas');
  const sign = t.type === 'income' ? '+' : t.type === 'transfer' ? '' : '−';
  return `<div class="tx ${t.type === 'transfer' ? 'transfer' : ''}" data-tx="${t.id}">
    ${icon}
    <div class="desc"><b>${esc(t.description)}</b><small>${what} · ${new Date(t.date).toLocaleDateString('lv-LV', { day: 'numeric', month: 'short' })}${t.source && t.source !== 'manuāli' ? ' · ' + esc(accLabel(t.source)) : ''}</small></div>
    <div class="amt num ${t.type === 'income' ? 'pos' : ''}">${sign}${money(t.amount)}</div>
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
  if (ui.filterAcc) list = list.filter(t => (t.source || 'manuāli') === ui.filterAcc);
  // Tabs: all / expenses / income / transfers, each with its total for the current filters.
  const byType = k => list.filter(t => t.type === k);
  const tabs = [['', 'Visi', `${list.length}`], ['expense', 'Izdevumi', '−' + money(sum(byType('expense').map(t => t.amount)), { whole: true })],
    ['income', 'Ienākumi', '+' + money(sum(byType('income').map(t => t.amount)), { whole: true })]];
  if (byType('transfer').length || ui.txType === 'transfer') tabs.push(['transfer', 'Starp kontiem', money(sum(byType('transfer').map(t => t.amount)), { whole: true })]);
  if (ui.txType) list = byType(ui.txType);
  const catFilter = !ui.txType || ui.txType === 'expense';
  if (ui.filterCat && catFilter) list = list.filter(t => t.categoryId === ui.filterCat);
  const accounts = [...new Set(S.transactions.map(t => t.source || 'manuāli'))].sort((a, b) => accLabel(a).localeCompare(accLabel(b)));
  list.sort((a, b) => b.date.localeCompare(a.date));
  const groups = {};
  list.forEach(t => (groups[t.date] = groups[t.date] || []).push(t));
  const exp = sum(list.filter(t => t.type === 'expense').map(t => t.amount));
  const inc = sum(list.filter(t => t.type === 'income').map(t => t.amount));
  const moved = list.filter(t => t.type === 'transfer');
  const cash = list.filter(t => t.source === CASH);
  const cashNet = sum(cash.map(t => (t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount : 0)));

  return `
  <div class="head"><h1>Darījumi</h1>
    <div class="row">${ui.txMonth === 'month' ? monthSwitch() : ''}<button class="btn" data-act="voice">🎤 Pateikt</button><button class="btn" data-act="addCash">💶 Skaidra nauda</button><button class="btn primary" data-act="addTx">+ Pievienot</button></div></div>
  <label class="dropzone" id="dz">
    <div class="ico">⤓</div>
    <div><b>Importēt izrakstu</b><div class="sub">Ievelc vai izvēlies XML (FiDAViSta, ISO 20022), PDF, CSV vai ekrānuzņēmumu. Var arī ielīmēt ar ⌘V. Claude sašķiros pa kategorijām.</div></div>
    <input type="file" id="fileIn" multiple accept=".xml,.pdf,.csv,.txt,image/*" hidden>
  </label>
  <div class="type-tabs" role="tablist">${tabs.map(([k, label, total]) => `<button role="tab" data-act="txType" data-v="${k}" aria-selected="${ui.txType === k}"
    class="${ui.txType === k ? 'on' : ''} ${k}"><span>${label}</span><b class="num">${total}</b></button>`).join('')}</div>
  <div class="card">
    <div class="toolbar">
      <input type="text" id="search" placeholder="Meklēt…" value="${esc(ui.search)}">
      ${catFilter ? `<select id="filterCat"><option value="">Visas kategorijas</option>
        ${S.categories.map(c => `<option value="${c.id}" ${ui.filterCat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
      <select id="filterAcc"><option value="">Visi konti</option>${accounts.map(a => `<option value="${esc(a)}" ${ui.filterAcc === a ? 'selected' : ''}>${esc(accLabel(a))}</option>`).join('')}</select>
      <div class="seg"><button data-act="txMonth" data-v="month" class="${ui.txMonth === 'month' ? 'on' : ''}">Mēnesis</button><button data-act="txMonth" data-v="all" class="${ui.txMonth === 'all' ? 'on' : ''}">Visi</button></div>
    </div>
    <div class="sub">${list.length} darījumi · izdevumi ${money(exp)}${inc ? ` · ienākumi ${money(inc)}` : ''}${cash.length ? ` · skaidrā naudā ${signed(cashNet)}` : ''}${moved.length ? ` · ${moved.length} pārskaitījumi starp kontiem netiek skaitīti` : ''}</div>
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closeMenu(); } });

function txForm(t) {
  const isNew = !t.id;
  // Payment method only for hand-entered transactions; bank and statement ones keep their source.
  const manual = isNew || !t.source || t.source === 'manuāli' || t.source === CASH;
  let source = t.source === CASH ? CASH : 'manuāli';
  const party = isNew ? '' : partyOf(t.description);
  openModal(`<h2>${isNew ? (source === CASH ? 'Skaidra nauda' : 'Jauns darījums') : 'Labot darījumu'}</h2>
  <form class="form" id="txForm">
    <div class="row" style="flex-wrap:wrap;gap:10px">
      <div class="seg"><button type="button" data-type="expense" class="${t.type === 'expense' || !t.type ? 'on' : ''}">Izdevumi</button><button type="button" data-type="income" class="${t.type === 'income' ? 'on' : ''}">Ienākumi</button><button type="button" data-type="transfer" class="${t.type === 'transfer' ? 'on' : ''}">🔁 Starp kontiem</button></div>
      ${manual ? `<div class="seg"><button type="button" data-src="manuāli" class="${source !== CASH ? 'on' : ''}">Karte / konts</button><button type="button" data-src="${CASH}" class="${source === CASH ? 'on' : ''}">💶 Skaidrā naudā</button></div>` : ''}
    </div>
    <label class="field">Apraksts<input type="text" name="description" value="${esc(t.description || '')}" placeholder="${t.type === 'income' ? 'piem. Pārdots velosipēds' : 'piem. Tirgus'}" required></label>
    <div class="grid g2"><label class="field">Summa (€)<input type="number" name="amount" step="0.01" min="0" value="${t.amount ?? ''}" required></label>
    <label class="field">Datums<input type="date" name="date" value="${t.date || defaultDate()}" required></label></div>
    <label class="field" id="catField" ${t.type && t.type !== 'expense' ? 'hidden' : ''}>Kategorija<select name="categoryId">${catOptions(t.categoryId)}</select></label>
    ${manual ? '' : `<div class="sub">Konts: <b>${esc(accLabel(t.source))}</b></div>`}
    ${party && !ownName(party) ? `<label class="check" id="ownField" ${t.type === 'transfer' ? '' : 'hidden'}><input type="checkbox" id="ownChk" checked> Vienmēr uzskatīt “${esc(party)}” par manu kontu</label>` : ''}
    <div class="sub" id="transferHint" ${t.type === 'transfer' ? '' : 'hidden'}>Pārskaitījumi starp saviem kontiem netiek skaitīti ne pie ienākumiem, ne izdevumiem.</div>
    <div class="actions">${isNew ? '' : `<button type="button" class="btn danger" data-del="${t.id}">Dzēst</button>`}<span class="spacer"></span>
      <button type="button" class="btn" data-close>Atcelt</button><button class="btn primary">Saglabāt</button></div>
  </form>`);
  let type = t.type || 'expense';
  const f = $('#txForm');
  $$('[data-type]', f).forEach(b => b.onclick = () => {
    type = b.dataset.type; $$('[data-type]', f).forEach(x => x.classList.toggle('on', x === b));
    $('#catField').hidden = type !== 'expense'; $('#transferHint').hidden = type !== 'transfer';
    if ($('#ownField')) $('#ownField').hidden = type !== 'transfer';
  });
  $$('[data-src]', f).forEach(b => b.onclick = () => { source = b.dataset.src; $$('[data-src]', f).forEach(x => x.classList.toggle('on', x === b)); });
  f.onsubmit = async e => {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(f)), type, ...(manual ? { source } : {}) };
    closeModal();
    ui.month = body.date.slice(0, 7); // show the month the transaction went into
    const learnOwn = type === 'transfer' && $('#ownChk')?.checked;
    if (isNew) await mutate('POST', '/api/transactions', body, 'Darījums pievienots');
    else await mutate('PUT', `/api/transactions/${t.id}`, body, 'Saglabāts');
    if (learnOwn) await mutate('PUT', '/api/settings', { ownNames: [...(S.settings.ownNames || []), party] }, `Visi “${party}” darījumi ir pārskaitījumi`);
  };
}

// Payee part of a bank description ("TOMS TEO · Izmaksa" -> "TOMS TEO").
const partyOf = d => String(d || '').split(' · ')[0].trim().slice(0, 60);
const ownName = p => (S.settings.ownNames || []).some(n => p.toLowerCase().startsWith(n.toLowerCase()));

function ownNamesCard() {
  return `<div class="card">
    <h2>Mani konti</h2>
    <div class="sub">Pārskaitījumi uz šiem vārdiem vai no tiem ir naudas pārvietošana starp taviem kontiem – tie netiek skaitīti ne pie ienākumiem, ne izdevumiem. Viens vārds rindā, tā kā tas redzams bankā.</div>
    <form class="form" id="ownForm" style="margin-top:12px">
      <textarea id="ownNames" rows="3" placeholder="VĀRDS UZVĀRDS">${esc((S.settings.ownNames || []).join('\n'))}</textarea>
      <div class="actions" style="justify-content:flex-start"><button class="btn">Saglabāt</button></div>
    </form>
  </div>`;
}

// ---------- Voice ----------
// Say the transactions in Latvian; Claude turns the text into rows for the same review screen as an import.
// Mac app: local Whisper phrase by phrase (livevoice.js); browser/phone: the browser's speech recognition.
let voiceRec = null; // running recogniser: { stop() → Promise }
const BrowserSpeech = window.SpeechRecognition || window.webkitSpeechRecognition;

async function voiceForm() {
  const mac = !!(window.finanses?.transcribe && window.LiveVoice) && (await window.finanses.voiceAvailable?.().catch(() => false));
  const canListen = mac || !!BrowserSpeech;
  openModal(`<h2>Pasaki, ko pievienot</h2>
    <div class="sub">Piemēram: “Vakar Rimi divdesmit trīs eiro, šodien kafija trīs eiro skaidrā naudā.” Vari nosaukt arī kontu, piem. “ar Revolut”.</div>
    <div class="voice">
      ${canListen ? `<button type="button" class="mic" id="micBtn" aria-label="Sākt vai beigt klausīšanos"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
        <div class="sub" id="micState">Nospied un runā</div>` : `<div class="sub">Šajā pārlūkā balss atpazīšanas nav – izmanto tastatūras diktēšanas pogu 🎤 vai ieraksti tekstu.</div>`}
    </div>
    <textarea id="voiceText" rows="4" placeholder="Te parādīsies teksts – vari to arī labot vai ierakstīt pats"></textarea>
    <div class="actions"><button class="btn" data-close>Atcelt</button><button class="btn primary" id="voiceGo">Pievienot</button></div>`);
  const box = $('#voiceText');
  const add = t => { box.value = (box.value.trim() + ' ' + t.trim()).trim(); };
  const setState = (on, msg) => {
    $('#micBtn')?.classList.toggle('on', on);
    if ($('#micState')) $('#micState').textContent = msg || (on ? 'Klausos… nospied vēlreiz, lai beigtu' : 'Nospied un runā');
  };
  const start = async () => {
    try {
      if (mac) {
        if (window.finanses.micAccess && !(await window.finanses.micAccess())) throw new Error('Atļauj mikrofonu: Sistēmas iestatījumi → Privātums → Mikrofons');
        voiceRec = await window.LiveVoice.start({
          transcribe: (wav, prev) => window.finanses.transcribe(wav, prev),
          onText: add, onError: m => toast(m),
        });
      } else {
        const rec = new BrowserSpeech();
        rec.lang = 'lv-LV'; rec.continuous = true; rec.interimResults = true;
        const base = box.value;
        let done = '';
        rec.onresult = e => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) done += ' ' + e.results[i][0].transcript; else interim += e.results[i][0].transcript;
          }
          box.value = (base + ' ' + done + ' ' + interim).replace(/\s+/g, ' ').trim();
        };
        let ended;
        const finished = new Promise(r => (ended = r));
        rec.onend = () => { ended(); if (voiceRec?.rec === rec) { voiceRec = null; setState(false); } };
        rec.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(e.error === 'not-allowed' ? 'Atļauj mikrofonu pārlūka iestatījumos' : 'Balss atpazīšana: ' + e.error); };
        rec.start();
        voiceRec = { rec, stop: () => { rec.stop(); return finished; } };
      }
      setState(true);
    } catch (e) { voiceRec = null; setState(false); toast(e.message); }
  };
  const stop = async () => {
    const r = voiceRec; voiceRec = null;
    if (!r) return;
    setState(false, 'Pabeidzu atpazīt…');
    await r.stop().catch(() => {});
    setState(false);
  };
  if ($('#micBtn')) {
    $('#micBtn').onclick = () => (voiceRec ? stop() : start());
    start(); // opened from a tap, so listening can begin right away
  }
  $('#voiceGo').onclick = async () => {
    await stop();
    const text = box.value.trim();
    if (!text) return toast('Pasaki vai ieraksti, ko pievienot');
    openModal(`<div class="row" style="gap:14px"><span class="spinner"></span><div><b>Saprotu teikto…</b><div class="sub">Claude izveido darījumus. Tas aizņem dažas sekundes.</div></div></div>`);
    try {
      const st = { categories: S.categories, rules: S.rules, transactions: S.transactions, settings: S.settings };
      const res = window.finanses?.voiceParse && !PREVIEW ? await window.finanses.voiceParse(text, st) : await api('POST', '/api/voice', { text });
      if (res.error) throw new Error(res.error);
      if (!res.transactions.length) throw new Error('Tekstā neatradu darījumus');
      reviewImport(res, 'Pārbaudi pirms pievienošanas');
    } catch (e) { closeModal(); toast(e.message); }
  };
}
// Closing the window stops listening.
new MutationObserver(() => { if ($('#modal').hidden && voiceRec) { const r = voiceRec; voiceRec = null; r.stop().catch(() => {}); } })
  .observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });

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
      ? await window.finanses.importLocal(payload, { categories: S.categories, rules: S.rules, transactions: S.transactions, settings: S.settings })
      : await api('POST', '/api/import', { files: payload });
    if (res.error) throw new Error(res.error);
    reviewImport(res);
  } catch (e) { closeModal(); toast(e.message); }
}

function reviewImport({ transactions: txs, warnings }, title = 'Pārbaudi importu') {
  if (!txs.length) { closeModal(); toast(warnings[0] || 'Darījumi netika atrasti'); return; }
  openModal(`<h2>${title}</h2>
    <div class="sub" style="margin-bottom:14px">Atrasti ${txs.length} darījumi. Vari mainīt kategorijas pirms saglabāšanas.${txs.some(t => t.duplicate) ? ' Iespējamie dublikāti ir atzīmēti pelēki un neatķeksēti.' : ''}</div>
    ${warnings.length ? `<div class="sub warn" style="margin-bottom:10px">${warnings.map(esc).join('<br>')}</div>` : ''}
    <table id="importTable"><thead><tr><th style="width:30px"><label class="all-chk"><input type="checkbox" id="allChk" checked><span>Atzīmēt visus</span></label></th><th>Datums</th><th>Apraksts</th><th>Kategorija</th><th class="r">Summa</th></tr></thead>
    <tbody>${txs.map((t, i) => `<tr class="${t.duplicate ? 'dup' : ''}" data-i="${i}">
      <td><input type="checkbox" class="chk" ${t.duplicate ? '' : 'checked'}></td>
      <td><input type="date" class="d" value="${t.date}"></td>
      <td><input type="text" class="ds" value="${esc(t.description)}"></td>
      <td>${t.type === 'income' ? '<span class="pos">Ienākumi</span>' : t.type === 'transfer' ? '<span class="sub">🔁 Starp kontiem</span>' : `<select class="c">${catOptions(t.categoryId)}</select>`}${t.source && t.source !== 'manuāli' && !/\.\w{2,4}$/.test(t.source) ? `<div class="sub">${esc(accLabel(t.source))}</div>` : ''}</td>
      <td class="r num ${t.type === 'income' ? 'pos' : ''}" style="white-space:nowrap">${t.type === 'income' ? '+' : t.type === 'transfer' ? '' : '−'}${money(t.amount)}</td></tr>`).join('')}</tbody></table>
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
  const pct = lim ? Math.round((sp.total / lim) * 100) : 0;
  const left = lim - sp.total;
  const over = S.categories.filter(c => c.limit && (sp.byCat[c.id] || 0) > c.limit).length;
  return `
  <div class="head"><h1>Budžets</h1>${monthSwitch()}</div>
  <div class="card budget-hero">
    <div class="bh-top">
      <div><span class="stat-label">Iztērēts ${monthName(ui.month).toLowerCase()}</span>
        <div class="big num">${money(sp.total)}</div>
        <div class="sub ${left < 0 ? 'neg' : ''}">${left >= 0 ? `vēl atlicis ${money(left, { whole: true })}` : `pārtērēts par ${money(-left, { whole: true })}`}</div></div>
      <label class="bh-limit"><span class="stat-label">Mēneša limits</span>
        <span class="money-in"><input type="number" id="totalLimit" class="bare num" min="0" step="10" value="${lim}" aria-label="Kopējais mēneša limits eiro"><i>€</i></span></label>
    </div>
    <div class="bh-bar"><i style="width:${Math.min(pct, 100)}%;background:${pctColor(pct)}"></i></div>
    <div class="bh-foot sub"><span class="num" style="color:${pctColor(pct)};font-weight:600">${pct}%</span>
      <span>Kategoriju limiti kopā <b class="num ${catSum > lim ? 'warn' : ''}">${money(catSum, { whole: true })}</b>${catSum > lim ? ` · par ${money(catSum - lim, { whole: true })} vairāk nekā kopējais limits` : ''}</span>
      ${over ? `<span class="pill neg">${over} pārsniegt${over === 1 ? 'a' : 'as'}</span>` : ''}</div>
  </div>
  <div class="card">
    <div class="row"><h2 style="margin:0">Kategorijas</h2><span class="spacer"></span><button class="btn" data-act="addCat">+ Kategorija</button></div>
    <div id="catTable">${S.categories.map(c => {
      const spent = sp.byCat[c.id] || 0, p = c.limit ? Math.round((spent / c.limit) * 100) : (spent ? 100 : 0), rest = c.limit - spent;
      return `<div class="cat-item ${!spent && !c.limit ? 'quiet' : ''}" data-id="${c.id}">
        <div class="cat-icon"><button class="emoji-btn" data-emoji="${c.id}" data-icon="${esc(c.icon || '🏷️')}" title="Mainīt emoji">${emo(c, 'lg')}</button>
          <label class="swatch" title="Krāsa" style="background:${c.color}"><input type="color" class="cc" value="${c.color}" aria-label="Krāsa"></label></div>
        <div class="cat-body">
          <div class="cat-line"><input type="text" class="cn bare" value="${esc(c.name)}" aria-label="Nosaukums">
            <span class="num cat-spent"><b>${money(spent, { whole: spent >= 100 })}</b></span></div>
          <div class="bar"><i style="width:${Math.min(p, 100)}%;background:${p > 100 ? 'var(--red)' : c.color}"></i></div>
          <div class="cat-line sub"><span class="${rest < 0 ? 'neg' : ''}">${!c.limit ? 'bez limita' : rest >= 0 ? `atlicis ${money(rest, { whole: true })}` : `pārsniegts par ${money(-rest, { whole: true })}`}</span>
            <span class="num" style="color:${pctColor(p)};font-weight:600">${p}%</span></div>
        </div>
        <label class="cat-limit"><span class="sub">Limits</span><span class="money-in"><input type="number" class="cl bare num" min="0" step="5" value="${c.limit}" aria-label="Limits eiro"><i>€</i></span></label>
        <button class="icon-btn cat-del" data-delcat="${c.id}" title="Dzēst" aria-label="Dzēst kategoriju">×</button>
      </div>`;
    }).join('')}</div>
    <div class="sub" style="margin-top:12px">Izmaiņas saglabājas automātiski. Uzklikšķini uz emoji vai krāsas punkta, lai tos mainītu. Dzēšot kategoriju, tās darījumi pāriet uz “Citi”.</div>
  </div>`;
}

function collectCats() {
  return $$('#catTable [data-id]').map(tr => ({ id: tr.dataset.id, icon: $('.emoji-btn', tr).dataset.icon, name: $('.cn', tr).value, color: $('.cc', tr).value, limit: $('.cl', tr).value }));
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

// Precious metals: "Dārgmetāli" position with grams in its name, valued by the server at today's price (Prices.gs).
const isMetal = p => p.assetType === 'Dārgmetāli' && /\d+(?:[.,]\d+)?\s*g\b/i.test(p.name);
let METAL = null; // { positionId: { grams, perGram, value, at } }
function loadMetal() {
  if (METAL || !S.savings.positions.some(isMetal)) return;
  if (PREVIEW) { METAL = { p5: { grams: 26, perGram: 103.17, value: 2682.42, at: new Date().toISOString() } }; return; }
  METAL = {};
  call('metalPrices').then(r => { METAL = r.result; if (ui.view === 'savings') render(); }).catch(() => { METAL = null; });
}

function savings() {
  loadMetal();
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
    ${pos.length ? posGroups(pos, snap, prev, prevM, total, typeColor)
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

// Positions grouped by asset type: header with subtotal and share, then one row per position.
const TYPE_ICONS = { 'Nauda': '💶', 'Krājkonts': '🏦', 'Akcijas / ETF': '📈', 'P2P aizdevumi': '🤝', 'Kripto': '🪙', 'Dārgmetāli': '🥇',
  'Pensija': '🌅', 'Nekustamais īpašums': '🏠', 'Cits': '📦' };
const signedWhole = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n), { whole: true });

function posGroups(pos, snap, prev, prevM, total, typeColor) {
  const types = [...new Set(pos.map(p => p.assetType))].sort((a, b) => S.savings.assetTypes.indexOf(a) - S.savings.assetTypes.indexOf(b));
  return `<div id="posTable">${types.map(type => {
    const list = pos.filter(p => p.assetType === type);
    const sub = sum(list.map(p => snap[p.id] || 0)), subPrev = prev ? sum(list.map(p => prev[p.id] || 0)) : null;
    const color = typeColor(type);
    return `<section class="pos-group">
      <header><span class="dot" style="background:${color}"></span><b>${esc(type)}</b><span class="sub">${list.length}</span><span class="spacer"></span>
        ${subPrev != null && sub !== subPrev ? `<span class="sub num">${signedWhole(sub - subPrev)}</span>` : ''}
        <b class="num">${money(sub, { whole: true })}</b>${total ? `<span class="share num">${Math.round((sub / total) * 100)}%</span>` : ''}</header>
      ${list.map(p => posRow(p, snap[p.id], prev?.[p.id], prevM, color)).join('')}
    </section>`;
  }).join('')}</div>`;
}

function posRow(p, v, pv, prevM, color) {
  const d = v != null && pv != null ? v - pv : null;
  const quiet = !v && !pv;
  const metal = METAL?.[p.id];
  return `<div class="pos-row ${quiet ? 'quiet' : ''}" data-id="${p.id}">
    <span class="emoji lg" style="background:color-mix(in srgb, ${color} 16%, transparent)">${TYPE_ICONS[p.assetType] || '💼'}</span>
    <div class="pos-main">
      <input type="text" class="pn bare" value="${esc(p.name)}" aria-label="Nosaukums">
      <div class="pos-meta"><input type="text" class="pp bare" value="${esc(p.place)}" placeholder="Kur glabājas?" aria-label="Kur"><span class="sub">·</span>
        <select class="pt bare" aria-label="Aktīva veids">${S.savings.assetTypes.map(t => `<option ${t === p.assetType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
    </div>
    <div class="pos-prev num">${pv != null ? `<small>${prevM ? monthShort(prevM) : 'iepriekš'}</small>${money(pv, { whole: true })}` : ''}</div>
    <div class="pos-val">
      <input type="number" class="pv bare num" step="0.01" value="${v ?? ''}" placeholder="—" aria-label="Vērtība eiro">
      ${metal ? `<button class="metal" data-metal="${p.id}" title="Ielikt vērtību pēc šodienas cenas">${String(metal.grams).replace('.', ',')} g × ${money(metal.perGram)} = <b>${money(metal.value, { whole: true })}</b></button>` : ''}
    </div>
    <div class="pos-delta">${d ? `<span class="pill ${d > 0 ? 'pos' : 'neg'} num">${signedWhole(d)}</span>` : d === 0 ? '<span class="sub">—</span>' : ''}</div>
    <button class="icon-btn pos-del" data-delpos="${p.id}" title="Dzēst" aria-label="Dzēst pozīciju">×</button>
  </div>`;
}

function collectPositions() {
  return $$('#posTable [data-id]').map(tr => ({ id: tr.dataset.id, name: $('.pn', tr).value, assetType: $('.pt', tr).value, place: $('.pp', tr).value }));
}
function collectValues() {
  const v = { ...(S.savings.snapshots[ui.month] || {}) };
  $$('#posTable [data-id]').forEach(tr => { const x = $('.pv', tr).value; if (x === '') delete v[tr.dataset.id]; else v[tr.dataset.id] = x; });
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
        ${c.accounts.map(a => `<div class="bank-acc ${a.skip ? 'off' : ''}" data-conn="${esc(c.id)}" data-uid="${esc(a.uid)}" data-old="${esc(a.label || '')}">
          <input type="text" class="acc-label" value="${esc(a.label)}" placeholder="${esc(a.name || 'Konts')}" aria-label="Konta nosaukums">
          <span class="sub">${esc(a.iban)}</span>
          <label class="check sub"><input type="checkbox" class="acc-skip" ${a.skip ? 'checked' : ''}> Nelietot</label>
          <span class="num">${a.balance != null && !a.skip ? money(a.balance) : ''}</span></div>`).join('')}
        <div class="sub ${late ? 'warn' : ''}">${c.error ? esc(c.error) + ' · ' : ''}${c.syncedAt ? 'Ielādēts ' + new Date(c.syncedAt).toLocaleString('lv-LV', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Vēl nav ielādēts'}
          · atļauja līdz ${fmtDate(c.validUntil)}${d < 14 ? ` (vēl ${Math.max(0, d)} d.)` : ''}</div>
      </div>`;
    }).join('') || '<div class="sub" style="margin-top:10px">Vēl nav pieslēgta neviena banka.</div>'}
    ${conns.length ? '<div class="sub" style="margin-top:12px">Konta nosaukums redzams pie katra darījuma, un pēc tā var filtrēt darījumus. Konti ar “Nelietot” netiek ielādēti.</div>' : ''}
    <div class="sub" style="margin-top:12px">${b.daily ? `Jaunie darījumi Google Sheets ielādējas paši katru dienu ap 6:00, arī ja programma nav atvērta${b.lastDaily ? ` (pēdējoreiz ${new Date(b.lastDaily.at).toLocaleString('lv-LV', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, +${b.lastDaily.added})` : ''}, un vēl atverot programmu.` : 'Jaunie darījumi ielādējas, kad atver programmu (ne biežāk kā reizi 6 stundās).'} Tie tiek sašķiroti kategorijās. Pārskaitījumi starp taviem kontiem un Revolut papildināšana netiek skaitīti kā izdevumi. Bankas atļauja jāatjauno ik pēc 180 dienām.</div>
  </div>`;
}

// Account name / not used, saved on the server (Bank.gs bankAccount); older transactions get the new name.
async function saveAccount(row) {
  if (PREVIEW) return toast('Priekšskatījumā bankas nav pieejamas');
  const conn = BANK?.connections.find(c => c.id === row.dataset.conn), acc = conn?.accounts.find(a => a.uid === row.dataset.uid);
  const oldLabel = acc ? (acc.label || (conn.accounts.length < 2 ? conn.bank : `${conn.bank} …${acc.iban.slice(-4)}`)) : '';
  try {
    BANK = (await call('bankAccount', { connId: row.dataset.conn, uid: row.dataset.uid, label: $('.acc-label', row).value, skip: $('.acc-skip', row).checked, oldLabel })).result;
    await refresh();
    toast('Konts saglabāts');
  } catch (e) { toast(e.message); }
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
  <div class="card">
    <h2>Izskats</h2>
    <div class="seg" style="margin-top:4px">${[['', 'Automātiski'], ['light', 'Gaišs'], ['dark', 'Tumšs']].map(([v, l]) =>
      `<button type="button" data-act="theme" data-v="${v}" class="${(localStorage.getItem(THEME_KEY) || '') === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="sub" style="margin-top:8px">Automātiski – kā sistēmā (telefonā vienmēr gaišs). Izvēle saglabājas šajā ierīcē.</div>
  </div>
  ${bankCard(bank)}
  ${ownNamesCard()}
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
  const el = e.target.closest('[data-act],[data-go],[data-tx],[data-close],[data-del],[data-delcat],[data-delpos],[data-metal],[data-emoji],[data-bankpick],[data-bankrenew],[data-bankdel]');
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
  if (el.dataset.metal) {
    const x = METAL[el.dataset.metal];
    return mutate('PUT', '/api/savings/snapshot', { month: ui.month, values: { ...collectValues(), [el.dataset.metal]: x.value } }, `Zelts pēc šodienas cenas: ${money(x.perGram)}/g`);
  }
  switch (el.dataset.act) {
    case 'prevMonth': ui.month = shiftMonth(ui.month, -1); return render();
    case 'nextMonth': ui.month = shiftMonth(ui.month, 1); return render();
    case 'txMonth': ui.txMonth = el.dataset.v; return render();
    case 'txType': ui.txType = el.dataset.v; return render();
    case 'theme':
      if (el.dataset.v) localStorage.setItem(THEME_KEY, el.dataset.v); else localStorage.removeItem(THEME_KEY);
      applyTheme(el.dataset.v); return render();
    case 'showType': ui.txType = el.dataset.v; ui.filterCat = ''; ui.txMonth = 'month'; return go('transactions');
    case 'addTx': return txForm({ type: 'expense', categoryId: S.categories[0]?.id });
    case 'voice': return voiceForm();
    case 'addCash': return txForm({ type: 'expense', categoryId: S.categories[0]?.id, source: CASH });
    case 'addCat': return saveBudget({ categories: [...collectCats(), { name: 'Jauna kategorija', icon: '🏷️', color: '#8E8E93', limit: 0 }] });
    case 'addPos': return mutate('PUT', '/api/savings/positions', { positions: [...collectPositions(), { name: 'Jauna pozīcija', assetType: S.savings.assetTypes[0], place: '' }] });
    case 'copyPrev': {
      // Metals are not copied: the server values them at today's price.
      const prev = { ...(S.savings.snapshots[prevSnapMonth(ui.month)] || {}) };
      S.savings.positions.filter(isMetal).forEach(p => delete prev[p.id]);
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
  if (t.id === 'filterAcc') { ui.filterAcc = t.value; return render(); }
  if (t.matches('.acc-label, .acc-skip')) return saveAccount(t.closest('.bank-acc'));
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
  if (e.target.id === 'ownForm') {
    e.preventDefault();
    const ownNames = $('#ownNames').value.split('\n').map(s => s.trim()).filter(Boolean);
    return mutate('PUT', '/api/settings', { ownNames }, 'Saglabāts');
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
