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
      io.to(p.socketId).emit('game_state', room.game.getPublicState(pid));
    }
  }
}

function sendError(socket, message) {
  socket.emit('error_message', { message });
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
        phase: 'lobby', // lobby | playing | game_over
        game: null,
      };
      room.players.set(playerId, { name: cleanName, socketId: socket.id, connected: true });
      room.order.push(playerId);
      rooms.set(code, room);
      socketIndex.set(socket.id, { roomCode: code, playerId });
      socket.join(code);
      ack && ack({ ok: true, roomCode: code, playerId });
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
      ack && ack({ ok: true, roomCode: code, playerId });
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
      ack && ack({ ok: true, roomCode: code, playerId });
      broadcastRoom(room);
      if (room.game) {
        io.to(socket.id).emit('game_state', room.game.getPublicState(playerId));
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

      room.game = new LeastCountGame(room.order.slice());
      room.game.startRound();
      room.phase = 'playing';
      broadcastRoom(room);
      broadcastGameState(room);
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
      if (room.game.gameOver) room.phase = 'game_over';
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
      broadcastGameState(room);
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
      room.game = null;
      room.phase = 'lobby';
      broadcastRoom(room);
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
