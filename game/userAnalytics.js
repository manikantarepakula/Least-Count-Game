// ---------------------------------------------------------------------------
// Users, month on month (Nov 2026) -- the report behind
// /api/admin/user-analytics. Mani's roll-forward, done the way a balance is
// rolled forward in accounts:
//
//   Opening active      users who played last month
//   + New users         first game ever, this month
//   + Came back         played before, but not last month
//   - Became inactive   played last month, not this month
//   = Closing active    users who played this month
//
//   Churn %             became inactive / opening active
//   Total users         everyone who has ever played, up to the month's end
//   Inactive users      total users - closing active
//
// "Played" = at least one game in the month, finished or left part-way (a
// part-way row still means real rounds were played). Months are India-time
// (IST) calendar months. A "user" is one account id: the app signs every
// player in anonymously the first time it opens, so that is one per phone or
// browser -- or one per Google account, once they sign in with Google.
//
// The data: the `activity` log (one row per player per game, finished or
// not, since the log began) and the `users` docs (a lifetime count of
// finished games). Someone whose lifetime count is higher than the finished
// games in the log played before the log began: the first month the log sees
// them, they "came back" rather than being new. Someone with games on their
// lifetime count but no rows at all only played before the log: counted in
// Total users, and inactive.
//
// Pure -- no Firestore and no clock of its own (now is passed in) -- so it
// can be tested exactly. server.js fetches the rows, this counts them, and
// renderHtml() draws the page.
// ---------------------------------------------------------------------------
'use strict';

const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function istIso(ms) { return new Date(ms + IST_OFFSET_MS).toISOString(); }
function monthOfMs(ms) { return istIso(ms).slice(0, 7); }               // 'YYYY-MM'
function shiftMonth(m, by) {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
function monthLabel(m) { return MONTH_NAMES[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4); }

function buildUserMonths({ activity, users, now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const people = new Map();
  let logStart = null;
  const person = (uid) => {
    let p = people.get(uid);
    if (!p) {
      p = { uid, months: new Set(), finishedInLog: 0, firstAt: null, lastAt: null,
        name: null, nameAt: '', app: false, web: false, before: false, gamesPlayed: 0 };
      people.set(uid, p);
    }
    return p;
  };

  for (const r of activity || []) {
    if (!r || !r.uid || typeof r.at !== 'string') continue;
    const ms = Date.parse(r.at);
    if (Number.isNaN(ms)) continue;
    const p = person(r.uid);
    p.months.add(monthOfMs(ms));
    if (!p.firstAt || r.at < p.firstAt) p.firstAt = r.at;
    if (!p.lastAt || r.at > p.lastAt) p.lastAt = r.at;
    // Rows from before the `completed` field existed were all finished games.
    if (r.completed !== false) p.finishedInLog += 1;
    if (r.displayName && r.at >= p.nameAt) { p.name = r.displayName; p.nameAt = r.at; }
    if (r.platform === 'android-app') p.app = true;
    else if (r.platform === 'web') p.web = true;
    if (!logStart || r.at < logStart) logStart = r.at;
  }

  for (const d of users || []) {
    if (!d || !d.uid) continue;
    const games = Number(d.gamesPlayed) || 0;
    const p = people.get(d.uid);
    if (p) {
      p.gamesPlayed = games;
      if (games > p.finishedInLog) p.before = true;           // games from before the log
      if (!p.name && d.displayName) p.name = d.displayName;
    } else if (games > 0) {
      const q = person(d.uid);                                 // only ever played before the log
      q.gamesPlayed = games;
      q.before = true;
      q.name = d.displayName || null;
      q.lastAt = typeof d.lastPlayedAt === 'string' ? d.lastPlayedAt : null;
    }
  }

  const all = [...people.values()];
  const firstMonth = (p) => (p.firstAt ? monthOfMs(Date.parse(p.firstAt)) : null);
  const currentMonth = monthOfMs(nowMs);
  const brief = (p) => ({ uid: p.uid, name: p.name, lastAt: p.lastAt, app: p.app, web: p.web });
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));

  const months = [];
  if (logStart) {
    const start = monthOfMs(Date.parse(logStart));
    for (let m = start, i = 0; m <= currentMonth && i < 600; m = shiftMonth(m, 1), i++) {
      const first = i === 0;
      const prev = shiftMonth(m, -1);
      const active = all.filter((p) => p.months.has(m));
      const newUsers = active.filter((p) => !p.before && firstMonth(p) === m);
      const retained = first ? [] : active.filter((p) => p.months.has(prev));
      const cameBack = active.filter((p) => !newUsers.includes(p) && !retained.includes(p));
      const wentInactive = first ? [] : all.filter((p) => p.months.has(prev) && !p.months.has(m));
      const opening = first ? null : all.filter((p) => p.months.has(prev)).length;
      const totalUsers = all.filter((p) => p.before || (firstMonth(p) && firstMonth(p) <= m)).length;
      months.push({
        month: m,
        label: monthLabel(m),
        inProgress: m === currentMonth,
        // The first month the log covers has no "last month" to compare with:
        // no opening figure, no churn, and everyone who isn't new "came back".
        firstTracked: first,
        opening,
        newUsers: newUsers.length,
        cameBack: cameBack.length,
        wentInactive: first ? null : wentInactive.length,
        retained: first ? null : retained.length,
        closing: active.length,
        churnPct: opening ? Math.round((1000 * wentInactive.length) / opening) / 10 : null,
        totalUsers,
        inactiveUsers: totalUsers - active.length,
        lists: {
          newUsers: newUsers.map(brief).sort(byName),
          cameBack: cameBack.map(brief).sort(byName),
          wentInactive: wentInactive.map(brief).sort(byName),
        },
      });
    }
  }

  const userRows = all.map((p) => ({
    uid: p.uid,
    name: p.name,
    status: p.months.has(currentMonth) ? 'active' : 'inactive',
    firstMonth: firstMonth(p),
    before: p.before,
    lastAt: p.lastAt,
    monthsActive: p.months.size,
    gamesFinished: Math.max(p.gamesPlayed, p.finishedInLog),
    app: p.app,
    web: p.web,
  })).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));

  const cur = months.length ? months[months.length - 1] : null;
  const last = months.length > 1 ? months[months.length - 2] : null;
  return {
    currentMonth,
    logStart,
    months,
    users: userRows,
    summary: {
      totalUsers: all.length,
      activeThisMonth: cur && cur.month === currentMonth ? cur.closing : 0,
      inactiveNow: all.length - (cur && cur.month === currentMonth ? cur.closing : 0),
      lastMonth: last ? { label: last.label, closing: last.closing, churnPct: last.churnPct } : null,
    },
  };
}

