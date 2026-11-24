// Preview mode: sample data + in-memory API, used when the UI is opened without the app/server (file://).
window.MockAPI = (() => {
  const uid = () => Math.random().toString(36).slice(2, 10);
  const now = new Date();
  const ym = n => { const d = new Date(now.getFullYear(), now.getMonth() + n, 15); return d.toISOString().slice(0, 7); };
  const ICONS = { 'Pārtika': '🛒', 'Kafejnīcas un restorāni': '☕️', 'Transports': '🚗', 'Mājoklis un komunālie': '🏠', 'Iepirkšanās': '🛍️',
    'Veselība': '💊', 'Izklaide': '🎬', 'Abonementi': '📱', 'Ceļojumi': '✈️', 'Citi': '📦' };
  const cats = [
    ['Pārtika', '#34C759', 400], ['Kafejnīcas un restorāni', '#FF9500', 150], ['Transports', '#007AFF', 150],
    ['Mājoklis un komunālie', '#5856D6', 500], ['Iepirkšanās', '#FF2D55', 150], ['Veselība', '#FF3B30', 50],
    ['Izklaide', '#AF52DE', 80], ['Abonementi', '#5AC8FA', 40], ['Ceļojumi', '#00C7BE', 100], ['Citi', '#8E8E93', 100],
  ].map(([name, color, limit]) => ({ id: uid(), name, color, limit, icon: ICONS[name] }));
  const c = n => cats.find(x => x.name === n).id;
  const m0 = ym(0), m1 = ym(-1);
  const tx = (d, description, amount, cat, type = 'expense') => ({ id: uid(), date: d, description, amount, type, categoryId: cat ? c(cat) : null, source: 'paraugs' });
  const state = {
    settings: { currency: 'EUR', totalLimit: 1800, sheetUrl: '', sheetWebAppUrl: '', sheetToken: 'preview', lastSync: null, lastSyncError: null },
    categories: cats,
    rules: {},
    transactions: [
      tx(`${m0}-02`, 'SIA Darbs · Alga', 2400, null, 'income'),
      tx(`${m0}-03`, 'RIMI Hypermarket', 64.2, 'Pārtika'),
      tx(`${m0}-04`, 'Bolt', 8.4, 'Transports'),
      tx(`${m0}-05`, 'Spotify', 11.99, 'Abonementi'),
      tx(`${m0}-06`, 'Īre', 450, 'Mājoklis un komunālie'),
      tx(`${m0}-08`, 'Maxima', 38.75, 'Pārtika'),
      tx(`${m0}-09`, 'Kafejnīca Mr. Fox', 14.5, 'Kafejnīcas un restorāni'),
      tx(`${m0}-10`, 'Circle K', 52, 'Transports'),
      tx(`${m0}-11`, 'Cinamon', 18, 'Izklaide'),
      tx(`${m0}-12`, 'Zara', 89.9, 'Iepirkšanās'),
      tx(`${m1}-04`, 'Lidl', 71.3, 'Pārtika'),
      tx(`${m1}-06`, 'Īre', 450, 'Mājoklis un komunālie'),
    ],
    savings: {
      assetTypes: ['Nauda', 'Krājkonts', 'Akcijas / ETF', 'P2P aizdevumi', 'Kripto', 'Dārgmetāli', 'Cits'],
      positions: [
        { id: 'p1', name: 'Norēķinu konts', assetType: 'Nauda', place: 'Banka' },
        { id: 'p2', name: 'Drošības spilvens', assetType: 'Krājkonts', place: 'Banka' },
        { id: 'p3', name: 'ETF portfelis', assetType: 'Akcijas / ETF', place: 'Brokeris' },
        { id: 'p4', name: 'Kripto', assetType: 'Kripto', place: 'Birža' },
      ],
      snapshots: {
        [ym(-3)]: { p1: 900, p2: 8000, p3: 6200, p4: 900 },
        [ym(-2)]: { p1: 750, p2: 8400, p3: 6550, p4: 1100 },
        [m1]: { p1: 1100, p2: 8800, p3: 6400, p4: 1050 },
        [m0]: { p1: 820, p2: 9300, p3: 6900, p4: 1200 },
      },
      snapshotDates: {},
    },
  };
  const round = n => Math.round((Number(n) || 0) * 100) / 100;

  function handle(method, url, body = {}) {
    const [, , res, id] = url.split('/');
    const key = `${method} ${res}`;
    if (key === 'GET state') return JSON.parse(JSON.stringify(state));
    if (key === 'POST transactions') {
      const list = Array.isArray(body.transactions) ? body.transactions : [body];
      list.forEach(t => state.transactions.push({ ...t, id: uid(), amount: round(t.amount), categoryId: t.type === 'income' ? null : t.categoryId }));
      return { added: list.length };
    }
    if (key === 'PUT transactions') { Object.assign(state.transactions.find(t => t.id === id), body, { amount: round(body.amount) }); return {}; }
    if (key === 'DELETE transactions') { state.transactions = state.transactions.filter(t => t.id !== id); return {}; }
    if (key === 'PUT budget') {
      state.settings.totalLimit = round(body.totalLimit);
      state.categories = body.categories.map(x => ({ ...x, id: x.id || uid(), limit: round(x.limit) }));
      return {};
    }
    if (key === 'PUT savings' && id === 'positions') { state.savings.positions = body.positions.map(p => ({ ...p, id: p.id || uid() })); return {}; }
    if (key === 'PUT savings' && id === 'snapshot') {
      const v = {}; for (const [k, x] of Object.entries(body.values)) if (x !== '' && x != null) v[k] = round(x);
      state.savings.snapshots[body.month] = v; return {};
    }
    if (key === 'PUT settings') { Object.assign(state.settings, body); return {}; }
    if (key === 'GET apps-script') return { script: '// Priekšskatījums: skripts pieejams lietotnē' };
    if (key === 'POST sync') throw new Error('Priekšskatījumā sinhronizācija nav pieejama');
    if (key === 'POST import') throw new Error('Priekšskatījumā imports nav pieejams, atver lietotni');
    throw new Error('Nav atrasts');
  }
  // Sample bank connections for the settings screen.
  const bank = {
    configured: true, appId: 'preview',
    connections: [
      { id: 'b1', bank: 'Swedbank', country: 'LV', validUntil: new Date(Date.now() + 150 * 864e5).toISOString(), syncedAt: new Date().toISOString(), error: '',
        accounts: [{ name: 'Norēķinu konts', iban: '•••• 4821', currency: 'EUR', balance: 1240.55 }, { name: 'Krājkonts', iban: '•••• 9310', currency: 'EUR', balance: 9300 }] },
      { id: 'b2', bank: 'Revolut', country: 'LV', validUntil: new Date(Date.now() + 9 * 864e5).toISOString(), syncedAt: new Date(Date.now() - 3 * 36e5).toISOString(), error: '',
        accounts: [{ name: 'EUR', iban: '•••• 0077', currency: 'EUR', balance: 212.4 }] },
    ],
  };
  return { handle, bank };
})();
