const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const { LeastCountGame, MAX_SCORE_OPTIONS, handValue, cardValue, DECLARE_MAX_VALUE, deckCountForPlayers } = require('./game/gameLogic');

const app = express();
const server = http.createServer(app);

// --------------------------------------------------------------------------
// Lock Socket.IO down to the real deployed clients instead of accepting a
// connection (and therefore create_room/chat_message/etc calls) from ANY
// origin, which is the default when no cors option is set at all. Includes
// the Android/iOS app's WebView origins (Capacitor apps don't share the
// website's origin) alongside the live site, so this doesn't break the
// mobile app while closing the door on some other page embedding a socket
// straight to this server. A request with no Origin header at all (some
// native WebView configurations omit it) is let through rather than
// rejected -- blocking it would risk breaking the mobile app for everyone,
// not just an attacker. Configurable via CLIENT_ORIGINS (comma-separated)
// in case the deployed origin ever changes without a code deploy.
// --------------------------------------------------------------------------
const DEFAULT_ALLOWED_ORIGINS = [
  'https://least-count-game.onrender.com',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
];
const ALLOWED_ORIGINS = process.env.CLIENT_ORIGINS
  ? process.env.CLIENT_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error('Origin not allowed'));
    },
  },
});

app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Firebase Admin (server-side). This is the ONLY trusted place stats,
// purchases, etc. should ever get written -- the server already knows who
// really won a game, so writing from here (instead of the browser) means a
// player can't just open dev tools and edit their own stats. Credentials
// come from a Render "Secret File" (see the Environment tab), never from
// anything committed to GitHub. Render makes secret files available both at
// /etc/secrets/<filename> and in the app's own root directory, so this
// checks both locations -- keeps things working the same in local dev too,
// if the same file is ever placed in the project root there.
// --------------------------------------------------------------------------
const FIREBASE_SERVICE_ACCOUNT_FILENAME = 'least-count-ad558-firebase-adminsdk-fbsvc-8ab25ff468';
const firebaseServiceAccountPath = [
  path.join('/etc/secrets', FIREBASE_SERVICE_ACCOUNT_FILENAME),
  path.join(__dirname, FIREBASE_SERVICE_ACCOUNT_FILENAME),
].find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