// ---------------------------------------------------------------------------
// The page. Same look as the tester report (dark table green), readable on a
// phone. `links` carries the admin key forward for the links between the two
// admin pages, built on the server because the site's security policy blocks
// scripts on pages like this one.
// ---------------------------------------------------------------------------
function renderHtml(report, { dataAt, links } = {}) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const day = (iso) => {
    const ms = Date.parse(iso || '');
    return Number.isNaN(ms) ? '-' : istIso(ms).slice(0, 10);
  };
  const stamp = (ms) => istIso(ms).slice(0, 16).replace('T', ' ') + ' IST';
  const num = (v) => (v == null ? '<span class="dim">&ndash;</span>' : String(v));
  const tags = (u) => (u.app ? '<span class="tag app">App</span>' : '') + (u.web ? '<span class="tag web">Web</span>' : '');
  const L = links || {};
  const M = report.months;
  const s = report.summary;

  const head = M.map((m) => `<th class="n">${esc(m.label)}${m.inProgress ? '<div class="so-far">so far</div>' : ''}</th>`).join('');
  const row = (label, cls, f) => `<tr class="${cls}"><th>${label}</th>${M.map((m) => `<td class="n">${f(m)}</td>`).join('')}</tr>`;
  const rollForward = M.length ? `
<div class="scroll"><table class="rf">
  <tr><th></th>${head}</tr>
  ${row('Opening active users', '', (m) => num(m.opening))}
  ${row('+ New users', 'add', (m) => num(m.newUsers))}
  ${row('+ Came back', 'add', (m) => num(m.cameBack))}
  ${row('&minus; Became inactive', 'less', (m) => (m.wentInactive == null ? num(null) : m.wentInactive + (m.inProgress ? '*' : '')))}
  ${row('Closing active users', 'total', (m) => num(m.closing))}
  ${row('Churn %', 'pct', (m) => (m.churnPct == null ? num(null) : m.churnPct + '%' + (m.inProgress ? '*' : '')))}
  ${row('Total users (ever played)', 'sub2', (m) => num(m.totalUsers))}
  ${row('Inactive users', 'sub2', (m) => num(m.inactiveUsers))}
</table></div>` : '<p class="dim">No games have been logged yet.</p>';

  const list = (title, arr) => {
    if (!arr.length) return '';
    const items = arr.slice(0, 300).map((u) => `<li><span class="pname">${esc(u.name || '(no name)')}</span>
      <span class="uid">${esc(String(u.uid).slice(0, 8))}</span> ${tags(u)}
      <span class="dim">last played ${esc(day(u.lastAt))}</span></li>`).join('');
    const more = arr.length > 300 ? `<li class="dim">... and ${arr.length - 300} more</li>` : '';
    return `<details><summary>${title} (${arr.length})</summary><ul>${items}${more}</ul></details>`;
  };
  const monthLists = M.slice().reverse().map((m) => {
    const parts = list('New users', m.lists.newUsers)
      + list('Came back', m.lists.cameBack)
      + list(m.inProgress ? 'Not played yet this month' : 'Became inactive', m.lists.wentInactive);
    return parts ? `<h3>${esc(m.label)}${m.inProgress ? ' <span class="dim">(so far)</span>' : ''}</h3>${parts}` : '';
  }).join('');

  // The FULL player id here (short everywhere else): it is what goes into
  // ADMIN_UIDS on Render to switch on the admin reports in someone's app.
  const userRows = report.users.map((u) => `<tr>
    <td><div class="pname">${esc(u.name || '(no name)')}</div><div class="uid full">${esc(u.uid)}</div></td>
    <td>${u.status === 'active' ? '<span class="tag on">Active</span>' : '<span class="tag off">Inactive</span>'}</td>
    <td>${esc(day(u.lastAt))}</td>
    <td>${u.firstMonth && !u.before ? esc(monthLabel(u.firstMonth)) : '<span class="dim">before log</span>'}</td>
    <td class="n">${u.monthsActive}</td>
    <td class="n">${u.gamesFinished}</td>
    <td>${tags(u)}</td>
  </tr>`).join('');

  const nowMonth = M.length ? M[M.length - 1] : null;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Users, month on month</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; background: #0d1f16; color: #e8f0ea; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 8px; }
  h3 { font-size: 13px; margin: 14px 0 6px; color: #d9e8de; }
  .sub { color: #8fae9c; font-size: 12px; margin-bottom: 14px; line-height: 1.6; }
  .sub a { color: #f2c14e; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 6px; }
  .card { background: #143d29; border: 1px solid #205237; border-radius: 10px; padding: 10px 14px; min-width: 110px; }
  .card .v { font-size: 22px; font-weight: 700; }
  .card .k { font-size: 11px; color: #8fae9c; text-transform: uppercase; letter-spacing: .04em; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; font-size: 13px; }
  .rf { min-width: 100%; }
  .rf th, .rf td { padding: 7px 10px; border-bottom: 1px solid #205237; white-space: nowrap; }
  .rf tr:first-child th { color: #8fae9c; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .rf th:first-child { text-align: left; position: sticky; left: 0; background: #0d1f16; font-weight: 500; }
  .rf .add th, .rf .less th { padding-left: 18px; color: #c9dccf; }
  .rf .total th, .rf .total td { font-weight: 700; border-top: 1px solid #8fae9c; border-bottom: 2px solid #8fae9c; }
  .rf .pct td { color: #f2c14e; font-weight: 600; }
  .rf .sub2 th, .rf .sub2 td { color: #8fae9c; }
  .so-far { font-size: 9px; color: #d9b45c; text-transform: none; letter-spacing: 0; }
  td.n, th.n { text-align: right; }
  .users { width: 100%; }
  .users th, .users td { text-align: left; padding: 7px 6px; border-bottom: 1px solid #205237; }
  .users th { color: #8fae9c; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .dim { color: #6f9080; }
  .pname { font-weight: 600; }
  .uid { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10px; color: #6f9080; }
  .uid.full { word-break: break-all; user-select: all; }
  .back { display: inline-block; margin-bottom: 10px; color: #f2c14e; font-size: 13px; text-decoration: none; }
  .tag { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; margin-right: 3px; }
  .tag.app { background: #1d5c3a; color: #a8f0c6; }
  .tag.web { background: #3a3f5c; color: #c3c8f0; }
  .tag.on { background: #1d5c3a; color: #a8f0c6; }
  .tag.off { background: #4a3a2a; color: #e8c9a0; }
  details { background: #11301f; border: 1px solid #205237; border-radius: 8px; margin: 6px 0; padding: 6px 10px; }
  summary { cursor: pointer; font-size: 13px; font-weight: 600; }
  ul { margin: 8px 0 4px; padding-left: 18px; font-size: 13px; line-height: 1.8; }
  .notes { color: #8fae9c; font-size: 12px; line-height: 1.6; background: #11301f; border-radius: 8px; padding: 10px 12px; margin-top: 22px; }
  .notes b { color: #d9e8de; }
</style></head><body>
<a class="back" href="/">&larr; Back to the game</a>
<h1>Users, month on month</h1>
<div class="sub">Months in India time (IST) &middot; data read ${esc(stamp(dataAt || Date.now()))}
${report.logStart ? ` &middot; games logged since ${esc(day(report.logStart))}` : ''}<br>
${L.refresh ? `<a href="${esc(L.refresh)}">Read fresh data</a> &middot; ` : ''}${L.testers ? `<a href="${esc(L.testers)}">Tester activity</a>` : ''}</div>

<div class="cards">
  <div class="card"><div class="v">${s.totalUsers}</div><div class="k">Total users (ever)</div></div>
  <div class="card"><div class="v">${s.activeThisMonth}</div><div class="k">Active ${nowMonth ? esc(nowMonth.label.split(' ')[0]) : 'this month'} (so far)</div></div>
  <div class="card"><div class="v">${s.inactiveNow}</div><div class="k">Inactive now</div></div>
  ${s.lastMonth ? `<div class="card"><div class="v">${s.lastMonth.churnPct == null ? '&ndash;' : s.lastMonth.churnPct + '%'}</div><div class="k">Churn, ${esc(s.lastMonth.label.split(' ')[0])}</div></div>` : ''}
</div>

<h2>Active users roll-forward</h2>
${rollForward}

<h2>Who moved</h2>
${monthLists || '<p class="dim">Nobody yet.</p>'}

<h2>All users (${report.users.length})</h2>
<details><summary>Show the list</summary>
<div class="scroll"><table class="users">
  <tr><th>Player</th><th>Status</th><th>Last played</th><th>First played</th><th class="n">Months</th><th class="n">Games</th><th>Where</th></tr>
  ${userRows}
</table></div>
</details>

<div class="notes">
  <b>Active</b> = played at least one game in the month (finished, or left part-way after playing rounds).<br>
  <b>New</b> = their first game ever. <b>Came back</b> = played before, but not in the month before.<br>
  <b>Became inactive</b> = played last month, not this month. <b>Churn %</b> = became inactive &divide; opening active users.<br>
  <b>Opening + New + Came back &minus; Became inactive = Closing</b>, every month.<br>
  * The current month is not over: "became inactive" here means not played yet this month, and some will still come back.<br>
  The first month of the log has no opening balance (the month before it was not logged).
  Players who only played before the log began count in Total users and as inactive.<br>
  A user is one account: one per phone or browser, or one per Google account once they sign in with Google.<br>
  <b>Admin reports in the app:</b> put a player's full ID (All users, above) into <b>ADMIN_UIDS</b> on Render
  -- several can be separated by commas. That account then gets an "Admin reports" button in its Profile.
</div>
</body></html>`;
}

module.exports = { buildUserMonths, renderHtml, monthOfMs, shiftMonth, monthLabel };
