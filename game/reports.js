// ---------------------------------------------------------------------------
// Admin reports (Nov 2026) -- the pages behind the "Admin reports" button.
//
//   Home        four blocks: Dashboard, Users, Games, Ads
//   Dashboard   check daily: Today (with who is online right now), Yesterday,
//               Last 7 days, This month -- each against its usual level, with
//               anything unusual listed first
//   Users       4 numbers + 4 reports    Games  4 numbers + 4 reports
//   Ads         4 numbers + 3 reports
//
// Where the numbers come from:
//   activity   one row per player per game (since Sep 2026)      "your data now"
//   users      lifetime games per account
//   accounts   Firebase sign-in accounts: when each phone/browser first opened
//              the game ("first-time visitors")
//   games, rooms, searches, days   the records game/analytics.js writes from
//              this version on                                   "from go-live"
//
// Reading Firestore costs a read per document, so everything is kept in memory
// and topped up: after the first load only rows newer than the last ones seen
// are fetched (the logs are append-only). Pages are plain HTML with no script
// (the site's security policy blocks scripts on these pages); the dashboard's
// tabs are CSS radio buttons. Every page works on a phone and on a laptop.
// ---------------------------------------------------------------------------
'use strict';

const UserAnalytics = require('./userAnalytics');

// ============================== time (IST) =================================
const IST_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ist = (ms) => new Date(ms + IST_MS);
const dayOf = (ms) => ist(ms).toISOString().slice(0, 10);
const monthOf = (ms) => ist(ms).toISOString().slice(0, 7);
const dayStart = (day) => Date.parse(day + 'T00:00:00Z') - IST_MS;
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const weekday = (day) => new Date(day + 'T00:00:00Z').getUTCDay();
function shiftMonth(m, by) {
  return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1)).toISOString().slice(0, 7);
}
const monthStart = (m) => dayStart(m + '-01');
const monthLabel = (m) => MON[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4);
const monShort = (m) => MON[Number(m.slice(5, 7)) - 1];
const fyOf = (m) => (Number(m.slice(5, 7)) >= 4 ? Number(m.slice(0, 4)) : Number(m.slice(0, 4)) - 1);
const fyLabel = (fy) => 'FY ' + String(fy % 100).padStart(2, '0') + '-' + String((fy + 1) % 100).padStart(2, '0');
function clock(ms) {
  const d = ist(ms);
  const h = d.getUTCHours();
  return (h % 12 || 12) + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
const dm = (day) => Number(day.slice(8, 10)) + ' ' + MON[Number(day.slice(5, 7)) - 1];
const dayLabel = (day) => WD[weekday(day)] + ' ' + dm(day);
const hourLabel = (h) => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');

// ============================== formatting =================================
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DASH = '<span class="dim">&ndash;</span>';
const ok = (v) => v != null && Number.isFinite(v);
const fmtInt = (v) => (ok(v) ? Math.round(v).toLocaleString('en-IN') : DASH);
const fmtNum = (v, dp) => (ok(v) ? v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : DASH);
const ratio = (a, b) => (b > 0 ? a / b : null);
const fmtPct = (r, dp) => (ok(r) ? (r * 100).toFixed(dp == null ? 0 : dp) + '%' : DASH);
const SYMBOL = { INR: '&#8377;', USD: '$', EUR: '&euro;', GBP: '&pound;' };
function fmtMoney(micros, cur) {
  if (!ok(micros)) return DASH;
  const v = micros / 1e6;
  const sym = SYMBOL[cur] || (cur ? esc(cur) + '&nbsp;' : '');
  const dp = v === 0 ? 0 : v < 1 ? 2 : v < 20 ? 1 : 0;
  return sym + v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtDur(secs) {
  if (!ok(secs)) return DASH;
  const s = Math.round(secs);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 10 && s % 60) return m + ' min ' + (s % 60) + ' s';
  if (m < 60) return Math.round(s / 60) + ' min';
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
const sumOf = (arr, f) => arr.reduce((s, x) => s + (f ? (Number(f(x)) || 0) : (Number(x) || 0)), 0);
const avgOf = (arr) => (arr.length ? sumOf(arr) / arr.length : null);
function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
}
// First index in a list sorted by key(x) whose key is >= v.
function lowerBound(arr, v, key) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}
const between = (arr, w, key) => arr.slice(lowerBound(arr, w.from, key), lowerBound(arr, w.to, key));

// ================================ data =====================================
const CACHE_MS = 10 * 60 * 1000;
const ACCOUNTS_MS = 30 * 60 * 1000;
const OVERLAP_MS = 15 * 60 * 1000;   // re-read a little before the last row seen
const ACT_FIELDS = ['uid', 'at', 'completed', 'displayName', 'platform', 'mode', 'roomCode', 'roundsPlayed', 'won', 'humanCount'];

function createStore() {
  return {
    at: 0, loading: null, model: null, errors: [],
    activity: new Map(), actMax: '', users: new Map(), usersMax: '',
    games: new Map(), gamesMax: '', rooms: new Map(), roomsMax: '', searches: new Map(), searchesMax: '',
    days: new Map(), daysFull: false, accounts: null, accountsAt: 0,
  };
}

// Everything newer than `max` (with a little overlap; rows are kept by id, so
// nothing is counted twice). The first time: the whole collection.
async function pull(db, name, field, max, fields, into) {
  let q = db.collection(name);
  const t = max ? Date.parse(max) : NaN;
  if (!Number.isNaN(t)) q = q.where(field, '>=', new Date(t - OVERLAP_MS).toISOString());
  if (fields && typeof q.select === 'function') q = q.select(...fields);
  const snap = await q.get();
  let top = max || '';
  snap.forEach((doc) => {
    const d = (doc.data && doc.data()) || {};
    into.set(doc.id, d);
    const v = d[field];
    if (typeof v === 'string' && v > top) top = v;
  });
  return top;
}

async function listAccounts(auth) {
  const out = [];
  let token;
  for (let page = 0; page < 1000; page++) {
    const res = await auth.listUsers(1000, token);
    for (const u of (res && res.users) || []) {
      const created = Date.parse(u && u.metadata && u.metadata.creationTime);
      if (u && u.uid && !Number.isNaN(created)) out.push({ uid: u.uid, created });
    }
    token = res && res.pageToken;
    if (!token) break;
  }
  return out;
}

// Brings the store up to date (at most every 10 minutes unless forced) and
// rebuilds the numbers. One load at a time; others wait for it.
async function refreshStore(store, { db, auth, now, force, log }) {
  const t = now();
  const L = log || console;
  if (!force && store.model && t - store.at < CACHE_MS) return store;
  if (store.loading) { await store.loading; return store; }
  store.loading = (async () => {
    const errors = [];
    const step = async (label, fn) => {
      try { await fn(); } catch (e) { errors.push(label); L.warn('[reports] ' + label + ':', e && e.message); }
    };
    await step('activity', async () => { store.actMax = await pull(db, 'activity', 'at', store.actMax, ACT_FIELDS, store.activity); });
    await step('users', async () => { store.usersMax = await pull(db, 'users', 'lastPlayedAt', store.usersMax, ['displayName', 'gamesPlayed', 'lastPlayedAt'], store.users); });
    await step('games', async () => { store.gamesMax = await pull(db, 'games', 'endedAt', store.gamesMax, null, store.games); });
    await step('rooms', async () => { store.roomsMax = await pull(db, 'rooms', 'closedAt', store.roomsMax, null, store.rooms); });
    await step('searches', async () => { store.searchesMax = await pull(db, 'searches', 'at', store.searchesMax, null, store.searches); });
    await step('days', async () => {
      if (!store.daysFull) {
        const snap = await db.collection('days').get();
        snap.forEach((doc) => store.days.set(doc.id, (doc.data && doc.data()) || {}));
        store.daysFull = true;
      } else {
        for (let i = 0; i < 3; i++) {
          const d = dayOf(t - i * DAY_MS);
          const doc = await db.collection('days').doc(d).get();
          if (doc && doc.exists) store.days.set(d, (doc.data && doc.data()) || {});
        }
      }
    });
    if (auth && (force || !store.accounts || t - store.accountsAt > ACCOUNTS_MS)) {
      await step('accounts', async () => { store.accounts = await listAccounts(auth); store.accountsAt = t; });
    }
    store.errors = errors;
    store.at = t;
    store.model = buildModel(store, t);
  })();
  try { await store.loading; } finally { store.loading = null; }
  return store;
}

// ================================ model ====================================
const FINISHED = new Set(['won', 'knocked-out', 'still-in']);
const toEnd = (g) => g.outcome === 'winner' || g.outcome === 'all-knocked-out';
const MODE_NAMES = { bots: 'Bots', friends: 'Friends room', online: 'Online match', group: 'Groups' };

function buildModel(store, nowMs) {
  const today = dayOf(nowMs);
  const curMonth = today.slice(0, 7);

  // ---- activity rows and people ----
  const rows = [];
  for (const r of store.activity.values()) {
    if (!r || !r.uid || typeof r.at !== 'string') continue;
    const ms = Date.parse(r.at);
    if (Number.isNaN(ms)) continue;
    const day = dayOf(ms);
    const done = r.completed !== false;
    rows.push({
      uid: r.uid, ms, day, month: day.slice(0, 7), done,
      app: r.platform === 'android-app', web: r.platform === 'web',
      multi: r.mode === 'multiplayer' || Number(r.humanCount) > 1,
      name: typeof r.displayName === 'string' ? r.displayName : null,
      // One key per game that reached a winner: every player's row from
      // recordGameResult shares the room and the moment it ended.
      key: done && r.roundsPlayed == null && r.roomCode ? r.roomCode + '|' + r.at : null,
    });
  }
  rows.sort((a, b) => a.ms - b.ms);
  const people = new Map();
  for (const r of rows) {
    let p = people.get(r.uid);
    if (!p) {
      p = { uid: r.uid, rows: [], name: null, firstMs: r.ms, firstPlat: r.app ? 'app' : r.web ? 'web' : 'other', before: false, gamesPlayed: 0, done: 0, lastMs: r.ms };
      people.set(r.uid, p);
    }
    r.i = p.rows.length;
    p.rows.push(r);
    p.lastMs = r.ms;
    if (r.name) p.name = r.name;
    if (r.done) p.done += 1;
  }
  for (const [uid, d] of store.users) {
    const games = Number(d && d.gamesPlayed) || 0;
    const p = people.get(uid);
    if (p) {
      p.gamesPlayed = games;
      if (games > p.done) p.before = true;
      if (!p.name && d.displayName) p.name = d.displayName;
    } else if (games > 0) {
      const lp = Date.parse((d && d.lastPlayedAt) || '');
      people.set(uid, { uid, rows: [], name: d.displayName || null, firstMs: null, firstPlat: null, before: true, gamesPlayed: games, done: 0, lastMs: Number.isNaN(lp) ? null : lp });
    }
  }
  for (const p of people.values()) {
    p.days = new Set(p.rows.map((r) => r.day));
    p.months = new Set(p.rows.map((r) => r.month));
    p.firstDay = p.firstMs != null ? dayOf(p.firstMs) : null;
    p.firstMonth = p.firstDay ? p.firstDay.slice(0, 7) : null;
    const lastRow = p.rows[p.rows.length - 1];
    p.lastPlat = lastRow ? (lastRow.app ? 'app' : lastRow.web ? 'web' : 'other') : null;
  }
  const newcomers = [...people.values()].filter((p) => !p.before && p.firstMs != null).sort((a, b) => a.firstMs - b.firstMs);
  const logStartMs = rows.length ? rows[0].ms : null;

  // The roll-forward, by the same rules as the deployed Users page.
  const um = UserAnalytics.buildUserMonths({
    activity: [...store.activity.values()],
    users: [...store.users.entries()].map(([uid, d]) => Object.assign({ uid }, d)),
    now: nowMs,
  });

  // ---- records from this version on ----
  const games = [];
  for (const g of store.games.values()) {
    const startMs = Date.parse(g && g.startedAt);
    const endMs = Date.parse(g && g.endedAt);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    games.push(Object.assign({}, g, { startMs, endMs, month: monthOf(endMs), players: Array.isArray(g.players) ? g.players : [] }));
  }
  games.sort((a, b) => a.endMs - b.endMs);
  const rooms = [];
  for (const r of store.rooms.values()) {
    const createdMs = Date.parse(r && r.createdAt);
    const closedMs = Date.parse(r && r.closedAt);
    if (Number.isNaN(createdMs) || Number.isNaN(closedMs)) continue;
    rooms.push(Object.assign({}, r, { createdMs, closedMs, month: monthOf(createdMs) }));
  }
  rooms.sort((a, b) => a.createdMs - b.createdMs);
  const searches = [];
  for (const s of store.searches.values()) {
    const ms = Date.parse(s && s.at);
    if (Number.isNaN(ms)) continue;
    searches.push(Object.assign({}, s, { ms, month: monthOf(ms) }));
  }
  searches.sort((a, b) => a.ms - b.ms);
  const days = store.days;
  const dayKeys = [...days.keys()].filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  // When the new records began: the earliest day any of them has.
  const starts = [];
  if (games.length) starts.push(games[0].startMs);
  if (rooms.length) starts.push(rooms[0].createdMs);
  if (searches.length) starts.push(searches[0].ms);
  if (dayKeys.length) starts.push(dayStart(dayKeys[0]));
  const liveStartMs = starts.length ? dayStart(dayOf(Math.min(...starts))) : null;

  // Each person's games in the new records, in order.
  const gamesBy = new Map();
  for (const g of games.slice().sort((a, b) => a.startMs - b.startMs)) {
    for (const pl of g.players) {
      if (!pl || !pl.uid) continue;
      if (!gamesBy.has(pl.uid)) gamesBy.set(pl.uid, []);
      gamesBy.get(pl.uid).push({ g, pl });
    }
  }

  const accounts = Array.isArray(store.accounts) ? store.accounts.slice().sort((a, b) => a.created - b.created) : null;
  let currency = null;
  for (const k of dayKeys) if (days.get(k) && typeof days.get(k).currency === 'string') currency = days.get(k).currency;

  return {
    nowMs, today, curMonth, rows, people, newcomers, logStartMs, um,
    games, rooms, searches, days, dayKeys, liveStartMs, gamesBy, accounts, currency: currency || 'INR',
    errors: store.errors || [], dataAt: store.at,
  };
}

// ============================ window metrics ===============================
// A window is { from, to } in ms (live: true when it runs up to now). Each
// metric gives { v, n }: the value, and how many things it was worked out
// from -- so a big swing on three games is not called unusual.
const rowsIn = (M, w) => between(M.rows, w, (r) => r.ms);
const gamesEnded = (M, w) => between(M.games, w, (g) => g.endMs);
const roomsMade = (M, w) => between(M.rooms, w, (r) => r.createdMs);
const searchesIn = (M, w) => between(M.searches, w, (s) => s.ms);

function activePlayers(M, w) {
  const s = new Set();
  for (const r of rowsIn(M, w)) s.add(r.uid);
  return { v: s.size, n: s.size };
}
function newUsers(M, w) {
  const n = between(M.newcomers, w, (p) => p.firstMs).length;
  return { v: n, n };
}
// Of the phones/browsers that opened the game for the first time in the
// window, the share that played a round that same day.
function visitorsPlayed(M, w) {
  if (!M.accounts) return null;
  const made = between(M.accounts, w, (a) => a.created);
  let played = 0;
  for (const a of made) {
    const p = M.people.get(a.uid);
    if (p && p.firstDay === dayOf(a.created)) played += 1;
  }
  return { v: ratio(played, made.length), n: made.length, a: played };
}
// Played in the window after 30 days or more without a game.
function cameBack(M, w) {
  const seen = new Set();
  let n = 0;
  for (const r of rowsIn(M, w)) {
    if (seen.has(r.uid)) continue;
    seen.add(r.uid);
    const p = M.people.get(r.uid);
    const prev = p.rows[r.i - 1];
    if ((prev && r.ms - prev.ms >= 30 * DAY_MS) || (!prev && p.before)) n += 1;
  }
  return { v: n, n };
}
function gamesToWinner(M, w) {
  const s = new Set();
  for (const r of rowsIn(M, w)) if (r.key) s.add(r.key);
  return { v: s.size, n: s.size };
}
function playersFinished(M, w) {
  let all = 0;
  let fin = 0;
  for (const g of gamesEnded(M, w)) for (const pl of g.players) { all += 1; if (FINISHED.has(pl.result)) fin += 1; }
  return { v: ratio(fin, all), n: all };
}
function lostPer100(M, w) {
  const gs = gamesEnded(M, w);
  return { v: gs.length ? (100 * sumOf(gs, (g) => g.lostConnections)) / gs.length : null, n: gs.length };
}
function roomsNobody(M, w) {
  const rs = roomsMade(M, w);
  return { v: ratio(rs.filter((r) => r.outcome === 'nobody-closed' || r.outcome === 'nobody-bots').length, rs.length), n: rs.length };
}
function searchMatched(M, w) {
  const ss = searchesIn(M, w);
  return { v: ratio(ss.filter((s) => s.outcome === 'matched').length, ss.length), n: ss.length };
}

