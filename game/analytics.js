// ---------------------------------------------------------------------------
// Our own game analytics (Nov 2026) -- what the Admin reports are built on.
//
// Numbers only: the anonymous account id every player already has, counts,
// times and results. No names, no phone numbers, nothing anyone typed.
//
// Four kinds of record:
//   games/{auto}     one per game, written when it ends (a winner, or everyone
//                    left first): mode, rounds, minutes, each player's result,
//                    calls, bot takeovers, lost connections, penalty cards...
//   rooms/{auto}     one per FRIENDS room, written when the room closes: did a
//                    friend come, was a game played, how long people waited.
//   searches/{auto}  one per online-match search: matched, filled with bots, or
//                    gave up, and how long it took.
//   days/{date}      one per India-time day: counters (app opens, invites,
//                    tutorial, every ad and what it earned, online peaks...).
//                    Kept in memory and written every few minutes, so a busy day
//                    costs a few hundred writes, not one per ad.
//
// Every entry point is wrapped: a failure here costs a number in a report,
// never a game. server.js calls these at the moments they describe.
// ---------------------------------------------------------------------------
'use strict';

const IST_MS = 330 * 60 * 1000;
const dayOf = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const hourOf = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 13);
const iso = (ms) => new Date(ms).toISOString();
const AD_TYPES = new Set(['banner', 'fs', 'rw']);