let db = null;
if (firebaseServiceAccountPath) {
  try {
    const serviceAccount = JSON.parse(fs.readFileSync(firebaseServiceAccountPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('[Firebase] Admin SDK initialized -- Firestore is connected.');
  } catch (e) {
    console.error('[Firebase] Failed to initialize Admin SDK:', e.message);
  }
} else {
  console.warn('[Firebase] Service account file not found -- Firestore writes are disabled for now.');
}

// Temporary manual check only -- visit /api/firebase-test in a browser to
// confirm the server can actually write to and read from Firestore. Safe to
// remove once this is confirmed working and real stat-writing replaces it.
app.get('/api/firebase-test', async (req, res) => {
  if (!db) return res.status(500).json({ ok: false, error: 'Firestore is not initialized on the server -- check the secret file setup.' });
  try {
    const ref = db.collection('_diagnostics').doc('server-test');
    await ref.set({ lastCheckedAt: new Date().toISOString(), ok: true });
    const snap = await ref.get();
    res.json({ ok: true, savedData: snap.data() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --------------------------------------------------------------------------
// Real stat-tracking. Called from every place a game can actually end (a
// correct declare, someone leaving down to 1 player, etc). Deliberately
// server-driven, not client-driven -- the server is the only thing that
// truly knows who won, so this is the one trustworthy place to record it.
// Guarded by room.statsRecorded so a game's result is only ever written
// once, no matter which of several code paths ends it. Bots and guests who
// never actually got a Firebase account linked (firebaseUid missing) are
// silently skipped -- there's nowhere to save their stats yet.
// --------------------------------------------------------------------------
async function recordGameResult(room) {
  if (!db || !room.game || !room.game.gameOver || room.statsRecorded) return;
  room.statsRecorded = true;
  const winnerId = room.game.winner;
  const writes = [];
  for (const pid of room.game.playerIds) {
    const player = room.players.get(pid);
    if (!player || player.isBot || !player.firebaseUid) continue;
    const ref = db.collection('users').doc(player.firebaseUid);
    const isWinner = pid === winnerId;
    writes.push(ref.set({
      displayName: player.name,
      gamesPlayed: admin.firestore.FieldValue.increment(1),
      wins: admin.firestore.FieldValue.increment(isWinner ? 1 : 0),
      lastPlayedAt: new Date().toISOString(),
    }, { merge: true }));
  }
  try {
    await Promise.all(writes);
    console.log(`[Firebase] Recorded game result for room ${room.code} (${writes.length} player(s) with linked accounts).`);
  } catch (e) {
    console.error(`[Firebase] Failed to record game result for room ${room.code}:`, e.message);
  }
}

// --------------------------------------------------------------------------
// Verifies a Firebase ID token the client sent and returns the uid it
// actually, provably belongs to -- or null if there's no token, it fails
// verification, or Firebase Admin isn't configured. Every place that used to
// take a raw `firebaseUid` string straight out of the client's payload (and
// trust it completely) now sends the short-lived ID token instead and uses
// ONLY what this returns -- so a player can no longer open dev tools, type
// in a stranger's uid (or a made-up one), and have game results/stats
// attributed to that account. Deliberately fails soft (null, not a thrown
// error) so a token hiccup degrades to "this game just won't count toward
// your stats" instead of blocking someone from playing at all.
// --------------------------------------------------------------------------
async function verifyFirebaseToken(idToken) {
  if (!idToken || !db) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (e) {
    console.warn('[Firebase] ID token verification failed:', e.message);
    return null;
  }
}

// --------------------------------------------------------------------------
// Basic chat content filtering. Deliberately simple -- a fixed word list,
// whole-word matching (so it doesn't flag substrings inside innocent words),
// and censoring (turning the word into asterisks) rather than blocking the
// message outright, so one filtered word doesn't stop the rest of a message
// from sending. This is a first layer for a family game, not a complete
// moderation system -- paired with the report/mute tools on the client for
// anything it misses.
// --------------------------------------------------------------------------
const PROFANITY_LIST = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy',
  'whore', 'slut', 'nigger', 'nigga', 'faggot', 'retard', 'rape', 'molest',
];
const PROFANITY_REGEX = new RegExp(`\\b(${PROFANITY_LIST.join('|')})\\b`, 'gi');
function censorText(text) {
  return text.replace(PROFANITY_REGEX, (match) => '*'.repeat(match.length));
}

// --------------------------------------------------------------------------
// GIF search (chat). Proxies to Giphy so the API key stays server-side only
// -- never shipped to the browser, where anyone could read it out of the
// page source and drain the quota. Set GIPHY_API_KEY as an environment
// variable (Render.com: Environment tab) to enable this; without it, the
// endpoint just tells the client GIF search isn't configured yet.
// --------------------------------------------------------------------------
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

app.get('/api/gif-search', async (req, res) => {
  if (!GIPHY_API_KEY) {
    return res.status(501).json({ ok: false, error: 'GIF search is not set up yet.' });
  }
  const q = (req.query.q || '').toString().trim().slice(0, 60);
  try {
    const endpoint = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(GIPHY_API_KEY)}&q=${encodeURIComponent(q)}&limit=18&rating=pg-13`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(GIPHY_API_KEY)}&limit=18&rating=pg-13`;
    const giphyRes = await fetch(endpoint);
    const data = await giphyRes.json();
    const gifs = (data.data || []).map((g) => ({
      id: g.id,
      preview: (g.images && (g.images.fixed_width_small || g.images.fixed_width) || {}).url,
      full: (g.images && (g.images.fixed_width || g.images.original) || {}).url,
    })).filter((g) => g.preview && g.full);
    res.json({ ok: true, gifs });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'GIF search failed. Try again.' });
  }
});

// --------------------------------------------------------------------------
// In-memory room store. Fine for a small private game among family/friends;
// state simply resets if the server restarts.
// --------------------------------------------------------------------------
const rooms = new Map(); // roomCode -> Room
const socketIndex = new Map(); // socket.id -> { roomCode, playerId }

// "Play Online" matchmaking -- queue by desired table size (3-6), matched
// with strangers the instant enough people are waiting for the same size.
// Deliberately separate from `rooms`/`socketIndex`: a queued player isn't in
// any room yet, so there's nothing there for them until they're matched.
const QUEUE_SIZES = [3, 4, 5, 6];
const matchQueues = new Map(QUEUE_SIZES.map((n) => [n, []])); // playerCount -> array of queued entries
const queueIndex = new Map(); // socket.id -> playerCount (which bucket they're in, for cleanup)

// Reduced from 30s -> 20s: with the sound-only "your turn" cue proving easy
// to miss, a snappier timer keeps a distracted player from stalling the
// table for too long even before the new visual pulse (client-side) kicks in.
const TURN_SECONDS = 20;
const CHAT_HISTORY_LIMIT = 100;
const DEFAULT_ELIMINATION_SCORE = 200;
// Solo play (item: "Play Solo" on the landing screen) -- bots act fast, well
// under the human turn timer, using the exact same auto-play logic already
// used when a human times out (see runBotTurn/scheduleTurnTimer below).
const BOT_MOVE_MS = 3000;
const MAX_BOTS = 7;

// ---------------------------------------------------------------------------
// Game-start sequence timing. When the host clicks "Start Game" the cards
// aren't just instantly dealt -- everyone sees a 3-2-1 countdown, then a
// live-dealing animation, then the round's joker rank + open card are
// revealed and held on screen for a few seconds. The real per-turn timer
// (and therefore "the start of the game") only begins partway into that
// reveal, not the instant hands are dealt.
// ---------------------------------------------------------------------------
const COUNTDOWN_MS = 3000; // 3-2-1
// The deal animation does one visual "flight" per card per player -- 13
// passes each, matching the real hand size, not a shortened stand-in.
// Total deal time scales with player count (a bigger table really does
// take longer to deal) rather than being a fixed duration split thinner
// and thinner as more players join.
const DEAL_PASSES = 13;
const DEAL_FLIGHT_MS = 90; // time per individual card flight (travel + brief pause)
// New intro phase, before the existing per-card deal animation: shows the
// actual number of decks in play (so players can reason about card-count
// probability), then a riffle-merge shuffle. Fixed duration regardless of
// table size -- only the deck COUNT shown changes, not how long this takes.
const DECK_INTRO_MS = 3400;
const REVEAL_MS = 2500; // joker/open-card reveal, held on screen
const REVEAL_TO_TIMER_MS = 1200; // turn timer quietly starts this far into the reveal
// Minimum penalty-cards-in-one-go and discard-group-size that count as
// "big" enough to trigger a seat reaction (items 9/10). The client decides
// which emoji(s) each reaction type maps to and whether it's shown at the
// affected player's own seat, everyone else's seats, or both.
const PENALTY_REACTION_THRESHOLD = 6;
const BIG_DISCARD_THRESHOLD = 4;
const LOW_CARDS_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Per-socket rate limiting. Each connected socket gets its own small bucket
// per action type; going over the limit just gets rejected (same as any
// other invalid action, via the existing ack({ok:false}) error path) instead
// of processed. This is a brake pedal, not a ban -- once the window passes,
// that socket can act again normally. Limits are set generously above what
// a real human could ever hit through normal play/chat, so this should never
// trip for a legitimate player; it's here for scripted spam and stuck-key
// button-mashing, not to slow anyone down.
// ---------------------------------------------------------------------------
const RATE_LIMITS = {
  chat_message: { max: 5, windowMs: 10000 },       // 5 chat/GIF messages per 10s
  play_turn: { max: 10, windowMs: 5000 },           // 10 moves per 5s
  declare: { max: 5, windowMs: 5000 },
  request_hint: { max: 10, windowMs: 10000 },
  create_room: { max: 5, windowMs: 60000 },
  create_solo_room: { max: 5, windowMs: 60000 },
  join_room: { max: 10, windowMs: 60000 },
  report_player: { max: 5, windowMs: 60000 },
  get_my_stats: { max: 10, windowMs: 30000 },
  get_player_stats: { max: 20, windowMs: 30000 },
};
const rateBuckets = new Map(); // socket.id -> { [eventName]: number[] recent timestamps }

function isRateLimited(socket, eventName) {
  const limit = RATE_LIMITS[eventName];
  if (!limit) return false;
  const now = Date.now();
  let bucket = rateBuckets.get(socket.id);
  if (!bucket) { bucket = {}; rateBuckets.set(socket.id, bucket); }
  let hits = bucket[eventName];
  if (!hits) { hits = []; bucket[eventName] = hits; }
  while (hits.length && now - hits[0] > limit.windowMs) hits.shift(); // drop expired hits
  if (hits.length >= limit.max) return true;
  hits.push(now);
  return false;
}

// --------------------------------------------------------------------------
// Per-IP rate limiting, on top of (not instead of) the per-socket limits
// above. Per-socket limits reset the instant a socket reconnects, so they're
// closer to "friction" than "protection" against anything scripted -- this
// adds a second, IP-keyed check on just the three endpoints that actually
// matter for abuse (spinning up rooms, and filing reports), which survives
// a reconnect. Deliberately generous (25/min) so a household or office on
// one shared/NAT'd public IP never gets penalized for normal play -- this
// is aimed at a script hammering the server, not a family playing together.
// --------------------------------------------------------------------------
const IP_RATE_LIMITS = {
  create_room: { max: 25, windowMs: 60000 },
  create_solo_room: { max: 25, windowMs: 60000 },
  report_player: { max: 25, windowMs: 60000 },
};
const ipRateBuckets = new Map(); // ip -> { [eventName]: number[] recent timestamps }

function getClientIp(socket) {
  // Render (and most hosts) put the app behind a proxy, so the raw socket
  // address is the proxy's own IP, not the visitor's -- prefer the
  // forwarded-for header (first hop is the original client) when present.
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return socket.handshake.address;
}

function isIpRateLimited(socket, eventName) {
  const limit = IP_RATE_LIMITS[eventName];
  if (!limit) return false;
  const ip = getClientIp(socket);
  const now = Date.now();
  let bucket = ipRateBuckets.get(ip);
  if (!bucket) { bucket = {}; ipRateBuckets.set(ip, bucket); }
  let hits = bucket[eventName];
  if (!hits) { hits = []; bucket[eventName] = hits; }
  while (hits.length && now - hits[0] > limit.windowMs) hits.shift();
  if (hits.length >= limit.max) return true;
  hits.push(now);
  return false;
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makePlayerId() {
  return crypto.randomUUID();
}

function publicRoomInfo(room) {
  return {
    roomCode: room.code,
    hostPlayerId: room.hostPlayerId,
    phase: room.phase,
    players: room.order.map((pid) => ({
      playerId: pid,
      name: room.players.get(pid).name,
      connected: room.players.get(pid).connected,
      isBot: !!room.players.get(pid).isBot,
    })),
  };
}

// Picks who should become the new host when the current one leaves/disconnects
// (excludePlayerId). Prefers someone actually still in the fight (connected,
// human, not eliminated/quit) over an eliminated player who's just sitting in
// the room post-elimination -- an eliminated host closing their tab shouldn't
// hand hosting to some other eliminated spectator instead of an active player.
// Falls back progressively (any connected human, then anyone at all) so a
// host handoff never simply fails.
function pickNextHost(room, excludePlayerId) {
  const eliminated = room.game ? room.game.eliminated : null;
  const quit = room.game ? room.game.quit : null;
  const isActive = (id) => {
    const pl = room.players.get(id);
    if (!pl || pl.isBot || !pl.connected) return false;
    if (eliminated && eliminated.has(id)) return false;
    if (quit && quit.has(id)) return false;
    return true;
  };
  const isConnectedHuman = (id) => {
    const pl = room.players.get(id);
    return !!(pl && pl.connected && !pl.isBot);
  };
  // Last-resort fallback must still never be a bot -- if every human has
  // disconnected (e.g. the sole human in a solo-bots room), host is left
  // pointing at whichever human it already was (via the null return below,
  // which both call sites treat as "leave hostPlayerId unchanged") so it's
  // instantly valid again the moment that human reconnects, instead of
  // getting stuck assigned to a bot that never takes an action to hand it
  // off again.
  const isHuman = (id) => {
    const pl = room.players.get(id);
    return !!(pl && !pl.isBot);
  };
  const candidates = room.order.filter((id) => id !== excludePlayerId);
  return candidates.find(isActive) || candidates.find(isConnectedHuman) || candidates.find(isHuman) || null;
}

function broadcastRoom(room) {
  for (const pid of room.order) {
    const p = room.players.get(pid);
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('room_update', publicRoomInfo(room));
    }
  }
}

// Pushes the CURRENT full list of pending mid-game join requests to the
// host only -- sent as a complete list (not a diff) every time it changes,
// so a host who's mid-round and only glances at the banner occasionally
// always sees an accurate, current picture rather than needing to track a
// stream of individual add/remove events.
function notifyHostOfJoinRequest(room) {
  const host = room.players.get(room.hostPlayerId);
  if (!host || !host.connected || !host.socketId || !room.pendingJoins) return;
  const pending = Array.from(room.pendingJoins.entries()).map(([playerId, r]) => ({ playerId, name: r.name }));
  io.to(host.socketId).emit('join_requests', { pending });
}

// Shared by both the hard 2-minute timeout and an explicit host Ignore --
// in both cases the requester is told the same thing and sent back to the
// landing screen, and the pending record + its timer are cleaned up.
function denyJoinRequest(room, playerId, reason) {
  if (!room.pendingJoins || !room.pendingJoins.has(playerId)) return;
  const entry = room.pendingJoins.get(playerId);
  clearTimeout(entry.timer);
  room.pendingJoins.delete(playerId);
  socketIndex.delete(entry.socketId);
  io.to(entry.socketId).emit('join_denied', { reason });
  notifyHostOfJoinRequest(room);
}

function broadcastGameState(room) {
  if (!room.game) return;
  for (const pid of room.order) {
    const p = room.players.get(pid);
    if (p.connected && p.socketId) {
      const state = room.game.getPublicState(pid);
      state.turnDeadline = room.turnDeadline || null;
      io.to(p.socketId).emit('game_state', state);
    }
  }
}

// ---------------------------------------------------------------------------
// "Play Online" matchmaking. Pulls exactly `playerCount` entries off the
// front of that size's queue (assumes the caller already confirmed there are
// enough), builds a fresh room for them -- same shape as create_room, just
// with every seat already filled by real strangers instead of one player
// waiting in a lobby -- and starts the game immediately (no lobby step at
// all, matching how create_solo_room skips it too).
function startMatchedRoom(entries) {
  const code = makeRoomCode();
  const hostPlayerId = entries[0].playerId; // arbitrary but consistent -- first to queue "hosts" (next-round max-score changes etc.)
  const room = {
    code,
    hostPlayerId,
    players: new Map(),
    order: [],
    phase: 'lobby',
    game: null,
    turnTimer: null,
    turnDeadline: null,
    dealTimer: null,
    revealTimer: null,
    chatHistory: [],
    statsRecorded: false,
    pendingJoins: new Map(),
  };
  for (const e of entries) {
    room.players.set(e.playerId, { name: e.name, socketId: e.socketId, connected: true, isBot: false, firebaseUid: e.firebaseUid || null });
    room.order.push(e.playerId);
    socketIndex.set(e.socketId, { roomCode: code, playerId: e.playerId });
    const s = io.sockets.sockets.get(e.socketId);
    if (s) s.join(code);
  }
  rooms.set(code, room);
  room.game = new LeastCountGame(room.order.slice(), DEFAULT_ELIMINATION_SCORE);
  room.game.startRound();
  for (const e of entries) {
    io.to(e.socketId).emit('queue_matched', { roomCode: code, playerId: e.playerId, chatHistory: room.chatHistory });
  }
  beginStartSequence(room, code);
}

// Checks whether the given queue size now has enough people waiting to fill
// a table, and if so, matches the first `playerCount` of them immediately.
// Called after every queue_join AND after queue_fill_bots removes people
// from a bucket (in case that bucket was already independently ready --
// shouldn't normally happen since this runs on every join too, but cheap
// and safe to double-check).
function tryMatchQueue(playerCount) {
  const bucket = matchQueues.get(playerCount);
  if (!bucket || bucket.length < playerCount) return;
  const entries = bucket.splice(0, playerCount);
  for (const e of entries) queueIndex.delete(e.socketId);
  startMatchedRoom(entries);
}

// ---------------------------------------------------------------------------
// Per-turn countdown. If a player doesn't act within TURN_SECONDS, a sensible
// default action is played on their behalf so the game never stalls.
// ---------------------------------------------------------------------------
function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnDeadline = null;
}

function scheduleTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.game || room.game.roundOver || room.game.gameOver) return;
  // Solo play: if it's a bot's turn, they act quickly on their own timer
  // instead of waiting out the full human turn countdown -- no deadline
  // shown to the human either, since there's nothing for them to react to.
  const currentPlayerRecord = room.players.get(room.game.currentPlayer());
  if (currentPlayerRecord && currentPlayerRecord.isBot) {
    room.turnTimer = setTimeout(() => runBotTurn(room), BOT_MOVE_MS);
    return;
  }
  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), TURN_SECONDS * 1000);
}