// ---- the day counters (days/{date}) ----
function g2(o, ...path) {
  let x = o;
  for (const k of path) {
    if (!x || typeof x !== 'object') return 0;
    x = x[k];
  }
  return Number(x) || 0;
}
// The days a window touches, and which hours of each.
function dayParts(w) {
  const parts = [];
  for (let d = dayOf(w.from), i = 0; dayStart(d) < w.to && i < 800; d = addDays(d, 1), i++) {
    const s = dayStart(d);
    const from = Math.max(s, w.from);
    const to = Math.min(s + DAY_MS, w.to);
    if (to > from) parts.push({ day: d, full: from === s && to === s + DAY_MS, fromH: (from - s) / 3600000, toH: (to - s) / 3600000 });
  }
  return parts;
}
// A counter added up over some hours of a day. Part of an hour counts in
// part -- except "now": today's current hour holds only what has happened so
// far, so it counts whole.
function hourSum(doc, field, fromH, toH, live) {
  if (!doc || !doc.hours) return 0;
  const end = live ? Math.ceil(toH) : toH;
  let s = 0;
  for (let h = Math.floor(fromH); h < Math.ceil(end) && h < 24; h++) {
    const overlap = Math.min(h + 1, end) - Math.max(h, fromH);
    if (overlap > 0) s += g2(doc.hours, String(h).padStart(2, '0'), field) * overlap;
  }
  return s;
}
const revOf = (doc) => g2(doc, 'rev', 'banner') + g2(doc, 'rev', 'fs') + g2(doc, 'rev', 'rw');
function revenue(M, w) {
  let v = 0;
  for (const p of dayParts(w)) {
    const doc = M.days.get(p.day);
    if (doc) v += p.full ? revOf(doc) : hourSum(doc, 'rev', p.fromH, p.toH, w.live);
  }
  return { v, n: v };
}
function bannerLoaded(M, w) {
  let ld = 0;
  let fl = 0;
  for (const p of dayParts(w)) {
    const doc = M.days.get(p.day);
    if (!doc) continue;
    if (p.full) { ld += g2(doc, 'ads', 'banner', 'loaded'); fl += g2(doc, 'ads', 'banner', 'failed'); }
    else { ld += hourSum(doc, 'bLoaded', p.fromH, p.toH, w.live); fl += hourSum(doc, 'bFailed', p.fromH, p.toH, w.live); }
  }
  return { v: ratio(ld, ld + fl), n: ld + fl };
}
function fsShown(M, w) {
  let due = 0;
  let shown = 0;
  for (const p of dayParts(w)) {
    const doc = M.days.get(p.day);
    if (doc) { due += g2(doc, 'ads', 'fs', 'due'); shown += g2(doc, 'ads', 'fs', 'shown'); }
  }
  return { v: ratio(shown, due), n: due };
}
// People who opened the app (not the website) in the window.
function appUsers(M, w) {
  const parts = dayParts(w);
  if (parts.length === 1 && !parts[0].full) return hourSum(M.days.get(parts[0].day), 'appOpens', parts[0].fromH, parts[0].toH, w.live);
  const s = new Set();
  for (const p of parts) {
    const doc = M.days.get(p.day);
    if (doc && doc.opens) for (const [uid, k] of Object.entries(doc.opens)) if (k === 'app') s.add(uid);
  }
  return s.size;
}
function revPerAppUser(M, w) {
  const u = appUsers(M, w);
  return { v: u > 0 ? revenue(M, w).v / u : null, n: u };
}

// ---- usual levels and what counts as unusual ----
// Does the data reach back over the whole window -- or, for the period being
// shown (partial), over any of it? (A month that began before go-live still
// shows its numbers from go-live on; it just has no usual level yet.)
function covered(M, src, w, partial) {
  const start = src === 'live' ? M.liveStartMs : M.logStartMs;
  if (start == null || (src === 'acct' && !M.accounts)) return false;
  return partial ? start < w.to : start <= w.from;
}
function measure(M, tile, w, partial) {
  if (!covered(M, tile.src, w, partial)) return null;
  const r = tile.f(M, w);
  return r && ok(r.v) ? r : null;
}
function usualOf(M, tile, wins) {
  const vals = wins.map((w) => measure(M, tile, w)).filter(Boolean);
  if (!vals.length) return null;
  return { v: avgOf(vals.map((x) => x.v)), n: avgOf(vals.map((x) => x.n || 0)), count: vals.length };
}
// '' (normal), 'bad', 'good' -- about 30% or more away from usual and big
// enough to matter -- or 'watch' (moving the wrong way, but small numbers).
function judge(tile, cur, usual) {
  if (!cur || !usual || !ok(cur.v) || !ok(usual.v)) return '';
  const v = cur.v;
  const u = usual.v;
  const rel = u !== 0 ? (v - u) / Math.abs(u) : (v !== 0 ? Infinity : 0);
  if (Math.abs(rel) < 0.3) return '';
  const nMin = Math.min(cur.n || 0, usual.n || 0);
  let big;
  let some;
  if (tile.kind === 'count') { big = Math.max(v, u) >= 10 && Math.abs(v - u) >= 3; some = Math.max(v, u) >= 5; }
  else if (tile.kind === 'money') { big = Math.max(v, u) >= 5e6 && Math.abs(v - u) >= 2e6; some = Math.max(v, u) >= 2e6; }
  else if (tile.kind === 'pct') { big = nMin >= 20 && Math.abs(v - u) >= 0.05; some = nMin >= 10; }
  else { big = nMin >= 20; some = nMin >= 10; }
  const goodWay = (v > u) === (tile.better === 'up');
  if (big) return goodWay ? 'good' : 'bad';
  return !goodWay && some ? 'watch' : '';
}
function showValue(tile, v, cur) {
  if (!ok(v)) return DASH;
  if (tile.kind === 'pct') return fmtPct(v);
  if (tile.kind === 'money') return fmtMoney(v, cur);
  if (tile.kind === 'rate') return fmtNum(v, v < 10 ? 1 : 0);
  return fmtInt(v);
}
function changeText(tile, v, u) {
  if (!ok(v) || !ok(u)) return '';
  const sign = (x) => (x > 0 ? '+' : x < 0 ? '&minus;' : '');
  if (tile.kind === 'pct') {
    const d = Math.round((v - u) * 100);
    return d === 0 ? '0' : sign(d) + Math.abs(d) + (Math.abs(d) === 1 ? ' pt' : ' pts');
  }
  if ((tile.kind === 'count' || tile.kind === 'rate') && u < 10) {
    const d = Math.round(v - u);
    return d === 0 ? '0' : sign(d) + Math.abs(d);
  }
  if (u === 0) return v > 0 ? 'new' : '0';
  const p = Math.round(((v - u) / Math.abs(u)) * 100);
  return p === 0 ? '0' : sign(p) + Math.abs(p) + '%';
}

// The twelve dashboard tiles.
const TILES = [
  { id: 'active', grp: 'users', label: 'Active players', kind: 'count', better: 'up', src: 'act', f: activePlayers },
  { id: 'new', grp: 'users', label: 'New users', kind: 'count', better: 'up', src: 'act', f: newUsers },
  { id: 'v2p', grp: 'users', label: 'First visit &rarr; played (same day)', kind: 'pct', better: 'up', src: 'acct', f: visitorsPlayed },
  { id: 'back', grp: 'users', label: 'Came back after a break', kind: 'count', better: 'up', src: 'act', f: cameBack },
  { id: 'games', grp: 'games', label: 'Games to a winner', kind: 'count', better: 'up', src: 'act', f: gamesToWinner },
  { id: 'fin', grp: 'games', label: 'Players who finished', kind: 'pct', better: 'up', src: 'live', f: playersFinished },
  { id: 'lost', grp: 'games', label: 'Lost connections / 100 games', kind: 'rate', better: 'down', src: 'live', f: lostPer100 },
  { id: 'nobody', grp: 'games', label: 'Friends rooms nobody joined', kind: 'pct', better: 'down', src: 'live', f: roomsNobody },
  { id: 'rev', grp: 'ads', label: 'Ad revenue', kind: 'money', better: 'up', src: 'live', f: revenue },
  { id: 'banner', grp: 'ads', label: 'Banner loaded', kind: 'pct', better: 'up', src: 'live', f: bannerLoaded },
  { id: 'fs', grp: 'ads', label: 'Full-screen ads shown (when due)', kind: 'pct', better: 'up', src: 'live', f: fsShown },
  { id: 'rpu', grp: 'ads', label: 'Revenue per app user', kind: 'money', better: 'up', src: 'live', f: revPerAppUser },
];
// What to look at when a tile is unusual.
const HINTS = {
  active: { bad: 'Check Render for a restart or errors; then Users &rsaquo; Growth &amp; active users.', good: 'Worth finding what brought them (a post, a festival, an invite wave).' },
  new: { bad: 'Fewer new people found the game &ndash; check the Play Store listing and recent posts.', good: 'Worth finding what brought them (a post, an invite wave).' },
  v2p: { bad: 'New visitors are not starting a game &ndash; check the home screen and the first minute.', good: 'More new visitors started playing at once.' },
  back: { bad: 'Fewer old players returned.', good: 'Old players are returning &ndash; see Users &rsaquo; Retention &amp; churn.' },
  games: { bad: 'Check Render for a restart or errors, then Games &rsaquo; Games played &amp; completion.', good: 'More games than usual.' },
  fin: { bad: 'More players walked out &ndash; Games &rsaquo; Games played &amp; completion shows in which round.', good: 'Fewer players walked out.' },
  lost: { bad: 'Check Render for a restart or a slow server around the busy hours.', good: 'Fewer dropped connections.' },
  nobody: { bad: 'Friends are not coming to rooms &ndash; check that invite links open the game.', good: 'More friends are joining rooms.' },
  rev: { bad: 'Most often the banner (below) or fewer full-screen ads; AdMob may also have had fewer ads.', good: 'Follows the growth in players.' },
  banner: { bad: 'Check Ads &rsaquo; Ads shown &amp; ad health: AdMob had no ads, or the banner broke in an update.', good: '' },
  fs: { bad: 'Full-screen ads were due but none was ready &ndash; Ads &rsaquo; Ads shown &amp; ad health.', good: '' },
  rpu: { bad: 'Each app user earned less &ndash; check the banner and full-screen numbers.', good: 'Each app user earned more.' },
};

// The dashboard's four periods, each with the windows its "usual" averages.
function periods(M) {
  const now = M.nowMs;
  const today = M.today;
  const t0 = dayStart(today);
  const y = addDays(today, -1);
  const y0 = dayStart(y);
  const m0 = monthStart(M.curMonth);
  const prevM = shiftMonth(M.curMonth, -1);
  const pm0 = monthStart(prevM);
  const wdT = WD_LONG[weekday(today)];
  const wdY = WD_LONG[weekday(y)];
  const k4 = [1, 2, 3, 4];
  const lastDay = dayOf(Math.min(pm0 + (t0 - m0), m0) - 1);
  return [
    { id: 't0', name: 'Today', today: true, w: { from: t0, to: now, live: true },
      usual: k4.map((k) => ({ from: t0 - 7 * k * DAY_MS, to: t0 - 7 * k * DAY_MS + (now - t0) })),
      cmp: `${dayLabel(today)}, so far &middot; compared with the last 4 ${wdT}s up to ${clock(now)}`,
      noun: `a usual ${wdT} by this time` },
    { id: 't1', name: 'Yesterday', w: { from: y0, to: t0 },
      usual: k4.map((k) => ({ from: y0 - 7 * k * DAY_MS, to: t0 - 7 * k * DAY_MS })),
      cmp: `${dayLabel(y)} &middot; compared with the last 4 ${wdY}s`, noun: `a usual ${wdY}` },
    { id: 't2', name: 'Last 7 days', w: { from: t0 - 7 * DAY_MS, to: t0 },
      usual: k4.map((k) => ({ from: t0 - 7 * (k + 1) * DAY_MS, to: t0 - 7 * k * DAY_MS })),
      cmp: `${dm(addDays(today, -7))}&ndash;${dm(y)} &middot; compared with the average week of the 4 weeks before`, noun: 'a usual week' },
    { id: 't3', name: 'This month', w: { from: m0, to: t0 }, empty: t0 <= m0,
      usual: [{ from: pm0, to: Math.min(pm0 + (t0 - m0), m0) }],
      cmp: t0 <= m0 ? 'The month started today &ndash; see Today.'
        : `1&ndash;${dm(y)} &middot; compared with 1&ndash;${dm(lastDay)}`,
      noun: `the same days of ${MON[Number(prevM.slice(5, 7)) - 1]}` },
  ];
}