function createAnalytics(opts) {
  const o = opts || {};
  const getDb = typeof o.db === 'function' ? o.db : () => o.db;
  const getFV = typeof o.FieldValue === 'function' ? o.FieldValue : () => o.FieldValue;
  const now = o.now || (() => Date.now());
  const log = o.log || console;
  const startedAt = now();

  let buf = {};                      // day -> nested { __inc } / { __set } leaves
  const lastFullScreenAt = new Map(); // account id -> when their last full-screen ad showed
  const bannerWindow = [];           // banner loads / failures in the last hour (for the live check)
  const hourMax = {};                // `${day}|${hh}` -> most players online in that hour
  let lastGameEndAt = null;
  let peak = { day: null, n: 0, at: null };

  const warn = (e) => { try { log.warn('[analytics]', e && e.message); } catch (x) { /* nothing */ } };
  const guard = (fn) => function guarded(...a) {
    try { return fn(...a); } catch (e) { warn(e); return undefined; }
  };

  // ---- the day buffer --------------------------------------------------
  function node(day, path) {
    let n = buf[day] || (buf[day] = {});
    for (const k of path) {
      const c = n[k];
      if (!c || typeof c !== 'object' || '__inc' in c || '__set' in c) n[k] = {};
      n = n[k];
    }
    return n;
  }
  function inc(path, by, at) {
    const day = dayOf(at || now());
    const parent = node(day, path.slice(0, -1));
    const k = path[path.length - 1];
    const cur = parent[k] && parent[k].__inc;
    parent[k] = { __inc: (cur || 0) + (by == null ? 1 : by) };
  }
  function put(path, value, at) {
    const day = dayOf(at || now());
    node(day, path.slice(0, -1))[path[path.length - 1]] = { __set: value };
  }
  function toFirestore(n) {
    if (n && typeof n === 'object' && '__inc' in n) {
      const FV = getFV();
      return FV && typeof FV.increment === 'function' ? FV.increment(n.__inc) : n.__inc;
    }
    if (n && typeof n === 'object' && '__set' in n) return n.__set;
    const out = {};
    for (const k of Object.keys(n)) out[k] = toFirestore(n[k]);
    return out;
  }
  function mergeBack(into, from) {
    for (const k of Object.keys(from)) {
      const f = from[k];
      if (f && typeof f === 'object' && '__inc' in f) {
        const cur = into[k] && into[k].__inc;
        into[k] = { __inc: (cur || 0) + f.__inc };
      } else if (f && typeof f === 'object' && '__set' in f) {
        if (!into[k]) into[k] = f;
      } else {
        into[k] = into[k] && typeof into[k] === 'object' ? into[k] : {};
        mergeBack(into[k], f);
      }
    }
  }
  async function flush() {
    const db = getDb();
    if (!db) return;
    const pending = buf;
    buf = {};
    for (const day of Object.keys(pending)) {
      try {
        await db.collection('days').doc(day).set(toFirestore(pending[day]), { merge: true });
      } catch (e) {
        warn(e);
        buf[day] = buf[day] || {};
        mergeBack(buf[day], pending[day]);   // try again next time
      }
    }
  }
  function store(collection, rec) {
    const db = getDb();
    if (!db) return;
    Promise.resolve().then(() => db.collection(collection).add(rec)).catch(warn);
  }

  // ---- games -----------------------------------------------------------
  function humansOf(room) {
    const g = room.game;
    if (!g) return [];
    return g.playerIds.filter((id) => { const p = room.players.get(id); return p && !p.isBot; });
  }
  function entryFor(room, pid, extra) {
    const s = room.ana;
    const p = room.players.get(pid);
    if (!s || !p || p.isBot) return null;
    const e = s.players[pid] || (s.players[pid] = {
      uid: p.firebaseUid || null, platform: p.platform || 'unknown', joinedAt: now(),
      joinedRound: (room.game ? room.game.roundNumber : 0) + 1,
      result: null, outRound: null, outAt: null, mid: false, viaAd: false, rejoined: false, back: null, takeovers: 0, lost: 0,
    });
    if (extra) Object.assign(e, extra);
    return e;
  }

  // A new game is dealt (first round). room.mode is set where the room is made.
  const gameStarted = guard((room) => {
    const g = room.game;
    if (!g) return;
    const hs = humansOf(room);
    room.ana = {
      mode: room.mode || 'friends', startedAt: now(), maxScore: g.eliminationScore,
      botLevel: g.playerIds.length > hs.length ? (room.botDifficulty || null) : null,
      tableSize: g.playerIds.length, humans: hs.length, bots: g.playerIds.length - hs.length,
      rounds: 0, lastRound: 0, calls: [], takeovers: 0, takeoverBack: 0, takeoverOut: 0,
      lostConnections: 0, soloPaused: 0, midJoins: 0, midJoinsAd: 0, rejoins: 0, rejoinsAd: 0, players: {}, done: false,
    };
    for (const pid of hs) entryFor(room, pid, { joinedRound: 1 });
    const rs = room.rstats;
    if (rs) { rs.games += 1; if (hs.length >= 2) rs.withFriends = true; }
  });

  // Once per finished round (onRoundEnded): the call, and who went out.
  const roundEnded = guard((room) => {
    const g = room.game;
    const s = room.ana;
    if (!g || !s || s.done || s.lastRound === g.roundNumber) return;
    s.lastRound = g.roundNumber;
    s.rounds = g.roundNumber;
    const r = g.lastRoundResult || {};
    if (r.declaredBy && r.values) {
      const p = room.players.get(r.declaredBy);
      if (p && !p.isBot) s.calls.push({ v: Number(r.values[r.declaredBy]) || 0, ok: !!r.correct });
    }
    const absent = new Set(r.absentEliminated || []);
    for (const pid of Object.keys(s.players)) {
      const e = s.players[pid];
      if (e.result || !g.eliminated.has(pid)) continue;
      e.result = absent.has(pid) ? 'missed-turns' : 'knocked-out';
      e.outRound = g.roundNumber;
      e.outAt = now();
      if (absent.has(pid)) s.takeoverOut += 1;
    }
  });

  function writeGame(room, outcome) {
    const s = room.ana;
    if (!s || s.done) return;
    s.done = true;
    const g = room.game;
    const t = now();
    const ds = (g && g.drawStats) || {};
    const players = Object.values(s.players).map((e) => ({
      uid: e.uid, platform: e.platform, result: e.result || 'walked-out',
      rounds: Math.max(0, (e.outRound == null ? s.rounds : e.outRound) - e.joinedRound + 1),
      secs: Math.max(0, Math.round(((e.outAt || t) - e.joinedAt) / 1000)),
      mid: !!e.mid, viaAd: !!e.viaAd, rejoined: !!e.rejoined, takeovers: e.takeovers, lost: e.lost,
      // rounds: first played, went out in (null = never out), came back in
      // (after an ad or a rejoin) -- "did they stay after coming back?"
      from: e.joinedRound, out: e.result === 'won' ? null : e.outRound, back: e.back,
    }));
    const winner = g && g.winner ? room.players.get(g.winner) : null;
    store('games', {
      v: 1, mode: s.mode, outcome, day: dayOf(s.startedAt), startedAt: iso(s.startedAt), endedAt: iso(t), endDay: dayOf(t),
      secs: Math.round((t - s.startedAt) / 1000), rounds: s.rounds, maxScore: s.maxScore, botLevel: s.botLevel,
      tableSize: s.tableSize, humans: s.humans, bots: s.bots,
      winner: outcome === 'winner' ? (winner && winner.isBot ? 'bot' : 'person') : null,
      calls: s.calls, takeovers: s.takeovers, takeoverBack: s.takeoverBack, takeoverOut: s.takeoverOut,
      lostConnections: s.lostConnections, soloPaused: s.soloPaused,
      midJoins: s.midJoins, midJoinsAd: s.midJoinsAd, rejoins: s.rejoins, rejoinsAd: s.rejoinsAd,
      penalty: { cards: ds.cards || 0, sum: ds.sum || 0, eightPlus: ds.eightPlus || 0, chains: ds.chains || 0, longestChain: ds.longestChain || 0 },
      reshuffles: (g && g.reshuffleCount) || 0,
      players,
    });
    lastGameEndAt = t;
  }

  // The game reached a winner.
  const gameFinished = guard((room) => {
    const g = room.game;
    const s = room.ana;
    if (!g || !s || s.done) return;
    roundEnded(room);
    for (const pid of Object.keys(s.players)) {
      const e = s.players[pid];
      if (pid === g.winner) e.result = 'won';
      if (e.result) continue;
      if (g.quit && g.quit.has(pid)) e.result = 'walked-out';
      else if (g.eliminated.has(pid)) e.result = 'knocked-out';
      else e.result = 'still-in';
      if (e.outRound == null) e.outRound = g.roundNumber;
      if (!e.outAt) e.outAt = now();
    }
    writeGame(room, 'winner');
    if (room.rstats) room.rstats.toWinner += 1;
  });

  // A person left the room while their game was still on (not after being
  // knocked out -- that is a finished game, not a walk-out).
  const playerLeft = guard((room, pid) => {
    const s = room.ana;
    const g = room.game;
    const e = s && s.players[pid];
    leftAfterAd(e && e.uid);
    if (!s || !g || s.done || g.gameOver || !e || e.result) return;
    e.result = 'walked-out';
    e.outRound = (g.roundHistory || []).length;
    e.outAt = now();
  });
  // Their connection went while still in a game (they may come back).
  const lostConnection = guard((room, pid) => {
    const s = room.ana;
    const g = room.game;
    const e = s && s.players[pid];
    if (!s || !g || s.done || g.gameOver || !e || e.result) return;
    s.lostConnections += 1;
    e.lost += 1;
    leftAfterAd(e.uid);
  });
  // Missed-turn takeovers: 'start' (bot took the seat) / 'back' (they came back).
  const takeover = guard((room, pid, kind) => {
    const s = room.ana;
    const e = s && s.players[pid];
    if (!s || s.done) return;
    if (kind === 'start') { s.takeovers += 1; if (e) e.takeovers += 1; }
    if (kind === 'back') s.takeoverBack += 1;
  });
  const soloPaused = guard((room) => { if (room.ana && !room.ana.done) room.ana.soloPaused += 1; });
  // A person seated into a running game (at the next deal), and how.
  const midGameJoin = guard((room, pid, viaAd) => {
    const s = room.ana;
    if (!s || s.done) return;
    const round = (room.game ? room.game.roundNumber : 0) + 1;
    const e = entryFor(room, pid, { mid: true, viaAd: !!viaAd, joinedAt: now(), joinedRound: round, back: viaAd ? round : null });
    if (!e) return;
    s.midJoins += 1;
    if (viaAd) s.midJoinsAd += 1;
  });
  // Knocked out, then let back in (seated at the next deal).
  const rejoined = guard((room, pid) => {
    const s = room.ana;
    const e = s && s.players[pid];
    if (!s || s.done || !e) return;
    e.result = null; e.outRound = null; e.outAt = null; e.rejoined = true;
    e.back = (room.game ? room.game.roundNumber : 0) + 1;
    s.rejoins += 1;
  });
  // A rejoin paid for with a rewarded ad (claim_ad_reward).
  const adSeat = guard((room, pid) => {
    const s = room.ana;
    const e = s && s.players[pid];
    if (!s || s.done || !e) return;
    if (!e.viaAd) s.rejoinsAd += 1;
    e.viaAd = true;
  });

  // ---- friends rooms ----------------------------------------------------
  const roomCreated = guard((room) => {
    room.rstats = { createdAt: now(), invites: 0, firstFriendAt: null, maxHumans: 1, bots: false, games: 0, withFriends: false, toWinner: 0, done: false };
  });
  const friendJoined = guard((room) => {
    const rs = room.rstats;
    if (!rs) return;
    if (!rs.firstFriendAt) rs.firstFriendAt = now();
    let humans = 0;
    for (const pid of room.order) { const p = room.players.get(pid); if (p && !p.isBot) humans += 1; }
    rs.maxHumans = Math.max(rs.maxHumans, humans);
  });
  const botAdded = guard((room) => { if (room.rstats) room.rstats.bots = true; });
  function writeRoom(room) {
    const rs = room.rstats;
    if (!rs || rs.done) return;
    rs.done = true;
    const t = now();
    let outcome = 'nobody-closed';
    if (rs.withFriends) outcome = 'played-friends';
    else if (rs.firstFriendAt) outcome = 'friend-never-started';
    else if (rs.games > 0) outcome = 'nobody-bots';
    store('rooms', {
      v: 1, day: dayOf(rs.createdAt), createdAt: iso(rs.createdAt), closedAt: iso(t), outcome,
      invites: rs.invites, firstFriendSecs: rs.firstFriendAt ? Math.round((rs.firstFriendAt - rs.createdAt) / 1000) : null,
      openSecs: Math.round((t - rs.createdAt) / 1000), friends: Math.max(0, rs.maxHumans - 1),
      games: rs.games, withFriends: rs.withFriends, toWinner: rs.toWinner,
    });
  }
  // Just before a room is deleted: a game still running ended early (everyone
  // left), and a friends room gets its record. When every person in it had
  // already been knocked out (only bots were left playing), the game is over
  // for all the people in it: 'all-knocked-out', counted as played to the end.
  const roomClosed = guard((room) => {
    const s = room.ana;
    const g = room.game;
    if (s && !s.done && g && !g.gameOver) {
      const people = Object.values(s.players);
      const allOut = people.length > 0 && people.every((e) => e.result === 'knocked-out');
      for (const e of people) {
        if (e.result) continue;
        e.result = 'walked-out';
        e.outRound = (g.roundHistory || []).length;
        e.outAt = now();
      }
      writeGame(room, allOut ? 'all-knocked-out' : 'ended-early');
    }
    writeRoom(room);
  });

  // ---- online matchmaking ------------------------------------------------
  const searchEnded = guard((entry, outcome) => {
    if (!entry || entry.anaEnded) return;
    entry.anaEnded = true;
    const t = now();
    const at = entry.queuedAt || t;
    store('searches', { v: 1, day: dayOf(at), at: iso(at), size: entry.size || null, waitSecs: Math.round((t - at) / 1000), outcome });
  });

  // ---- client events -------------------------------------------------------
  function leftAfterAd(uid) {
    if (!uid) return;
    const at = lastFullScreenAt.get(uid);
    if (at && now() - at <= 60 * 1000) { inc(['ads', 'fs', 'leftAfter']); lastFullScreenAt.delete(uid); }
  }
  // App opens: who opened today (one entry per person, app or website), and
  // in which hour each person FIRST opened it today -- so "so far today" can
  // be set beside the same hours of other days. (After a server restart a
  // person's next open can count once more in a later hour; rare.)
  const firstOpens = { day: null, seen: new Set() };
  const opened = guard((uid, platform) => {
    if (!uid) return;
    const kind = platform === 'android-app' ? 'app' : (platform === 'web' ? 'web' : 'other');
    put(['opens', uid], kind);
    const at = now();
    const day = dayOf(at);
    if (firstOpens.day !== day) { firstOpens.day = day; firstOpens.seen = new Set(); }
    if (!firstOpens.seen.has(uid)) {
      firstOpens.seen.add(uid);
      inc(['hours', hourOf(at), kind === 'app' ? 'appOpens' : 'webOpens'], 1, at);
    }
  });
  const inviteShared = guard((room) => {
    inc(['invites']);
    if (room && room.rstats) room.rstats.invites += 1;
  });
  function adEvent(uid, ev) {
    const t = AD_TYPES.has(ev.t) ? ev.t : null;
    const a = typeof ev.a === 'string' && /^[a-zA-Z]{2,16}$/.test(ev.a) ? ev.a : null;
    if (!t || !a) return;
    const at = now();
    const hh = hourOf(at);
    inc(['ads', t, a]);
    if (a === 'paid') {
      const v = Math.max(0, Math.min(1e9, Math.round(Number(ev.v) || 0)));
      inc(['rev', t], v);
      inc(['hours', hh, 'rev'], v);
      if (uid) inc(['revBy', uid], v);
      if (typeof ev.c === 'string' && /^[A-Z]{3}$/.test(ev.c)) put(['currency'], ev.c);
    }
    if ((a === 'impression' || a === 'shown') && uid) inc(['adsBy', uid]);
    if (t === 'banner' && (a === 'loaded' || a === 'failed')) {
      inc(['hours', hh, a === 'loaded' ? 'bLoaded' : 'bFailed']);
      bannerWindow.push({ at, ok: a === 'loaded' });
      while (bannerWindow.length && at - bannerWindow[0].at > 60 * 60 * 1000) bannerWindow.shift();
      if (a === 'failed' && ev.why === 'nofill') inc(['ads', 'banner', 'nofill']);
    }
    if (t === 'banner' && a === 'click' && Number(ev.ms) >= 0 && Number(ev.ms) < 1000) inc(['ads', 'banner', 'quickClick']);
    if (t === 'fs' && a === 'shown' && uid) lastFullScreenAt.set(uid, at);
    if (t === 'fs' && a === 'skip') inc(['ads', 'fs', ev.why === 'soon' ? 'skipSoon' : 'skipNotReady']);
    if (t === 'fs' && a === 'dismissed' && Number(ev.ms) >= 0 && Number(ev.ms) < 5000) inc(['ads', 'fs', 'quickClose']);
  }
  const track = guard((uid, platform, ev, room) => {
    if (!ev || typeof ev.e !== 'string') return;
    switch (ev.e) {
      case 'invite_shared':
      case 'invite_shared_whatsapp':
        inviteShared(room);
        break;
      case 'room_joined':
      case 'room_joined_midgame':
        if (ev.via === 'invite' && uid) put(['invitedJoins', uid], 1);
        break;
      case 'invite_link_opened': inc(['inviteOpens']); break;
      case 'tutorial_started': inc(['tutorial', 'started']); break;
      case 'tutorial_completed':
        inc(['tutorial', 'done']);
        if (uid) put(['tutorialBy', uid], 'done');
        break;
      case 'tutorial_skipped':
      case 'tutorial_declined':
        inc(['tutorial', 'skipped']);
        if (uid) put(['tutorialBy', uid], 'skipped');
        break;
      case 'install_prompt_shown': inc(['install', 'shown']); break;
      case 'install_prompt_accepted': inc(['install', 'accepted']); break;
      case 'ad': adEvent(uid, ev); break;
      default: break;
    }
  });

  // ---- live ------------------------------------------------------------------
  // Called every minute with what the server sees right now.
  const sample = guard((live) => {
    const at = now();
    const day = dayOf(at);
    const key = day + '|' + hourOf(at);
    const n = Math.max(0, Number(live && live.online) || 0);
    if ((hourMax[key] || 0) < n || hourMax[key] == null) {
      hourMax[key] = Math.max(hourMax[key] || 0, n);
      put(['hours', hourOf(at), 'online'], hourMax[key]);
    }
    if (peak.day !== day) peak = { day, n: 0, at: null };
    if (n > peak.n) {
      peak = { day, n, at: iso(at) };
      put(['peak'], { n, at: peak.at });
    }
    for (const k of Object.keys(hourMax)) if (!k.startsWith(day)) delete hourMax[k];
  });
  function liveInfo() {
    const at = now();
    while (bannerWindow.length && at - bannerWindow[0].at > 60 * 60 * 1000) bannerWindow.shift();
    const loaded = bannerWindow.filter((x) => x.ok).length;
    return {
      startedAt: iso(startedAt), lastGameEndAt: lastGameEndAt ? iso(lastGameEndAt) : null,
      bannerLastHour: { loaded, failed: bannerWindow.length - loaded },
      peakToday: peak.day === dayOf(at) ? { n: peak.n, at: peak.at } : { n: 0, at: null },
    };
  }

  return {
    gameStarted, roundEnded, gameFinished, playerLeft, lostConnection, takeover, soloPaused, midGameJoin, rejoined, adSeat,
    roomCreated, friendJoined, botAdded, roomClosed, inviteShared,
    searchEnded, opened, track, sample, liveInfo, flush,
    // for tests
    _buffer: () => buf,
  };
}

module.exports = { createAnalytics, dayOf, hourOf };
