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
  let chatUnread = 0;
  let timerInterval = null;

  // ---------------- sound effects (Web Audio API, no files needed) ----------------
  const Sound = (() => {
    let ctx = null;
    let muted = localStorage.getItem('leastcount_muted') === '1';

    function ensureCtx() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    function tone(freq, duration, opts) {
      opts = opts || {};
      if (muted) return;
      const c = ensureCtx();
      if (!c) return;
      const t0 = c.currentTime + (opts.delay || 0);
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = opts.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(opts.gain || 0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.03);
    }

    function seq(notes) {
      notes.forEach((n) => tone(n[0], n[1], { delay: n[2] || 0, type: n[3], gain: n[4] }));
    }

    return {
      isMuted: () => muted,
      setMuted(v) { muted = v; localStorage.setItem('leastcount_muted', v ? '1' : '0'); },
      init() { ensureCtx(); },
      discard() { tone(520, 0.08, { type: 'triangle', gain: 0.12 }); },
      penaltyDraw() { tone(180, 0.18, { type: 'sawtooth', gain: 0.12 }); },
      chainAlert() { seq([[300, 0.12, 0, 'square', 0.1], [220, 0.18, 0.1, 'square', 0.1]]); },
      yourTurn() { seq([[660, 0.1, 0], [880, 0.14, 0.1]]); },
      declareCorrect() { seq([[523, 0.12, 0], [659, 0.12, 0.1], [784, 0.22, 0.2]]); },
      declareWrong() { seq([[300, 0.2, 0, 'sawtooth'], [220, 0.28, 0.15, 'sawtooth']]); },
      win() { seq([[523, 0.15, 0], [659, 0.15, 0.12], [784, 0.15, 0.24], [1046, 0.35, 0.36]]); },
    };
  })();

  document.addEventListener('click', function initAudioOnce() {
    Sound.init();
    document.removeEventListener('click', initAudioOnce);
  }, { once: true });

  const soundBtn = document.getElementById('btn-sound-toggle');
  soundBtn.textContent = Sound.isMuted() ? '🔇' : '🔊';
  soundBtn.onclick = () => {
    const next = !Sound.isMuted();
    Sound.setMuted(next);
    soundBtn.textContent = next ? '🔇' : '🔊';
  };

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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // ---------------- landing screen ----------------
  document.getElementById('btn-create').onclick = () => {
    const name = document.getElementById('input-name').value.trim();
    if (!name) return setLandingError('పేరు రాయండి / Enter your name');
    socket.emit('create_room', { name }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      saveSession(res.roomCode, res.playerId);
      loadChatHistory(res.chatHistory);
      showChatFab();
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
      loadChatHistory(res.chatHistory);
      showChatFab();
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

  // ---------------- realistic card rendering ----------------
  function cardEl(card, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'card';
    if (card.rank === 'JOKER') {
      el.classList.add('joker');
      el.innerHTML =
        '<div class="card-corner corner-tl"><span class="corner-rank">JK</span></div>' +
        '<div class="card-center"><span class="center-rank">🃏</span></div>' +
        '<div class="card-corner corner-br"><span class="corner-rank">JK</span></div>';
    } else {
      const isRed = RED_SUITS.has(card.suit);
      el.classList.add(isRed ? 'red' : 'black');
      const suit = SUIT_SYMBOL[card.suit] || '';
      el.innerHTML =
        `<div class="card-corner corner-tl"><span class="corner-rank">${card.rank}</span><span class="corner-suit">${suit}</span></div>` +
        `<div class="card-center"><span class="center-rank">${card.rank}</span><span class="center-suit">${suit}</span></div>` +
        `<div class="card-corner corner-br"><span class="corner-rank">${card.rank}</span><span class="corner-suit">${suit}</span></div>`;
    }
    if (opts.selectable) el.classList.add('selectable');
    if (opts.selected) el.classList.add('selected');
    return el;
  }

  function sortHand(hand) {
    return hand.slice().sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank));
  }

  // ---------------- oval table ----------------
  function renderOvalTable(game) {
    const oval = document.getElementById('oval-table');
    oval.querySelectorAll('.seat').forEach((el) => el.remove());
    if (!latestRoom) return;

    const players = latestRoom.players;
    const me = players.find((p) => p.playerId === myPlayerId);
    const others = players.filter((p) => p.playerId !== myPlayerId);
    const seatOrder = me ? [me, ...others] : players.slice();
    const n = seatOrder.length;

    seatOrder.forEach((p, i) => {
      const angle = Math.PI / 2 + (i / n) * 2 * Math.PI;
      const left = 50 + 44 * Math.cos(angle);
      const top = 50 + 40 * Math.sin(angle);

      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      if (game && !game.roundOver && game.currentPlayer === p.playerId) seatEl.classList.add('active');
      if (game && game.eliminated && game.eliminated.includes(p.playerId)) seatEl.classList.add('eliminated');
      if (game && game.quit && game.quit.includes(p.playerId)) seatEl.classList.add('quit');
      seatEl.style.left = left + '%';
      seatEl.style.top = top + '%';

      const count = game && game.handCounts ? game.handCounts[p.playerId] : undefined;
      const score = game && game.scores ? (game.scores[p.playerId] ?? 0) : 0;
      const showBack = p.playerId !== myPlayerId && count !== undefined;

      seatEl.innerHTML =
        (showBack ? '<div class="mini-card-back"></div>' : '') +
        '<div class="seat-chip">' +
        `<div class="seat-name">${escapeHtml(p.name)}${p.playerId === myPlayerId ? ' (You)' : ''}</div>` +
        `<div class="seat-meta">${count !== undefined ? count + ' cards · ' : ''}${score} pts</div>` +
        '</div>';
      oval.appendChild(seatEl);
    });
  }

  // ---------------- turn timer ----------------
  function updateTurnTimerDisplay(deadline) {
    const el = document.getElementById('turn-timer');
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (!deadline) { el.classList.add('hidden'); return; }

    function tick() {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      document.getElementById('timer-seconds').textContent = remaining;
      el.classList.remove('hidden');
      el.classList.toggle('low', remaining <= 10);
    }
    tick();
    timerInterval = setInterval(tick, 250);
  }

  // ---------------- main game rendering ----------------
  function renderGame(game) {
    document.getElementById('round-info').textContent = `Round ${game.roundNumber}`;

    const isMyTurn = game.currentPlayer === myPlayerId;
    const currentName = playerName(game.currentPlayer);
    document.getElementById('turn-info').textContent = game.roundOver
      ? 'Round Over'
      : (isMyTurn ? 'మీ వంతు! Your turn' : `${currentName} వంతు...`);

    updateTurnTimerDisplay(game.roundOver ? null : game.turnDeadline);
    renderOvalTable(game);

    document.getElementById('stock-count').textContent = game.stockCount;
    const openSlot = document.getElementById('open-card-slot');
    openSlot.innerHTML = '';
    if (game.openCard) openSlot.appendChild(cardEl(game.openCard));

    document.getElementById('joker-indicator').textContent = game.roundJokerRank || 'None';

    const chainBanner = document.getElementById('chain-banner');
    const showChain = isMyTurn && game.chainCount > 0 && !game.roundOver;
    chainBanner.classList.toggle('hidden', !showChain);
    if (showChain) document.getElementById('penalty-count').textContent = game.chainCount * 2;

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

    const discardBtn = document.getElementById('btn-discard');
    const declareBtn = document.getElementById('btn-declare');
    discardBtn.disabled = !(isMyTurn && !game.roundOver && !duringChain && selectedIds.size > 0);
    declareBtn.disabled = !(isMyTurn && !game.roundOver && !duringChain && handValue <= 5);
    discardBtn.classList.toggle('hidden', duringChain);
    declareBtn.classList.toggle('hidden', duringChain);

    if (game.roundOver && game.lastRoundResult && game.roundNumber !== window.__lastRoundResultShownFor) {
      showRoundResult(game);
    }
    if (game.gameOver) {
      showGameOver(game);
    }
  }

  function toggleSelect(card) {
    if (latestGame && latestGame.chainCount > 0) {
      selectedIds = selectedIds.has(card.id) ? new Set() : new Set([card.id]);
    } else {
      if (selectedIds.has(card.id)) {
        selectedIds.delete(card.id);
      } else {
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

  function submitChainTwo(card) {
    socket.emit('play_turn', { roomCode: myRoomCode, cardIds: [card.id] }, (res) => {
      if (!res.ok) setGameError(res.error);
      else setGameError('');
    });
  }

  document.getElementById('btn-discard').onclick = () => {
    Sound.discard();
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

  // ---------------- round result / scores / game over overlays ----------------
  function showRoundResult(game) {
    window.__lastRoundResultShownFor = game.roundNumber;
    const r = game.lastRoundResult;
    const title = r.correct
      ? `✅ ${playerName(r.declaredBy)} correctly declared Least Count!`
      : `❌ ${playerName(r.declaredBy)} declared wrong! (+75 penalty)`;
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

  // ---------------- leave room ----------------
  function leaveRoom() {
    socket.emit('leave_room', { roomCode: myRoomCode }, (res) => {
      if (!res.ok) {
        setGameError(res.error);
        document.getElementById('lobby-error').textContent = res.error;
        return;
      }
      localStorage.removeItem('leastcount_session');
      myRoomCode = null;
      myPlayerId = null;
      latestRoom = null;
      latestGame = null;
      window.__lastRoundResultShownFor = null;
      hideChatUI();
      document.getElementById('overlay-round-result').classList.add('hidden');
      document.getElementById('overlay-gameover').classList.add('hidden');
      document.getElementById('overlay-scores').classList.add('hidden');
      showScreen('screen-landing');
    });
  }
  document.getElementById('btn-leave-lobby').onclick = leaveRoom;
  document.getElementById('btn-leave-round-result').onclick = leaveRoom;
  document.getElementById('btn-leave-gameover').onclick = leaveRoom;

  // ---------------- chat ----------------
  function showChatFab() { document.getElementById('chat-fab').classList.remove('hidden'); }
  function hideChatUI() {
    document.getElementById('chat-fab').classList.add('hidden');
    document.getElementById('chat-panel').classList.add('hidden');
    chatUnread = 0;
  }

  function updateChatBadge() {
    const badge = document.getElementById('chat-badge');
    if (chatUnread > 0) {
      badge.textContent = chatUnread > 9 ? '9+' : chatUnread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function appendChatMessage(msg, opts) {
    opts = opts || {};
    const container = document.getElementById('chat-messages');
    const emptyEl = container.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();
    const div = document.createElement('div');
    div.className = 'chat-msg' + (msg.playerId === myPlayerId ? ' me' : '');
    div.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}:</span> <span class="chat-text">${escapeHtml(msg.text)}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    const panelOpen = !document.getElementById('chat-panel').classList.contains('hidden');
    if (!panelOpen && msg.playerId !== myPlayerId && !opts.silent) {
      chatUnread += 1;
      updateChatBadge();
    }
  }

  function loadChatHistory(history) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    if (!history || history.length === 0) {
      container.innerHTML = '<div class="chat-empty">ఇంకా మెసేజ్‌లు లేవు</div>';
      return;
    }
    history.forEach((m) => appendChatMessage(m, { silent: true }));
  }

  document.getElementById('chat-fab').onclick = () => {
    document.getElementById('chat-panel').classList.remove('hidden');
    document.getElementById('chat-fab').classList.add('hidden');
    chatUnread = 0;
    updateChatBadge();
    document.getElementById('chat-input').focus();
  };
  document.getElementById('btn-chat-close').onclick = () => {
    document.getElementById('chat-panel').classList.add('hidden');
    document.getElementById('chat-fab').classList.remove('hidden');
  };
  function sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat_message', { roomCode: myRoomCode, text }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
    input.value = '';
  }
  document.getElementById('btn-chat-send').onclick = sendChat;
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  socket.on('chat_message', (msg) => appendChatMessage(msg));

  // ---------------- sound event detection (diff previous vs new game state) ----------------
  function playSoundsForTransition(prev, game) {
    if (!prev) return;
    if (game.currentPlayer === myPlayerId && prev.currentPlayer !== myPlayerId && !game.roundOver) {
      Sound.yourTurn();
    }
    if (game.chainCount > 0 && prev.chainCount === 0) {
      Sound.chainAlert();
    }
    if (!prev.roundOver && game.roundOver && game.lastRoundResult) {
      if (game.lastRoundResult.correct) Sound.declareCorrect();
      else Sound.declareWrong();
    }
    if (!prev.gameOver && game.gameOver) {
      Sound.win();
    }
  }

  // ---------------- drawn-card reveal ----------------
  // Shows exactly which card(s) a player just drew as a penalty, face-up, for
  // a couple of seconds -- so they get that little moment of joy/disappointment
  // before it just quietly joins their hand.
  let drawRevealTimeout = null;
  function showDrawReveal(cards) {
    if (!cards || cards.length === 0) return;
    Sound.penaltyDraw();
    const overlay = document.getElementById('draw-reveal');
    const container = document.getElementById('draw-reveal-cards');
    const label = document.getElementById('draw-reveal-label');
    label.textContent = cards.length > 1
      ? `మీకు ${cards.length} కార్డులు వచ్చాయి / You drew ${cards.length} cards`
      : 'మీకు వచ్చింది / You drew';
    container.innerHTML = '';
    cards.forEach((c) => container.appendChild(cardEl(c)));
    overlay.classList.remove('hidden');
    if (drawRevealTimeout) clearTimeout(drawRevealTimeout);
    drawRevealTimeout = setTimeout(() => {
      overlay.classList.add('hidden');
    }, 2500);
  }
  socket.on('cards_drawn', ({ cards }) => showDrawReveal(cards));

  // ---------------- socket listeners ----------------
  socket.on('connect', () => {
    if (myRoomCode && myPlayerId) {
      socket.emit('rejoin', { roomCode: myRoomCode, playerId: myPlayerId }, (res) => {
        if (!res.ok) {
          localStorage.removeItem('leastcount_session');
          showScreen('screen-landing');
        } else {
          loadChatHistory(res.chatHistory);
          showChatFab();
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
    const prev = latestGame;
    playSoundsForTransition(prev, game);
    latestGame = game;
    showScreen('screen-game');
    renderGame(game);
  });

  socket.on('error_message', (data) => setGameError(data.message));

  // initial screen
  if (!(myRoomCode && myPlayerId)) {
    showScreen('screen-landing');
  }
})();