// ================================ the look =================================
// Two stylesheets, as in the approved samples: one for the home, dashboard
// and block pages, one for the reports.
const BASE_CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#0d1f16;color:#e8f0ea;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:#f2c14e}
.top{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:10px}.top a{color:#f2c14e;text-decoration:none}
h1{font-size:21px;margin:0 0 2px}@media(min-width:900px){h1{font-size:27px}}
.sub{color:#8fae9c;font-size:12px;margin-bottom:12px}.sub a{color:#f2c14e}
.crumb{color:#8fae9c;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.dim{color:#6f9080}
.notes{color:#8fae9c;font-size:12px;margin-top:16px;line-height:1.6}.notes b{color:#d9e8de}
.err{background:#5c2a2a;color:#ffd9d9;border-radius:8px;padding:6px 10px;font-size:12px;margin-bottom:12px}
.empty{color:#8fae9c;font-size:13px;padding:6px 0}`;

const DASH_CSS = BASE_CSS + `
.wrap{max-width:1120px;margin:0 auto;padding:14px 12px 40px}
@media(min-width:900px){.wrap{padding:24px 32px 48px}}
input.tab{position:absolute;opacity:0;pointer-events:none}
.tabs{display:flex;background:#11301f;border:1px solid #205237;border-radius:12px;padding:4px;gap:4px;margin-bottom:12px}
.tabs label{flex:1;text-align:center;padding:9px 4px;border-radius:9px;cursor:pointer;font-weight:600;font-size:13px;color:#c9dccf;white-space:nowrap}
@media(max-width:420px){.tabs label{font-size:12px;padding:9px 2px}}
#t0:checked~.tabs label[for=t0],#t1:checked~.tabs label[for=t1],#t2:checked~.tabs label[for=t2],#t3:checked~.tabs label[for=t3]{background:#f2c14e;color:#241a05}
.panel{display:none}#t0:checked~.panels .p0,#t1:checked~.panels .p1,#t2:checked~.panels .p2,#t3:checked~.panels .p3{display:block}
.live{background:linear-gradient(135deg,#1d5c3a,#143d29);border:1px solid #4fbf7f;border-radius:14px;padding:12px;margin-bottom:12px}
.live .big{display:flex;align-items:baseline;gap:8px}.live .big b{font-size:34px}.live .big span{color:#c9dccf}
.pulse{display:inline-block;width:9px;height:9px;border-radius:50%;background:#7fd6a0;box-shadow:0 0 0 4px #7fd6a033;margin-right:6px;vertical-align:middle}
.lstats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;margin-top:8px;font-size:13px}
@media(min-width:760px){.lstats{grid-template-columns:repeat(4,minmax(0,1fr))}}
.lstats div{color:#c9dccf}.lstats b{color:#fff}
.health{margin-top:8px;font-size:12px;color:#a8f0c6}.health .w{color:#f2c14e}
.cmp{color:#8fae9c;font-size:12px;margin:-4px 0 10px}
.alerts{background:#11301f;border:1px solid #205237;border-radius:14px;padding:10px 12px;margin-bottom:12px}
.alerts h2{font-size:14px;margin:0 0 6px}
.al{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-top:1px solid #205237;font-size:13px}
.al:first-of-type{border-top:0}
.dot{flex:0 0 10px;height:10px;border-radius:50%;margin-top:5px}
.dot.bad{background:#ff8a80}.dot.good{background:#7fd6a0}.dot.watch{background:#f2c14e}
.al .chk{color:#8fae9c;font-size:12px}
.calm{color:#7fd6a0;font-size:13px}
.grp{background:#11301f;border:1px solid #205237;border-radius:14px;padding:12px;margin-bottom:12px}
.grp h3{font-size:14px;margin:0 0 8px;display:flex;justify-content:space-between;align-items:center}
.grp h3 a{font-size:12px;color:#f2c14e;text-decoration:none;font-weight:500}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
@media(min-width:760px){.tiles{grid-template-columns:repeat(4,minmax(0,1fr))}}
.tile{background:#143d29;border:1px solid #205237;border-radius:11px;padding:9px 10px;min-width:0}
.tile.bad{border-color:#ff8a80;box-shadow:inset 0 0 0 1px #ff8a8055}.tile.good{border-color:#7fd6a0}.tile.watch{border-color:#f2c14e}
.tile .k{font-size:11px;color:#8fae9c;line-height:1.3;min-height:28px}
.tile .v{font-size:21px;font-weight:700;margin-top:2px}
.tile .u{font-size:11px;color:#8fae9c;display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap}
.ch{font-weight:700}.ch.bad{color:#ff8a80}.ch.good{color:#7fd6a0}.ch.watch{color:#f2c14e}.ch.flat{color:#8fae9c}
.home{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}
@media(min-width:760px){.home{grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}}
.hb{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px;min-height:150px;background:#11301f;border:1px solid #205237;border-radius:18px;color:inherit;text-decoration:none;padding:14px}
@media(min-width:760px){.hb{min-height:190px}}
.hb:hover{background:#143d29}
.hb.daily{border-color:#f2c14e;background:linear-gradient(160deg,#2a3a1c,#11301f)}
.hb .ic{width:58px;height:58px;border-radius:16px;display:grid;place-items:center;font-size:30px;background:#1d5c3a}
.hb.daily .ic{background:#5c4a1d}.hb.games .ic{background:#3a3f5c}.hb.ads .ic{background:#5c3a2a}
.hb .nm{font-size:17px;font-weight:700}.hb .ds{font-size:12px;color:#8fae9c}
.kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:14px}
@media(min-width:760px){.kpis{grid-template-columns:repeat(4,minmax(0,1fr))}}
.rlist{background:#11301f;border:1px solid #205237;border-radius:14px;overflow:hidden}
.rrow{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:13px 14px;border-top:1px solid #205237;color:inherit;text-decoration:none}
.rrow:first-child{border-top:0}.rrow:hover{background:#143d29}
.rrow .arrow{color:#f2c14e;font-size:20px}
.rname{font-size:14px;font-weight:600}.rdesc{font-size:12px;color:#8fae9c}`;

const REPORT_CSS = BASE_CSS + `
.wrap{max-width:1120px;margin:0 auto;padding:14px 14px 40px}
@media(min-width:900px){.wrap{padding:24px 32px 48px}body{font-size:15px}}
h1{margin:2px 0 2px}.sub{margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media(min-width:700px){.cards{grid-template-columns:repeat(4,minmax(0,1fr))}}
.card{background:#143d29;border:1px solid #205237;border-radius:12px;padding:10px 12px;min-width:0}
.card .v{font-size:23px;font-weight:700}@media(min-width:900px){.card .v{font-size:29px}}
.card .k{font-size:11px;color:#8fae9c;text-transform:uppercase;letter-spacing:.04em}
.card .d{font-size:12px;margin-top:2px;color:#8fae9c}
.up{color:#7fd6a0!important}.down{color:#ff8a80!important}
.grid2{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;margin-top:14px}
@media(min-width:900px){.grid2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.sec{background:#11301f;border:1px solid #205237;border-radius:14px;padding:14px;margin-top:14px;min-width:0}
.grid2 .sec{margin-top:0}
.sec h2{font-size:15px;margin:0 0 2px}
.q{color:#8fae9c;font-size:12px;margin-bottom:10px}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;white-space:nowrap}
.tag.now{background:#1d5c3a;color:#a8f0c6}.tag.live{background:#5c4a1d;color:#f2d79a}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:7px 8px;border-bottom:1px solid #205237;white-space:nowrap;text-align:right}
th{color:#8fae9c;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
th:first-child,td:first-child{text-align:left;white-space:normal}
.sticky td:first-child,.sticky th:first-child{position:sticky;left:0;background:#11301f;min-width:128px;z-index:1}
.so{display:block;font-size:9px;color:#d9b45c;text-transform:none;letter-spacing:0}
td.fy,th.fy{background:#173f2a}
td.cur,th.cur{border-left:1px dashed #4d6659}
@media(max-width:600px){.old{display:none}
  .wrap{padding:12px 10px 36px}.sec{padding:12px 10px}
  table{font-size:12px}th,td{padding:6px 4px}th{font-size:10px;letter-spacing:0}
  .sticky td:first-child,.sticky th:first-child{min-width:104px;max-width:120px}
  tr.ind td:first-child{padding-left:12px}}
tr.total td{font-weight:700;border-top:1px solid #8fae9c}
tr.ind td:first-child{padding-left:20px;color:#c9dccf}
tr.grp td{color:#f2c14e;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding-top:14px;border-bottom:1px solid #2f7a4f}
.pct{color:#f2c14e;font-weight:600}
.insight{margin-top:14px;border-left:3px solid #f2c14e;background:#1a2a1e;border-radius:0 10px 10px 0;padding:10px 12px;font-size:13px}
.insight b{color:#f2c14e}
.funnel .fs{display:grid;grid-template-columns:minmax(0,42%) minmax(0,1fr) 84px;gap:8px;align-items:center;margin:7px 0;font-size:13px}
@media(min-width:900px){.funnel .fs{grid-template-columns:minmax(0,34%) minmax(0,1fr) 110px}}
.fb{height:14px;background:#0d1f16;border-radius:7px;overflow:hidden}
.fb i{display:block;height:100%;background:linear-gradient(90deg,#4fbf7f,#2f7a4f);border-radius:7px}
.fb i.bad{background:linear-gradient(90deg,#e07a6a,#9c4c42)}
.fn{text-align:right;white-space:nowrap}.fn small{color:#8fae9c}
.stack{display:flex;height:12px;border-radius:6px;overflow:hidden;background:#0d1f16;min-width:80px}
.stack i{display:block;height:100%}
.c1{background:#4fbf7f}.c2{background:#7d86d6}.c3{background:#d9b45c}.c4{background:#e07a6a}.c5{background:#5fb3c9}.c6{background:#9aa59f}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:#c9dccf;margin-top:8px}
.legend span::before{content:"";display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle;background:var(--c)}
.hb{display:grid;grid-template-columns:minmax(0,40%) minmax(0,1fr) 54px;gap:8px;align-items:center;margin:6px 0;font-size:13px}
.list .r{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #205237}
.list .nm{font-weight:600;font-size:14px;word-break:break-word}.list .mt{color:#8fae9c;font-size:12px}
.list .nu{text-align:right;white-space:nowrap;font-size:13px}
.pill{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:#1d5c3a;color:#a8f0c6;margin-left:6px}
.pill.web{background:#3a3f5c;color:#c3c8f0}
.coh td.c{font-weight:600;color:#0d1f16;text-align:center}
.heat{table-layout:fixed}
.heat th{text-align:center;padding:5px 2px}
.heat td.h{text-align:center;color:#0d1f16;font-weight:600;font-size:11px;padding:6px 2px}
.heat td:first-child{width:46px}
.spark{display:flex;align-items:flex-end;gap:2px;height:80px;margin-top:6px}
.spark i{flex:1;background:#4fbf7f;border-radius:2px 2px 0 0;min-width:2px}
.spark i.we{background:#d9b45c}.spark.gold i{background:#d9b45c}
.axis{display:flex;justify-content:space-between;font-size:11px;color:#8fae9c;margin-top:4px}
.kv{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;font-size:13px}
.kv div:nth-child(even){text-align:right;font-weight:600}
.okm{color:#7fd6a0;font-weight:700}.warnm{color:#ff8a80;font-weight:700}`;

const ICONS = { dashboard: '&#128200;', users: '&#128101;', games: '&#127183;', ads: '&#128250;' };
const BLOCK_NAMES = { users: 'Users', games: 'Games', ads: 'Ads' };

function doc(title, css, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><style>${css}</style></head><body><div class="wrap">
${inner}
</div></body></html>`;
}
function errLine(M) {
  return M && M.errors && M.errors.length
    ? `<div class="err">Could not read: ${esc(M.errors.join(', '))}. The numbers that use them are missing &ndash; try Refresh in a minute.</div>` : '';
}
function updated(M, L) {
  return `India time (IST) &middot; updated ${dayLabel(dayOf(M.dataAt))}, ${clock(M.dataAt)} &middot; <a href="${esc(L.refresh)}">Refresh</a>`;
}
function dashShell(M, L, { title, sub, body, back, crumb }) {
  const top = back
    ? `<div class="top"><a href="${esc(L.home)}">&larr; Admin reports</a><a href="/">Back to the game</a></div>`
    : '<div class="top"><span></span><a href="/">Back to the game</a></div>';
  return doc(title, DASH_CSS, `${top}
${errLine(M)}${crumb ? `<div class="crumb">${crumb}</div>` : ''}<h1>${title}</h1>
<div class="sub">${sub}</div>
${body}`);
}
function tileHtml(label, value, usualText, change, state) {
  return `<div class="tile${state ? ' ' + state : ''}"><div class="k">${label}</div><div class="v">${value}</div>`
    + `<div class="u"><span>${usualText}</span><span class="ch ${state || 'flat'}">${change}</span></div></div>`;
}

// ================================ home =====================================
function renderHome(M, L) {
  return dashShell(M, L, {
    title: 'Admin reports',
    sub: 'Only for your account &middot; ' + updated(M, L),
    back: false,
    body: `<div class="home">
<a class="hb daily" href="${esc(L.dashboard)}"><div class="ic">${ICONS.dashboard}</div><div class="nm">Dashboard</div><div class="ds">check daily</div></a>
<a class="hb users" href="${esc(L.users)}"><div class="ic">${ICONS.users}</div><div class="nm">Users</div><div class="ds">players &amp; churn</div></a>
<a class="hb games" href="${esc(L.games)}"><div class="ic">${ICONS.games}</div><div class="nm">Games</div><div class="ds">how games go</div></a>
<a class="hb ads" href="${esc(L.ads)}"><div class="ic">${ICONS.ads}</div><div class="nm">Ads</div><div class="ds">revenue &amp; ad health</div></a>
</div>`,
  });
}

// ============================== dashboard ==================================
function liveBlock(M, live) {
  if (!live) return '';
  const now = M.nowMs;
  const hh = String(ist(now).getUTCHours()).padStart(2, '0');
  const past = [1, 2, 3, 4].map((k) => M.days.get(addDays(M.today, -7 * k)))
    .filter((d) => d && d.hours && d.hours[hh] && d.hours[hh].online != null).map((d) => Number(d.hours[hh].online) || 0);
  const usualOnline = past.length ? Math.round(avgOf(past)) : null;
  const todayDoc = M.days.get(M.today) || {};
  const peak = live.peakToday && live.peakToday.n ? live.peakToday : (todayDoc.peak || null);
  const peakAt = peak && Date.parse(peak.at);
  const health = [];
  const started = Date.parse(live.startedAt || '');
  if (!Number.isNaN(started)) {
    health.push(now - started < 15 * 60 * 1000
      ? `<span class="w">&#9888; server restarted at ${clock(started)}</span>`
      : `&#10003; Server running since ${dayOf(started) === M.today ? clock(started) : dm(dayOf(started)) + ', ' + clock(started)}`);
  }
  let lastGame = Date.parse(live.lastGameEndAt || '');
  if (Number.isNaN(lastGame)) {
    const keyed = M.rows.filter((r) => r.key);
    lastGame = keyed.length ? keyed[keyed.length - 1].ms : NaN;
  }
  if (!Number.isNaN(lastGame)) {
    const mins = Math.round((now - lastGame) / 60000);
    const h = ist(now).getUTCHours();
    const ago = mins < 60 ? mins + ' min ago' : mins < 48 * 60 ? Math.round(mins / 60) + ' h ago' : 'on ' + dm(dayOf(lastGame));
    health.push(mins > 180 && h >= 10 ? `<span class="w">&#9888; no game finished for ${ago.replace(' ago', '')}</span>` : `&#10003; last game finished ${ago}`);
  }
  const bl = live.bannerLastHour || { loaded: 0, failed: 0 };
  const btotal = (bl.loaded || 0) + (bl.failed || 0);
  if (btotal) {
    health.push(bl.failed / btotal > 0.3
      ? `<span class="w">&#9888; banner failing: ${bl.failed} of ${btotal} loads in the last hour</span>`
      : '&#10003; banner OK in the last hour');
  } else health.push('<span class="dim">no banner loads in the last hour</span>');
  return `<div class="live"><div style="font-size:12px;color:#c9dccf"><span class="pulse"></span>Live &middot; ${clock(now)}</div>
<div class="big"><b>${fmtInt(live.online)}</b><span>online now</span></div>
<div class="cmp" style="margin:2px 0 0">${usualOnline == null ? 'usual for this hour: not known yet' : `usual at this hour on a ${WD_LONG[weekday(M.today)]}: ${usualOnline}`}</div>
<div class="lstats"><div>Playing a game <b>${fmtInt(live.playing)}</b></div><div>Tables running <b>${fmtInt(live.tables)}</b></div>
<div>Looking for a match <b>${fmtInt(live.searching)}</b></div><div>Peak today <b>${peak && peak.n ? fmtInt(peak.n) : DASH}</b>${peakAt ? ' at ' + clock(peakAt) : ''}</div></div>
<div class="health">${health.join(' &middot; ')}</div></div>`;
}

function periodPanel(M, L, P) {
  if (P.empty) return '<div class="empty">The month started today &ndash; see Today.</div>';
  const items = [];
  const groups = { users: [], games: [], ads: [] };
  for (const t of TILES) {
    const cur = measure(M, t, P.w, true);
    const usual = usualOf(M, t, P.usual);
    const state = judge(t, cur, usual);
    const label = P.today && (t.kind === 'count' || t.kind === 'money') ? t.label + ' so far' : t.label;
    const value = cur ? showValue(t, cur.v, M.currency) : DASH;
    const usualTxt = usual ? 'usual ' + showValue(t, usual.v, M.currency) : (cur ? 'no usual yet' : 'from go-live');
    groups[t.grp].push(tileHtml(label, value, usualTxt, cur && usual ? changeText(t, cur.v, usual.v) : '', state));
    if (state) items.push({ t, state, cur, usual, label: t.label });
  }
  const order = { bad: 0, watch: 1, good: 2 };
  items.sort((a, b) => order[a.state] - order[b.state]);
  const rows = items.map((x) => {
    const v = showValue(x.t, x.cur.v, M.currency);
    const u = showValue(x.t, x.usual.v, M.currency);
    let text;
    if (x.t.kind === 'pct' || x.t.kind === 'rate') text = `<b>${x.label}: ${v}</b> (${P.noun}: ${u})`;
    else {
      const rel = x.usual.v ? Math.round((Math.abs(x.cur.v - x.usual.v) / x.usual.v) * 100) : null;
      const more = x.cur.v > x.usual.v;
      const word = x.t.kind === 'money' ? (more ? 'more' : 'less') : (more ? 'more' : 'fewer');
      text = `<b>${x.label} ${v}</b> &ndash; ${rel == null ? word : rel + '% ' + word} than ${P.noun} (${u})`;
    }
    const hint = (HINTS[x.t.id] || {})[x.state === 'good' ? 'good' : 'bad'] || '';
    return `<div class="al"><span class="dot ${x.state}"></span><div><div>${text}</div>${hint ? `<div class="chk">${hint}</div>` : ''}</div></div>`;
  }).join('');
  const alerts = items.length
    ? `<div class="alerts"><h2>Unusual activity (${items.length})</h2>${rows}</div>`
    : '<div class="alerts"><h2>Unusual activity</h2><div class="calm">Nothing unusual &ndash; everything within its normal range.</div></div>';
  const grp = (name, href, link, tiles) => `<div class="grp"><h3>${name}<a href="${esc(href)}">${link} &rsaquo;</a></h3><div class="tiles">${tiles.join('')}</div></div>`;
  return alerts + grp('Users', L.users, 'Users reports', groups.users)
    + grp('Games', L.games, 'Games reports', groups.games) + grp('Ads', L.ads, 'Ads reports', groups.ads);
}

function renderDashboard(M, L, live) {
  const P = periods(M);
  const radios = P.map((p, i) => `<input class="tab" type="radio" name="t" id="${p.id}"${i === 0 ? ' checked' : ''}>`).join('');
  const labels = P.map((p) => `<label for="${p.id}">${p.name}</label>`).join('');
  const panels = P.map((p, i) => `<div class="panel p${i}"><div class="cmp">${p.cmp}</div>${i === 0 ? liveBlock(M, live) : ''}${periodPanel(M, L, p)}</div>`).join('\n');
  return dashShell(M, L, {
    title: 'Dashboard',
    sub: updated(M, L),
    back: true,
    crumb: 'Check daily',
    body: `${radios}<div class="tabs">${labels}</div><div class="panels">${panels}</div>
<div class="notes"><b>Today</b> is compared with the usual level by the same time on the same weekday; <b>Online now</b> is live.
<b>Unusual</b> = about 30% or more away from usual, and big enough to matter. Red = a problem to look at, green = unusually good,
gold = moving the wrong way, but on small numbers. Numbers marked &ldquo;from go-live&rdquo; start with this version, so they have no
usual level for their first weeks. Numbers are up to 10 minutes old (Refresh reads them again); &ldquo;online now&rdquo; is always live.</div>`,
  });
}

// ============================== block pages ================================
const REPORTS = {
  users: [
    ['users-growth', 'Growth &amp; active users', 'Roll-forward and churn, new users, app vs website'],
    ['users-first', 'Visitors &amp; first experience', 'First visit &rarr; player, first game mode, tutorial'],
    ['users-retention', 'Retention &amp; churn', 'By joining month, who leaves and why, at risk, came back'],
    ['users-engagement', 'Engagement, friends &amp; top players', 'Games per user, friends vs solo, invites, top players'],
  ],
  games: [
    ['games-completion', 'Games played &amp; completion', 'Games to a winner, player results, when people walk out'],
    ['games-modes', 'Modes &amp; matchmaking', 'Modes, friends rooms, online matches, bot level, joins'],
    ['games-experience', 'Game experience &amp; fairness', 'Takeovers, lost connections, wrong calls, card fairness'],
    ['games-when', 'When people play', 'Busy hours and days, best times to post, notify, deploy'],
  ],
  ads: [
    ['ads-revenue', 'Ad revenue', 'By ad type, per 1,000 shows, per player and per game'],
    ['ads-shown', 'Ads shown &amp; ad health', 'Ads seen, full-screen due &rarr; shown, rewarded, banner'],
    ['ads-players', 'Ads &amp; players', 'Leaving after ads, ads seen vs staying, taps'],
  ],
};
// This month so far against the same days (and hours) of last month.
function monthToDate(M) {
  const m0 = monthStart(M.curMonth);
  const prevM = shiftMonth(M.curMonth, -1);
  const pm0 = monthStart(prevM);
  return { w: { from: m0, to: M.nowMs, live: true }, usual: [{ from: pm0, to: Math.min(pm0 + (M.nowMs - m0), m0) }], prevM };
}
function kpiTile(M, tile, label, P) {
  const cur = measure(M, tile, P.w, true);
  const usual = usualOf(M, tile, P.usual);
  const state = judge(tile, cur, usual);
  return tileHtml(label, cur ? showValue(tile, cur.v, M.currency) : DASH,
    `${monShort(P.prevM)}: ${usual ? showValue(tile, usual.v, M.currency) : (cur ? 'before go-live' : 'from go-live')}`,
    cur && usual ? changeText(tile, cur.v, usual.v) : '', state);
}
const tileById = (id) => TILES.find((t) => t.id === id);
function fsEcpm(M, w) {
  let rev = 0;
  let shown = 0;
  for (const p of dayParts(w)) {
    const d = M.days.get(p.day);
    if (d) { rev += g2(d, 'rev', 'fs'); shown += g2(d, 'ads', 'fs', 'shown'); }
  }
  return { v: shown ? (rev / shown) * 1000 : null, n: shown };
}
function renderBlock(M, L, block) {
  const P = monthToDate(M);
  const mName = monthLabel(M.curMonth).split(' ')[0];
  const pName = monthLabel(P.prevM).split(' ')[0];
  let kpis = [];
  if (block === 'users') {
    const total = [...M.people.values()].length;
    const atPrevEnd = [...M.people.values()].filter((p) => p.before || (p.firstMs != null && p.firstMs < P.w.from)).length;
    const um = M.um.months;
    const closed = um.filter((m) => !m.inProgress);
    const last = closed[closed.length - 1];
    const prev = closed[closed.length - 2];
    const newState = judge(tileById('new'), measure(M, tileById('new'), P.w), usualOf(M, tileById('new'), P.usual));
    kpis = [
      tileHtml('Total users (ever)', fmtInt(total), `${pName} end: ${fmtInt(atPrevEnd)}`, total - atPrevEnd > 0 ? '+' + (total - atPrevEnd) : '0', newState === 'good' ? 'good' : ''),
      kpiTile(M, tileById('active'), `Active this month`, P),
      kpiTile(M, tileById('new'), 'New users this month', P),
      tileHtml(`Churn last month${last ? ' (' + monShort(last.month) + ')' : ''}`, last && last.churnPct != null ? last.churnPct + '%' : DASH,
        `${prev ? monShort(prev.month) : 'before'}: ${prev && prev.churnPct != null ? prev.churnPct + '%' : DASH}`,
        last && prev && last.churnPct != null && prev.churnPct != null ? changeText({ kind: 'pct' }, last.churnPct / 100, prev.churnPct / 100) : '',
        last && prev && last.churnPct != null && prev.churnPct != null && last.churnPct - prev.churnPct >= 10 ? 'bad' : ''),
    ];
  } else if (block === 'games') {
    kpis = [
      kpiTile(M, tileById('games'), 'Games to a winner', P),
      kpiTile(M, tileById('fin'), 'Players who finished', P),
      kpiTile(M, tileById('nobody'), 'Friends rooms nobody joined', P),
      kpiTile(M, { kind: 'pct', better: 'up', src: 'live', f: searchMatched }, 'Online: found a match', P),
    ];
  } else {
    kpis = [
      kpiTile(M, tileById('rev'), 'Ad revenue', P),
      kpiTile(M, tileById('rpu'), 'Per app user', P),
      kpiTile(M, { kind: 'money', better: 'up', src: 'live', f: fsEcpm }, 'Full-screen eCPM', P),
      kpiTile(M, tileById('banner'), 'Banner loaded', P),
    ];
  }
  const list = REPORTS[block].map(([id, n, d]) => `<a class="rrow" href="${esc(L.report(id))}"><div><div class="rname">${n}</div><div class="rdesc">${d}</div></div><span class="arrow">&rsaquo;</span></a>`).join('');
  return dashShell(M, L, {
    title: BLOCK_NAMES[block],
    sub: `${mName} so far, against the same days of ${pName} &middot; ${updated(M, L)}`,
    back: true,
    body: `<div class="kpis">${kpis.join('')}</div><div class="rlist">${list}</div>`,
  });
}

// ============================== report kit =================================
function reportPage(M, L, { block, title, sub, cards, body, notes }) {
  const cardsHtml = cards.map(([v, k, d, cls]) => `<div class="card"><div class="v">${v}</div><div class="k">${k}</div>`
    + (d ? `<div class="d ${cls || ''}">${d}</div>` : '') + '</div>').join('');
  return doc(title.replace(/&amp;/g, '&').replace(/<[^>]+>/g, ''), REPORT_CSS, `<div class="top"><a href="${esc(L[block])}">&larr; ${BLOCK_NAMES[block]}</a><a href="/">Back to the game</a></div>
${errLine(M)}<div class="crumb">${BLOCK_NAMES[block]}</div>
<h1>${title}</h1>
<div class="sub">${sub} &middot; ${updated(M, L)}</div>
<div class="cards">${cardsHtml}</div>
${body}
<div class="notes">${notes}</div>`);
}
function sec(title, q, tag, inner, insight) {
  const t = tag === 'now' ? '<span class="tag now">your data now</span>' : '<span class="tag live">from go-live</span>';
  return `<div class="sec"><h2>${title}${t}</h2><div class="q">${q}</div>${inner}`
    + (insight ? `<div class="insight"><b>What this tells us:</b> ${insight}</div>` : '') + '</div>';
}
const grid2 = (a, b) => `<div class="grid2">${a}${b}</div>`;
function notYet(M, what) {
  if (M.liveStartMs == null) return '<div class="empty">Starts filling when this version goes live.</div>';
  return `<div class="empty">Filling since ${dm(dayOf(M.liveStartMs))} &ndash; ${what || 'not enough yet'}.</div>`;
}
// Columns for a month-by-month table: the closed months of this financial
// year (April-March) that have data, the year so far, then this month so far.
// Before any month of a new year has closed (April), last year's months.
function monthCols(M, firstMonth) {
  const cur = M.curMonth;
  const lo = firstMonth || cur;
  let fy = fyOf(cur);
  const months = [];
  for (let m = fy + '-04'; m < cur; m = shiftMonth(m, 1)) if (m >= lo) months.push(m);
  let full = false;
  if (!months.length) {
    fy -= 1;
    for (let m = fy + '-04', i = 0; i < 12; m = shiftMonth(m, 1), i++) if (m >= lo && m < cur) months.push(m);
    full = true;
  }
  const cols = [];
  const shown = months.slice(-6);
  shown.forEach((m, i) => cols.push({ months: [m], m, label: monthLabel(m), cls: i < shown.length - 1 ? 'old' : '' }));
  if (months.length) cols.push({ months, fy: true, label: fyLabel(fy), cls: 'fy', so: full ? 'full year' : 'closed months' });
  cols.push({ months: [cur], m: cur, label: monthLabel(cur), cls: 'cur', so: 'so far', cur: true });
  return cols;
}
// rows: [label, f(column) -> html, class]; class 'grp' = a heading across.
function mtable(cols, rows) {
  const head = '<tr><th></th>' + cols.map((c) => `<th class="${c.cls}">${c.label}${c.so ? `<span class="so">${c.so}</span>` : ''}</th>`).join('') + '</tr>';
  const body = rows.map(([label, f, cls]) => {
    if (cls === 'grp') return `<tr class="grp"><td colspan="${cols.length + 1}">${label}</td></tr>`;
    return `<tr class="${cls || ''}"><td>${label}</td>` + cols.map((c) => {
      let v;
      try { v = f(c); } catch (e) { v = null; }
      return `<td class="${c.cls}">${v == null || v === '' ? DASH : v}</td>`;
    }).join('') + '</tr>';
  }).join('');
  return `<div class="scroll"><table class="sticky">${head}${body}</table></div>`;
}
function table(head, rows) {
  return `<div class="scroll"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>`
    + rows.map((r) => `<tr>${r.map((x) => `<td>${x == null ? DASH : x}</td>`).join('')}</tr>`).join('') + '</table></div>';
}
function funnel(steps) {
  const top = steps[0][1];
  return '<div class="funnel">' + steps.map(([label, n]) => {
    const p = top > 0 ? (100 * n) / top : 0;
    return `<div class="fs"><div>${label}</div><div class="fb"><i style="width:${p.toFixed(1)}%"></i></div>`
      + `<div class="fn">${fmtInt(n)} <small>${top > 0 ? Math.round(p) + '%' : ''}</small></div></div>`;
  }).join('') + '</div>';
}
function hbars(items, bad) {
  return items.map(([label, r]) => `<div class="hb"><div>${label}</div><div class="fb"><i class="${bad ? 'bad' : ''}" style="width:${ok(r) ? Math.max(0, Math.min(100, r * 100)).toFixed(1) : 0}%"></i></div>`
    + `<div class="fn">${fmtPct(r)}</div></div>`).join('');
}
function plist(rows) {
  return '<div class="list">' + rows.map(([nm, meta, nums, plat]) => `<div class="r"><div><div class="nm">${nm}`
    + (plat ? `<span class="pill${plat === 'Web' ? ' web' : ''}">${plat}</span>` : '') + `</div><div class="mt">${meta}</div></div><div class="nu">${nums}</div></div>`).join('') + '</div>';
}
const COLORS = { c1: '#4fbf7f', c2: '#7d86d6', c3: '#d9b45c', c4: '#e07a6a', c5: '#5fb3c9', c6: '#9aa59f' };
function stack(parts, height) {
  const shown = parts.filter((p) => p[1] > 0);
  return `<div class="stack" style="height:${height || 12}px">${shown.map(([c, s]) => `<i class="${c}" style="width:${(s * 100).toFixed(1)}%"></i>`).join('')}</div>`
    + `<div class="legend">${shown.map(([c, s, l]) => `<span style="--c:${COLORS[c]}">${l} ${Math.round(s * 100)}%</span>`).join('')}</div>`;
}
const kv = (pairs) => '<div class="kv">' + pairs.map(([k, v]) => `<div>${k}</div><div>${v == null ? DASH : v}</div>`).join('') + '</div>';
function spark(vals, labels, gold, weekends) {
  const max = Math.max(1, ...vals);
  return `<div class="spark${gold ? ' gold' : ''}">` + vals.map((v, i) => `<i class="${weekends && weekends[i] ? 'we' : ''}" style="height:${Math.max(1, (100 * v) / max).toFixed(0)}%"></i>`).join('')
    + `</div><div class="axis">${labels.map((x) => `<span>${x}</span>`).join('')}</div>`;
}
function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
const who = (p) => (p && p.name ? esc(p.name) : '(no name)') + (p ? ` <span class="dim">${esc(String(p.uid).slice(0, 6))}</span>` : '');
const platOf = (p) => (p && p.lastPlat === 'app' ? 'App' : p && p.lastPlat === 'web' ? 'Web' : '');
function ago(M, ms) {
  const d = Math.round((dayStart(M.today) - dayStart(dayOf(ms))) / DAY_MS);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago';
}
// Played on another day within 7 days of `day`.
function backWithin7(p, day) {
  const end = addDays(day, 7);
  for (const d of p.days) if (d > day && d <= end) return true;
  return false;
}
const last30 = (M) => ({ from: M.nowMs - 30 * DAY_MS, to: M.nowMs });
const pctSpan = (r) => (ok(r) ? `<span class="pct">${fmtPct(r)}</span>` : DASH);

// ============================== Users reports ==============================
function rUsersGrowth(M, L) {
  const um = M.um;
  const byM = new Map(um.months.map((m) => [m.month, m]));
  const cols = monthCols(M, um.months.length ? um.months[0].month : null);
  const agg = (c) => {
    const ms = c.months.map((m) => byM.get(m)).filter(Boolean);
    if (!ms.length) return null;
    if (!c.fy) return ms[0];
    return { fy: true, opening: ms[0].opening, newUsers: sumOf(ms, (x) => x.newUsers), cameBack: sumOf(ms, (x) => x.cameBack),
      wentInactive: sumOf(ms, (x) => x.wentInactive || 0), closing: ms[ms.length - 1].closing,
      totalUsers: ms[ms.length - 1].totalUsers, inactiveUsers: ms[ms.length - 1].inactiveUsers };
  };
  const v = (f) => (c) => { const a = agg(c); return a ? f(a, c) : null; };
  const star = (c) => (c.cur ? '*' : '');
  const rf = mtable(cols, [
    ['Opening active users', v((a) => (a.opening == null ? null : fmtInt(a.opening)))],
    ['+ New users', v((a) => fmtInt(a.newUsers)), 'ind'],
    ['+ Came back', v((a) => fmtInt(a.cameBack)), 'ind'],
    ['&minus; Became inactive', v((a, c) => (a.wentInactive == null ? null : fmtInt(a.wentInactive) + star(c))), 'ind'],
    ['Closing active users', v((a) => fmtInt(a.closing)), 'total'],
    ['Churn %', v((a, c) => (a.fy || a.churnPct == null ? null : `<span class="pct">${a.churnPct}%${star(c)}</span>`))],
    ['Total users (ever played)', v((a) => fmtInt(a.totalUsers))],
    ['Inactive users', v((a) => fmtInt(a.inactiveUsers))],
  ]);
  const newBy = (months) => {
    let all = 0; let app = 0; let web = 0;
    for (const m of months) {
      const x = byM.get(m);
      if (!x) continue;
      for (const u of x.lists.newUsers) {
        all += 1;
        const p = M.people.get(u.uid);
        if (p && p.firstPlat === 'app') app += 1; else if (p && p.firstPlat === 'web') web += 1;
      }
    }
    return { all, app, web };
  };
  const np = mtable(cols, [
    ['New users', (c) => fmtInt(newBy(c.months).all), 'total'],
    ['from the app', (c) => fmtInt(newBy(c.months).app), 'ind'],
    ['from the website', (c) => fmtInt(newBy(c.months).web), 'ind'],
    ['App share', (c) => { const x = newBy(c.months); return fmtPct(ratio(x.app, x.all)); }],
  ]);
  const plat = new Map();
  for (const r of M.rows) {
    let x = plat.get(r.month);
    if (!x) { x = { app: new Set(), web: new Set(), any: new Set() }; plat.set(r.month, x); }
    x.any.add(r.uid);
    if (r.app) x.app.add(r.uid);
    if (r.web) x.web.add(r.uid);
  }
  const moved = new Map();
  for (const p of M.people.values()) {
    let sawWeb = false;
    for (const r of p.rows) {
      if (r.web) sawWeb = true;
      if (r.app) { if (sawWeb) moved.set(r.month, (moved.get(r.month) || 0) + 1); break; }
    }
  }
  const stay = (m, kind) => {
    const nm = shiftMonth(m, 1);
    const x = plat.get(m);
    if (!x || nm > M.curMonth || !x[kind].size) return null;
    const nx = plat.get(nm);
    const kept = nx ? [...x[kind]].filter((u) => nx.any.has(u)).length : 0;
    return { r: kept / x[kind].size, partial: nm === M.curMonth };
  };
  const stayCell = (kind) => (c) => { if (c.fy) return null; const s = stay(c.m, kind); return s ? fmtPct(s.r) + (s.partial ? '*' : '') : null; };
  const pv = mtable(cols, [
    ['Active in the app', (c) => (c.fy ? null : fmtInt((plat.get(c.m) || { app: new Set() }).app.size))],
    ['Active on the website', (c) => (c.fy ? null : fmtInt((plat.get(c.m) || { web: new Set() }).web.size))],
    ['Moved website &rarr; app', (c) => fmtInt(sumOf(c.months, (m) => moved.get(m) || 0))],
    ['Stay next month: app', stayCell('app')],
    ['Stay next month: website', stayCell('web')],
  ]);
  const closed = um.months.filter((m) => !m.inProgress);
  const lc = closed[closed.length - 1];
  const pc = closed[closed.length - 2];
  const cur = um.months.find((m) => m.month === M.curMonth);
  let ins1 = null;
  if (lc && pc) {
    ins1 = `Active users went from ${pc.closing} in ${monShort(pc.month)} to ${lc.closing} in ${monShort(lc.month)}`;
    ins1 += lc.churnPct != null
      ? `; ${lc.churnPct}% of ${monShort(pc.month)}&rsquo;s players did not play in ${monShort(lc.month)}${lc.churnPct >= 40 ? ' &ndash; growth depends on new users replacing them' : ''}.`
      : '.';
  }
  const nb = lc ? newBy([lc.month]) : null;
  const ins2 = nb && nb.all ? `The app brought ${fmtPct(ratio(nb.app, nb.all))} of ${monShort(lc.month)}&rsquo;s new users.` : null;
  const sa = lc ? stay(lc.month, 'app') : null;
  const sw = lc ? stay(lc.month, 'web') : null;
  const ins3 = sa && sw ? (sw.r < sa.r
    ? `Website players come back less often (${fmtPct(sw.r)} vs ${fmtPct(sa.r)} in the app) &rarr; keep moving them to the app.`
    : `Website players come back as often as app players (${fmtPct(sw.r)} vs ${fmtPct(sa.r)}).`) : null;
  const body = sec('Active users roll-forward', 'Opening + new + came back &minus; became inactive = closing, each month.', 'now', rf, ins1)
    + grid2(sec('New users &amp; where they come from', 'App vs website, each month (where their first game was).', 'now', np, ins2),
      sec('App vs website', 'Who plays where, who moved to the app, and who comes back the next month.', 'now', pv, ins3));
  return reportPage(M, L, {
    block: 'users', title: 'Growth &amp; active users', sub: 'Months in India time (IST) &middot; FY = April&ndash;March',
    cards: [
      [fmtInt(um.summary.totalUsers), 'Total users (ever)', cur ? '+' + cur.newUsers + ' this month' : '', cur && cur.newUsers > 0 ? 'up' : ''],
      [fmtInt(cur ? cur.closing : 0), `Active ${monShort(M.curMonth)} (so far)`, lc ? `${monShort(lc.month)}: ${lc.closing}` : '', ''],
      [fmtInt(cur ? cur.newUsers : 0), `New users ${monShort(M.curMonth)}`, lc ? `${monShort(lc.month)}: ${lc.newUsers}` : '', ''],
      [lc && lc.churnPct != null ? lc.churnPct + '%' : DASH, `Churn ${lc ? monShort(lc.month) : ''}`, lc && lc.opening && pc ? `of ${lc.opening} active in ${monShort(pc.month)}` : '', 'down'],
    ],
    body,
    notes: '<b>Active</b> = played at least one round in the month (a game finished, or left part-way after real rounds). '
      + '<b>New</b> = their first game ever. <b>Came back</b> = played before, but not in the month before. '
      + '<b>Churn %</b> = became inactive &divide; opening. <b>FY</b> = the closed months of the financial year so far; the current month follows it. '
      + '* = the month is not over yet. The first month of the log has no opening (the month before it was not logged). '
      + 'On a phone the older months are hidden to fit; the laptop shows them all.',
  });
}

function rUsersFirst(M, L) {
  const logM = M.logStartMs != null ? monthOf(M.logStartMs) : null;
  const cols = monthCols(M, logM);
  const vis = new Map();
  if (M.accounts) {
    for (const a of M.accounts) {
      const m = monthOf(a.created);
      if (!logM || m < logM) continue;
      let x = vis.get(m);
      if (!x) { x = { n: 0, played: 0, finished: 0, back7: 0, next: 0 }; vis.set(m, x); }
      x.n += 1;
      const p = M.people.get(a.uid);
      if (!p || !p.rows.length) continue;
      x.played += 1;
      if (p.rows[0].done) x.finished += 1;
      if (backWithin7(p, p.firstDay)) x.back7 += 1;
      if (p.months.has(shiftMonth(m, 1))) x.next += 1;
    }
  }
  const vs = (c, k) => sumOf(c.months, (m) => (vis.get(m) || {})[k] || 0);
  const lcM = shiftMonth(M.curMonth, -1);
  const lv = vis.get(lcM);
  let top;
  if (!M.accounts) top = '<div class="empty">The sign-in accounts could not be read, so first visits are not known right now.</div>';
  else if (!lv || !lv.n) top = `<div class="empty">No first visits recorded for ${monthLabel(lcM)}.</div>`;
  else {
    top = funnel([['First-time visitors', lv.n], ['Played at least one round', lv.played], ['Finished their first game', lv.finished],
      ['Came back another day (within 7 days)', lv.back7], [`Played again in ${monShort(M.curMonth)} (so far)`, lv.next]]);
  }
  const ins1 = lv && lv.n ? (ratio(lv.played, lv.n) < 0.5
    ? `<b>${Math.round((1 - lv.played / lv.n) * 10)} in 10</b> first-time visitors never played a round &ndash; the biggest leak. The home screen and the first minute matter most.`
    : `${fmtPct(ratio(lv.played, lv.n))} of first-time visitors played a round.`) : null;
  const monthly = mtable(cols, [
    ['First-time visitors', (c) => fmtInt(vs(c, 'n'))],
    ['Played a round', (c) => fmtInt(vs(c, 'played'))],
    ['Visitor &rarr; player %', (c) => pctSpan(ratio(vs(c, 'played'), vs(c, 'n')))],
    ['Finished first game', (c) => fmtInt(vs(c, 'finished'))],
    ['Came back within 7 days', (c) => fmtInt(vs(c, 'back7')) + (c.cur ? '*' : '')],
  ]);
  // From go-live: what new players started with, and the tutorial.
  const fresh = M.liveStartMs == null ? [] : M.newcomers.filter((p) => p.firstMs >= M.liveStartMs);
  const sevenAgo = addDays(M.today, -7);
  const outcome = (list) => {
    const base = list.filter((p) => p.firstDay <= sevenAgo);
    return [fmtInt(list.length), fmtPct(ratio(list.filter((p) => p.rows[0] && p.rows[0].done).length, list.length)),
      base.length ? fmtPct(ratio(base.filter((p) => backWithin7(p, p.firstDay)).length, base.length)) : DASH];
  };
  const byMode = {};
  for (const p of fresh) {
    const gl = M.gamesBy.get(p.uid);
    if (!gl || !gl.length) continue;
    (byMode[gl[0].g.mode] = byMode[gl[0].g.mode] || []).push(p);
  }
  const modeRows = ['bots', 'friends', 'online', 'group'].filter((k) => byMode[k]).map((k) => [MODE_NAMES[k], ...outcome(byMode[k])]);
  const tut = new Map();
  for (const k of M.dayKeys) {
    const t = (M.days.get(k) || {}).tutorialBy;
    if (t && typeof t === 'object') for (const [uid, s] of Object.entries(t)) { if (s === 'done' || !tut.has(uid)) tut.set(uid, s === 'done' ? 'done' : 'skipped'); }
  }
  const tg = { done: [], skipped: [], none: [] };
  for (const p of fresh) tg[tut.get(p.uid) || 'none'].push(p);
  const tutRows = [['Did the tutorial', tg.done], ['Skipped it / said no', tg.skipped], ['Not offered (or not seen)', tg.none]]
    .filter(([, l]) => l.length).map(([n, l]) => [n, ...outcome(l)]);
  const body = sec(`From first visit to regular player &ndash; ${monthLabel(lcM)}`, 'Every step a new person goes through, and how many make it.', 'now', top, ins1)
    + sec('Each month', 'The same steps, month by month (by the month of the first visit).', 'now', M.accounts ? monthly : '<div class="empty">Not available right now.</div>')
    + grid2(sec('First game mode', 'What new players started with, and how it went.', 'live',
      modeRows.length ? table(['Started with', 'New users', 'Finished 1st game', 'Back in 7 days'], modeRows) : notYet(M, 'no new players with a recorded first game yet')),
    sec('Tutorial', 'Did the guided tutorial help new players?', 'live',
      tutRows.length ? table(['Tutorial', 'New users', 'Finished 1st game', 'Back in 7 days'], tutRows) : notYet(M, 'no new players yet')));
  return reportPage(M, L, {
    block: 'users', title: 'Visitors &amp; first experience', sub: `How new people find their way into the game &middot; ${monthLabel(lcM)} is the last closed month`,
    cards: [
      [lv ? fmtInt(lv.n) : DASH, `First-time visitors ${monShort(lcM)}`, '', ''],
      [lv ? fmtPct(ratio(lv.played, lv.n), 1) : DASH, 'Played a round', lv ? `${lv.played} of ${lv.n}` : '', ''],
      [lv ? fmtPct(ratio(lv.finished, lv.played)) : DASH, 'Finished 1st game', lv ? `${lv.finished} of ${lv.played} players` : '', ''],
      [lv ? fmtPct(ratio(lv.back7, lv.played)) : DASH, 'Came back in 7 days', lv ? `${lv.back7} of ${lv.played}` : '', ''],
    ],
    body,
    notes: '<b>First-time visitor</b> = the first time the game was opened on a phone or in a browser (the date its sign-in account was made). '
      + '<b>Finished their first game</b> = played it to the end (won, or knocked out). <b>Back in 7 days</b> = played again on another day within a week of the first game; '
      + 'in the tables below only players whose first game is a week old count. * = still filling. <b>From go-live</b> sections start filling from the deploy day.',
  });
}

function rUsersRetention(M, L) {
  const cur = M.curMonth;
  const coh = groupBy(M.newcomers, (p) => p.firstMonth);
  const cohM = [...coh.keys()].sort().slice(-6);
  const K = 4;
  const cell = (r, partial) => (ok(r)
    ? `<td class="c" style="background:rgba(127,214,160,${(0.15 + 0.85 * r).toFixed(2)})">${Math.round(r * 100)}%${partial ? '*' : ''}</td>` : '<td></td>');
  let ct = '<div class="scroll"><table class="coh sticky"><tr><th>Joined</th><th>Users</th>'
    + Array.from({ length: K }, (_, i) => `<th>Month ${i + 1}</th>`).join('') + '</tr>';
  for (const m of cohM) {
    const ppl = coh.get(m);
    ct += `<tr><td>${monthLabel(m)}</td><td>${ppl.length}</td>`;
    for (let k = 0; k < K; k++) {
      const mk = shiftMonth(m, k);
      ct += mk > cur ? '<td></td>' : cell(ppl.filter((p) => p.months.has(mk)).length / ppl.length, mk === cur && k > 0);
    }
    ct += '</tr>';
  }
  ct += '</table></div>';
  const prevC = cohM.filter((m) => shiftMonth(m, 1) < cur);
  const lastFull = prevC[prevC.length - 1];
  const stay1 = lastFull ? coh.get(lastFull).filter((p) => p.months.has(shiftMonth(lastFull, 1))).length / coh.get(lastFull).length : null;
  // Who churns most: the last two closed months.
  const a = shiftMonth(cur, -2);
  const b = shiftMonth(cur, -1);
  const actIn = (m) => {
    const s = new Map();
    for (const r of M.rows) {
      if (r.month !== m) continue;
      let x = s.get(r.uid);
      if (!x) { x = { app: false, web: false, multi: false }; s.set(r.uid, x); }
      if (r.app) x.app = true;
      if (r.web) x.web = true;
      if (r.multi) x.multi = true;
    }
    return s;
  };
  const A = actIn(a);
  const B = actIn(b);
  const C = actIn(cur);
  let seg = '';
  let segIns = null;
  if (A.size && M.logStartMs != null && monthOf(M.logStartMs) <= a) {
    const groups = [
      ['New users', (u) => { const p = M.people.get(u); return p.firstMonth === a && !p.before; }],
      ['Existing users', (u) => { const p = M.people.get(u); return !(p.firstMonth === a && !p.before); }],
      ['Website', (u, x) => x.web], ['App', (u, x) => x.app],
      ['Bots only', (u, x) => !x.multi], ['Plays with other people', (u, x) => x.multi],
    ];
    const res = groups.map(([n, f]) => {
      const base = [...A.entries()].filter(([u, x]) => f(u, x));
      return [n, base.length, base.length ? base.filter(([u]) => !B.has(u)).length / base.length : null];
    }).filter((x) => x[1] > 0);
    seg = hbars(res.map(([n, c, r]) => [`${n} <span class="dim">(${c})</span>`, r]), true);
    const worst = res.filter((x) => x[1] >= 5).sort((x, y) => y[2] - x[2])[0];
    if (worst) segIns = `${worst[0]} left most often (${fmtPct(worst[2])} of ${worst[1]}).`;
  } else seg = '<div class="empty">Needs two full months of games.</div>';
  // Why they left: the last game of players with no game for 14 days.
  const cats = { out: 0, walked: 0, won: 0, bot: 0, lost: 0 };
  let stopped = 0;
  if (M.liveStartMs != null) {
    for (const p of M.people.values()) {
      if (!p.lastMs || p.lastMs > M.nowMs - 14 * DAY_MS || p.lastMs < M.liveStartMs) continue;
      const gl = M.gamesBy.get(p.uid);
      if (!gl || !gl.length) continue;
      const { pl } = gl[gl.length - 1];
      stopped += 1;
      if (pl.lost > 0 && pl.result !== 'won') cats.lost += 1;
      else if (pl.result === 'missed-turns' || (pl.takeovers > 0 && pl.result !== 'won')) cats.bot += 1;
      else if (pl.result === 'won') cats.won += 1;
      else if (pl.result === 'walked-out') cats.walked += 1;
      else cats.out += 1;
    }
  }
  const why = stopped >= 5 ? stack([['c4', cats.out / stopped, 'Lost (knocked out)'], ['c6', cats.walked / stopped, 'Walked out'],
    ['c1', cats.won / stopped, 'Won'], ['c2', cats.bot / stopped, 'Bot took over (missed turns)'], ['c5', cats.lost / stopped, 'Lost connection']], 16)
    : notYet(M, 'not enough players have stopped since then');
  const whyIns = stopped >= 5 && (cats.bot + cats.lost) / stopped >= 0.1
    ? `${fmtPct((cats.bot + cats.lost) / stopped)} left after a bad experience (a bot took over, or the connection dropped) &ndash; those are fixable.` : null;
  // At risk, and came back.
  const gamesB = new Map();
  for (const r of M.rows) if (r.month === b) gamesB.set(r.uid, (gamesB.get(r.uid) || 0) + (r.done ? 1 : 0));
  const risk = [...gamesB.entries()].filter(([u]) => !C.has(u)).map(([u, g]) => ({ p: M.people.get(u), g }))
    .sort((x, y) => y.g - x.g || y.p.lastMs - x.p.lastMs);
  const invited = new Set();
  for (const k of M.dayKeys) if (k.startsWith(cur)) { const ij = (M.days.get(k) || {}).invitedJoins; if (ij) Object.keys(ij).forEach((u) => invited.add(u)); }
  const back = [];
  for (const u of C.keys()) {
    const p = M.people.get(u);
    const first = p.rows.find((r) => r.month === cur);
    const prev = first ? p.rows[first.i - 1] : null;
    if (first && ((prev && first.ms - prev.ms >= 30 * DAY_MS) || (!prev && p.before))) back.push({ p, first, prev });
  }
  back.sort((x, y) => y.first.ms - x.first.ms);
  const riskList = risk.length ? plist(risk.slice(0, 8).map(({ p, g }) => [who(p), `last played ${dm(dayOf(p.lastMs))}`, `${g} game${g === 1 ? '' : 's'} in ${monShort(b)}`, platOf(p)]))
    + (risk.length > 8 ? `<div class="empty">&hellip; and ${risk.length - 8} more.</div>` : '') : '<div class="empty">Nobody &ndash; everyone from last month has played this month.</div>';
  const backList = back.length ? plist(back.slice(0, 8).map(({ p, first, prev }) => [who(p),
    `${prev ? 'away since ' + monShort(prev.month) : 'played before the log'} &middot; back ${dm(first.day)}`,
    invited.has(p.uid) ? 'joined through an invite' : 'on their own', platOf(p)])) : '<div class="empty">Nobody yet this month.</div>';
  const lcU = M.um.months.filter((m) => !m.inProgress);
  const lc = lcU[lcU.length - 1];
  const body = sec('Retention by joining month', 'Of the users who joined in a month, the share playing 1, 2, 3 and 4 months on (Month 1 = the month they joined).', 'now',
    cohM.length ? ct : '<div class="empty">No new users yet.</div>',
    ok(stay1) ? `${fmtPct(stay1)} of ${monthLabel(lastFull)}&rsquo;s new users played again the month after.` : null)
    + grid2(sec(`Who churns most &ndash; ${monShort(a)} &rarr; ${monShort(b)}`, `Of the players active in ${monShort(a)}, the share who did not play in ${monShort(b)}, by kind of player.`, 'now', seg, segIns),
      sec('Why they left &ndash; their last game', 'Players with no game for 14 days or more: what happened in their last game.', 'live', why, whyIns))
    + grid2(sec(`At risk now (${risk.length})`, `Played in ${monShort(b)}, not yet in ${monShort(cur)} &ndash; most games first.`, 'now', riskList),
      sec(`Came back in ${monShort(cur)} (${back.length})`, 'Away a month or more, now playing again.', 'now', backList));
  return reportPage(M, L, {
    block: 'users', title: 'Retention &amp; churn', sub: 'Who stays, who leaves, and why',
    cards: [
      [lc && lc.churnPct != null ? lc.churnPct + '%' : DASH, `Churn ${lc ? monShort(lc.month) : ''}`, lc && lc.opening ? `${lc.wentInactive} of ${lc.opening} left` : '', 'down'],
      [ok(stay1) ? fmtPct(stay1) : DASH, 'Stay after month 1', lastFull ? `${monShort(lastFull)} joiners` : '', ''],
      [fmtInt(risk.length), 'At risk now', `played ${monShort(b)}, not ${monShort(cur)}`, risk.length ? 'down' : ''],
      [fmtInt(back.length), `Came back ${monShort(cur)}`, 'after a break', back.length ? 'up' : ''],
    ],
    body,
    notes: '<b>Month 1</b> = the month they joined (always 100%). <b>At risk</b> = active last month, no game yet this month &ndash; the list to remind first. '
      + '<b>Came back</b> = no game for 30 days or more before. Names are as players typed them; the grey code is the start of their account id.',
  });
}

function rUsersEngagement(M, L) {
  const cur = M.curMonth;
  const pm = new Map();
  for (const r of M.rows) {
    let mm = pm.get(r.month);
    if (!mm) { mm = new Map(); pm.set(r.month, mm); }
    let x = mm.get(r.uid);
    if (!x) { x = { g: 0, days: new Set(), multi: false }; mm.set(r.uid, x); }
    if (r.done) x.g += 1;
    x.days.add(r.day);
    if (r.multi) x.multi = true;
  }
  const st = (months) => {
    const s = { n: 0, g: 0, d: 0, light: 0, med: 0, heavy: 0, heavyG: 0, multi: 0 };
    for (const m of months) {
      const mm = pm.get(m);
      if (!mm) continue;
      for (const x of mm.values()) {
        s.n += 1; s.g += x.g; s.d += x.days.size;
        if (x.g <= 1) s.light += 1; else if (x.g <= 5) s.med += 1; else { s.heavy += 1; s.heavyG += x.g; }
        if (x.multi) s.multi += 1;
      }
    }
    return s;
  };
  const cols = monthCols(M, M.logStartMs != null ? monthOf(M.logStartMs) : null);
  const star = (c) => (c.cur ? '*' : '');
  const eng = mtable(cols, [
    ['Games per active user', (c) => { const s = st(c.months); return s.n ? fmtNum(s.g / s.n, 1) + star(c) : null; }],
    ['Active days per user', (c) => { const s = st(c.months); return s.n ? fmtNum(s.d / s.n, 1) + star(c) : null; }],
    ['Light (0&ndash;1 game)', (c) => { const s = st(c.months); return s.n ? fmtPct(s.light / s.n) + star(c) : null; }, 'ind'],
    ['Medium (2&ndash;5 games)', (c) => { const s = st(c.months); return s.n ? fmtPct(s.med / s.n) + star(c) : null; }, 'ind'],
    ['Heavy (6+ games)', (c) => { const s = st(c.months); return s.n ? fmtPct(s.heavy / s.n) + star(c) : null; }, 'ind'],
  ]);
  const lcM = shiftMonth(cur, -1);
  const ls = st([lcM]);
  const mix = ls.n ? stack([['c3', ls.light / ls.n, 'Light'], ['c2', ls.med / ls.n, 'Medium'], ['c1', ls.heavy / ls.n, 'Heavy']], 16) : '<div class="empty">No games last month.</div>';
  const mixIns = ls.n && ls.g && ls.heavy ? `${fmtPct(ls.heavy / ls.n)} of players (the heavy ones) played ${fmtPct(ls.heavyG / ls.g)} of all finished games &ndash; keep them happy.` : null;
  const stayBy = (m, multi) => {
    const nm = shiftMonth(m, 1);
    const mm = pm.get(m);
    if (!mm || nm > cur) return null;
    const nx = pm.get(nm) || new Map();
    const base = [...mm.entries()].filter(([, x]) => x.multi === multi);
    return base.length ? { r: base.filter(([u]) => nx.has(u)).length / base.length, partial: nm === cur } : null;
  };
  const dayDocs = (months) => M.dayKeys.filter((k) => months.includes(k.slice(0, 7))).map((k) => M.days.get(k) || {});
  const invitedIn = (months) => {
    const s = new Set();
    for (const d of dayDocs(months)) if (d.invitedJoins) Object.keys(d.invitedJoins).forEach((u) => s.add(u));
    return s;
  };
  const liveM = M.liveStartMs != null ? monthOf(M.liveStartMs) : null;
  const isLive = (c) => liveM && c.months.some((m) => m >= liveM);
  const soc = mtable(cols, [
    ['Play with other people', (c) => { const s = st(c.months); return fmtPct(ratio(s.multi, s.n)); }],
    ['Stay next month: with others', (c) => { if (c.fy) return null; const s = stayBy(c.m, true); return s ? fmtPct(s.r) + (s.partial ? '*' : '') : null; }],
    ['Stay next month: bots only', (c) => { if (c.fy) return null; const s = stayBy(c.m, false); return s ? fmtPct(s.r) + (s.partial ? '*' : '') : null; }],
    ['Invites sent', (c) => (isLive(c) ? fmtInt(sumOf(dayDocs(c.months), (d) => d.invites)) : null)],
    ['Invited people who played', (c) => (isLive(c) ? fmtInt(invitedIn(c.months).size) : null)],
    ['New players per player', (c) => {
      if (!isLive(c)) return null;
      const s = st(c.months);
      const inv = [...invitedIn(c.months)].filter((u) => { const p = M.people.get(u); return p && !p.before && c.months.includes(p.firstMonth); }).length;
      return s.n ? fmtNum(inv / s.n, 2) : null;
    }],
  ]);
  const so = stayBy(lcM, true);
  const sb = stayBy(lcM, false);
  const socIns = so && sb ? (so.r > sb.r
    ? `Players who play with other people come back more often (${fmtPct(so.r)} vs ${fmtPct(sb.r)}) &rarr; make inviting friends easy.`
    : `Bots-only players come back as often as social players (${fmtPct(sb.r)} vs ${fmtPct(so.r)}).`) : null;
  const tp = new Map();
  for (const r of rowsIn(M, last30(M))) {
    let x = tp.get(r.uid);
    if (!x) { x = { g: 0, days: new Set(), last: 0 }; tp.set(r.uid, x); }
    if (r.done) x.g += 1;
    x.days.add(r.day);
    x.last = r.ms;
  }
  const top = [...tp.entries()].sort((a, b) => b[1].g - a[1].g || b[1].days.size - a[1].days.size).slice(0, 10)
    .map(([u, x]) => { const p = M.people.get(u); return [who(p), `${x.days.size} active day${x.days.size === 1 ? '' : 's'} &middot; last played ${ago(M, x.last)}`, `${x.g} game${x.g === 1 ? '' : 's'}`, platOf(p)]; });
  const cs = st([cur]);
  const invCur = [...invitedIn([cur])].filter((u) => { const p = M.people.get(u); return p && !p.before && p.firstMonth === cur; }).length;
  const body = sec('How much active users play', 'Finished games and active days per user, and light / medium / heavy players.', 'now', eng)
    + grid2(sec(`Light, medium, heavy &ndash; ${monthLabel(lcM)}`, 'Share of active users by finished games in the month.', 'now', mix, mixIns),
      sec('With other people vs bots only', 'Who plays with others (friends, groups or online), who comes back, and how invites spread the game.', 'now', soc, socIns))
    + sec('Top players &ndash; last 30 days', 'Your most active players.', 'now', top.length ? plist(top) : '<div class="empty">No games in the last 30 days.</div>',
      top.length ? 'Ask them for feedback first &ndash; they know the game best.' : null);
  return reportPage(M, L, {
    block: 'users', title: 'Engagement, friends &amp; top players', sub: 'How much people play, who they play with, and your best players',
    cards: [
      [ls.n ? fmtNum(ls.g / ls.n, 1) : DASH, `Games / user ${monShort(lcM)}`, '', ''],
      [ls.n ? fmtNum(ls.d / ls.n, 1) : DASH, `Active days ${monShort(lcM)}`, '', ''],
      [fmtPct(ratio(ls.multi, ls.n)), 'Play with others', monthLabel(lcM), ''],
      [liveM ? fmtNum(cs.n ? invCur / cs.n : 0, 2) : DASH, 'New players / player', `invites, ${monShort(cur)}`, ''],
    ],
    body,
    notes: '<b>Games</b> = finished games (played to the end, or knocked out). <b>Light</b> also includes players who only left games part-way. '
      + '<b>Play with other people</b> = at least one game with another person at the table. '
      + '<b>Invites</b> count from go-live: the app notes each invite shared and each invited person who joins.',
  });
}

// ============================== Games reports ==============================
const liveMonth = (M) => (M.liveStartMs != null ? monthOf(M.liveStartMs) : null);
const gamesOfCol = (M) => {
  const byMonth = groupBy(M.games, (g) => g.month);
  return (c) => c.months.flatMap((m) => byMonth.get(m) || []);
};
const cnt = (arr, f) => arr.filter(f).length;

function rGamesCompletion(M, L) {
  const cols = monthCols(M, liveMonth(M));
  const G = gamesOfCol(M);
  const P = (c) => G(c).flatMap((g) => g.players);
  const res = (r) => (c) => (G(c).length ? fmtInt(cnt(P(c), (p) => p.result === r)) : null);
  const anyStill = M.games.some((g) => g.players.some((p) => p.result === 'still-in'));
  const rows = [
    ['Games &ndash; the whole game, start to end', null, 'grp'],
    ['Games started', (c) => fmtInt(G(c).length), 'total'],
    ['Played to a winner', (c) => (G(c).length ? fmtInt(cnt(G(c), (g) => g.outcome === 'winner')) : null), 'ind'],
    ['Every person knocked out (bots finished it)', (c) => (G(c).length ? fmtInt(cnt(G(c), (g) => g.outcome === 'all-knocked-out')) : null), 'ind'],
    ['Ended early (everyone left)', (c) => (G(c).length ? fmtInt(cnt(G(c), (g) => g.outcome === 'ended-early')) : null), 'ind'],
    ['Games completed %', (c) => (G(c).length ? pctSpan(ratio(cnt(G(c), toEnd), G(c).length)) : null)],
    ['Rounds per game', (c) => { const e = G(c).filter(toEnd); return e.length ? fmtNum(avgOf(e.map((g) => g.rounds)), 1) : null; }],
    ['Minutes per game', (c) => { const e = G(c).filter(toEnd); return e.length ? fmtNum(avgOf(e.map((g) => g.secs / 60)), 0) : null; }],
    ['Players &ndash; each player&rsquo;s own game', null, 'grp'],
    ['Players in games', (c) => fmtInt(P(c).length), 'total'],
    ['Won', res('won'), 'ind'],
    ['Knocked out on score', res('knocked-out'), 'ind'],
  ];
  if (anyStill) rows.push(['Still in at the end', res('still-in'), 'ind']);
  rows.push(
    ['Out for missed turns', res('missed-turns'), 'ind'],
    ['Walked out', res('walked-out'), 'ind'],
    ['Players who finished %', (c) => (P(c).length ? pctSpan(ratio(cnt(P(c), (p) => FINISHED.has(p.result)), P(c).length)) : null)],
    ['Rounds a player plays', (c) => (P(c).length ? fmtNum(avgOf(P(c).map((p) => p.rounds)), 1) : null)],
    ['Minutes a player plays', (c) => (P(c).length ? fmtNum(avgOf(P(c).map((p) => p.secs / 60)), 0) : null)],
  );
  const g30 = gamesEnded(M, last30(M));
  const p30 = g30.flatMap((g) => g.players);
  const walk = p30.filter((p) => p.result === 'walked-out');
  const B = [['Before finishing round 1', (r) => r <= 0], ['After round 1', (r) => r === 1], ['After round 2', (r) => r === 2], ['After round 3', (r) => r === 3],
    ['After rounds 4&ndash;6', (r) => r >= 4 && r <= 6], ['After rounds 7&ndash;10', (r) => r >= 7 && r <= 10], ['After round 11 or later', (r) => r >= 11]];
  const early = walk.length ? cnt(walk, (p) => p.rounds <= 2) / walk.length : null;
  const leave = walk.length >= 5 ? hbars(B.map(([n, f]) => [n, cnt(walk, (p) => f(p.rounds)) / walk.length]), true) : notYet(M, 'too few walk-outs yet');
  const modes = ['bots', 'friends', 'online', 'group'].map((k) => [k, g30.filter((g) => g.mode === k)]).filter(([, gs]) => gs.length);
  const bymode = modes.length ? hbars(modes.map(([k, gs]) => [`${MODE_NAMES[k]} <span class="dim">(${gs.length})</span>`, cnt(gs, toEnd) / gs.length])) : notYet(M);
  const worstMode = modes.filter(([, gs]) => gs.length >= 10).sort((a, b) => cnt(a[1], toEnd) / a[1].length - cnt(b[1], toEnd) / b[1].length)[0];
  const SB = [['100', (s) => s <= 100], ['150', (s) => s > 100 && s <= 150], ['200', (s) => s > 150 && s <= 200], ['250 or more', (s) => s > 200]];
  const scoreRows = SB.map(([n, f]) => {
    const gs = g30.filter((g) => f(Number(g.maxScore) || 0));
    if (!gs.length) return null;
    const e = gs.filter(toEnd);
    return [n, fmtPct(gs.length / g30.length), e.length ? fmtNum(avgOf(e.map((g) => g.secs / 60)), 0) : DASH, fmtPct(e.length / gs.length)];
  }).filter(Boolean);
  const fin30 = p30.length ? cnt(p30, (p) => FINISHED.has(p.result)) / p30.length : null;
  const e30 = g30.filter(toEnd);
  const body = sec('Games each month', 'Games played to the end, and every player&rsquo;s own result: won, knocked out, out for missed turns, or walked out.', 'live',
    M.games.length ? mtable(cols, rows) : notYet(M),
    ok(fin30) && p30.length >= 20 ? `${fmtPct(fin30)} of players finish their game (won or knocked out); ${fmtPct(cnt(p30, (p) => p.result === 'walked-out') / p30.length)} walk out.` : null)
    + grid2(sec('When players walk out &ndash; last 30 days', 'After how many of their rounds players still in the game walked out (knocked-out players are not counted).', 'live', leave,
      ok(early) && walk.length >= 10 && early >= 0.4 ? `<b>${fmtPct(early)} of those who walk out do it in their first 2 rounds</b> &ndash; the start of a game is where it loses them.` : null),
    sec('Played to the end, by mode &ndash; last 30 days', 'Share of games that reached the end.', 'live', bymode,
      worstMode ? `${MODE_NAMES[worstMode[0]]} games break most often.` : null))
    + sec('Max score chosen &ndash; last 30 days', 'Which game length players pick, and how it goes.', 'live',
      scoreRows.length ? table(['Max score', 'Share of games', 'Minutes', 'Finished'], scoreRows) : notYet(M));
  return reportPage(M, L, {
    block: 'games', title: 'Games played &amp; completion', sub: 'How many games, how long, and where they break',
    cards: [
      [fmtInt(e30.length), 'Games to the end', `last 30 days, of ${g30.length}`, ''],
      [fmtPct(fin30), 'Players who finished', 'won or knocked out', ''],
      [e30.length ? fmtNum(avgOf(e30.map((g) => g.secs / 60)), 0) + ' min' : DASH, 'Average game', e30.length ? fmtNum(avgOf(e30.map((g) => g.rounds)), 1) + ' rounds' : '', ''],
      [fmtPct(early), 'Walk out in rounds 1&ndash;2', 'of those who walk out', 'down'],
    ],
    body,
    notes: '<b>Rounds / minutes per game</b> = the whole game, from the deal to the end. <b>Rounds / minutes a player plays</b> = until that player won, '
      + 'was knocked out or walked out &ndash; shorter, because most players are out before the end. <b>Finished</b> (a player) = won, or knocked out on score: '
      + 'they played their game through. <b>Walked out</b> = left, or closed the app for good, while still in. <b>Played to the end</b> (a game) = reached a winner, '
      + 'or every person in it was knocked out (only bots were left). <b>Ended early</b> = every person left first. All of this starts from go-live.',
  });
}

function rGamesModes(M, L) {
  const g30 = gamesEnded(M, last30(M));
  const sevenAgo = addDays(M.today, -7);
  const modeRows = ['bots', 'friends', 'online', 'group'].map((k) => {
    const gs = g30.filter((g) => g.mode === k);
    if (!gs.length) return null;
    const uids = new Set(gs.flatMap((g) => g.players.map((p) => p.uid)).filter(Boolean));
    const firstDay = new Map();
    for (const g of gs) for (const pl of g.players) if (pl.uid && !firstDay.has(pl.uid)) firstDay.set(pl.uid, dayOf(g.endMs));
    let base = 0;
    let back = 0;
    for (const [u, d] of firstDay) {
      if (d > sevenAgo) continue;
      base += 1;
      const p = M.people.get(u);
      if (p && backWithin7(p, d)) back += 1;
    }
    return { k, row: [MODE_NAMES[k], fmtInt(gs.length), fmtInt(uids.size), fmtPct(cnt(gs, toEnd) / gs.length), base ? fmtPct(back / base) : DASH], back: base ? back / base : null, base };
  }).filter(Boolean);
  const bestBack = modeRows.filter((x) => x.base >= 5 && ok(x.back)).sort((a, b) => b.back - a.back);
  const modesIns = bestBack.length >= 2 ? `${MODE_NAMES[bestBack[0].k]} keeps players best (${fmtPct(bestBack[0].back)} back in a week); ${MODE_NAMES[bestBack[bestBack.length - 1].k]} the least (${fmtPct(bestBack[bestBack.length - 1].back)}).` : null;
  const r30 = roomsMade(M, last30(M));
  let roomsHtml;
  let roomsIns = null;
  if (r30.length) {
    const n = r30.length;
    const joined = cnt(r30, (r) => r.friends >= 1 || r.firstFriendSecs != null);
    const played = cnt(r30, (r) => r.withFriends);
    const won = cnt(r30, (r) => r.withFriends && r.toWinner > 0);
    const oc = (o) => cnt(r30, (r) => r.outcome === o) / n;
    const nobody = oc('nobody-closed') + oc('nobody-bots');
    roomsHtml = funnel([['Friends rooms created', n], ['At least one friend joined', joined], ['Game started with friends', played], ['Game played to a winner', won]])
      + '<div style="margin-top:12px">' + stack([['c1', oc('played-friends'), 'Played with friends'], ['c3', oc('friend-never-started'), 'Friend joined, never started'],
        ['c2', oc('nobody-bots'), 'Nobody came &ndash; played the bots'], ['c4', oc('nobody-closed'), 'Nobody came &ndash; closed']], 16) + '</div>'
      + '<div style="margin-top:12px">' + kv([
        ['Rooms where the invite was shared', fmtPct(cnt(r30, (r) => r.invites > 0) / n)],
        ['Time until the first friend joined', fmtDur(median(r30.filter((r) => r.firstFriendSecs != null).map((r) => r.firstFriendSecs))) + ' <span class="dim">(typical)</span>'],
        ['How long hosts waited before closing an empty room', fmtDur(median(r30.filter((r) => r.outcome === 'nobody-closed').map((r) => r.openSecs)))],
        ['Friends per played room', fmtNum(avgOf(r30.filter((r) => r.outcome === 'played-friends').map((r) => r.friends)), 1)],
      ]) + '</div>';
    if (n >= 10 && nobody >= 0.3) roomsIns = `<b>${Math.round(nobody * 10)} in 10 rooms close with nobody joining</b> &ndash; the invite isn&rsquo;t reaching friends, or they don&rsquo;t come. Make sharing one tap right after creating, and offer bots while waiting.`;
  } else roomsHtml = notYet(M, 'no friends rooms closed yet');
  const s30 = searchesIn(M, last30(M));
  let mmHtml;
  let mmIns = null;
  let waitHtml;
  if (s30.length) {
    const matched = cnt(s30, (s) => s.outcome === 'matched');
    const bots = cnt(s30, (s) => s.outcome === 'bots');
    const gave = cnt(s30, (s) => s.outcome === 'gave-up');
    const playedOn = g30.filter((g) => g.mode === 'online' && !g.bots).flatMap((g) => g.players).filter((p) => FINISHED.has(p.result)).length;
    mmHtml = funnel([['Searched for an online game', s30.length], ['Found a match', matched], ['Played that game to the end', Math.min(playedOn, matched)]])
      + '<div style="margin-top:10px">' + kv([['Filled the table with bots instead', `${bots} <span class="dim">(${fmtPct(bots / s30.length)})</span>`],
        ['Gave up waiting', `${gave} <span class="dim">(${fmtPct(gave / s30.length)})</span>`]]) + '</div>';
    if (s30.length >= 10 && gave / s30.length >= 0.3) mmIns = `<b>${fmtPct(gave / s30.length)} gave up waiting</b> for a match &rarr; fill the table with bots sooner, or show how many people are online.`;
    const WB = [['Under 15 s', (s) => s < 15], ['15&ndash;30 s', (s) => s >= 15 && s < 30], ['30&ndash;60 s', (s) => s >= 30 && s < 60], ['1&ndash;2 min', (s) => s >= 60 && s < 120], ['Over 2 min', (s) => s >= 120]];
    waitHtml = hbars(WB.map(([nm, f]) => [nm, cnt(s30, (s) => f(Number(s.waitSecs) || 0)) / s30.length]));
  } else { mmHtml = notYet(M, 'no online searches yet'); waitHtml = notYet(M); }
  const bg = g30.filter((g) => g.bots > 0 && g.botLevel);
  const diffRows = ['easy', 'medium', 'hard'].map((lv) => {
    const gs = bg.filter((g) => g.botLevel === lv);
    if (!gs.length) return null;
    const w = gs.filter((g) => g.outcome === 'winner');
    return [lv[0].toUpperCase() + lv.slice(1), fmtInt(gs.length), fmtPct(gs.length / bg.length), w.length ? fmtPct(cnt(w, (g) => g.winner === 'person') / w.length) : DASH, w.length ? cnt(w, (g) => g.winner === 'person') / w.length : null, w.length];
  }).filter(Boolean);
  const hard = diffRows.find((r) => r[0] === 'Hard');
  const diffIns = hard && hard[5] >= 10 && hard[4] < 0.35 ? `Hard bots win ${fmtPct(1 - hard[4])} of their games &ndash; fine for experts, but not for anyone&rsquo;s first game.` : null;
  const mid = sumOf(g30, (g) => g.midJoins);
  const midPl = g30.flatMap((g) => g.players).filter((p) => p.mid);
  const midStay = cnt(midPl, (p) => p.rounds >= 2 || FINISHED.has(p.result));
  const joins = g30.length ? kv([
    ['Joined a game already running', fmtInt(mid)], ['&hellip; after watching an ad', fmtInt(sumOf(g30, (g) => g.midJoinsAd))],
    ['Played more than their first round', midPl.length ? `${midStay} <span class="dim">(${fmtPct(midStay / midPl.length)})</span>` : DASH],
    ['Rejoined after being knocked out', fmtInt(sumOf(g30, (g) => g.rejoins))], ['&hellip; after watching an ad', fmtInt(sumOf(g30, (g) => g.rejoinsAd))],
  ]) : notYet(M);
  const matchedS = s30.filter((s) => s.outcome === 'matched');
  const body = sec('Each mode at a glance &ndash; last 30 days', 'Games, players, how often games reach the end, and whether players come back.', 'live',
    modeRows.length ? table(['Mode', 'Games', 'Players', 'Played to the end', 'Back in 7 days'], modeRows.map((x) => x.row)) : notYet(M), modesIns)
    + sec('Friends rooms: created &rarr; played &ndash; last 30 days', 'Every room someone made for friends: did anyone come, and was a game played?', 'live', roomsHtml, roomsIns)
    + grid2(sec('Online matchmaking &ndash; last 30 days', 'From searching to a finished game.', 'live', mmHtml, mmIns),
      sec('How long people wait for a match', 'Waiting time before a game started, or they gave up.', 'live', waitHtml))
    + grid2(sec('Bot level &ndash; last 30 days', 'Which level people play, and how often a person wins.', 'live',
      diffRows.length ? table(['Bot level', 'Games', 'Chosen', 'People win'], diffRows.map((r) => r.slice(0, 4))) : notYet(M), diffIns),
    sec('Joining mid-game &amp; rejoining &ndash; last 30 days', 'Players who came into a game already running.', 'live', joins));
  return reportPage(M, L, {
    block: 'games', title: 'Modes &amp; matchmaking', sub: 'Bots, friends, online and groups &ndash; and how well players find a game',
    cards: [
      [g30.length ? fmtPct(cnt(g30, (g) => g.mode === 'bots') / g30.length) : DASH, 'Games vs bots', 'last 30 days', ''],
      [g30.length ? fmtPct(cnt(g30, (g) => g.mode === 'online') / g30.length) : DASH, 'Online matches', 'last 30 days', ''],
      [s30.length ? fmtPct(matchedS.length / s30.length) : DASH, 'Found a match', s30.length ? `of ${s30.length} searches` : '', ''],
      [matchedS.length ? fmtDur(median(matchedS.map((s) => Number(s.waitSecs) || 0))) : DASH, 'Typical wait', 'for a match', ''],
    ],
    body,
    notes: '<b>Back in 7 days</b> = played again (any mode) on another day within a week of their first game in this mode in the period; '
      + 'only games a week old count. <b>Groups</b> = permanent groups. All of this starts from go-live.',
  });
}

// What a card drawn from the pile is worth on a fair shuffle: 54 cards a deck
// (two printed jokers worth 0), and each round one rank other than 2 is wild
// (worth 0) -- 340 points a deck less 4 x 6.92 for the wild rank, over 54.
const FAIR_AVG = (340 - 4 * (83 / 12)) / 54;          // 5.78
const FAIR_8 = (24 - 4 * 0.5) / 54;                   // 40.7% worth 8 or more
function rGamesExperience(M, L) {
  const cols = monthCols(M, liveMonth(M));
  const G = gamesOfCol(M);
  const per100 = (f) => (c) => { const gs = G(c); return gs.length ? fmtNum((100 * sumOf(gs, f)) / gs.length, 1) : null; };
  const prob = mtable(cols, [
    ['Bot took over (3 missed turns)', per100((g) => g.takeovers)],
    ['&hellip; came back in time', per100((g) => g.takeoverBack), 'ind'],
    ['&hellip; out at the round end', per100((g) => g.takeoverOut), 'ind'],
    ['Lost connection mid-game', per100((g) => g.lostConnections)],
    ['Solo games paused', per100((g) => g.soloPaused)],
  ]);
  const g30 = gamesEnded(M, last30(M));
  const tk = sumOf(g30, (g) => g.takeovers);
  const tkOut = sumOf(g30, (g) => g.takeoverOut);
  const probIns = g30.length >= 20 && tk ? `${fmtNum((100 * tk) / g30.length, 0)} missed-turn takeovers per 100 games; ${fmtPct(tkOut / tk)} of those players ended up out &ndash; a &ldquo;your turn&rdquo; reminder would save most of them.` : null;
  const calls = g30.flatMap((g) => g.calls || []);
  const CB = [['Calls at 0', (v) => v <= 0], ['Calls at 1&ndash;2', (v) => v >= 1 && v <= 2], ['Calls at 3&ndash;5', (v) => v >= 3 && v <= 5], ['Calls at 6 or more', (v) => v >= 6]];
  const cb = CB.map(([n, f]) => { const cs = calls.filter((c) => f(Number(c.v) || 0)); return [n, cs.length, cs.length ? cnt(cs, (c) => !c.ok) / cs.length : null]; }).filter((x) => x[1] > 0);
  const callsHtml = calls.length >= 10 ? hbars(cb.map(([n, c, r]) => [`${n} <span class="dim">(${c})</span>`, r]), true) : notYet(M, 'too few calls yet');
  const worstCall = cb.filter((x) => x[1] >= 10).sort((a, b) => b[2] - a[2])[0];
  const callsIns = worstCall && worstCall[2] >= 0.3 ? `${worstCall[0].replace('Calls at', 'Calling at')} is wrong ${fmtPct(worstCall[2])} of the time &rarr; a tutorial tip: call only when you are sure.` : null;
  const cards = sumOf(g30, (g) => g.penalty && g.penalty.cards);
  const csum = sumOf(g30, (g) => g.penalty && g.penalty.sum);
  const c8 = sumOf(g30, (g) => g.penalty && g.penalty.eightPlus);
  const chains = sumOf(g30, (g) => g.penalty && g.penalty.chains);
  const longest = Math.max(0, ...g30.map((g) => (g.penalty && g.penalty.longestChain) || 0));
  const rounds = sumOf(g30, (g) => g.rounds);
  const resh = sumOf(g30, (g) => g.reshuffles);
  let fairHtml;
  let fairIns = null;
  let avgCard = null;
  if (cards >= 50) {
    avgCard = csum / cards;
    const p8 = c8 / cards;
    const enough = cards >= 300;
    const okAvg = Math.abs(avgCard - FAIR_AVG) <= Math.max(0.25, (3 * 3.6) / Math.sqrt(cards));
    const ok8 = Math.abs(p8 - FAIR_8) <= Math.max(0.04, 3 * Math.sqrt((FAIR_8 * (1 - FAIR_8)) / cards));
    const mark = (good) => (!enough ? '' : good ? ' <span class="okm">&#10003;</span>' : ' <span class="warnm">&#10007;</span>');
    fairHtml = kv([
      ['Average card drawn from the pile', `${fmtNum(avgCard, 1)} <span class="dim">(fair deck: ${fmtNum(FAIR_AVG, 1)})</span>${mark(okAvg)}`],
      ['Cards worth 8 or more', `${fmtPct(p8)} <span class="dim">(fair: ${fmtPct(FAIR_8)})</span>${mark(ok8)}`],
      ['Cards drawn (checked)', fmtInt(cards)],
      ['Pile turned over (reshuffled)', rounds ? `${fmtNum((100 * resh) / rounds, 1)} per 100 rounds` : DASH],
      ['+2 chains', rounds ? `${fmtNum((100 * chains) / rounds, 1)} per 100 rounds &middot; longest ${longest}` : DASH],
    ]);
    if (enough) fairIns = okAvg && ok8 ? 'Matches a fair shuffle &ndash; if players feel unlucky, this is the proof.' : 'Different from a fair deck &ndash; worth a closer look.';
  } else fairHtml = notYet(M, 'too few cards drawn yet');
  const body = sec('Problems during games &ndash; per 100 games', 'Things that spoil a game for someone.', 'live', M.games.length ? prob : notYet(M), probIns)
    + grid2(sec('Wrong calls (75-point penalty) &ndash; last 30 days', 'How often a Least Count call by a person is wrong, by the hand value at the call.', 'live', callsHtml, callsIns),
      sec('Card fairness &ndash; live check, last 30 days', 'The cards players actually draw from the pile, against a fair shuffled deck.', 'live', fairHtml, fairIns));
  return reportPage(M, L, {
    block: 'games', title: 'Game experience &amp; fairness', sub: 'What spoils games, how good the calls are, and whether the cards are fair',
    cards: [
      [g30.length ? fmtNum((100 * tk) / g30.length, 0) : DASH, 'Bot takeovers / 100', 'games, last 30 days', tk ? 'down' : ''],
      [tk ? fmtPct(sumOf(g30, (g) => g.takeoverBack) / tk) : DASH, 'Came back after one', tk ? `of ${tk}` : '', ''],
      [calls.length ? fmtPct(cnt(calls, (c) => !c.ok) / calls.length) : DASH, 'Wrong calls', calls.length ? `of ${calls.length} calls` : '', ''],
      [ok(avgCard) ? fmtNum(avgCard, 1) : DASH, 'Avg card drawn', `fair deck: ${fmtNum(FAIR_AVG, 1)}`, ''],
    ],
    body,
    notes: 'All of this starts from go-live (the per-game records). <b>Per 100 games</b> keeps months of different sizes comparable. '
      + '<b>Calls</b> count only calls made by people, not bots. <b>Cards drawn</b> = every card picked up from the pile, as players see them.',
  });
}

const BLOCK_LABELS = ['12&ndash;3 AM', '3&ndash;6 AM', '6&ndash;9 AM', '9 AM&ndash;12 PM', '12&ndash;3 PM', '3&ndash;6 PM', '6&ndash;9 PM', '9 PM&ndash;12 AM'];
function rGamesWhen(M, L) {
  const t0 = dayStart(M.today);
  const keys = new Map();
  for (const r of rowsIn(M, { from: t0 - 28 * DAY_MS, to: t0 })) if (r.key && !keys.has(r.key)) keys.set(r.key, r.ms);
  const grid = Array.from({ length: 7 }, () => new Array(8).fill(0));
  const hourly = new Array(24).fill(0);
  const byWd = new Array(7).fill(0);
  for (const ms of keys.values()) {
    const d = ist(ms);
    const h = d.getUTCHours();
    const wd = d.getUTCDay();
    grid[wd][Math.floor(h / 3)] += 1;
    hourly[h] += 1;
    byWd[wd] += 1;
  }
  const ORDER = [1, 2, 3, 4, 5, 6, 0];
  const mx = Math.max(1, ...grid.flat());
  let heat = '<div class="scroll"><table class="heat"><tr><th></th>' + ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'].map((h) => `<th>${h}</th>`).join('') + '</tr>';
  for (const wd of ORDER) {
    heat += `<tr><td>${WD[wd]}</td>` + grid[wd].map((v) => `<td class="h" style="background:rgba(127,214,160,${(0.08 + (0.92 * v) / mx).toFixed(2)})">${v}</td>`).join('') + '</tr>';
  }
  heat += '</table></div>';
  const blockTotals = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => sumOf(grid.map((row) => row[b])));
  const bestBlock = blockTotals.indexOf(Math.max(...blockTotals));
  const daysSorted = ORDER.slice().sort((a, b) => byWd[b] - byWd[a]);
  const total = keys.size;
  const daily = [];
  const we = [];
  const labels = [];
  for (let i = 30; i >= 1; i--) {
    const d = addDays(M.today, -i);
    const w = { from: dayStart(d), to: dayStart(d) + DAY_MS };
    daily.push(gamesToWinner(M, w).v);
    we.push(weekday(d) === 0 || weekday(d) === 6);
    labels.push(d);
  }
  const weAvg = avgOf(daily.filter((_, i) => we[i]));
  const wdAvg = avgOf(daily.filter((_, i) => !we[i]));
  const hMax = hourly.indexOf(Math.max(...hourly));
  let quiet = 0;
  let quietSum = Infinity;
  for (let h = 0; h < 24; h++) {
    const s = hourly[h] + hourly[(h + 1) % 24] + hourly[(h + 2) % 24];
    if (s < quietSum) { quietSum = s; quiet = h; }
  }
  let peak = null;
  for (const k of M.dayKeys) {
    const p = (M.days.get(k) || {}).peak;
    if (p && Number(p.n) > (peak ? peak.n : 0)) peak = { n: Number(p.n), at: Date.parse(p.at) };
  }
  const remindH = (hMax + 23) % 24;
  const best = total ? kv([
    ['Post on Instagram', `${WD[daysSorted[0]]} &amp; ${WD[daysSorted[1]]}, around ${hourLabel(hMax)}`],
    ['Send a reminder notification', `around ${(remindH % 12 || 12)}:30 ${remindH < 12 ? 'AM' : 'PM'}`],
    ['Deploy updates (quietest)', `${hourLabel(quiet)} &ndash; ${hourLabel((quiet + 3) % 24)}`],
    ['Most players online at once', peak ? `${peak.n} &middot; ${dayLabel(dayOf(peak.at))}, ${clock(peak.at)}` : '<span class="dim">from go-live</span>'],
  ]) : '<div class="empty">No games in the last 4 weeks.</div>';
  const body = sec('Games by day and time (IST) &ndash; last 4 weeks', 'Games that reached a winner, in each 3-hour block, by weekday.', 'now', heat,
    total ? `${BLOCK_LABELS[bestBlock]} is the busiest time; ${WD_LONG[daysSorted[0]]}s are the busiest day. The quietest hours are ${hourLabel(quiet)}&ndash;${hourLabel((quiet + 3) % 24)}.` : null)
    + grid2(sec('Games per day &ndash; last 30 days', 'Games that reached a winner each day; weekends in gold.', 'now',
      spark(daily, [dm(labels[0]), 'weekends in gold', dm(labels[labels.length - 1])], false, we),
      ok(weAvg) && ok(wdAvg) && wdAvg > 0 && weAvg / wdAvg >= 1.2 ? `Weekends are about ${Math.round((weAvg / wdAvg - 1) * 100)}% busier than weekdays.` : null),
    sec('Best times', 'Worked out from the busy hours above.', 'now', best, total ? 'Reminders and posts land best just before the evening peak; deploy in the quiet hours.' : null));
  return reportPage(M, L, {
    block: 'games', title: 'When people play', sub: 'Busy hours and days &ndash; for posts, notifications and safe deploys',
    cards: [
      [total ? BLOCK_LABELS[bestBlock] : DASH, 'Busiest time', 'last 4 weeks', ''],
      [total ? WD[daysSorted[0]] : DASH, 'Busiest day', total ? `then ${WD[daysSorted[1]]}` : '', ''],
      [peak ? fmtInt(peak.n) : DASH, 'Most online at once', peak ? `${dayLabel(dayOf(peak.at))}, ${clock(peak.at)}` : 'from go-live', ''],
      [fmtNum(avgOf(daily), 1), 'Games a day', 'last 30 days', ''],
    ],
    body,
    notes: 'Times are India time (IST). <b>Your data now</b>: game times are already recorded. &ldquo;Most online at once&rdquo; starts from go-live '
      + '(the server notes how many are online every minute).',
  });
}

// =============================== Ads reports ===============================
function adsHelpers(M) {
  const docsOf = (months) => M.dayKeys.filter((k) => months.includes(k.slice(0, 7))).map((k) => M.days.get(k) || {});
  const docsIn = (w) => dayParts(w).map((p) => M.days.get(p.day)).filter(Boolean);
  const R = (docs, t) => sumOf(docs, (d) => g2(d, 'rev', t));
  const RT = (docs) => R(docs, 'banner') + R(docs, 'fs') + R(docs, 'rw');
  const A = (docs, t, a) => sumOf(docs, (d) => g2(d, 'ads', t, a));
  const appU = (docs) => {
    const s = new Set();
    for (const d of docs) if (d.opens) for (const [u, k] of Object.entries(d.opens)) if (k === 'app') s.add(u);
    return s.size;
  };
  const money = (v) => fmtMoney(v, M.currency);
  return { docsOf, docsIn, R, RT, A, appU, money };
}

function rAdsRevenue(M, L) {
  const H = adsHelpers(M);
  const cols = monthCols(M, liveMonth(M));
  const D = (c) => H.docsOf(c.months);
  const has = (c) => D(c).length > 0;
  const gamesIn = (c) => M.games.filter((g) => c.months.includes(g.month)).length;
  const ecpm = (t, a) => (c) => { const n = H.A(D(c), t, a); return n ? H.money((H.R(D(c), t) / n) * 1000) : null; };
  const rev = mtable(cols, [
    ['Revenue by ad type', null, 'grp'],
    ['Bottom banner', (c) => (has(c) ? H.money(H.R(D(c), 'banner')) : null)],
    ['Full-screen ads', (c) => (has(c) ? H.money(H.R(D(c), 'fs')) : null)],
    ['Rewarded ads (join / rejoin)', (c) => (has(c) ? H.money(H.R(D(c), 'rw')) : null)],
    ['Total revenue', (c) => (has(c) ? H.money(H.RT(D(c))) : null), 'total'],
    ['Earned per 1,000 ads (eCPM)', null, 'grp'],
    ['Bottom banner', ecpm('banner', 'impression')],
    ['Full-screen ads', ecpm('fs', 'shown')],
    ['Rewarded ads', ecpm('rw', 'shown')],
    ['Per player and per game', null, 'grp'],
    ['Revenue per app user', (c) => { const u = H.appU(D(c)); return u ? H.money(H.RT(D(c)) / u) : null; }],
    ['Revenue per game', (c) => { const g = gamesIn(c); return g && has(c) ? H.money(H.RT(D(c)) / g) : null; }],
  ]);
  const w30 = last30(M);
  const d30 = H.docsIn(w30);
  const bE = H.A(d30, 'banner', 'impression') ? H.R(d30, 'banner') / H.A(d30, 'banner', 'impression') : null;
  const fE = H.A(d30, 'fs', 'shown') ? H.R(d30, 'fs') / H.A(d30, 'fs', 'shown') : null;
  const revIns = ok(bE) && ok(fE) && bE > 0 ? `A full-screen ad earns about ${Math.round(fE / bE)}&times; what a banner show earns`
    + (H.R(d30, 'banner') > H.R(d30, 'fs') ? ' &ndash; but the banner still brings the most money, because it is always on screen.' : '.') : null;
  const vals = [];
  const labels = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(M.today, -i);
    vals.push(revOf(M.days.get(d) || {}) / 1e6);
    labels.push(d);
  }
  const sym = SYMBOL[M.currency] || esc(M.currency);
  const u30 = appUsers(M, w30);
  const per = u30 ? H.RT(d30) / u30 : null;
  const web30 = new Set(rowsIn(M, w30).filter((r) => r.web).map((r) => r.uid)).size;
  const worth = kv([
    ['Earned per app user (last 30 days)', H.money(per)],
    ['Earned per website player', `${sym}0 <span class="dim">(no ads on the website)</span>`],
    ['Website players, last 30 days', fmtInt(web30)],
    ['Extra a month if they all used the app', ok(per) ? `<span class="pct">${H.money(per * web30)}</span>` : DASH],
  ]);
  const P = monthToDate(M);
  const curRev = revenue(M, P.w).v;
  const prevRev = M.liveStartMs != null && M.liveStartMs <= P.usual[0].from ? revenue(M, P.usual[0]).v : null;
  const g30 = gamesEnded(M, w30).length;
  const body = sec('Ad revenue by month', 'What each type of ad earned, what it earns per 1,000 shows, and per player and game.', 'live', M.dayKeys.length ? rev : notYet(M), revIns)
    + grid2(sec('Revenue per day &ndash; last 30 days', 'What the ads earned each day.', 'live', M.dayKeys.length ? spark(vals, [dm(labels[0]), sym + ' per day', dm(labels[labels.length - 1])], true) : notYet(M)),
      sec('What moving a website player to the app is worth', 'The website shows no ads, so every website player who moves to the app adds revenue.', 'live', worth,
        ok(per) && web30 ? `Moving website players to the app is worth about ${H.money(per)} each a month.` : null));
  return reportPage(M, L, {
    block: 'ads', title: 'Ad revenue', sub: 'What the ads earn, by type, per player and per game &middot; in your AdMob currency',
    cards: [
      [H.money(curRev), `Revenue ${monShort(M.curMonth)} (so far)`, prevRev != null ? `${monShort(P.prevM)} same days: ${H.money(prevRev)}` : '', prevRev != null && curRev > prevRev ? 'up' : ''],
      [H.money(per), 'Per app user', 'last 30 days', ''],
      [ok(fE) ? H.money(fE * 1000) : DASH, 'Full-screen eCPM', 'per 1,000 shows', ''],
      [g30 && d30.length ? H.money(H.RT(d30) / g30) : DASH, 'Per game', 'last 30 days', ''],
    ],
    body,
    notes: 'Revenue here is what each ad reports to the app as it is shown (AdMob&rsquo;s <b>impression-level ad revenue</b> &ndash; switch it on in '
      + 'AdMob &rsaquo; Settings). AdMob&rsquo;s own report stays the final figure; the two should be close. <b>App user</b> = opened the app in the period. '
      + 'Google&rsquo;s test ads are never counted. All from go-live.',
  });
}

function rAdsShown(M, L) {
  const H = adsHelpers(M);
  const cols = monthCols(M, liveMonth(M));
  const D = (c) => H.docsOf(c.months);
  const has = (c) => D(c).length > 0;
  const shown = mtable(cols, [
    ['Bottom banner shows', (c) => (has(c) ? fmtInt(H.A(D(c), 'banner', 'impression')) : null)],
    ['Full-screen ads shown', (c) => (has(c) ? fmtInt(H.A(D(c), 'fs', 'shown')) : null)],
    ['Rewarded ads watched to the end', (c) => (has(c) ? fmtInt(H.A(D(c), 'rw', 'rewarded')) : null)],
    ['Ads per app user per day', (c) => {
      let ads = 0;
      let ud = 0;
      for (const d of D(c)) {
        if (d.adsBy) ads += sumOf(Object.values(d.adsBy));
        if (d.opens) ud += Object.values(d.opens).filter((k) => k === 'app').length;
      }
      return ud ? fmtNum(ads / ud, 1) : null;
    }],
    ['Full-screen ads per game', (c) => { const g = M.games.filter((x) => c.months.includes(x.month)).length; return g && has(c) ? fmtNum(H.A(D(c), 'fs', 'shown') / g, 1) : null; }],
  ]);
  const d30 = H.docsIn(last30(M));
  const due = H.A(d30, 'fs', 'due');
  const notReady = H.A(d30, 'fs', 'skipNotReady');
  const fsShownN = H.A(d30, 'fs', 'shown');
  const full = due ? funnel([['Full-screen ads due', due], ['An ad was ready', Math.max(0, due - notReady)], ['Shown', fsShownN]])
    + '<div style="margin-top:10px">' + kv([['Skipped: no ad loaded yet', fmtInt(notReady)], ['Skipped: another ad less than a minute before', fmtInt(H.A(d30, 'fs', 'skipSoon'))],
      ['Failed to show', fmtInt(H.A(d30, 'fs', 'failshow'))]]) + '</div>' : notYet(M, 'no full-screen ads due yet');
  const fullIns = due >= 20 && notReady / due >= 0.15 ? `${fmtPct(notReady / due)} of full-screen ads are lost because none was loaded in time &rarr; start loading earlier.` : null;
  const offered = H.A(d30, 'rw', 'offered');
  const started = H.A(d30, 'rw', 'started');
  const adPl = gamesEnded(M, last30(M)).flatMap((g) => g.players).filter((p) => p.viaAd && p.back != null);
  const stayedBack = cnt(adPl, (p) => !(p.out != null && p.out <= p.back && (p.result === 'walked-out' || p.result === 'missed-turns')));
  const rew = offered || started ? funnel([['Could take a seat with an ad', Math.max(offered, started)], ['Started (asked, and approved)', started],
    ['The ad played', H.A(d30, 'rw', 'shown')], ['Watched to the end', H.A(d30, 'rw', 'rewarded')]])
    + '<div style="margin-top:10px">' + kv([['Closed the ad early', fmtInt(H.A(d30, 'rw', 'closed'))], ['Seat given free (no ad could play)', fmtInt(H.A(d30, 'rw', 'free'))],
      ['Still in after their first round back', adPl.length ? `${stayedBack} <span class="dim">(${fmtPct(stayedBack / adPl.length)})</span>` : DASH]]) + '</div>' : notYet(M, 'no rewarded ads yet');
  const ld = H.A(d30, 'banner', 'loaded');
  const fl = H.A(d30, 'banner', 'failed');
  const nf = H.A(d30, 'banner', 'nofill');
  let trouble = 0;
  let hoursWith = 0;
  for (let i = 0; i < 7; i++) {
    const doc = M.days.get(addDays(M.today, -i));
    if (!doc || !doc.hours) continue;
    for (const h of Object.values(doc.hours)) {
      const a = Number(h && h.bLoaded) || 0;
      const b = Number(h && h.bFailed) || 0;
      if (a + b >= 5) { hoursWith += 1; if (b / (a + b) > 0.3) trouble += 1; }
    }
  }
  const health = ld + fl ? hbars([['Banner loaded when asked', ld / (ld + fl)], ['Banner: no ad available', nf / (ld + fl)], ['Banner: other errors', Math.max(0, fl - nf) / (ld + fl)]])
    + '<div style="margin-top:10px">' + kv([['Hours with banner trouble, last 7 days', hoursWith ? `${trouble} of ${hoursWith}` : DASH]]) + '</div>' : notYet(M, 'no banner loads yet');
  const body = sec('Ads shown', 'How many ads players actually see.', 'live', M.dayKeys.length ? shown : notYet(M))
    + grid2(sec('Full-screen ads &ndash; last 30 days', 'Due &rarr; ready &rarr; shown, and why some were skipped.', 'live', full, fullIns),
      sec('Rewarded ads &ndash; last 30 days', 'Watching an ad to join a running game, or to rejoin after being knocked out.', 'live', rew))
    + sec('Ad health &ndash; last 30 days', 'Is the banner there when it should be?', 'live', health,
      'Watch this after every app update &ndash; a broken banner shows up here at once. &ldquo;Trouble&rdquo; = more than 3 in 10 banner loads failing in an hour.');
  return reportPage(M, L, {
    block: 'ads', title: 'Ads shown &amp; ad health', sub: 'How many ads are seen, and how many are lost',
    cards: [
      [fmtInt(fsShownN), 'Full-screen shown', due ? `of ${due} due, last 30 days` : 'last 30 days', ''],
      [due ? fmtPct(fsShownN / due) : DASH, 'Full-screen shown', 'when due', ''],
      [started ? fmtPct(H.A(d30, 'rw', 'rewarded') / started) : DASH, 'Rewarded: watched', 'when started', ''],
      [ld + fl ? fmtPct(ld / (ld + fl)) : DASH, 'Banner loaded', 'when asked', ''],
    ],
    body,
    notes: '<b>Due</b> = a moment a full-screen ad is planned (every 4th round, and leaving a room). Players who bought Remove Ads never have one due. '
      + 'All from go-live: before this version the app only wrote ad events to the phone&rsquo;s own log.',
  });
}

function rAdsPlayers(M, L) {
  const H = adsHelpers(M);
  const w30 = last30(M);
  const d30 = H.docsIn(w30);
  const fsN = H.A(d30, 'fs', 'shown');
  const left = H.A(d30, 'fs', 'leftAfter');
  const p30 = gamesEnded(M, w30).flatMap((g) => g.players);
  const mins = sumOf(p30, (p) => p.secs) / 60;
  const walked = cnt(p30, (p) => p.result === 'walked-out');
  const r1 = fsN ? left / fsN : null;
  const r0 = mins > 0 ? walked / mins : null;
  const after = fsN >= 10 ? hbars([['Left within 1 min after a full-screen ad', r1], ['Left in any 1 min of play (normal)', r0]], true) : notYet(M, 'too few full-screen ads yet');
  const afterIns = fsN >= 20 && ok(r1) && ok(r0) && r0 > 0 && r1 / r0 >= 1.5
    ? `Right after a full-screen ad, players leave ${fmtNum(r1 / r0, 1)}&times; as often as usual &ndash; keep these ads at natural breaks, never mid-hand.`
    : (fsN >= 20 ? 'Full-screen ads do not make players leave noticeably more than usual.' : null);
  // Ads seen per day of play (30 days ending a week ago) against still playing in the last 7 days.
  const win = { from: M.nowMs - 37 * DAY_MS, to: M.nowMs - 7 * DAY_MS };
  const per = new Map();
  for (const p of dayParts(win)) {
    const doc = M.days.get(p.day);
    if (!doc || !doc.adsBy) continue;
    for (const [u, n] of Object.entries(doc.adsBy)) {
      const x = per.get(u) || { ads: 0, days: 0 };
      x.ads += Number(n) || 0;
      x.days += 1;
      per.set(u, x);
    }
  }
  const recent = new Set(rowsIn(M, { from: M.nowMs - 7 * DAY_MS, to: M.nowMs }).map((r) => r.uid));
  const EB = [['Few (up to 5 a day)', (v) => v <= 5], ['Some (6&ndash;15 a day)', (v) => v > 5 && v <= 15], ['Many (over 15 a day)', (v) => v > 15]];
  const eb = EB.map(([n, f]) => {
    const us = [...per.entries()].filter(([, x]) => f(x.ads / x.days)).map(([u]) => u);
    return [n, us.length, us.length ? cnt(us, (u) => recent.has(u)) / us.length : null];
  });
  const exp = per.size >= 10 ? table(['Ads seen a day of play', 'Players', 'Still playing a week later'], eb.map(([n, c, r]) => [n, fmtInt(c), fmtPct(r)]))
    : notYet(M, 'needs a few weeks of ad data');
  const few = eb[0];
  const many = eb[2];
  const expIns = per.size >= 10 && ok(few[2]) && ok(many[2]) && many[1] >= 5
    ? (many[2] < few[2] ? `Players who see many ads stay less (${fmtPct(many[2])} vs ${fmtPct(few[2])}) &ndash; partly because they play the most; compare before adding more ads.`
      : `Seeing many ads does not stop players coming back (${fmtPct(many[2])} vs ${fmtPct(few[2])}).`) : null;
  const imp = H.A(d30, 'banner', 'impression');
  const dis = H.A(d30, 'fs', 'dismissed');
  const taps = imp || dis ? kv([
    ['Banner taps per 100 shows', imp ? fmtNum((100 * H.A(d30, 'banner', 'click')) / imp, 2) : DASH],
    ['Taps within 1 s of the banner appearing', imp ? fmtNum((100 * H.A(d30, 'banner', 'quickClick')) / imp, 2) + ' <span class="dim">per 100 (likely accidental)</span>' : DASH],
    ['Full-screen ads closed in under 5 s', dis ? fmtPct(H.A(d30, 'fs', 'quickClose') / dis) : DASH],
  ]) : notYet(M, 'no ads yet');
  const quick = imp ? H.A(d30, 'banner', 'quickClick') / imp : 0;
  const adPl = p30.filter((p) => p.viaAd && p.back != null);
  const stayed = cnt(adPl, (p) => !(p.out != null && p.out <= p.back && (p.result === 'walked-out' || p.result === 'missed-turns')));
  const body = sec('Do full-screen ads make people leave? &ndash; last 30 days', 'Leaving the game within a minute after a full-screen ad, against the normal rate.', 'live', after, afterIns)
    + grid2(sec('Ads seen vs staying', 'Do players who see many ads stop playing sooner? (Ads in the 30 days up to a week ago; still playing = a game in the last 7 days.)', 'live', exp, expIns),
      sec('Taps on ads &ndash; last 30 days', 'Real interest, or accidental taps (which AdMob penalises)?', 'live', taps,
        imp >= 500 ? (quick > 0.002 ? 'Some taps come within a second of the banner appearing &ndash; check that it does not jump under a button.' : 'Accidental taps are low &ndash; the banner stays clear of the buttons.') : null));
  return reportPage(M, L, {
    block: 'ads', title: 'Ads &amp; players', sub: 'Do ads cost us players? Balancing revenue against leaving',
    cards: [
      [ok(r1) && ok(r0) && r0 > 0 ? fmtNum(r1 / r0, 1) + '&times;' : DASH, 'Leave after full-screen', 'vs normal', ''],
      [ok(many[2]) ? fmtPct(many[2]) : DASH, 'Stay: many-ad viewers', ok(few[2]) ? `vs ${fmtPct(few[2])} few` : '', ''],
      [imp ? fmtNum((100 * H.A(d30, 'banner', 'click')) / imp, 2) : DASH, 'Banner taps / 100', 'shows', ''],
      [adPl.length ? fmtPct(stayed / adPl.length) : DASH, 'Rewarded, then stayed', 'after their first round back', ''],
    ],
    body,
    notes: 'All from go-live. <b>Leaving</b> = walked out of the game or lost the connection for good, within a minute of the ad closing.',
  });
}

// ================================ pages =====================================
const REPORT_FNS = {
  'users-growth': rUsersGrowth, 'users-first': rUsersFirst, 'users-retention': rUsersRetention, 'users-engagement': rUsersEngagement,
  'games-completion': rGamesCompletion, 'games-modes': rGamesModes, 'games-experience': rGamesExperience, 'games-when': rGamesWhen,
  'ads-revenue': rAdsRevenue, 'ads-shown': rAdsShown, 'ads-players': rAdsPlayers,
};
const hasReport = (id) => Object.prototype.hasOwnProperty.call(REPORT_FNS, id);
function renderReport(M, L, id) {
  return REPORT_FNS[id](M, L);
}

module.exports = {
  createStore, refreshStore, buildModel,
  renderHome, renderDashboard, renderBlock, renderReport, hasReport,
  REPORT_IDS: Object.keys(REPORT_FNS),
  // for tests
  _t: { dayOf, monthOf, dayStart, addDays, monthCols, periods, judge, TILES, measure, usualOf, dayParts, hourSum, fyLabel, FAIR_AVG, FAIR_8, changeText },
};
