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

  // Game-start sequence (countdown -> live deal -> joker/open-card reveal).
  // pendingStartReveal is set true the moment the countdown+deal animation
  // finishes locally; the very next game_state we receive after that is the
  // one carrying the freshly-dealt hands/joker/open-card, so that's the
  // signal to switch the overlay into its "reveal" step -- not a fixed
  // client-side timer, so it can never fire before the data actually exists.
  let pendingStartReveal = false;
  let startSeqTimer = null;
  let dealAnimationCancel = null;

  // ---------------- seat emoji reactions (items 9 & 10) ----------------
  // playerId -> { emoji, startedAt }. Seats get fully torn down and rebuilt
  // on every renderOvalTable() call, so instead of animating a persistent
  // DOM node we just track "what's active and since when" here and have
  // renderOvalTable() re-inject the bubble every time, using a negative
  // animation-delay (= how long it's already been showing) so the pop/hold/
  // fade animation looks continuous across re-renders instead of restarting.
  const seatReactions = {};
  const REACTION_HOLD_MS = 3000;
  const REACTION_FADE_MS = 400;
  const REACTION_TOTAL_MS = REACTION_HOLD_MS + REACTION_FADE_MS;

  function triggerSeatReaction(playerId, emoji) {
    const startedAt = Date.now();
    seatReactions[playerId] = { emoji, startedAt };
    renderOvalTable(latestGame);
    setTimeout(() => {
      if (seatReactions[playerId] && seatReactions[playerId].startedAt === startedAt) {
        delete seatReactions[playerId];
        renderOvalTable(latestGame);
      }
    }, REACTION_TOTAL_MS + 60);
  }

  // Big and playful on purpose -- it's fine if it briefly covers the name,
  // since a subtle reaction nobody notices defeats the point.
  const SEAT_REACTION_RULES = {
    penalty6: { self: '😅', others: '😂' },
    lowcards: { self: null, others: '👀' },
    bigdiscard: { self: '🔥', others: null },
    timeout: { self: '😴', others: null },
    chainextend: { self: '😈', others: null },
    eliminated: { self: '👋', others: null },
  };

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

    // A short burst of filtered white noise -- the actual building block of
    // every card sound below. A pure tone can't sound like a card no matter
    // how it's tuned; a snap/flick/riffle is fundamentally a noise transient,
    // not a pitch, so this generates real noise and shapes it with a filter
    // sweep + fast envelope instead of an oscillator.
    function noiseBurst(opts) {
      opts = opts || {};
      if (muted) return;
      const c = ensureCtx();
      if (!c) return;
      const duration = opts.duration || 0.08;
      const t0 = c.currentTime + (opts.delay || 0);

      const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
      const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

      const src = c.createBufferSource();
      src.buffer = buffer;

      const filter = c.createBiquadFilter();
      filter.type = opts.filterType || 'bandpass';
      filter.frequency.setValueAtTime(opts.freqStart || 3000, t0);
      if (opts.freqEnd !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(60, opts.freqEnd), t0 + duration);
      }
      filter.Q.value = opts.q || 1;

      const gain = c.createGain();
      const peak = opts.gain || 0.25;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);

      src.connect(filter).connect(gain).connect(c.destination);
      src.start(t0);
      src.stop(t0 + duration + 0.02);
    }

    // One crisp card hitting the table: a sharp high-frequency "flick" with
    // a touch of low-end "thud" underneath it for body.
    function cardSnap(opts) {
      opts = opts || {};
      const gain = opts.gain || 0.3;
      const delay = opts.delay || 0;
      noiseBurst({ duration: 0.05, filterType: 'bandpass', freqStart: 4500, freqEnd: 1200, q: 1.2, gain, delay });
      noiseBurst({ duration: 0.04, filterType: 'lowpass', freqStart: 350, gain: gain * 0.5, delay });
    }

    // Several overlapping snaps in quick succession -- a riffle/draw sound
    // that scales with how many cards are actually moving, so drawing 1
    // penalty card sounds like a single flick and drawing 6 (a big +2 chain
    // penalty) sounds like a real handful being pulled off the stock.
    function cardRiffle(count) {
      count = Math.max(1, count || 1);
      const n = Math.min(count, 8); // cap the sound even if the draw itself is huge
      for (let i = 0; i < n; i++) {
        const delay = (i / n) * (0.1 + n * 0.02) + Math.random() * 0.015;
        noiseBurst({
          duration: 0.04, filterType: 'bandpass',
          freqStart: 3200 + Math.random() * 1400, freqEnd: 1800, q: 1.5,
          gain: 0.28, delay,
        });
      }
    }

    // A quick spray of tiny, high-passed noise ticks -- the flutter of a
    // proper riffle shuffle, as opposed to the slower per-card cardRiffle().
    function shuffleBurst(n, span, opts) {
      opts = opts || {};
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const jitter = (Math.random() - 0.5) * (span / n) * 0.6;
        noiseBurst({
          duration: opts.dur || 0.018,
          filterType: 'highpass',
          freqStart: 2000 + Math.random() * (opts.freqSpread || 3000),
          gain: (opts.gain || 0.2) * (0.7 + 0.3 * Math.sin(t * Math.PI)),
          delay: t * span + jitter,
        });
      }
    }

    // The stock reshuffle sound -- two staggered, slightly different-pitched
    // flutter layers, like someone riffling the pile with both hands. Public
    // event (doesn't reveal any hand), so every player at the table hears it.
    function cardReshuffle() {
      shuffleBurst(35, 0.4, { gain: 0.2, dur: 0.016 });
      shuffleBurst(35, 0.4, { gain: 0.16, dur: 0.016, freqSpread: 2500 });
    }

    return {
      isMuted: () => muted,
      setMuted(v) { muted = v; localStorage.setItem('leastcount_muted', v ? '1' : '0'); },
      init() { ensureCtx(); },
      discard() { cardSnap({ gain: 0.42 }); },
      penaltyDraw(count) { cardRiffle(count || 1); },
      reshuffle() { cardReshuffle(); },
      chainAlert() { cardSnap({ gain: 0.5 }); seq([[280, 0.14, 0.05, 'square', 0.08]]); },
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
    // The game screen locks the page to one viewport (no drag/scroll needed);
    // other screens (lobby, overlays) are allowed to scroll normally.
    document.body.classList.toggle('game-active', id === 'screen-game');
  }

  // ---------------- game-start sequence ----------------
  // 3-2-1 countdown, then a "dealing cards" animation, then the round's
  // joker rank + open card are revealed and held for a few seconds. The
  // real turn timer quietly starts partway into that reveal (server-driven,
  // see game_state handler below) -- this function only owns the visuals.
  function runStartSequence(data) {
    if (startSeqTimer) { clearTimeout(startSeqTimer); startSeqTimer = null; }
    if (dealAnimationCancel) { dealAnimationCancel(); dealAnimationCancel = null; }
    document.getElementById('overlay-gameover').classList.add('hidden');
    document.getElementById('overlay-round-result').classList.add('hidden');
    document.getElementById('overlay-scores').classList.add('hidden');
    const overlay = document.getElementById('overlay-start-sequence');
    const countdownEl = document.getElementById('start-seq-countdown');
    const dealingEl = document.getElementById('start-seq-dealing');
    const revealEl = document.getElementById('start-seq-reveal');
    overlay.classList.remove('hidden');
    revealEl.classList.add('hidden');
    dealingEl.classList.add('hidden');
    countdownEl.classList.remove('hidden');

    const countdownMs = data.countdownMs || 3000;
    const dealMs = data.dealMs || 1500;
    const steps = 3; // "3", "2", "1"
    const stepMs = countdownMs / steps;

    function showCountdownStep(n) {
      if (n <= 0) {
        countdownEl.classList.add('hidden');
        dealingEl.classList.remove('hidden');
        animateDealing(data.players || [], dealMs, data.dealPasses || 13);
        startSeqTimer = setTimeout(() => {
          // Countdown + deal animation are done. The board itself will pop
          // to life the instant the server's post-deal game_state arrives
          // (see pendingStartReveal handling below) -- we just flag that
          // we're now waiting for it.
          pendingStartReveal = true;
        }, dealMs);
        return;
      }
      countdownEl.textContent = String(n);
      startSeqTimer = setTimeout(() => showCountdownStep(n - 1), stepMs);
    }
    showCountdownStep(steps);
  }

  // A small "flying card" travels from a center deck marker to each player's
  // chip in turn, looping around the table for a full 13 passes (matching
  // the real hand size dealt underneath -- not a shortened stand-in),
  // mirroring how a real dealer hands out one card at a time, round and
  // round. Chip counters tick up with every card that "lands". totalMs is
  // computed server-side to scale with player count, so per-flight speed
  // stays consistent (~90ms) regardless of table size.
  function animateDealing(players, totalMs, passes) {
    const container = document.getElementById('start-seq-dealing-players');
    container.innerHTML = '';
    if (players.length === 0) return;
    container.style.position = 'relative';

    const chips = players.map((p) => {
      const chip = document.createElement('div');
      chip.className = 'deal-chip';
      chip.innerHTML = `<div class="deal-chip-name">${escapeHtml(p.name)}</div><div class="deal-chip-count">0</div>`;
      container.appendChild(chip);
      return chip;
    });

    const deck = document.createElement('div');
    deck.className = 'deal-deck';
    container.appendChild(deck);

    const flyer = document.createElement('div');
    flyer.className = 'deal-flyer';
    container.appendChild(flyer);

    passes = passes || 13;
    const totalFlights = players.length * passes;
    const flightMs = totalMs / totalFlights;
    let flight = 0;
    let cancelled = false;
    dealAnimationCancel = () => { cancelled = true; };

    function centerOf(el) {
      const cRect = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - cRect.left + r.width / 2, y: r.top - cRect.top + r.height / 2 };
    }

    function flyNext() {
      if (cancelled) return;
      if (flight >= totalFlights) { flyer.style.opacity = '0'; return; }
      const chip = chips[flight % chips.length];
      const from = centerOf(deck);
      const to = centerOf(chip);
      flyer.style.transition = 'none';
      flyer.style.left = from.x + 'px';
      flyer.style.top = from.y + 'px';
      flyer.style.opacity = '1';
      const travelMs = flightMs * 0.7;
      requestAnimationFrame(() => {
        if (cancelled) return;
        flyer.style.transition = `left ${travelMs}ms ease, top ${travelMs}ms ease`;
        flyer.style.left = to.x + 'px';
        flyer.style.top = to.y + 'px';
      });
      setTimeout(() => {
        if (cancelled) return;
        const countEl = chip.querySelector('.deal-chip-count');
        countEl.textContent = String(parseInt(countEl.textContent, 10) + 1);
        chip.classList.add('dealt');
        flight += 1;
        setTimeout(flyNext, flightMs * 0.3);
      }, travelMs);
    }
    flyNext();
  }

  // Called once the first post-deal game_state arrives (pendingStartReveal
  // was set true by runStartSequence above). Shows the joker rank + open
  // card big or held on screen, then reveals the live board underneath.
  function showStartReveal(game, revealMs) {
    const overlay = document.getElementById('overlay-start-sequence');
    const dealingEl = document.getElementById('start-seq-dealing');
    const revealEl = document.getElementById('start-seq-reveal');
    dealingEl.classList.add('hidden');
    revealEl.classList.remove('hidden');

    const jokerSlot = document.getElementById('start-seq-joker-card');
    const openSlot = document.getElementById('start-seq-open-card');
    jokerSlot.innerHTML = '';
    openSlot.innerHTML = '';
    jokerSlot.appendChild(game.roundJokerRank
      ? cardEl({ rank: game.roundJokerRank, suit: null }, { wild: true })
      : cardEl({ rank: 'JOKER', suit: null }));
    if (game.openCard) openSlot.appendChild(cardEl(game.openCard));

    if (startSeqTimer) { clearTimeout(startSeqTimer); startSeqTimer = null; }
    startSeqTimer = setTimeout(() => {
      overlay.classList.add('hidden');
      startSeqTimer = null;
    }, revealMs || 5000);
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
    if (!name) return setLandingError('Enter your name (పేరు రాయండి)');
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
    if (!name) return setLandingError('Enter your name (పేరు రాయండి)');
    if (!roomCode) return setLandingError('Enter room code (రూమ్ కోడ్ రాయండి)');
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
      ? (room.players.length < 2 ? 'Need at least 2 players (కనీసం 2 మంది కావాలి)' : `Ready with ${room.players.length} players`)
      : 'Waiting for host to start (హోస్ట్ మొదలుపెట్టే వరకు వేచి ఉండండి)';
  }

  // ---------------- realistic card rendering ----------------
  function cardEl(card, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'card';
    if (card.rank === 'JOKER') {
      el.classList.add('joker');
      const stacked = '<span class="joker-letters">' +
        'J<br>O<br>K<br>E<br>R' +
        '</span>';
      el.innerHTML =
        `<div class="card-corner corner-tl">${stacked}</div>` +
        '<div class="card-center"><div class="joker-cap"></div></div>' +
        `<div class="card-corner corner-br">${stacked}</div>`;
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
    if (opts.wild) el.classList.add('wild-zero');
    return el;
  }

  function sortHand(hand) {
    return hand.slice().sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank));
  }

  // Groups same-rank cards into a single tile with a count badge, so a hand
  // of e.g. four 9s only takes up one card-slot of screen space. Rank '2' is
  // always kept as separate individual tiles since the +2 chain rule needs
  // playing exactly one 2 at a time.
  function groupHand(hand) {
    const groups = [];
    const byRank = new Map();
    hand.forEach((card) => {
      if (card.rank === '2') {
        groups.push({ rank: '2', cards: [card] });
        return;
      }
      let g = byRank.get(card.rank);
      if (!g) {
        g = { rank: card.rank, cards: [] };
        byRank.set(card.rank, g);
        groups.push(g);
      }
      g.cards.push(card);
    });
    return groups;
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
      const left = 50 + 43 * Math.cos(angle);
      const top = 50 + 43 * Math.sin(angle);

      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      if (game && !game.roundOver && game.currentPlayer === p.playerId) seatEl.classList.add('active');
      if (game && game.eliminated && game.eliminated.includes(p.playerId)) seatEl.classList.add('eliminated');
      if (game && game.quit && game.quit.includes(p.playerId)) seatEl.classList.add('quit');
      seatEl.style.left = left + '%';
      seatEl.style.top = top + '%';

      const count = game && game.handCounts ? game.handCounts[p.playerId] : undefined;
      const score = game && game.scores ? (game.scores[p.playerId] ?? 0) : 0;

      // Every seat (opponent or you) renders the exact same single chip:
      // name on top, "N cards · M pts" below. No extra icon on top of it,
      // so every seat looks identical regardless of position on the table.
      seatEl.innerHTML =
        '<div class="seat-chip">' +
        `<div class="seat-name">${escapeHtml(p.name)}${p.playerId === myPlayerId ? ' (You)' : ''}</div>` +
        `<div class="seat-meta">${count !== undefined ? count + ' cards · ' : ''}${score} pts</div>` +
        '</div>';

      const reaction = seatReactions[p.playerId];
      if (reaction) {
        const elapsed = Date.now() - reaction.startedAt;
        if (elapsed < REACTION_TOTAL_MS) {
          const bubble = document.createElement('div');
          bubble.className = 'seat-emoji-bubble';
          bubble.textContent = reaction.emoji;
          bubble.style.animationDelay = (-elapsed) + 'ms';
          seatEl.appendChild(bubble);
        } else {
          delete seatReactions[p.playerId];
        }
      }

      oval.appendChild(seatEl);
    });
  }

  socket.on('seat_reaction', ({ type, affectedPlayerId }) => {
    const rule = SEAT_REACTION_RULES[type];
    if (!rule || !latestRoom) return;
    if (rule.self) triggerSeatReaction(affectedPlayerId, rule.self);
    if (rule.others) {
      latestRoom.players.forEach((p) => {
        if (p.playerId !== affectedPlayerId) triggerSeatReaction(p.playerId, rule.others);
      });
    }
  });

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

  // Renders one row of grouped-card tiles (used for both the normal hand
  // row and the separate joker/wild row) into the given container.
  function renderHandTiles(container, groups, isMyTurn, game, duringChain) {
    container.innerHTML = '';
    const wildRank = game.roundJokerRank;
    groups.forEach((g) => {
      const rep = g.cards[0];
      let selectable = isMyTurn && !game.roundOver;
      if (duringChain) selectable = selectable && g.rank === '2';
      const allSelected = g.cards.every((c) => selectedIds.has(c.id));
      const isWild = rep.rank !== 'JOKER' && wildRank && rep.rank === wildRank;
      const el = cardEl(rep, { selectable, selected: allSelected, wild: isWild });
      if (g.cards.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'card-count-badge';
        badge.textContent = '×' + g.cards.length;
        el.appendChild(badge);
      }
      if (selectable) {
        el.onclick = duringChain ? () => submitChainTwo(rep) : () => toggleSelectGroup(g);
      }
      container.appendChild(el);
    });
  }

  // ---------------- main game rendering ----------------
  function renderGame(game) {
    // The host's "Next Round" click only hides the round-result popup on
    // their own screen. Everyone else keeps seeing it (blocking the table
    // underneath, which HAS actually updated) until they manually refresh.
    // Once a live round is confirmed in progress, force it closed for everyone.
    if (!game.roundOver) {
      document.getElementById('overlay-round-result').classList.add('hidden');
    }

    document.getElementById('round-info').textContent = `Round ${game.roundNumber}`;

    const isMyTurn = game.currentPlayer === myPlayerId;
    const currentName = playerName(game.currentPlayer);
    document.getElementById('turn-info').textContent = game.roundOver
      ? 'Round Over'
      : (isMyTurn ? 'Your turn! (మీ వంతు)' : `${currentName}'s turn... (వంతు)`);

    updateTurnTimerDisplay(game.roundOver ? null : game.turnDeadline);
    renderOvalTable(game);

    document.getElementById('stock-count').textContent = game.stockCount;
    const openSlot = document.getElementById('open-card-slot');
    openSlot.innerHTML = '';
    if (game.openCard) openSlot.appendChild(cardEl(game.openCard));

    // Show the round's wild rank as an actual mini card, same treatment as
    // the Open Card, instead of bare text -- no suit, gold border to mark
    // it as "worth 0 this round" (matches the wild-card highlight in hand).
    const jokerSlot = document.getElementById('joker-indicator');
    jokerSlot.innerHTML = '';
    if (game.roundJokerRank) {
      jokerSlot.appendChild(cardEl({ rank: game.roundJokerRank, suit: null }, { wild: true }));
    } else {
      jokerSlot.appendChild(cardEl({ rank: 'JOKER', suit: null }));
    }

    // The +2 chain status is now visible to EVERYONE at the table (not just
    // whoever must respond), so the whole table can follow the drama. Only
    // the player actually facing the chain gets the "Take Penalty" button.
    const duringChain = game.chainCount > 0;
    const chainBanner = document.getElementById('chain-banner');
    const showChain = duringChain && !game.roundOver;
    chainBanner.classList.toggle('hidden', !showChain);
    if (showChain) {
      const respondingName = isMyTurn ? 'You (మీరు)' : currentName;
      document.getElementById('chain-banner-text').textContent =
        `🔥 +2 Chain! ${respondingName} must play a 2 or draw ${game.chainCount * 2} cards`;
      document.getElementById('penalty-count').textContent = game.chainCount * 2;
      document.getElementById('btn-take-penalty').classList.toggle('hidden', !isMyTurn);
    }

    const handValue = game.yourHandValue ?? 0;
    document.getElementById('hand-value').textContent = handValue;
    const hand = sortHand(game.yourHand || []);
    const groups = groupHand(hand);

    // Cards worth 0 this round (actual Jokers, and this round's wild rank)
    // get pulled into their own private row so you can spot them at a
    // glance -- opponents never see this breakdown, only your total card count.
    const wildRank = game.roundJokerRank;
    const isWildGroup = (g) => g.rank === 'JOKER' || (wildRank && g.rank === wildRank);
    const jokerGroups = groups.filter(isWildGroup);
    const normalGroups = groups.filter((g) => !isWildGroup(g));

    document.getElementById('hand-jokers-row').classList.toggle('hidden', jokerGroups.length === 0);
    renderHandTiles(document.getElementById('hand-jokers'), jokerGroups, isMyTurn, game, duringChain);
    renderHandTiles(document.getElementById('hand'), normalGroups, isMyTurn, game, duringChain);

    const discardBtn = document.getElementById('btn-discard');
    const declareBtn = document.getElementById('btn-declare');
    // Declaring is blocked only while a +2 chain is actively pending
    // (duringChain) -- not just because the open card happens to show a 2.
    // The chain-banner already explains that case, so no separate hint needed.
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

  // Selecting a grouped tile selects/deselects every card in that rank-group
  // together (they're always discarded as a set anyway, matching-rank or not).
  function toggleSelectGroup(group) {
    const allSelected = group.cards.every((c) => selectedIds.has(c.id));
    if (allSelected) {
      group.cards.forEach((c) => selectedIds.delete(c.id));
    } else {
      const firstId = [...selectedIds][0];
      if (firstId) {
        const firstCard = (latestGame.yourHand || []).find((c) => c.id === firstId);
        if (firstCard && firstCard.rank !== group.rank) selectedIds.clear();
      }
      group.cards.forEach((c) => selectedIds.add(c.id));
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
    // The declarer's own penalty is no longer always a flat 75 (a tied
    // wrong declare now costs just their own hand value) -- show whatever
    // it actually was instead of hardcoding the old flat number.
    const declarerScore = r.roundScores[r.declaredBy];
    const title = r.correct
      ? `${playerName(r.declaredBy)} correctly declared Least Count!`
      : `${playerName(r.declaredBy)} declared wrong! (+${declarerScore} penalty)`;
    document.getElementById('round-result-title').textContent = title;

    // Declare emojis show here (not at a seat) since the game redirects to
    // this screen almost instantly after a declare -- a seat reaction
    // would barely be visible before getting covered by this overlay.
    const emojiEl = document.getElementById('round-result-emoji');
    emojiEl.textContent = r.correct ? '🎉' : '😬';
    emojiEl.style.animation = 'none';
    void emojiEl.offsetWidth;
    emojiEl.style.animation = 'scoreCardEmojiPop 3.4s ease 1 both';

    const body = document.getElementById('round-result-body');
    body.innerHTML = '';
    Object.keys(r.values).forEach((pid) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      // This round's score change is the whole point of this screen -- make
      // it visually pop (same gold badge used on the final gameover screen)
      // instead of blending in with the value/total text around it.
      row.innerHTML = `<span>${escapeHtml(playerName(pid))}</span><span>value ${r.values[pid]} · <span class="final-round-delta">+${r.roundScores[pid]}</span> pts · total ${game.scores[pid]}</span>`;
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

  // ---------------- confetti celebration (item 7) ----------------
  // Pure canvas + requestAnimationFrame, no external library or assets --
  // a burst of colored rectangles falling with gravity and a little spin,
  // fading out near the end. Fires once when the game-over screen appears.
  let confettiRunning = false;
  function launchConfetti() {
    if (confettiRunning) return;
    const canvas = document.getElementById('confetti-canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    confettiRunning = true;
    canvas.classList.remove('hidden');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#d4a017', '#ffcb6b', '#1e5631', '#9fd8b8', '#ffffff', '#c0392b'];
    const pieces = Array.from({ length: 140 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 10,
      vx: -1.5 + Math.random() * 3,
      vy: 2 + Math.random() * 3,
      rot: Math.random() * Math.PI * 2,
      vrot: -0.2 + Math.random() * 0.4,
      color: colors[Math.floor(Math.random() * colors.length)],
    }));

    const durationMs = 3200;
    const startedAt = Date.now();

    function frame() {
      const elapsed = Date.now() - startedAt;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (elapsed >= durationMs) {
        canvas.classList.add('hidden');
        confettiRunning = false;
        return;
      }
      const fadeStart = durationMs - 500;
      const alpha = elapsed > fadeStart ? Math.max(0, 1 - (elapsed - fadeStart) / 500) : 1;
      ctx.globalAlpha = alpha;
      pieces.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.03;
        p.rot += p.vrot;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function showGameOver(game) {
    document.getElementById('overlay-round-result').classList.add('hidden');
    document.getElementById('gameover-title').textContent = `🏆 ${playerName(game.winner)} wins!`;
    const body = document.getElementById('gameover-body');
    body.innerHTML = '';
    // The final round's score change is what actually ended the game --
    // call it out distinctly (a dedicated banner, not just a small inline
    // badge easy to miss) next to each player's cumulative total.
    const lastRoundScores = (game.lastRoundResult && game.lastRoundResult.roundScores) || {};
    const hasDeltas = Object.keys(lastRoundScores).length > 0;
    if (hasDeltas) {
      const banner = document.createElement('div');
      banner.className = 'final-round-banner';
      const parts = Object.entries(lastRoundScores).map(([pid, delta]) =>
        `${escapeHtml(playerName(pid))} <b>+${delta}</b>`
      );
      banner.innerHTML = `<div class="final-round-banner-label">Final round</div><div>${parts.join(' &nbsp;·&nbsp; ')}</div>`;
      body.appendChild(banner);
    }
    Object.entries(game.scores).sort((a,b) => a[1]-b[1]).forEach(([pid, score]) => {
      const row = document.createElement('div');
      row.className = 'result-row' + (pid === game.winner ? ' winner-row' : '');
      const delta = lastRoundScores[pid];
      const deltaHtml = delta !== undefined
        ? `<span class="final-round-delta">+${delta}</span> this round · `
        : '';
      row.innerHTML = `<span>${escapeHtml(playerName(pid))}</span><span>${deltaHtml}${score} pts total</span>`;
      body.appendChild(row);
    });
    const isHost = latestRoom && latestRoom.hostPlayerId === myPlayerId;
    document.getElementById('btn-new-game').classList.toggle('hidden', !isHost);
    document.getElementById('gameover-hint').textContent = isHost ? '' : 'Waiting for host to start a new game...';
    document.getElementById('overlay-gameover').classList.remove('hidden');
    launchConfetti();
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
      container.innerHTML = '<div class="chat-empty">No messages yet (ఇంకా మెసేజ్‌లు లేవు)</div>';
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

  // ---------------- +2 chain flash notification ----------------
  // A brief, table-wide toast every time a 2 lands, the chain escalates, or
  // someone takes the penalty instead -- so this moment is visible and fun
  // for everyone, not just whoever's turn it currently is.
  let chainFlashTimeout = null;
  function showChainFlash(text) {
    const el = document.getElementById('chain-flash');
    el.textContent = text;
    el.classList.remove('hidden');
    // restart the pop-in animation even if a flash is already showing
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    if (chainFlashTimeout) clearTimeout(chainFlashTimeout);
    chainFlashTimeout = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function checkChainFlash(prev, game) {
    // Skip across a round boundary -- if a fresh round happens to deal a 2
    // as the opening card, that's the shuffle's doing, not a real play by
    // whoever's stale "prev.currentPlayer" happened to be from last round.
    if (!prev || prev.roundNumber !== game.roundNumber) return;
    // The player who just acted is whoever's turn it was a moment ago --
    // the new currentPlayer is whoever must respond next.
    const actor = playerName(prev.currentPlayer);
    if (game.chainCount > 0 && prev.chainCount === 0) {
      showChainFlash(`🔥 ${actor} played a 2! Draw ${game.chainCount * 2} or answer with a 2`);
    } else if (game.chainCount > prev.chainCount && prev.chainCount > 0) {
      showChainFlash(`🔥🔥 ${actor} stacked another 2! Now +${game.chainCount * 2}`);
    } else if (game.chainCount === 0 && prev.chainCount > 0) {
      showChainFlash(`${actor} took the +${prev.chainCount * 2} penalty. Back to normal!`);
    }
  }

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
    // The stock ran out and got reshuffled from the discard pile -- public
    // event, so play it for every player at the table, not just whoever drew.
    if (prev.roundNumber === game.roundNumber && game.reshuffleCount > (prev.reshuffleCount || 0)) {
      Sound.reshuffle();
    }
  }

  // ---------------- drawn-card reveal ----------------
  // Shows exactly which card(s) a player just drew as a penalty, face-up, for
  // a couple of seconds -- so they get that little moment of joy/disappointment
  // before it just quietly joins their hand.
  let drawRevealTimeout = null;
  function showDrawReveal(cards) {
    if (!cards || cards.length === 0) return;
    Sound.penaltyDraw(cards.length);
    const overlay = document.getElementById('draw-reveal');
    const container = document.getElementById('draw-reveal-cards');
    const label = document.getElementById('draw-reveal-label');
    label.textContent = cards.length > 1
      ? `You drew ${cards.length} cards (మీకు ${cards.length} కార్డులు వచ్చాయి)`
      : 'You drew (మీకు వచ్చింది)';
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
  function syncWithServer() {
    if (!myRoomCode || !myPlayerId) return;
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

  socket.on('connect', syncWithServer);

  // Mobile browsers aggressively suspend background tabs, which can silently
  // drop or stall the socket connection without the UI ever noticing. When
  // the tab becomes visible again, force a fresh state sync so nobody has to
  // manually reload the page mid-game.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (socket.connected) {
        syncWithServer();
      } else {
        socket.connect();
        // 'connect' handler above will run syncWithServer() once reconnected.
      }
    }
  });

  // Some mobile browsers fire 'pageshow' (e.g. returning via back-forward
  // cache) without a matching visibilitychange - cover that path too.
  window.addEventListener('pageshow', () => {
    if (document.visibilityState === 'visible') syncWithServer();
  });

  // ---------------- connection watchdog ----------------
  // Mobile connections can go "zombie": the browser still thinks the socket
  // is connected, but it has actually stopped delivering anything (common
  // when the OS briefly throttles the network in the background). No
  // 'disconnect' event fires in that case, so nothing above ever kicks in,
  // and the screen just quietly goes stale until the page is manually
  // reloaded. This checks every few seconds that the connection is truly
  // alive (a real server round-trip, not just the client's belief about it)
  // and forces a hard reconnect if it isn't -- self-healing, no refresh needed.
  let watchdogAwaitingAck = false;
  setInterval(() => {
    if (!myRoomCode || !myPlayerId || watchdogAwaitingAck) return;
    watchdogAwaitingAck = true;
    const bail = setTimeout(() => {
      if (!watchdogAwaitingAck) return;
      watchdogAwaitingAck = false;
      socket.disconnect();
      socket.connect();
    }, 4000);
    socket.emit('rejoin', { roomCode: myRoomCode, playerId: myPlayerId }, () => {
      // A fresh room_update/game_state has already been emitted by the
      // server as a side effect of this rejoin -- just confirms we're alive.
      watchdogAwaitingAck = false;
      clearTimeout(bail);
    });
  }, 7000);

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

  let lastStartRevealMs = 5000;
  socket.on('game_starting', (data) => {
    lastStartRevealMs = data.revealMs || 5000;
    showScreen('screen-game');
    runStartSequence(data);
  });

  socket.on('game_state', (game) => {
    const prev = latestGame;
    // Skip the normal sound/flash reactions for the very first state of a
    // fresh round (no meaningful "previous" state to diff against yet), and
    // don't let a stale error/selection check misfire during the reveal.
    if (!pendingStartReveal) {
      playSoundsForTransition(prev, game);
      checkChainFlash(prev, game);
    }
    latestGame = game;
    // Once the turn (or round) has actually moved on, any error message or
    // card selection left over from a previous failed attempt is stale --
    // clear both so they don't linger on screen through later turns.
    if (!prev || prev.currentPlayer !== game.currentPlayer || prev.roundNumber !== game.roundNumber) {
      selectedIds = new Set();
      setGameError('');
    }
    showScreen('screen-game');
    renderGame(game);

    if (pendingStartReveal) {
      pendingStartReveal = false;
      showStartReveal(game, lastStartRevealMs);
    }
  });

  socket.on('error_message', (data) => setGameError(data.message));

  // initial screen
  if (!(myRoomCode && myPlayerId)) {
    showScreen('screen-landing');
  }
})();