// A bot's turn: declare as soon as it legally can (hand value low enough,
// and no +2 challenge actively pending against it -- same rule a human has
// to follow), otherwise fall back to the exact same sensible auto-discard
// used when a human times out. Re-schedules afterward, which naturally
// chains through consecutive bot seats until it reaches a human.
function runBotTurn(room) {
  const game = room.game;
  if (!game || game.roundOver || game.gameOver) return;
  const pid = game.currentPlayer();
  const player = room.players.get(pid);
  if (!player || !player.isBot) return; // safety: turn moved on some other way already

  try {
    const myValue = handValue(game.hands[pid] || [], game.roundJokerRank);
    if (game.chainCount === 0 && myValue <= DECLARE_MAX_VALUE) {
      game.declare(pid);
      const newlyEliminated = (game.lastRoundResult && game.lastRoundResult.newlyEliminated) || [];
      for (const id of newlyEliminated) emitSeatReaction(room.code, 'eliminated', id);
    } else {
      const cardIds = game.autoPickDiscard(pid);
      game.playTurn(pid, cardIds);
      revealDrawIfAny(room);
      emitLogBasedReactions(room, room.code);
      checkLowCardReaction(room, room.code, pid);
    }
  } catch (e) {
    console.error(`Bot turn failed for room ${room.code}:`, e.message);
  }

  if (game.roundOver || game.gameOver) {
    clearTurnTimer(room);
    if (game.gameOver) { room.phase = 'game_over'; recordGameResult(room); }
  } else {
    scheduleTurnTimer(room);
  }
  broadcastRoom(room);
  broadcastGameState(room);
}

