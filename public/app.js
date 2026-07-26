(function () {
  const socket = io();

  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RED_SUITS = new Set(['H', 'D']);
  const RANK_ORDER = ['A','2','3','4','5','6','7','8','9','10','J','Q','K','JOKER'];

  let session = JSON.parse(localStorage.getItem('leastcount_session') || 'null');
  let myPlayerId = session ? session.playerId : null;
  let myRoomCode = session ? session.roomCode : null;

  let latestRoom = null;
  let latestGame = null;
  let selectedIds = new Set();
  let lastSeenRoundNumber = null;

  // ---------------- screen management ----------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function saveSession(roomCode, playerId) {
    myRoomCode = roomCode;
    myPlayerId = playerId;
    localStorage.setItem('leastcount_session', JSON.stringify({ roomCode, playerId }));
  }

  // ---------------- landing screen ----------------
  document.getElementById('btn-create').onclick = () => {
    const name = document.getElementById('input-name').value.trim();
    if (!name) return setLandingError('పేరు రాయండి / Enter your name');
    socket.emit('create_room', { name }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      saveSession(res.roomCode, res.playerId);
      showScreen('screen-lobby');
    });
  };

  document.getElementById('btn-join').onclick = () => {
    const name = document.getElementById('input-name').value.trim();
    const roomCode = document.getElementById('input-roomcode').value.trim().toUpperCase();
    if (!name) return setLandingError('పేరు రాయండి / Enter your name');
    if (!roomCode) return setLandingError('రూమ్ కోడ్ రాయండి / Enter room code');
    socket.emit('join_room', { roomCode, name }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      saveSession(res.roomCode, res.playerId);
      showScreen('screen-lobby');
    });
  };

  function setLandingError(msg) { document.getElementById('landing-error').textContent = msg || ''; }

  // ---------------- lobby screen ----------------
  document.getElementById('btn-start').onclick = () => {
    socket.emit('start_game', { roomCode: myRoomCode }, (res) => {
      if (!res.ok) document.getElementById('lobby-error').textContent = res.error;
    });
  };

  function renderLobby(room) {
    document.getElementById('lobby-roomcode').textContent = room.roomCode;
    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      const hostTag = p.playerId === room.hostPlayerId ? '<span class="host-tag">HOST</span>' : '';
      li.innerHTML = `<span>${escapeHtml(p.name)} ${hostTag}</span><span class="status">${p.connected ? 'online' : 'offline'}</span>`;
      list.appendChild(li);
    });
    const isHost = room.hostPlayerId === myPlayerId;
    const btn = document.getElementById('btn-start');
    btn.classList.toggle('hidden', !isHost);
    btn.disabled = room.players.length < 2;
    document.getElementById('lobby-hint').textContent = isHost
      ? (room.players.length < 2 ? 'కనీసం 2 మంది కావాలి / Need at least 2 players' : `Ready with ${room.players.length} players`)
      : 'హోస్ట్ గేమ్ మొదలుపెట్టే వరకు వేచి ఉండండి / Waiting for host to start';
  }

  // ---------------- game screen rendering ----------------
  function cardEl(card, { selectable, selected } = {}) {
    const el = document.createElement('div');
    el.className = 'card';
    if (card.rank === 'JOKER') {
      el.classList.add('joker');
      el.textContent = 'JOKER';
    } else {
      el.classList.add(RED_SUITS.has(card.suit) ? 'red' : 'black');
      el.textContent = `${card.rank}${SUIT_SYMBOL[card.suit] || ''}`;
    }
    if (selectable) el.classList.add('selectable');
    if (selected) el.classList.add('selected');
    return el;
  }

  function sortHand(hand) {
    return hand.slice().sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank));
  }

  function renderGame(game) {
    document.getElementById('round-info').textContent = `Round ${game.roundNumber}`;

    const isMyTurn = game.currentPlayer === myPlayerId;
    const currentName = playerName(game.currentPlayer);
    document.getElementById('turn-info').textContent = game.roundOver
      ? 'Round Over'
      : (isMyTurn ? 'మీ వంతు! Your turn' : `${currentName} వంతు...`);

    // opponents strip
    const strip = document.getElementById('opponents-strip');
    strip.innerHTML = '';
    (latestRoom ? latestRoom.players : []).forEach((p) => {
      const chip = document.createElement('div');
      chip.className = 'opponent-chip';
      if (p.playerId === game.currentPlayer && !game.roundOver) chip.classList.add('active');
      if (game.eliminated.includes(p.playerId)) chip.classList.add('eliminated');
      const count = game.handCounts[p.playerId] ?? '-';
      const score = game.scores[p.playerId] ?? 0;
      chip.innerHTML = `${escapeHtml(p.name)}${p.playerId === myPlayerId ? ' (You)' : ''}<br>${count} cards · ${score} pts`;
      strip.appendChild(chip);
    });

    document.getElementById('stock-count').textContent = game.stockCount;
    const openSlot = document.getElementById('open-card-slot');
    openSlot.innerHTML = '';
    if (game.openCard) openSlot.appendChild(cardEl(game.openCard));

    document.getElementById('joker-indicator').textContent = game.roundJokerRank || 'None';

    // +2 chain banner
    const chainBanner = document.getElementById('chain-banner');
    const showChain = isMyTurn && game.chainCount > 0 && !game.roundOver;
    chainBanner.classList.toggle('hidden', !showChain);
    if (showChain) document.getElementById('penalty-count').textContent = game.chainCount * 2;

    // hand
    const handValue = game.yourHandValue ?? 0;
    document.getElementById('hand-value').textContent = handValue;
    const handDiv = document.getElementById('hand');
    handDiv.innerHTML = '';
    const hand = sortHand(game.yourHand || []);

    const duringChain = game.chainCount > 0;
    hand.forEach((card) => {
      let selectable = isMyTurn && !game.roundOver;
      if (duringChain) selectable = selectable && card.rank === '2';
      const el = cardEl(card, { selectable, selected: selectedIds.has(card.id) });
      if (selectable) {
        el.onclick = duringChain ? () => submitChainTwo(card) : () => toggleSelect(card);
      }
      handDiv.appendChild(el);
    });

    // action buttons
    const discardBtn = document.getElementById('btn-discard');
    const declareBtn = document.getElementById('btn-declare');
    discardBtn.disabled = !(isMyTurn && !game.roundOver && !duringChain && selectedIds.size > 0);
    declareBtn.disabled = !(isMyTurn && !game.roundOver && !duringChain && handValue <= 5);
    discardBtn.classList.toggle('hidden', duringChain);
    declareBtn.classList.toggle('hidden', duringChain);

    // round result overlay
    if (game.roundOver && game.lastRoundResult && game.roundNumber !== lastSeenRoundResultShownFor()) {
      showRoundResult(game);
    }
    if (game.gameOver) {
      showGameOver(game);
    }
  }

  function lastSeenRoundResultShownFor() {
    return window.__lastRoundResultShownFor;
  }

  function toggleSelect(card) {
    if (game_isDuringChain()) {
      selectedIds = selectedIds.has(card.id) ? new Set() : new Set([card.id]);
    } else {
      if (selectedIds.has(card.id)) {
        selectedIds.delete(card.id);
      } else {
        // enforce same-rank selection
        const firstId = [...selectedIds][0];
        if (firstId) {
          const firstCard = (latestGame.yourHand || []).find((c) => c.id === firstId);
          if (firstCard && firstCard.rank !== card.rank) selectedIds.clear();
        }
        selectedIds.add(card.id);
      }
    }
    renderGame(latestGame);
  }

  function game_isDuringChain() {
    return latestGame && latestGame.chainCount > 0;
  }

  function submitChainTwo(card) {
    socket.emit('play_turn', { roomCode: myRoomCode, cardIds: [card.id] }, (res) => {
      if (!res.ok) setGameError(res.error);
      else setGameError('');
    });
  }

  document.getElementById('btn-discard').onclick = () => {
    const ids = [...selectedIds];
    socket.emit('play_turn', { roomCode: myRoomCode, cardIds: ids }, (res) => {
      if (!res.ok) return setGameError(res.error);
      selectedIds = new Set();
      setGameError('');
    });
  };

  document.getElementById('btn-declare').onclick = () => {
    socket.emit('declare', { roomCode: myRoomCode }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
  };

  document.getElementById('btn-take-penalty').onclick = () => {
    socket.emit('play_turn', { roomCode: myRoomCode, cardIds: [] }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
  };

  function setGameError(msg) { document.getElementById('game-error').textContent = msg || ''; }

  function playerName(playerId) {
    if (!latestRoom) return '?';
    const p = latestRoom.players.find((x) => x.playerId === playerId);
    return p ? p.name : '?';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ---------------- round result / scores / game over overlays ----------------
  function showRoundResult(game) {
    window.__lastRoundResultShownFor = game.roundNumber;
    const r = game.lastRoundResult;
    const title = r.correct
      ? `✅ ${playerName(r.declaredBy)} correctly declared Least Count!`
      : `❌ ${playerName(r.declaredBy)} declared wrong! (+${75} penalty)`;
    document.getElementById('round-result-title').textContent = title;

    const body = document.getElementById('round-result-body');
    body.innerHTML = '';
    Object.keys(r.values).forEach((pid) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML = `<span>${escapeHtml(playerName(pid))}</span><span>value ${r.values[pid]} · +${r.roundScores[pid]} pts · total ${game.scores[pid]}</span>`;
      body.appendChild(row);
    });
    if (r.newlyEliminated && r.newlyEliminated.length) {
      const elim = document.createElement('p');
      elim.className = 'error';
      elim.textContent = `Eliminated: ${r.newlyEliminated.map(playerName).join(', ')}`;
      body.appendChild(elim);
    }

    const isHost = latestRoom && latestRoom.hostPlayerId === myPlayerId;
    const nextBtn = document.getElementById('btn-next-round');
    nextBtn.classList.toggle('hidden', !isHost || game.gameOver);
    document.getElementById('round-result-hint').textContent = isHost || game.gameOver ? '' : 'Waiting for host to start next round...';
    document.getElementById('overlay-round-result').classList.remove('hidden');
  }

  document.getElementById('btn-next-round').onclick = () => {
    document.getElementById('overlay-round-result').classList.add('hidden');
    socket.emit('next_round', { roomCode: myRoomCode }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
  };

  document.getElementById('btn-scores').onclick = () => {
    if (!latestGame) return;
    const body = document.getElementById('scores-body');
    body.innerHTML = '';
    (latestRoom.players || []).slice().sort((a,b) => (latestGame.scores[a.playerId]||0) - (latestGame.scores[b.playerId]||0)).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      const elim = latestGame.eliminated.includes(p.playerId) ? ' (out)' : '';
      row.innerHTML = `<span>${escapeHtml(p.name)}${elim}</span><span>${latestGame.scores[p.playerId] ?? 0} pts</span>`;
      body.appendChild(row);
    });
    document.getElementById('overlay-scores').classList.remove('hidden');
  };
  document.getElementById('btn-close-scores').onclick = () => document.getElementById('overlay-scores').classList.add('hidden');

  function showGameOver(game) {
    document.getElementById('overlay-round-result').classList.add('hidden');
    document.getElementById('gameover-title').textContent = `🏆 ${playerName(game.winner)} wins!`;
    const body = document.getElementById('gameover-body');
    body.innerHTML = '';
    Object.entries(game.scores).sort((a,b) => a[1]-b[1]).forEach(([pid, score]) => {
      const row = document.createElement('div');
      row.className = 'result-row' + (pid === game.winner ? ' winner-row' : '');
      row.innerHTML = `<span>${escapeHtml(playerName(pid))}</span><span>${score} pts</span>`;
      body.appendChild(row);
    });
    const isHost = latestRoom && latestRoom.hostPlayerId === myPlayerId;
    document.getElementById('btn-new-game').classList.toggle('hidden', !isHost);
    document.getElementById('gameover-hint').textContent = isHost ? '' : 'Waiting for host to start a new game...';
    document.getElementById('overlay-gameover').classList.remove('hidden');
  }

  document.getElementById('btn-new-game').onclick = () => {
    socket.emit('new_game', { roomCode: myRoomCode }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
  };

  // ---------------- socket listeners ----------------
  socket.on('connect', () => {
    if (myRoomCode && myPlayerId) {
      socket.emit('rejoin', { roomCode: myRoomCode, playerId: myPlayerId }, (res) => {
        if (!res.ok) {
          localStorage.removeItem('leastcount_session');
          showScreen('screen-landing');
        }
      });
    }
  });

  socket.on('room_update', (room) => {
    latestRoom = room;
    if (room.phase === 'lobby') {
      latestGame = null;
      window.__lastRoundResultShownFor = null;
      document.getElementById('overlay-round-result').classList.add('hidden');
      document.getElementById('overlay-gameover').classList.add('hidden');
      renderLobby(room);
      showScreen('screen-lobby');
    } else if (latestGame) {
      showScreen('screen-game');
      renderGame(latestGame);
    }
  });

  socket.on('game_state', (game) => {
    latestGame = game;
    showScreen('screen-game');
    renderGame(game);
  });

  socket.on('error_message', (data) => setGameError(data.message));

  // initial screen
  if (myRoomCode && myPlayerId) {
    // will attempt rejoin on connect
  } else {
    showScreen('screen-landing');
  }
})();
