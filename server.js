const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { LeastCountGame } = require('./game/gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// In-memory room store. Fine for a small private game among family/friends;
// state simply resets if the server restarts.
// --------------------------------------------------------------------------
const rooms = new Map(); // roomCode -> Room
const socketIndex = new Map(); // socket.id -> { roomCode, playerId }

const TURN_SECONDS = 30;
const CHAT_HISTORY_LIMIT = 100;

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
const REVEAL_MS = 5000; // joker/open-card reveal, held on screen
const REVEAL_TO_TIMER_MS = 2000; // turn timer quietly starts this far into the reveal
// Minimum penalty-cards-in-one-go and discard-group-size that count as
// "big" enough to trigger a seat reaction (items 9/10). The client decides
// which emoji(s) each reaction type maps to and whether it's shown at the
// affected player's own seat, everyone else's seats, or both.
const PENALTY_REACTION_THRESHOLD = 6;
const BIG_DISCARD_THRESHOLD = 4;
const LOW_CARDS_THRESHOLD = 4;

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
    })),
  };
}

function broadcastRoom(room) {
  for (const pid of room.order) {
    const p = room.players.get(pid);
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('room_update', publicRoomInfo(room));
    }
  }
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
  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  room.turnTimer = setTimeout(() => handleTurnTimeout(room), TURN_SECONDS * 1000);
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
  const dealMs = DEAL_PASSES * room.order.length * DEAL_FLIGHT_MS;
  room.currentDealMs = dealMs; // remembered so a mid-sequence rejoin replays with the same timing
  broadcastRoom(room);
  io.to(roomCode).emit('game_starting', {
    countdownMs: COUNTDOWN_MS,
    dealMs,
    dealPasses: DEAL_PASSES,
    revealMs: REVEAL_MS,
    players: room.order.map((pid) => ({ playerId: pid, name: room.players.get(pid).name })),
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
  }, COUNTDOWN_MS + dealMs);
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
    if (game.gameOver) room.phase = 'game_over';
  } else {
    scheduleTurnTimer(room);
  }

  broadcastRoom(room);
  broadcastGameState(room);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }, ack) => {
    try {
      const cleanName = (name || '').trim().slice(0, 20) || 'Player';
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
      };
      room.players.set(playerId, { name: cleanName, socketId: socket.id, connected: true });
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

  socket.on('join_room', ({ roomCode, name }, ack) => {
    try {
      const code = (roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new Error('Room not found. Check the code.');
      if (room.phase !== 'lobby') throw new Error('Game already started in this room.');
      if (room.order.length >= 10) throw new Error('Room is full (max 10 players).');

      const cleanName = (name || '').trim().slice(0, 20) || 'Player';
      const playerId = makePlayerId();
      room.players.set(playerId, { name: cleanName, socketId: socket.id, connected: true });
      room.order.push(playerId);
      socketIndex.set(socket.id, { roomCode: code, playerId });
      socket.join(code);
      ack && ack({ ok: true, roomCode: code, playerId, chatHistory: room.chatHistory });
      broadcastRoom(room);
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
      p.socketId = socket.id;
      p.connected = true;
      socketIndex.set(socket.id, { roomCode: code, playerId });
      socket.join(code);
      ack && ack({ ok: true, roomCode: code, playerId, chatHistory: room.chatHistory });
      broadcastRoom(room);
      // Don't leak hands/joker/open-card to a reconnecting client while the
      // countdown/deal/reveal sequence is still in progress for everyone
      // else -- re-play the sequence for them instead so they don't skip it.
      if (room.game && room.phase === 'starting') {
        io.to(socket.id).emit('game_starting', {
          countdownMs: COUNTDOWN_MS,
          dealMs: room.currentDealMs || DEAL_PASSES * room.order.length * DEAL_FLIGHT_MS,
          dealPasses: DEAL_PASSES,
          revealMs: REVEAL_MS,
          players: room.order.map((pid) => ({ playerId: pid, name: room.players.get(pid).name })),
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

  socket.on('start_game', ({ roomCode }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry || entry.playerId !== room.hostPlayerId) throw new Error('Only the host can start the game.');
      if (room.order.length < 2) throw new Error('Need at least 2 players.');
      if (room.order.length > 10) throw new Error('Maximum 10 players.');

      // Cards are dealt on the server right away (the engine has no notion of
      // "not yet dealt"), but we deliberately withhold the full game_state
      // broadcast -- which is what actually reveals hands/joker/open card to
      // clients -- until the countdown + live-deal animation has played out.
      room.game = new LeastCountGame(room.order.slice());
      room.game.startRound();
      beginStartSequence(room, roomCode);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('play_turn', ({ roomCode, cardIds }, ack) => {
    try {
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

  socket.on('declare', ({ roomCode }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room || !room.game) throw new Error('Game not active.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');
      room.game.declare(entry.playerId);
      clearTurnTimer(room);
      if (room.game.gameOver) room.phase = 'game_over';
      const newlyEliminated = (room.game.lastRoundResult && room.game.lastRoundResult.newlyEliminated) || [];
      for (const id of newlyEliminated) emitSeatReaction(roomCode, 'eliminated', id);
      broadcastRoom(room);
      broadcastGameState(room);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('next_round', ({ roomCode }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room || !room.game) throw new Error('Game not active.');
      const entry = socketIndex.get(socket.id);
      if (!entry || entry.playerId !== room.hostPlayerId) throw new Error('Only the host can start the next round.');
      if (!room.game.roundOver) throw new Error('Round is still in progress.');
      if (room.game.gameOver) throw new Error('Game is already over.');
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
        if (room.game.gameOver) room.phase = 'game_over';
      }

      room.players.delete(playerId);
      room.order = room.order.filter((id) => id !== playerId);
      socketIndex.delete(socket.id);
      socket.leave(roomCode);

      if (room.order.length === 0) {
        clearTurnTimer(room);
        clearStartSequenceTimers(room);
        rooms.delete(roomCode);
        ack && ack({ ok: true });
        return;
      }

      if (room.hostPlayerId === playerId) room.hostPlayerId = room.order[0];

      broadcastRoom(room);
      if (room.game) broadcastGameState(room);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('chat_message', ({ roomCode, text }, ack) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found.');
      const entry = socketIndex.get(socket.id);
      if (!entry) throw new Error('Not in a room.');
      const cleanText = (text || '').toString().trim().slice(0, 300);
      if (!cleanText) throw new Error('Empty message.');

      const player = room.players.get(entry.playerId);
      const msg = {
        id: crypto.randomUUID(),
        playerId: entry.playerId,
        name: player ? player.name : '?',
        text: cleanText,
        ts: Date.now(),
      };
      room.chatHistory.push(msg);
      if (room.chatHistory.length > CHAT_HISTORY_LIMIT) room.chatHistory.shift();
      io.to(roomCode).emit('chat_message', msg);
      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('disconnect', () => {
    const entry = socketIndex.get(socket.id);
    if (!entry) return;
    socketIndex.delete(socket.id);
    const room = rooms.get(entry.roomCode);
    if (!room) return;
    const p = room.players.get(entry.playerId);
    if (p) {
      p.connected = false;
      p.socketId = null;
      broadcastRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Least Count server listening on port ${PORT}`);
});