// Clears the one-shot timers that drive the countdown -> deal -> reveal
// game-start sequence (as distinct from the recurring per-turn timer above).
function clearStartSequenceTimers(room) {
  if (room.dealTimer) {
    clearTimeout(room.dealTimer);
    room.dealTimer = null;
  }
  if (room.revealTimer) {
    clearTimeout(room.revealTimer);
    room.revealTimer = null;
  }
}

// If the player who just acted drew penalty card(s), privately reveal exactly
// what they drew so they can react to it (before it just merges into their hand).
function revealDrawIfAny(room) {
  const draw = room.game && room.game.lastDraw;
  if (!draw || !draw.cards || draw.cards.length === 0) return;
  const p = room.players.get(draw.playerId);
  if (p && p.connected && p.socketId) {
    io.to(p.socketId).emit('cards_drawn', { cards: draw.cards });
  }
}

// Kicks off the countdown -> live-deal -> joker/open-card reveal sequence
// for the round that was just dealt (startRound() must already have been
// called). Shared by both start_game (first round) and next_round (every
// round after), so the same playful sequence plays every time, not just once.
function beginStartSequence(room, roomCode) {
  room.lowCardNotified = new Set(); // reset item-10 "look out" tracking for the new round
  room.phase = 'starting';
  // The dealing animation's player list must reflect who is ACTUALLY being
  // dealt into this round -- room.game.turnOrder (set by startRound(), which
  // already excludes anyone eliminated or who quit, and is in the real,
  // dealer-rotated play order) -- not room.order, which is plain join order
  // and still includes players who are out but haven't left the room. Using
  // turnOrder here fixes two things at once: eliminated players no longer
  // appear to receive cards in the dealing animation, and the seats the
  // animation deals to (and the seating the client then keeps) match actual
  // turn order instead of join order.
  const dealOrder = (room.game && room.game.turnOrder && room.game.turnOrder.length)
    ? room.game.turnOrder
    : room.order;
  const dealMs = DEAL_PASSES * dealOrder.length * DEAL_FLIGHT_MS;
  const deckCount = deckCountForPlayers(dealOrder.length);
  room.currentDealMs = dealMs; // remembered so a mid-sequence rejoin replays with the same timing
  broadcastRoom(room);
  io.to(roomCode).emit('game_starting', {
    countdownMs: COUNTDOWN_MS,
    introMs: DECK_INTRO_MS,
    deckCount,
    dealMs,
    dealPasses: DEAL_PASSES,
    revealMs: REVEAL_MS,
    players: dealOrder.map((pid) => ({ playerId: pid, name: room.players.get(pid).name })),
  });

  clearStartSequenceTimers(room);
  room.dealTimer = setTimeout(() => {
    room.dealTimer = null;
    // Guard against the room having been torn down or reset mid-sequence
    // (e.g. everyone left, or the host started a new game already).
    if (!room.game || room.phase !== 'starting') return;
    room.phase = 'playing';
    broadcastRoom(room);
    broadcastGameState(room); // hands, joker rank, open card now visible; turnDeadline still null
    room.revealTimer = setTimeout(() => {
      room.revealTimer = null;
      if (!room.game || room.game.roundOver || room.game.gameOver) return;
      scheduleTurnTimer(room); // real turn timer quietly starts here, mid-reveal
      broadcastGameState(room);
    }, REVEAL_TO_TIMER_MS);
  }, COUNTDOWN_MS + DECK_INTRO_MS + dealMs);
}

// ---------------------------------------------------------------------------
// Seat-reaction emojis (items 9 & 10) -- little playful, non-mechanical
// reactions that pop up at a player's seat on the client. The server only
// decides WHEN something reaction-worthy happened; the client decides which
// emoji(s) to show and at whose seat(s) (self, others, or both).
// ---------------------------------------------------------------------------
function emitSeatReaction(roomCode, type, affectedPlayerId) {
  io.to(roomCode).emit('seat_reaction', { type, affectedPlayerId });
}

// Inspects the log entry a playTurn() call just pushed and fires the
// matching reaction, if any. Covers normal discards, +2 chain extends, and
// +2 chain penalty draws uniformly (all three go through playTurn()).
function emitLogBasedReactions(room, roomCode) {
  if (!room.game || !room.game.log.length) return;
  const entry = room.game.log[room.game.log.length - 1];
  if (entry.type === 'discard' && entry.count >= BIG_DISCARD_THRESHOLD) {
    emitSeatReaction(roomCode, 'bigdiscard', entry.playerId);
  } else if (entry.type === '2-chain-extend') {
    emitSeatReaction(roomCode, 'chainextend', entry.playerId);
  } else if (entry.type === '2-chain-penalty' && entry.penalty > PENALTY_REACTION_THRESHOLD) {
    emitSeatReaction(roomCode, 'penalty6', entry.playerId);
  }
}

// Fires the "look out" reaction the first time (per round) a player's hand
// drops below the threshold -- tracked per-round so it doesn't re-fire on
// every subsequent turn while they stay low.
function checkLowCardReaction(room, roomCode, playerId) {
  if (!room.game || !room.game.hands || !room.game.hands[playerId]) return;
  if (!room.lowCardNotified) room.lowCardNotified = new Set();
  const len = room.game.hands[playerId].length;
  if (len > 0 && len < LOW_CARDS_THRESHOLD && !room.lowCardNotified.has(playerId)) {
    room.lowCardNotified.add(playerId);
    emitSeatReaction(roomCode, 'lowcards', playerId);
  }
}

function handleTurnTimeout(room) {
  const game = room.game;
  if (!game || game.roundOver || game.gameOver) return;

  const pid = game.currentPlayer();
  try {
    const cardIds = game.autoPickDiscard(pid);
    game.playTurn(pid, cardIds);
    revealDrawIfAny(room);
    emitLogBasedReactions(room, room.code);
    checkLowCardReaction(room, room.code, pid);
    emitSeatReaction(room.code, 'timeout', pid);
  } catch (e) {
    console.error(`Turn timeout auto-play failed for room ${room.code}:`, e.message);
  }

  if (game.roundOver || game.gameOver) {
    clearTurnTimer(room);
    if (game.gameOver) { room.phase = 'game_over'; recordGameResult(room); }
  } else {
    scheduleTurnTimer(room);
  }

  broadcastRoom(room);
  broadcastGameState(room);
}

io.on('connection', (socket) => {
  socket.on('create_room', async ({ name, firebaseIdToken }, ack) => {
    try {
      if (isRateLimited(socket, 'create_room')) throw new Error('Too many rooms created too quickly. Please wait a moment.');
      if (isIpRateLimited(socket, 'create_room')) throw new Error('Too many rooms created from this network too quickly. Please wait a moment.');
      const cleanName = (name || '').trim().slice(0, 20) || 'Player';
      const verifiedUid = await verifyFirebaseToken(firebaseIdToken);
      const code = makeRoomCode();
      const playerId = makePlayerId();
      const room = {
        code,
        hostPlayerId: playerId,
        players: new Map(),
        order: [],
        phase: 'lobby', // lobby | starting | playing | game_over
        game: null,
        turnTimer: null,
        turnDeadline: null,
        dealTimer: null,
        revealTimer: null,
        chatHistory: [],
        statsRecorded: false,
        pendingJoins: new Map(), // mid-game join requests awaiting host approval -- see join_room below
        allHumansDisconnectedAt: null, // set once every human is gone -- see the cleanup sweep below
      };
      room.players.set(playerId, { name: cleanName, socketId: socket.id, connected: true, isBot: false, firebaseUid: verifiedUid });
      room.order.push(playerId);
      rooms.set(code, room);
      socketIndex.set(socket.id, { roomCode: code, playerId });
      socket.join(code);
      ack && ack({ ok: true, roomCode: code, playerId, chatHistory: room.chatHistory });
      broadcastRoom(room);
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  // Solo play: one human + a chosen number of bots, in a fresh room that
  // skips the lobby entirely and jumps straight into the normal
  // countdown -> deal -> reveal sequence, exactly like a real multiplayer
  // game starting -- bots are just regular players to the game engine, the
  // only special handling is how quickly they act (see scheduleTurnTimer).
  socket.on('create_solo_room', async ({ name, botCount, firebaseIdToken }, ack) => {
    try {
      if (isRateLimited(socket, 'create_solo_room')) throw new Error('Too many rooms created too quickly. Please wait a moment.');
      if (isIpRateLimited(socket, 'create_solo_room')) throw new Error('Too many rooms created from this network too quickly. Please wait a moment.');
      const cleanName = (name || '').trim().slice(0, 20) || 'Player';
      const verifiedUid = await verifyFirebaseToken(firebaseIdToken);
      const n = Math.max(1, Math.min(MAX_BOTS, Math.round(Number(botCount)) || 3));
      const code = makeRoomCode();
      const playerId = makePlayerId();
      const room = {
        code,
        hostPlayerId: playerId,
        players: new Map(),
        order: [],
        phase: 'lobby',
        game: null,
        turnTimer: null,
        turnDeadline: null,
        dealTimer: null,
        revealTimer: null,
        chatHistory: [],
        statsRecorded: false,
        allHumansDisconnectedAt: null,
      };
      room.players.set(playerId, { name: cleanName, socketId: socket.id, connected: true, isBot: false, firebaseUid: verifiedUid });
      room.order.push(playerId);
      for (let i = 1; i <= n; i++) {
        const botId = makePlayerId();
        room.players.set(botId, { name: `🤖 Bot ${i}`, socketId: null, connected: true, isBot: true });
        room.order.push(botId);
      }
      rooms.set(code, room);
      socketIndex.set(socket.id, { roomCode: code, playerId });
      socket.join(code);

      room.game = new LeastCountGame(room.order.slice(), DEFAULT_ELIMINATION_SCORE);
      room.game.startRound();
      beginStartSequence(room, code);

      ack && ack({ ok: true, roomCode: code, playerId, chatHistory: room.chatHistory });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  // ---------------- "Play Online" matchmaking ----------------
  // Joins the waiting queue for a specific table size. Matches immediately
  // if enough strangers are already waiting for that same size; otherwise
  // just confirms they're queued -- the client shows its own waiting screen
  // and, after a while with no match, offers wait/fill-with-bots/cancel.
  // Actual matching happens via queue_matched (pushed, not an ack reply),
  // since a match can land seconds or minutes after this call returns.
  socket.on('queue_join', async ({ playerCount, name, firebaseIdToken }, ack) => {
    try {
      if (isRateLimited(socket, 'join_room')) throw new Error('Too many attempts too quickly. Please wait a moment.');
      const n = Math.round(Number(playerCount));
      if (!QUEUE_SIZES.includes(n)) throw new Error('Invalid player count for online matchmaking.');
      if (queueIndex.has(socket.id)) throw new Error('Already in a matchmaking queue.');
      const cleanName = (name || '').trim().slice(0, 20) || 'Player';
      const verifiedUid = await verifyFirebaseToken(firebaseIdToken);
      const playerId = makePlayerId();
      matchQueues.get(n).push({ playerId, socketId: socket.id, name: cleanName, firebaseUid: verifiedUid });
      queueIndex.set(socket.id, n);
      ack && ack({ ok: true, queued: true, playerId });
      tryMatchQueue(n);
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('queue_cancel', (_data, ack) => {
    const n = queueIndex.get(socket.id);
    if (n !== undefined) {
      const bucket = matchQueues.get(n);
      const idx = bucket.findIndex((e) => e.socketId === socket.id);
      if (idx !== -1) bucket.splice(idx, 1);
      queueIndex.delete(socket.id);
    }
    ack && ack({ ok: true });
  });

  // Host's choice after the client-side "still waiting" prompt times out:
  // take everyone currently queued for this exact size (usually just this
  // one player, occasionally a couple of others who were also waiting) and
  // start right away, padding whatever's left up to the ORIGINAL target size
  // with bots -- rather than leaving them stuck waiting indefinitely for
  // strangers who may never come.
  socket.on('queue_fill_bots', (_data, ack) => {
    try {
      const n = queueIndex.get(socket.id);
      if (n === undefined) throw new Error('Not currently in a queue.');
      const bucket = matchQueues.get(n);
      const idx = bucket.findIndex((e) => e.socketId === socket.id);
      if (idx === -1) throw new Error('Not currently in a queue.');
      const entries = bucket.splice(0); // take EVERYONE currently waiting for this size, not just self
      for (const e of entries) queueIndex.delete(e.socketId);

      const code = makeRoomCode();
      const hostPlayerId = entries[0].playerId;
      const room = {
        code, hostPlayerId, players: new Map(), order: [], phase: 'lobby', game: null,
        turnTimer: null, turnDeadline: null, dealTimer: null, revealTimer: null,
        chatHistory: [], statsRecorded: false, pendingJoins: new Map(),
        allHumansDisconnectedAt: null,
      };
      for (const e of entries) {
        room.players.set(e.playerId, { name: e.name, socketId: e.socketId, connected: true, isBot: false, firebaseUid: e.firebaseUid || null });
        room.order.push(e.playerId);
        socketIndex.set(e.socketId, { roomCode: code, playerId: e.playerId });
        const s = io.sockets.sockets.get(e.socketId);
        if (s) s.join(code);
      }
      let botNum = 1;
      while (room.order.length < n) {
        const botId = makePlayerId();
        room.players.set(botId, { name: `🤖 Bot ${botNum}`, socketId: null, connected: true, isBot: true });
        room.order.push(botId);
        botNum += 1;
      }
      rooms.set(code, room);
      room.game = new LeastCountGame(room.order.slice(), DEFAULT_ELIMINATION_SCORE);
      room.game.startRound();
      for (const e of entries) {
        io.to(e.socketId).emit('queue_matched', { roomCode: code, playerId: e.playerId, chatHistory: room.chatHistory });
      }
      beginStartSequence(room, code);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('join_room', async ({ roomCode, name, firebaseIdToken }, ack) => {
    try {
      if (isRateLimited(socket, 'join_room')) throw new Error('Too many attempts too quickly. Please wait a moment.');
      const code = (roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new Error('Room not found. Check the code.');
      if (room.order.length >= 10) throw new Error('Room is full (max 10 players).');
      const cleanName = (name || '').trim().slice(0, 20) || 'Player';
      const verifiedUid = await verifyFirebaseToken(firebaseIdToken);

      // Room hasn't started yet -- exactly the original behavior, join
      // straight into the lobby, no approval needed.
      if (room.phase === 'lobby') {
        const playerId = makePlayerId();
        room.players.set(playerId, { name: cleanName, socketId: socket.id, connected: true, isBot: false, firebaseUid: verifiedUid });
        room.order.push(playerId);
        socketIndex.set(socket.id, { roomCode: code, playerId });
        socket.join(code);
        ack && ack({ ok: true, roomCode: code, playerId, chatHistory: room.chatHistory });
        broadcastRoom(room);
        return;
      }

      if (room.phase === 'starting') throw new Error('Game is starting -- try again in a few seconds.');
      if (room.phase === 'game_over') throw new Error('This game has already ended.');

      // Mid-game join request: the room is actively 'playing'. Rather than
      // dropping straight in, this holds as a pending request the host has
      // to explicitly approve (see admit_join_request/ignore_join_request
      // below) -- privacy/consent for whoever's already at the table, same
      // idea as a meeting "waiting room". Not added to room.players/order
      // yet at all, so they don't show up anywhere in the UI until admitted.
      if (!room.pendingJoins) room.pendingJoins = new Map();
      if (room.pendingJoins.size + room.order.length >= 10) throw new Error('Room is full (max 10 players).');
      const playerId = makePlayerId();
      const JOIN_REQUEST_TIMEOUT_MS = 120000; // 2 minutes -- see the "Waiting for host" screen client-side
      const timer = setTimeout(() => denyJoinRequest(room, playerId, 'timeout'), JOIN_REQUEST_TIMEOUT_MS);
      room.pendingJoins.set(playerId, {
        name: cleanName, firebaseUid: verifiedUid, socketId: socket.id, requestedAt: Date.now(), timer,
      });
      socketIndex.set(socket.id, { roomCode: code, playerId, pending: true });
      socket.join(code);
      ack && ack({ ok: true, pending: true, roomCode: code, playerId });
      notifyHostOfJoinRequest(room);
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('admit_join_request', ({ roomCode, playerId }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const hostEntry = socketIndex.get(socket.id);
      if (!hostEntry || hostEntry.playerId !== room.hostPlayerId) throw new Error('Only the host can admit players.');
      if (!room.pendingJoins || !room.pendingJoins.has(playerId)) throw new Error('That request is no longer waiting.');
      const req = room.pendingJoins.get(playerId);
      clearTimeout(req.timer);
      room.pendingJoins.delete(playerId);

      room.players.set(playerId, { name: req.name, socketId: req.socketId, connected: true, isBot: false, firebaseUid: req.firebaseUid });
      room.order.push(playerId);
      const sockEntry = socketIndex.get(req.socketId);
      if (sockEntry) sockEntry.pending = false;
      // Actual game-engine entry (addPlayer) happens in next_round, right
      // before startRound() -- never here. addPlayer() requires roundOver,
      // and admitting can happen at any point in a round (or between
      // rounds); deferring it to a single place keeps "joins next round, at
      // the current max score" true no matter when the host actually taps
      // Admit.
      // Include chatHistory here too -- every other join path (create_room,
      // join_room, queue_matched) sends it so the client can render existing
      // messages and show the chat FAB; this path was missing it, which is
      // why someone admitted mid-game never got a chat option at all.
      io.to(req.socketId).emit('join_admitted', { roomCode, playerId, chatHistory: room.chatHistory });
      broadcastRoom(room);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  // The requester backing out of their own still-pending request (tapping
  // Cancel on the "Waiting for host" screen) -- distinct from the host's
  // ignore_join_request below, but shares the same cleanup path.
  socket.on('cancel_join_request', ({ roomCode, playerId }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry || entry.playerId !== playerId) throw new Error('Not your request.');
      denyJoinRequest(room, playerId, 'cancelled');
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('ignore_join_request', ({ roomCode, playerId }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const hostEntry = socketIndex.get(socket.id);
      if (!hostEntry || hostEntry.playerId !== room.hostPlayerId) throw new Error('Only the host can respond to join requests.');
      denyJoinRequest(room, playerId, 'declined');
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('rejoin', ({ roomCode, playerId }, ack) => {
    try {
      const code = (roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room || !room.players.has(playerId)) throw new Error('Session expired, please join again.');
      const p = room.players.get(playerId);
      // The mobile watchdog on the client calls 'rejoin' every few seconds
      // as a routine "are we still connected" ping, even while the socket
      // never actually dropped. If we replayed the game_starting sequence
      // on every one of those pings, a deal animation running longer than
      // the ping interval would get interrupted and restarted mid-flight --
      // exactly the "distributes 6-7 cards, then restarts and does 13"
      // symptom. Only replay the sequence (or resend state) when this is a
      // genuinely NEW connection for this player, not a same-socket ping.
      const isFreshReconnect = p.socketId !== socket.id || !p.connected;
      p.socketId = socket.id;
      // If this reconnecting player is the host and someone's currently
      // waiting to be let in, re-send the banner -- otherwise a host who
      // refreshes mid-request would lose it until the next unrelated change.
      if (playerId === room.hostPlayerId && room.pendingJoins && room.pendingJoins.size) {
        notifyHostOfJoinRequest(room);
      }
      p.connected = true;
      room.allHumansDisconnectedAt = null; // a human is back -- cancel any pending abandoned-room cleanup
      socketIndex.set(socket.id, { roomCode: code, playerId });
      socket.join(code);
      ack && ack({ ok: true, roomCode: code, playerId, chatHistory: room.chatHistory });
      broadcastRoom(room);
      if (!isFreshReconnect) return; // just a keepalive ping -- client already has everything
      // Don't leak hands/joker/open-card to a reconnecting client while the
      // countdown/deal/reveal sequence is still in progress for everyone
      // else -- re-play the sequence for them instead so they don't skip it.
      if (room.game && room.phase === 'starting') {
        const dealOrder = (room.game.turnOrder && room.game.turnOrder.length) ? room.game.turnOrder : room.order;
        io.to(socket.id).emit('game_starting', {
          countdownMs: COUNTDOWN_MS,
          introMs: DECK_INTRO_MS,
          deckCount: deckCountForPlayers(dealOrder.length),
          dealMs: room.currentDealMs || DEAL_PASSES * dealOrder.length * DEAL_FLIGHT_MS,
          dealPasses: DEAL_PASSES,
          revealMs: REVEAL_MS,
          players: dealOrder.map((pid) => ({ playerId: pid, name: room.players.get(pid).name })),
        });
      } else if (room.game) {
        const state = room.game.getPublicState(playerId);
        state.turnDeadline = room.turnDeadline || null;
        io.to(socket.id).emit('game_state', state);
      }
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('start_game', ({ roomCode, eliminationScore }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry || entry.playerId !== room.hostPlayerId) throw new Error('Only the host can start the game.');
      if (room.order.length < 2) throw new Error('Need at least 2 players.');
      if (room.order.length > 10) throw new Error('Maximum 10 players.');

      let maxScore = DEFAULT_ELIMINATION_SCORE;
      if (eliminationScore !== undefined && eliminationScore !== null) {
        if (!MAX_SCORE_OPTIONS.includes(Number(eliminationScore))) throw new Error('Invalid max score option.');
        maxScore = Number(eliminationScore);
      }

      // Cards are dealt on the server right away (the engine has no notion of
      // "not yet dealt"), but we deliberately withhold the full game_state
      // broadcast -- which is what actually reveals hands/joker/open card to
      // clients -- until the countdown + live-deal animation has played out.
      room.game = new LeastCountGame(room.order.slice(), maxScore);
      room.statsRecorded = false;
      room.game.startRound();
      beginStartSequence(room, roomCode);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('play_turn', ({ roomCode, cardIds }, ack) => {
    try {
      if (isRateLimited(socket, 'play_turn')) throw new Error('Too many actions too quickly. Please slow down.');
      const room = rooms.get(roomCode);
      if (!room || !room.game) throw new Error('Game not active.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');
      room.game.playTurn(entry.playerId, cardIds || []);
      revealDrawIfAny(room);
      emitLogBasedReactions(room, roomCode);
      checkLowCardReaction(room, roomCode, entry.playerId);
      if (room.game.roundOver || room.game.gameOver) clearTurnTimer(room);
      else scheduleTurnTimer(room);
      broadcastGameState(room);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  // "Help me play" -- bots-mode-only assist. Reuses the exact same decision
  // logic the bots themselves act on (autoPickDiscard/declare threshold), but
  // returns it as a suggestion for the requesting human instead of playing it
  // automatically. Gated to solo-vs-bots rooms only (no other real player at
  // the table) so it can never give one human an edge over another in a real
  // match, and to the requester's own turn only.
  socket.on('request_hint', ({ roomCode }, ack) => {
    try {
      if (isRateLimited(socket, 'request_hint')) throw new Error('Too many actions too quickly. Please slow down.');
      const room = rooms.get(roomCode);
      if (!room || !room.game) throw new Error('Game not active.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');
      const pid = entry.playerId;
      const game = room.game;
      if (game.currentPlayer() !== pid) throw new Error('Hints are only available on your own turn.');

      const realPlayers = room.order.filter((id) => !room.players.get(id).isBot);
      if (realPlayers.length !== 1 || realPlayers[0] !== pid) {
        throw new Error('Hints are only available in a solo game against bots.');
      }

      const hand = game.hands[pid] || [];
      let hint;
      if (game.chainCount > 0) {
        const two = hand.find((c) => c.rank === '2');
        hint = two
          ? { type: 'discard', cardIds: [two.id], reason: 'Play your 2 to pass the +2 penalty on instead of taking it.' }
          : { type: 'take_penalty', cardIds: [], reason: `You don't have a 2 -- take the ${game.chainCount * 2}-card penalty now.` };
      } else {
        const myValue = handValue(hand, game.roundJokerRank);
        if (myValue <= DECLARE_MAX_VALUE) {
          hint = { type: 'declare', cardIds: [], reason: `Your hand is worth ${myValue} -- low enough to declare "Least Count!" now.` };
        } else {
          const cardIds = game.autoPickDiscard(pid);
          const chosen = hand.filter((c) => cardIds.includes(c.id));
          const rank = chosen[0] && chosen[0].rank;
          const plural = chosen.length > 1 ? 's' : '';
          const openCard = game.discardPile[game.discardPile.length - 1];
          const matchesOpen = openCard && rank === openCard.rank;
          const groupValue = chosen.reduce((sum, c) => sum + cardValue(c, game.roundJokerRank), 0);
          hint = matchesOpen
            ? { type: 'discard', cardIds, reason: `Discard your ${rank}${plural} -- it matches the open card, so no penalty card.` }
            : { type: 'discard', cardIds, reason: `No match for the open card. Release your ${rank}${plural} (worth ${groupValue} pts) -- your highest-value group, so it costs you the least.` };
        }
      }
      ack && ack({ ok: true, hint });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('declare', ({ roomCode }, ack) => {
    try {
      if (isRateLimited(socket, 'declare')) throw new Error('Too many actions too quickly. Please slow down.');
      const room = rooms.get(roomCode);
      if (!room || !room.game) throw new Error('Game not active.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');
      room.game.declare(entry.playerId);
      clearTurnTimer(room);
      if (room.game.gameOver) { room.phase = 'game_over'; recordGameResult(room); }
      const newlyEliminated = (room.game.lastRoundResult && room.game.lastRoundResult.newlyEliminated) || [];
      for (const id of newlyEliminated) emitSeatReaction(roomCode, 'eliminated', id);
      broadcastRoom(room);
      broadcastGameState(room);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('next_round', ({ roomCode, eliminationScore }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room || !room.game) throw new Error('Game not active.');
      const entry = socketIndex.get(socket.id);
      if (!entry || entry.playerId !== room.hostPlayerId) throw new Error('Only the host can start the next round.');
      if (!room.game.roundOver) throw new Error('Round is still in progress.');
      if (room.game.gameOver) throw new Error('Game is already over.');

      // The host may optionally change the max score before starting the
      // next round (to extend or shorten the game). Only touch it if a
      // different value was actually picked -- setEliminationScore() itself
      // enforces that it's still above the current highest score on the board.
      if (eliminationScore !== undefined && eliminationScore !== null) {
        const n = Number(eliminationScore);
        if (n !== room.game.eliminationScore) {
          if (!MAX_SCORE_OPTIONS.includes(n)) throw new Error('Invalid max score option.');
          room.game.setEliminationScore(n);
        }
      }

      // Anyone admitted mid-game (see admit_join_request above) sits in
      // room.order/room.players already, but was deliberately never added to
      // the GAME itself until now -- this is the one moment "joins starting
      // next round" actually happens, right before the deal, at whatever the
      // current max score is (addPlayer() sets their starting score to the
      // current highest on the board).
      for (const pid of room.order) {
        if (!room.game.playerIds.includes(pid)) room.game.addPlayer(pid);
      }

      room.game.startRound();
      beginStartSequence(room, roomCode);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('new_game', ({ roomCode }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry || entry.playerId !== room.hostPlayerId) throw new Error('Only the host can start a new game.');
      clearTurnTimer(room);
      clearStartSequenceTimers(room);
      room.game = null;
      room.phase = 'lobby';
      broadcastRoom(room);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('leave_room', ({ roomCode }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');
      const playerId = entry.playerId;

      if (room.phase === 'starting') {
        throw new Error('Cannot leave while the game is starting. Wait for it to finish.');
      }
      if (room.phase === 'playing' && room.game && !room.game.roundOver) {
        throw new Error('Cannot leave in the middle of a round. Wait for it to finish.');
      }

      // Only ask the game engine to remove the player if the game is still
      // going - if it already ended (e.g. because the last leave dropped the
      // active count to 1), removePlayer() would throw and wrongly block
      // this person from leaving a finished game.
      if (room.game && !room.game.gameOver) {
        room.game.removePlayer(playerId);
        if (room.game.gameOver) { room.phase = 'game_over'; recordGameResult(room); }
      }

      room.players.delete(playerId);
      room.order = room.order.filter((id) => id !== playerId);
      socketIndex.delete(socket.id);
      socket.leave(roomCode);

      // Also clean up a solo room once no human is left in it -- bots never
      // leave on their own, so without this a solo player leaving would
      // otherwise leak a room that lingers forever with only bots in it.
      const noHumansLeft = room.order.every((id) => room.players.get(id).isBot);
      if (room.order.length === 0 || noHumansLeft) {
        clearTurnTimer(room);
        clearStartSequenceTimers(room);
        rooms.delete(roomCode);
        ack && ack({ ok: true });
        return;
      }

      if (room.hostPlayerId === playerId) {
        const nextHost = pickNextHost(room, playerId);
        if (nextHost) room.hostPlayerId = nextHost;
      }

      broadcastRoom(room);
      if (room.game) broadcastGameState(room);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('chat_message', ({ roomCode, type, text, gifUrl }, ack) => {
    try {
      if (isRateLimited(socket, 'chat_message')) throw new Error('You are sending messages too quickly. Please slow down.');
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');

      const player = room.players.get(entry.playerId);
      const msg = {
        id: crypto.randomUUID(),
        playerId: entry.playerId,
        name: player ? player.name : '?',
        ts: Date.now(),
      };

      if (type === 'gif') {
        const cleanUrl = (gifUrl || '').toString().trim().slice(0, 500);
        if (!cleanUrl) throw new Error('No GIF selected.');
        // Only allow actual Giphy media links through, not arbitrary URLs.
        if (!/^https:\/\/media\d*\.giphy\.com\//.test(cleanUrl)) throw new Error('Invalid GIF link.');
        msg.type = 'gif';
        msg.gifUrl = cleanUrl;
      } else {
        const cleanText = censorText((text || '').toString().trim().slice(0, 300));
        if (!cleanText) throw new Error('Empty message.');
        msg.type = 'text';
        msg.text = cleanText;
      }

      room.chatHistory.push(msg);
      if (room.chatHistory.length > CHAT_HISTORY_LIMIT) room.chatHistory.shift();
      io.to(roomCode).emit('chat_message', msg);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  // A player flagging another player's message. Deliberately not something
  // that takes automatic action (no auto-mute/auto-kick) -- it just records
  // the report to Firestore's "reports" collection so it can be reviewed by
  // hand, since there's no live moderator watching every room. Falls back to
  // a server log line if Firestore isn't connected, so nothing is silently
  // lost either way.
  socket.on('report_player', ({ roomCode, reportedPlayerId, reportedName, messageType, messageText }, ack) => {
    try {
      if (isRateLimited(socket, 'report_player')) throw new Error('Too many reports too quickly. Please wait a moment.');
      if (isIpRateLimited(socket, 'report_player')) throw new Error('Too many reports from this network too quickly. Please wait a moment.');
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');
      const reporter = room.players.get(entry.playerId);
      const reportDoc = {
        roomCode: (roomCode || '').toString().slice(0, 10),
        reportedPlayerId: (reportedPlayerId || '').toString().slice(0, 100),
        reportedName: (reportedName || '').toString().slice(0, 40),
        reporterPlayerId: entry.playerId,
        reporterName: reporter ? reporter.name : '?',
        messageType: (messageType || 'text').toString().slice(0, 10),
        messageText: (messageText || '').toString().slice(0, 300),
        createdAt: new Date().toISOString(),
      };
      if (db) {
        db.collection('reports').add(reportDoc).catch((e) => {
          console.error('[Firebase] Failed to save report:', e.message);
        });
      } else {
        console.warn('[Report] (Firestore not connected, logged here instead):', reportDoc);
      }
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  // ---------------- player-facing stats (own + opponents') ----------------
  // Both read the same `users` collection that recordGameResult() already
  // writes to after every finished game -- no new data collection, just a
  // read-only view onto stats that already exist. Neither handler ever sends
  // a firebaseUid back to the browser, including the requester's own -- only
  // the two numbers (gamesPlayed, wins), so tapping an opponent's seat can
  // never hand you a stable account identifier for them, just their record.
  socket.on('get_my_stats', async ({ firebaseIdToken }, ack) => {
    try {
      if (isRateLimited(socket, 'get_my_stats')) throw new Error('Too many requests. Please wait a moment.');
      if (!db) throw new Error('Stats are not available right now.');
      const verifiedUid = await verifyFirebaseToken(firebaseIdToken);
      if (!verifiedUid) throw new Error('Not signed in yet.');
      const doc = await db.collection('users').doc(verifiedUid).get();
      const data = doc.exists ? doc.data() : {};
      ack && ack({ ok: true, stats: { gamesPlayed: data.gamesPlayed || 0, wins: data.wins || 0 } });
    } catch (e) {
      console.error('[Firebase] Failed to read own stats:', e.message);
      ack && ack({ ok: false, error: e.message || 'Could not load stats right now.' });
    }
  });

  socket.on('get_player_stats', ({ roomCode, playerId }, ack) => {
    try {
      if (isRateLimited(socket, 'get_player_stats')) throw new Error('Too many requests. Please wait a moment.');
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const player = room.players.get(playerId);
      if (!player) throw new Error('Player not found.');
      // Bots and anyone who never got linked to a Firebase account (guest
      // whose sign-in hadn't finished yet when they joined) simply have no
      // record to show -- not an error, just null stats.
      if (player.isBot || !player.firebaseUid || !db) {
        ack && ack({ ok: true, stats: null });
        return;
      }
      db.collection('users').doc(player.firebaseUid).get()
        .then((doc) => {
          const data = doc.exists ? doc.data() : {};
          ack && ack({ ok: true, stats: { gamesPlayed: data.gamesPlayed || 0, wins: data.wins || 0 } });
        })
        .catch((e) => {
          console.error('[Firebase] Failed to read player stats:', e.message);
          ack && ack({ ok: false, error: 'Could not load stats right now.' });
        });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('disconnect', () => {
    rateBuckets.delete(socket.id); // this socket is gone -- no point keeping its rate-limit history around
    // Clean up matchmaking queue membership too -- someone who closes the
    // app while waiting for a match shouldn't count toward filling a table.
    const queuedSize = queueIndex.get(socket.id);
    if (queuedSize !== undefined) {
      const bucket = matchQueues.get(queuedSize);
      const idx = bucket.findIndex((e) => e.socketId === socket.id);
      if (idx !== -1) bucket.splice(idx, 1);
      queueIndex.delete(socket.id);
    }
    const entry = socketIndex.get(socket.id);
    if (!entry) return;
    socketIndex.delete(socket.id);
    const room = rooms.get(entry.roomCode);
    if (!room) return;
    // A still-pending mid-game join requester who closes the app/loses
    // connection isn't in room.players at all -- clean up their waiting
    // request (and its timer) immediately instead of leaving it sitting in
    // the host's banner for up to 2 minutes for someone who's already gone.
    if (entry.pending) {
      denyJoinRequest(room, entry.playerId, 'disconnected');
      return;
    }
    const p = room.players.get(entry.playerId);
    if (p) {
      p.connected = false;
      p.socketId = null;
      // If the disconnected player was the host, hand hosting off to an
      // actually-active player (see pickNextHost) -- otherwise a host who
      // closes the app/tab (rather than tapping Leave Room, e.g. right after
      // being eliminated) permanently strands the room. Every host-only
      // action (Next Round, changing max score, kicking) checks
      // hostPlayerId, and that id could otherwise never match a real
      // connected player again.
      if (room.hostPlayerId === entry.playerId) {
        const nextHost = pickNextHost(room, entry.playerId);
        if (nextHost) room.hostPlayerId = nextHost;
      }
      // If that was the last connected human in the room (bots don't count),
      // start the clock on the abandoned-room cleanup sweep below -- unlike
      // leave_room, closing the tab/losing connection was never actually
      // deleting the room, so without this a "Play with Bots" session (or a
      // friends room everyone just closes) sat in memory forever.
      const anyHumanConnected = room.order.some((id) => {
        const pl = room.players.get(id);
        return pl && !pl.isBot && pl.connected;
      });
      if (!anyHumanConnected && room.allHumansDisconnectedAt == null) {
        room.allHumansDisconnectedAt = Date.now();
      }
      broadcastRoom(room);
    }
  });
});

// --------------------------------------------------------------------------
// Abandoned-room cleanup sweep. A room only gets its allHumansDisconnectedAt
// timestamp set above once every human in it has disconnected (a bot-only
// room, or a friends room everyone closed the tab on); it's cleared the
// moment any human reconnects (see the 'rejoin' handler). This runs every
// minute and deletes any room that's been fully human-abandoned for 10+
// minutes -- long enough that a real reconnect (page refresh, brief network
// drop) never gets caught by it, short enough that a script looping
// "create solo room -> disconnect" can't grow server memory indefinitely.
// --------------------------------------------------------------------------
const ROOM_CLEANUP_SWEEP_MS = 60 * 1000;
const ROOM_ABANDONED_GRACE_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.allHumansDisconnectedAt != null && now - room.allHumansDisconnectedAt > ROOM_ABANDONED_GRACE_MS) {
      clearTurnTimer(room);
      clearStartSequenceTimers(room);
      rooms.delete(code);
      console.log(`[Cleanup] Deleted abandoned room ${code} (no human connected for 10+ minutes).`);
    }
  }
  // Same sweep also prunes expired IP rate-limit buckets -- otherwise every
  // distinct visitor IP the server has ever seen stays in memory forever.
  for (const [ip, bucket] of ipRateBuckets) {
    let anyHitsLeft = false;
    for (const eventName of Object.keys(bucket)) {
      const limit = IP_RATE_LIMITS[eventName];
      const hits = bucket[eventName];
      while (hits.length && now - hits[0] > limit.windowMs) hits.shift();
      if (hits.length) anyHitsLeft = true;
    }
    if (!anyHitsLeft) ipRateBuckets.delete(ip);
  }
}, ROOM_CLEANUP_SWEEP_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Least Count server listening on port ${PORT}`);
});
