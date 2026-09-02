(function () {
  const socket = io();

  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const RED_SUITS = new Set(['H', 'D']);
  const RANK_ORDER = ['A','2','3','4','5','6','7','8','9','10','J','Q','K','JOKER'];

  let session = JSON.parse(localStorage.getItem('leastcount_session') || 'null');
  let myPlayerId = session ? session.playerId : null;
  let myRoomCode = session ? session.roomCode : null;

  // Players this device has chosen to mute -- local only, resets on reload,
  // never sent to the server. Hides both their chat panel messages and their
  // seat speech-bubbles for the rest of this session.
  const mutedPlayerIds = new Set();
  function isMuted(playerId) { return mutedPlayerIds.has(playerId); }

  // ---------------- Firebase account status (wiring check only) ----------------
  // No UI or game behavior changes yet -- this just confirms firebase-init.js
  // loaded and Firebase Auth is connected, logged to the console so it's easy
  // to verify. A real "Sign in with Google" button and Firestore-backed
  // stats/purchases come in a later step.
  if (window.LCAuth) {
    window.LCAuth.onUserChange((user) => {
      if (user) {
        console.log(`[Firebase] signed in as ${user.uid}${user.isAnonymous ? ' (anonymous/guest)' : ' (Google account)'}`);
      } else {
        console.log('[Firebase] no user yet, signing in...');
      }
      updateSigninUI(user);
      maybeUseGoogleDisplayName(user);
    });
  } else {
    console.warn('[Firebase] LCAuth not found -- check that firebase-init.js loaded before app.js.');
  }

  // If someone signs in with Google and has never typed/saved a name here
  // before, use their Google account name as a starting point instead of
  // leaving the field blank -- they can still change it, this is just a
  // sensible default so "enter your name" isn't the very first thing a
  // signed-in user hits. Never overwrites a name they already typed/saved
  // (that always wins). Inlines the storage key rather than referencing
  // NAME_STORAGE_KEY (declared further down) since this callback can in
  // principle fire before that line runs.
  function maybeUseGoogleDisplayName(user) {
    if (!user || user.isAnonymous || !user.displayName) return;
    const nameInput = document.getElementById('input-name');
    if (!nameInput) return;
    const alreadySaved = localStorage.getItem('leastcount_name');
    if (alreadySaved || nameInput.value.trim()) return;
    nameInput.value = user.displayName;
    localStorage.setItem('leastcount_name', user.displayName);
  }

  // Current Firebase uid (if any), sent along with create/join so the server
  // can link a room seat to a real account and later record stats against
  // it. Safe to call anytime -- returns null before sign-in has finished,
  // in which case that player's games just won't have stats saved (same as
  // any guest who never gets linked to an account).
  function currentFirebaseUid() {
    const user = window.LCAuth && window.LCAuth.getUser();
    return user ? user.uid : null;
  }

  // Short-lived Firebase ID token, sent instead of the raw uid on every
  // create/join/stats call. The server independently verifies this itself
  // (admin.auth().verifyIdToken()) instead of trusting whatever uid a client
  // claims -- sending the uid string alone would let anyone who opens dev
  // tools type in someone else's real uid and have stats/results attributed
  // to that stranger's account. Resolves to null before sign-in has
  // finished, same as currentFirebaseUid() above -- the server treats that
  // the same as any other guest whose account isn't linked yet.
  async function currentFirebaseIdToken() {
    const user = window.LCAuth && window.LCAuth.getUser();
    if (!user) return null;
    try {
      return await user.getIdToken();
    } catch (e) {
      console.warn('[Firebase] Failed to get ID token:', e.message);
      return null;
    }
  }

  // Thin, always-safe wrapper around window.LCAnalytics.log -- so every call
  // site below doesn't need its own existence check. A handful of funnel
  // events only (room created/joined, solo game started, game completed,
  // player reported) -- not every click, just enough to see whether the app
  // is actually growing and where people drop off.
  function logAnalytics(name, params) {
    if (window.LCAnalytics) window.LCAnalytics.log(name, params);
  }

  // ---------------- optional Google sign-in (non-blocking) ----------------
  // Small status line + button on the landing screen only. A guest can keep
  // playing without ever touching this -- it's purely an upgrade path so
  // their stats can follow them to another device later, via the same
  // linkWithPopup() flow in firebase-init.js that preserves their uid.
  const googleSigninBtn = document.getElementById('btn-google-signin');
  const signinStatusEl = document.getElementById('signin-status');

  function updateSigninUI(user) {
    if (!googleSigninBtn || !signinStatusEl) return;
    if (user && !user.isAnonymous) {
      const label = user.displayName || user.email || 'Google account';
      signinStatusEl.textContent = `Signed in as ${label}`;
      googleSigninBtn.classList.add('hidden');
    } else {
      signinStatusEl.textContent = 'Playing as Guest';
      googleSigninBtn.classList.remove('hidden');
    }
  }

  if (googleSigninBtn) {
    googleSigninBtn.onclick = async () => {
      googleSigninBtn.disabled = true;
      googleSigninBtn.textContent = 'Signing in...';
      // TEMPORARY instrumentation block (debugging native-app sign-in "shows
      // nothing" report, Sept 2026) -- two things were true before this:
      // (1) any error was caught and only console.warn'd, invisible without
      // a USB debugger attached to the phone; (2) if the native call never
      // resolves OR rejects at all (e.g. a WebView-blocked popup that just
      // sits there forever, which is what happens if the native Capacitor
      // Firebase plugin isn't actually wired into this build), there'd be no
      // error to even catch -- the button would just silently sit on
      // "Signing in..." forever with nothing to look at. The timeout race
      // below turns THAT case into a visible message too. Safe to remove
      // once the native sign-in issue is confirmed fixed.
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT: no response from Google sign-in after 15s -- the native call likely never started (plugin not registered in this build?) rather than failing outright.')), 15000)
      );
      try {
        await Promise.race([window.LCAuth.signInWithGoogle(), timeout]);
      } catch (e) {
        // Most common cases: the user closed the Google popup, or the
        // browser blocked it -- neither is a real error worth alarming
        // anyone over, just let them try again.
        console.warn('[Firebase] Google sign-in did not complete:', e.message);
        if (signinStatusEl) {
          signinStatusEl.textContent = `Sign-in failed: ${e.code || 'no code'} - ${e.message || e}`;
        }
      } finally {
        googleSigninBtn.disabled = false;
        googleSigninBtn.textContent = 'Sign in with Google';
      }
    };
  }

  // ---------------- "My Stats" (own games played / wins) ----------------
  // Reads the same `users` Firestore doc recordGameResult() already writes
  // to -- this button just exposes it. Works for guests too (they already
  // accumulate stats on this device once anonymous sign-in finishes), not
  // only Google-linked accounts.
  const myStatsBtn = document.getElementById('btn-my-stats');
  if (myStatsBtn) {
    myStatsBtn.onclick = async () => {
      const body = document.getElementById('my-stats-body');
      body.innerHTML = '<p class="hint">Loading...</p>';
      document.getElementById('overlay-my-stats').classList.remove('hidden');
      const uid = currentFirebaseUid();
      if (!uid) {
        body.innerHTML = '<p class="hint">Still signing you in -- try again in a second.</p>';
        return;
      }
      const firebaseIdToken = await currentFirebaseIdToken();
      socket.emit('get_my_stats', { firebaseIdToken }, (res) => {
        if (!res || !res.ok) {
          body.innerHTML = `<p class="error">${escapeHtml((res && res.error) || 'Could not load stats.')}</p>`;
          return;
        }
        const { gamesPlayed, wins } = res.stats;
        const winRate = gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 100) : 0;
        body.innerHTML =
          `<div class="result-row"><span>Games played</span><span>${gamesPlayed}</span></div>` +
          `<div class="result-row"><span>Wins</span><span>${wins}</span></div>` +
          `<div class="result-row"><span>Win rate</span><span>${winRate}%</span></div>` +
          (gamesPlayed === 0 ? '<p class="hint">Play a game to start building your stats!</p>' : '');
      });
    };
  }
  const closeMyStatsBtn = document.getElementById('btn-close-my-stats');
  if (closeMyStatsBtn) {
    closeMyStatsBtn.onclick = () => document.getElementById('overlay-my-stats').classList.add('hidden');
  }

  // ---------------- Remove Ads purchase (native app only) ----------------
  // Reads whatever RevenueCat offering/package is configured server-side
  // (see revenuecat-init.js) rather than hardcoding a product id here, so
  // swapping from the Test Store to the real Play Store product later needs
  // no changes on this side -- just the API key.
  let adsRemoved = false;
  const removeAdsBtn = document.getElementById('btn-remove-ads');

  async function refreshRemoveAdsUI() {
    if (!removeAdsBtn || !window.LCPurchases || !window.LCPurchases.isReady()) return;
    try {
      // Make sure RevenueCat has finished switching identity to the current
      // Firebase uid before checking entitlements -- identify() is kicked
      // off separately (fire-and-forget) from firebase-init.js, so without
      // this the check can race ahead and run against the wrong (default
      // anonymous) customer right after a fresh app launch, wrongly
      // reporting "not purchased" even though it was.
      if (window.LCPurchases.whenIdentified) await window.LCPurchases.whenIdentified();
      // NOTE: confirmed directly from a live customerInfo response --
      // entitlements.active is keyed by "remove ads" (with a literal space
      // in it, since that's exactly how the entitlement's identifier was
      // typed when it was created in the RevenueCat dashboard). Not
      // "removeads" (that's actually the PRODUCT's identifier, a separate
      // resource) and not "remove_ads" -- this exact string, space and all.
      adsRemoved = await window.LCPurchases.isEntitled('remove ads');
    } catch (e) {
      adsRemoved = false;
    }
    if (adsRemoved) {
      removeAdsBtn.classList.add('hidden');
      if (window.LCAds) window.LCAds.hideBanner();
    } else {
      removeAdsBtn.classList.remove('hidden');
    }
  }

  if (removeAdsBtn) {
    removeAdsBtn.onclick = async () => {
      if (!window.LCPurchases) return;
      removeAdsBtn.disabled = true;
      const originalLabel = removeAdsBtn.textContent;
      removeAdsBtn.textContent = 'Please wait...';
      try {
        const offering = await window.LCPurchases.getOfferings();
        const pkg = offering && offering.availablePackages && offering.availablePackages[0];
        if (!pkg) {
          alert('Remove Ads is not available right now -- please try again later.');
          return;
        }
        await window.LCPurchases.purchasePackage(pkg);
        adsRemoved = true;
        removeAdsBtn.classList.add('hidden');
        if (window.LCAds) window.LCAds.hideBanner();
        if (window.LCAnalytics) window.LCAnalytics.log('ads_removed_purchase');
        alert('Ads removed -- thanks for supporting Least Count!');
      } catch (e) {
        // Most common case: the player backed out of the purchase sheet --
        // not a real error worth alarming anyone over.
        if (!(e && (e.userCancelled || e.code === 'PURCHASE_CANCELLED'))) {
          console.warn('[RevenueCat] purchase failed:', e && e.message);
          alert('Something went wrong with the purchase. Please try again.');
        }
      } finally {
        removeAdsBtn.disabled = false;
        removeAdsBtn.textContent = originalLabel;
      }
    };
  }

  // Re-check whenever the signed-in Firebase user becomes known (guest or
  // Google) -- this is what actually triggers RevenueCat's identify() call
  // over in firebase-init.js, so checking here (rather than after a fixed
  // delay) means we're never checking entitlements before that's fired.
  // Safe no-op on the regular website either way, since
  // LCPurchases.isReady() just stays false there.
  if (window.LCAuth) {
    window.LCAuth.onUserChange(() => refreshRemoveAdsUI());
  }
  // Fallback in case LCAuth's user was already known before this file ran.
  setTimeout(refreshRemoveAdsUI, 1500);

  let latestRoom = null;
  let latestGame = null;
  let selectedIds = new Set();
  let chatUnread = 0;
  let timerInterval = null;

  // ---- "Help me play" (bots-mode-only assist) ----
  const HELP_EVER_USED_KEY = 'leastcount_help_ever_used';
  let currentHint = null; // { type, cardIds, reason } for whoever's turn it currently is
  let hintTurnKey = null; // identifies which turn currentHint belongs to, so it clears on turn change

  // Fixed max-score choices offered to the host, both at game creation and
  // again after every round (mirrors MAX_SCORE_OPTIONS in game/gameLogic.js --
  // the server independently validates against its own copy of this list).
  const MAX_SCORE_OPTIONS = [100, 150, 200, 250, 300, 350, 400, 450, 500];
  const DEFAULT_MAX_SCORE = 200;

  // Fills a <select> with every option strictly greater than minExclusive
  // (plus the current value even if it wouldn't otherwise qualify, so the
  // dropdown always has something sensible pre-selected).
  function populateMaxScoreSelect(selectEl, currentValue, minExclusive) {
    selectEl.innerHTML = '';
    MAX_SCORE_OPTIONS.filter((v) => v > minExclusive || v === currentValue).forEach((v) => {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = String(v);
      // Intentionally NOT relying on opt.selected here (see selectEl.value
      // below) -- setting .selected on an <option> before it's attached to
      // the DOM is unreliable on some Android WebView versions: it can
      // silently fail to stick, leaving the <select> defaulting to its
      // FIRST option instead. That's the actual root cause behind "I set
      // max score to 250, and next round it's back to 200" -- 200 just
      // happened to be the first surviving option in the filtered list at
      // whatever score range the board was in when the bug was reported,
      // not a value anyone actually chose or that the server reverted to.
      selectEl.appendChild(opt);
    });
    // Authoritative, WebView-safe way to set the selection: assign the
    // <select>'s own .value AFTER every <option> is already attached. This
    // works consistently everywhere, unlike per-option .selected above.
    selectEl.value = String(currentValue);
    syncDropdown(selectEl);
  }

  // ---------------- custom themed dropdown (replaces native <select> UI) ----------------
  // The underlying <select> stays in the DOM and fully functional -- every
  // existing call site above keeps reading/writing its .value and rebuilding
  // its <option> children exactly as before. This only adds a themed
  // button+list on top that mirrors it, so the browser's own native popup
  // (white background, system font -- can't be restyled to match the app)
  // never has to appear. Call syncDropdown(select) after anything changes
  // the select's value/options from code, since a plain `.value = x`
  // assignment fires no DOM event this could otherwise hook into.
  const dropdownWraps = new Map(); // selectEl -> { syncLabel }

  function initDropdown(selectId) {
    const select = document.getElementById(selectId);
    if (!select || dropdownWraps.has(select)) return;

    const wrap = document.createElement('div');
    wrap.className = 'dd';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('dd-native-select');
    select.tabIndex = -1;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dd-toggle';
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span class="dd-value"></span><svg class="dd-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    wrap.appendChild(toggle);

    const list = document.createElement('ul');
    list.className = 'dd-list hidden';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);

    const valueSpan = toggle.querySelector('.dd-value');
    const isOpen = () => !list.classList.contains('hidden');
    const closeList = () => { list.classList.add('hidden'); toggle.setAttribute('aria-expanded', 'false'); };
    const syncLabel = () => {
      const opt = select.options[select.selectedIndex];
      valueSpan.textContent = opt ? opt.textContent : '';
    };

    function buildList() {
      list.innerHTML = '';
      Array.from(select.options).forEach((opt) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.tabIndex = -1;
        li.dataset.value = opt.value;
        li.textContent = opt.textContent;
        if (opt.value === select.value) li.setAttribute('aria-selected', 'true');
        li.addEventListener('click', () => {
          select.value = opt.value;
          select.dispatchEvent(new Event('change'));
          syncLabel();
          closeList();
          toggle.focus();
        });
        list.appendChild(li);
      });
    }
    function openList() {
      buildList();
      list.classList.remove('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      const active = list.querySelector('[aria-selected="true"]') || list.firstElementChild;
      if (active) active.focus();
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      isOpen() ? closeList() : openList();
    });
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      } else if (e.key === 'Escape') {
        closeList();
      }
    });
    list.addEventListener('keydown', (e) => {
      const items = Array.from(list.children);
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement.click(); }
      else if (e.key === 'Escape') { closeList(); toggle.focus(); }
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) closeList();
    });

    syncLabel();
    dropdownWraps.set(select, { syncLabel });
  }

  function syncDropdown(selectEl) {
    const entry = dropdownWraps.get(selectEl);
    if (entry) entry.syncLabel();
  }

  // ---------------- your-turn visual pulse ----------------
  // A subtle pulsing highlight at YOUR OWN seat only -- never broadcast, never
  // shown at anyone else's seat -- that kicks in only after 5 seconds of your
  // own turn going by with no action. The existing sound cue still plays the
  // instant it becomes your turn; this is purely an additional, local nudge
  // for when that gets missed. No vibration (per explicit request -- players
  // rest their hands on the phone and constant buzzing would be irritating).
  const TURN_PULSE_DELAY_MS = 5000;
  let myTurnPulseTimer = null;
  let myTurnPulseActive = false;

  function updateMyTurnPulseTimer(prev, game) {
    const isMyActiveTurn = game.currentPlayer === myPlayerId && !game.roundOver;
    const turnJustChanged = !prev || prev.currentPlayer !== game.currentPlayer || prev.roundNumber !== game.roundNumber;
    if (isMyActiveTurn) {
      if (turnJustChanged) {
        if (myTurnPulseTimer) clearTimeout(myTurnPulseTimer);
        myTurnPulseActive = false;
        myTurnPulseTimer = setTimeout(() => {
          myTurnPulseActive = true;
          renderOvalTable(latestGame);
        }, TURN_PULSE_DELAY_MS);
      }
    } else {
      if (myTurnPulseTimer) { clearTimeout(myTurnPulseTimer); myTurnPulseTimer = null; }
      myTurnPulseActive = false;
    }
  }

  // ---------------- chat speech bubbles at the sender's seat ----------------
  // playerId -> { type, text, gifUrl, startedAt, durationMs }. Shown IN
  // ADDITION to the separate chat panel (unchanged), for 5-10s scaled by
  // message length (GIFs get a flat mid-range duration).
  const chatBubbles = {};
  function triggerChatBubble(playerId, msg) {
    const isGif = msg.type === 'gif';
    const lengthFactor = isGif ? 30 : (msg.text || '').length;
    const durationMs = Math.max(5000, Math.min(10000, 5000 + lengthFactor * 80));
    const startedAt = Date.now();
    chatBubbles[playerId] = { type: msg.type, text: msg.text, gifUrl: msg.gifUrl, startedAt, durationMs };
    renderOvalTable(latestGame);
    setTimeout(() => {
      if (chatBubbles[playerId] && chatBubbles[playerId].startedAt === startedAt) {
        delete chatBubbles[playerId];
        renderOvalTable(latestGame);
      }
    }, durationMs + 60);
  }

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

  // Sound toggle button was removed from the game screen's top bar by
  // request; Sound.isMuted()/setMuted() are still available if a toggle is
  // reintroduced elsewhere later.

  // ---------------- screen management ----------------
  function showScreen(id) {
    // Captured BEFORE we touch any classList below -- this is the only way
    // to tell "genuinely just arrived at the game screen" apart from
    // "already there, this is just a routine re-render". The latter matters
    // a lot: showScreen('screen-game') isn't called once per visit, it's
    // called on EVERY 'game_state' push from the server (every card played,
    // every bot move, every turn change -- see the socket.on('game_state')
    // handler far below), which happens continuously throughout a game.
    const alreadyOnGameScreen = document.getElementById('screen-game').classList.contains('active');
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    // The game screen locks the page to one viewport (no drag/scroll needed);
    // other screens (lobby, overlays) are allowed to scroll normally.
    document.body.classList.toggle('game-active', id === 'screen-game');
    // Banner ad (native Android app only -- see admob-init.js) shows on the
    // landing/lobby screens, where there's room for it, and hides during
    // actual gameplay, where every pixel of the single-viewport layout
    // already matters.
    if (window.LCAds) {
      // adsRemoved (see the Remove Ads purchase block above) overrides
      // everything else -- once someone's paid to remove ads, the banner
      // should never come back, on any screen.
      if (id === 'screen-game' || adsRemoved) window.LCAds.hideBanner();
      else window.LCAds.showBanner();
    }
    if (id === 'screen-game') {
      // BUG (found via live testing, Sept 2026): this used to reset
      // unconditionally on every call. Since a fresh game_state arrives
      // constantly during play, that meant: open chat, keyboard shrinks the
      // visible area, then the very next bot move calls showScreen('screen-
      // game') again -- which wiped the "no keyboard" baseline and replaced
      // it with the CURRENT keyboard-shrunk height, permanently baking the
      // squished table in as the new "normal" for the rest of that keyboard
      // session. That's what was actually causing the table/seats to visibly
      // collapse the moment chat was opened mid-game. Only reset when this
      // is a genuine fresh arrival at the game screen (from lobby, landing,
      // round-result, etc.) -- routine re-renders while already here must
      // leave the established baseline alone.
      if (!alreadyOnGameScreen) {
        maxViewportHeight = 0; // fresh baseline only on genuine entry
      }
      applyKeyboardSafeLayout();
    } else {
      // Leaving the game screen -- release the inline pixel height back to
      // CSS, since landing/lobby are meant to scroll normally and were never
      // part of this problem.
      document.body.style.height = '';
      const screenGameEl = document.getElementById('screen-game');
      if (screenGameEl) screenGameEl.style.height = '';
      const chatPanelEl = document.getElementById('chat-panel');
      if (chatPanelEl) chatPanelEl.style.bottom = '';
    }
  }

  // --------------------------------------------------------------------
  // Keyboard-safe game screen height. Neither CSS viewport units
  // (100vh/100dvh/100svh) nor the native Android windowSoftInputMode /
  // interactive-widget settings reliably stopped the on-screen keyboard
  // from shrinking the visible area on the actual test device -- both were
  // tried and confirmed still squishing the oval table. This sidesteps the
  // whole question of which browser/OS viewport mechanism the current
  // device happens to respect, by taking manual control via the
  // VisualViewport API instead (supported on Android Chrome/WebView since
  // 2017, far broader than the newer CSS-only tools):
  //   - Tracks the tallest visible height seen since the game screen opened
  //     -- that's "keyboard closed", since the keyboard only ever shrinks
  //     the visible area, never grows it past the real full-screen value.
  //   - Pins #screen-game and body to exactly that many pixels via inline
  //     style, which wins over any CSS vh/dvh/svh rule regardless of
  //     whether THIS device's browser/OS actually respects those units for
  //     the keyboard case.
  //   - Separately computes the keyboard's own height (baseline minus
  //     current visible height) to lift the chat panel above it, instead of
  //     relying on env(keyboard-inset-height) support.
  // --------------------------------------------------------------------
  let maxViewportHeight = 0;
  function applyKeyboardSafeLayout() {
    if (!window.visualViewport || !document.body.classList.contains('game-active')) return;
    const vv = window.visualViewport;
    maxViewportHeight = Math.max(maxViewportHeight, vv.height);

    document.body.style.height = maxViewportHeight + 'px';
    const screenGameEl = document.getElementById('screen-game');
    if (screenGameEl) screenGameEl.style.height = maxViewportHeight + 'px';

    const keyboardHeight = Math.max(0, Math.round(maxViewportHeight - vv.height));
    const chatPanelEl = document.getElementById('chat-panel');
    if (chatPanelEl) chatPanelEl.style.bottom = keyboardHeight + 'px';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyKeyboardSafeLayout);
  }
  // A genuine device rotation (not just the keyboard) should get a fresh
  // baseline instead of staying pinned to the previous orientation's height.
  window.addEventListener('orientationchange', () => {
    maxViewportHeight = 0;
    setTimeout(applyKeyboardSafeLayout, 300);
  });

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

    // The solid full-screen overlay is reserved for the joker/open-card
    // reveal step only -- during countdown + dealing, the real oval table
    // stays fully visible (cards fly to the actual chair positions), with
    // just a small floating badge for the "3-2-1" / "Dealing..." text.
    document.getElementById('overlay-start-sequence').classList.add('hidden');
    document.getElementById('start-seq-reveal').classList.add('hidden');

    const badge = document.getElementById('deal-phase-badge');
    const countdownEl = document.getElementById('start-seq-countdown');
    const dealingLabel = document.getElementById('deal-phase-label');
    badge.classList.remove('hidden');
    countdownEl.classList.remove('hidden');
    dealingLabel.classList.add('hidden');

    // Build the real seats now, in the actual turn order the server just
    // dealt this round with (see beginStartSequence in server.js), each
    // starting at 0 cards -- so the dealing animation has real chairs to fly
    // cards to instead of an abstract side panel.
    const dealOrderIds = (data.players || []).map((p) => p.playerId);
    renderOvalTable(null, dealOrderIds);
    document.getElementById('open-card-slot').innerHTML = '';
    document.getElementById('joker-indicator').innerHTML = '';
    document.getElementById('stock-count').textContent = '';
    document.getElementById('chain-banner').classList.add('hidden');
    document.getElementById('turn-timer').classList.add('hidden');
    // The player's own hand tray previously kept showing last round's cards
    // (whatever was left in it when that round ended) all the way through
    // the countdown and the entire dealing animation, since nothing ever
    // cleared it until the new hand actually arrived. Wipe it immediately so
    // no stale cards are visible while the new deal is in progress.
    document.getElementById('hand').innerHTML = '';
    document.getElementById('hand-jokers').innerHTML = '';
    document.getElementById('hand-jokers-row').classList.add('hidden');
    document.getElementById('hand-value').textContent = '0';
    selectedIds = new Set();
    document.getElementById('btn-discard').disabled = true;
    document.getElementById('btn-declare').disabled = true;

    const countdownMs = data.countdownMs || 3000;
    const introMs = data.introMs || 3400;
    const deckCount = data.deckCount || 2;
    const dealMs = data.dealMs || 1500;
    const steps = 3; // "3", "2", "1"
    const stepMs = countdownMs / steps;

    function showCountdownStep(n) {
      if (n <= 0) {
        countdownEl.classList.add('hidden');
        dealingLabel.classList.remove('hidden');
        runDeckIntro(deckCount, introMs, () => {
          animateDealing(data.players || [], dealMs, data.dealPasses || 13);
        });
        startSeqTimer = setTimeout(() => {
          // Countdown + intro + deal animation are all done. The board
          // itself will pop to life the instant the server's post-deal
          // game_state arrives (see pendingStartReveal handling below) --
          // we just flag that we're now waiting for it.
          pendingStartReveal = true;
        }, introMs + dealMs);
        return;
      }
      countdownEl.textContent = String(n);
      startSeqTimer = setTimeout(() => showCountdownStep(n - 1), stepMs);
    }
    showCountdownStep(steps);
  }

  // Pre-deal intro: places the real number of decks in play for this table
  // size (so players can reason about card-count probability -- item
  // requested after testers asked "how many decks are we even playing
  // with?"), then a riffle-merge shuffle, before handing off to the
  // existing, unchanged animateDealing() below. Purely visual -- the actual
  // shoe is already shuffled server-side; this never blocks real state.
  function runDeckIntro(deckCount, introMs, onDone) {
    const oval = document.getElementById('oval-table');
    const container = document.getElementById('deck-intro');
    // NOTE: this is a sibling function to runStartSequence, not nested
    // inside it -- runStartSequence's own local `dealingLabel` const is out
    // of scope here, so grab our own reference to the same element instead
    // of relying on that outer variable (a bug that previously threw a
    // ReferenceError the instant this function ran, silently skipping the
    // whole deck/shuffle animation on every single deal).
    const dealingLabel = document.getElementById('deal-phase-label');
    container.innerHTML = '';
    container.classList.remove('hidden');
    dealingLabel.textContent = deckCount === 1
      ? 'Setting up 1 deck...'
      : `Setting up ${deckCount} decks...`;
    dealingLabel.classList.remove('hidden');

    function tableCenter() {
      const r = oval.getBoundingClientRect();
      return { x: r.width / 2, y: r.height / 2 };
    }
    const center = tableCenter();
    let cancelled = false;
    const timers = [];
    const setT = (fn, ms) => { const t = setTimeout(() => { if (!cancelled) fn(); }, ms); timers.push(t); return t; };

    dealAnimationCancel = () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      container.innerHTML = '';
      container.classList.add('hidden');
    };

    // Step 1: decks drop in, fanned apart so the count is visible/countable,
    // then slide together into one spot.
    const decks = [];
    for (let i = 0; i < deckCount; i++) {
      const d = document.createElement('div');
      d.className = 'deck-stack';
      d.textContent = 'LC';
      const spread = (i - (deckCount - 1) / 2) * 46;
      d.style.left = (center.x - 20 + spread) + 'px';
      d.style.top = (center.y - 28) + 'px';
      container.appendChild(d);
      decks.push(d);
      setT(() => { d.style.opacity = '1'; d.style.transform = 'translateY(0) scale(1)'; }, 60 + i * 150);
    }
    setT(() => {
      decks.forEach((d) => { d.style.left = (center.x - 20) + 'px'; d.style.top = (center.y - 28) + 'px'; });
    }, 750);

    // Step 2: riffle-merge shuffle -- the combined deck "splits" into two
    // halves that zipper together in the center, alternating cards rapidly.
    setT(() => {
      dealingLabel.textContent = 'Shuffling...';
      decks.forEach((d) => { d.style.opacity = '0'; });
    }, 1150);

    setT(() => {
      const leftStack = { x: center.x - 42, y: center.y };
      const rightStack = { x: center.x + 18, y: center.y };
      const mid = { x: center.x - 11, y: center.y };
      const total = 22;
      for (let i = 0; i < total; i++) {
        const fromLeft = i % 2 === 0;
        const src = fromLeft ? leftStack : rightStack;
        const c = document.createElement('div');
        c.className = 'shuffle-card';
        c.style.left = src.x + 'px';
        c.style.top = src.y + 'px';
        c.style.zIndex = String(i);
        c.style.transition = 'left 0.18s ease, top 0.18s ease, transform 0.18s ease';
        container.appendChild(c);
        setT(() => {
          c.style.left = mid.x + 'px';
          c.style.top = (mid.y - i * 0.55) + 'px';
          c.style.transform = 'rotate(' + (fromLeft ? -8 : 8) + 'deg)';
        }, i * 55);
      }
      setT(() => {
        container.querySelectorAll('.shuffle-card').forEach((c) => { c.style.transition = 'opacity 0.25s ease'; c.style.opacity = '0'; });
        setT(() => {
          container.innerHTML = '';
          container.classList.add('hidden');
          // Hand the label back to its default "Dealing cards..." text
          // (we borrowed it above for "Setting up N decks.../Shuffling...")
          // before the existing per-card deal animation takes over.
          dealingLabel.textContent = 'Dealing cards...';
          if (!cancelled) onDone();
        }, 250);
      }, total * 55 + 320);
    }, 1400);
  }

  // A small "flying card" travels directly from seat to seat around the real
  // oval table, looping for a full 13 passes (matching the real hand size
  // dealt underneath -- not a shortened stand-in), mirroring how a real
  // dealer hands out one card at a time, round and round. Each seat's card
  // count ticks up as cards land on it. totalMs is computed server-side to
  // scale with player count, so per-flight speed stays consistent (~90ms)
  // regardless of table size.
  //
  // Only the very first card starts from the table's center (nothing has
  // been dealt yet); every card after that flies straight from wherever the
  // PREVIOUS card just landed to the next seat -- it no longer snaps back
  // through the middle between every single card. That center-round-trip
  // was the original/production behavior, but once testers could actually
  // see it clearly (after fixing the deck-intro bug that had been silently
  // skipping this whole animation), the feedback was that it read as
  // distracting rather than dealer-like, so this switches to a direct
  // seat-to-seat path instead.
  function animateDealing(players, totalMs, passes) {
    const oval = document.getElementById('oval-table');
    const flyer = document.getElementById('deal-flyer');
    if (players.length === 0) { flyer.classList.add('hidden'); return; }
    flyer.classList.remove('hidden');

    function centerOf(el) {
      const cRect = oval.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - cRect.left + r.width / 2, y: r.top - cRect.top + r.height / 2 };
    }
    function tableCenter() {
      const cRect = oval.getBoundingClientRect();
      return { x: cRect.width / 2, y: cRect.height / 2 };
    }
    function seatFor(playerId) {
      return oval.querySelector(`.seat[data-player-id="${CSS.escape(playerId)}"]`);
    }

    passes = passes || 13;
    const totalFlights = players.length * passes;
    const flightMs = totalMs / totalFlights;
    let flight = 0;
    let cancelled = false;
    dealAnimationCancel = () => { cancelled = true; flyer.classList.add('hidden'); };

    // Snap the flyer to the table's center once, up front -- this is the
    // ONLY time it starts from center. Every flight after this continues
    // from wherever the flyer's transition just left it (the previous
    // seat), so there's no repeated reset-to-center in the loop below.
    const start = tableCenter();
    flyer.style.transition = 'none';
    flyer.style.left = start.x + 'px';
    flyer.style.top = start.y + 'px';
    flyer.style.opacity = '1';

    function flyNext() {
      if (cancelled) return;
      if (flight >= totalFlights) { flyer.style.opacity = '0'; return; }
      const p = players[flight % players.length];
      const seatEl = seatFor(p.playerId);
      if (!seatEl) { flight += 1; flyNext(); return; }
      const to = centerOf(seatEl);
      const travelMs = flightMs * 0.7;
      flyer.style.transition = `left ${travelMs}ms ease, top ${travelMs}ms ease`;
      flyer.style.left = to.x + 'px';
      flyer.style.top = to.y + 'px';
      setTimeout(() => {
        if (cancelled) return;
        const metaEl = seatEl.querySelector('.seat-meta');
        if (metaEl) {
          const cur = parseInt(metaEl.textContent, 10) || 0;
          metaEl.textContent = (cur + 1) + ' cards';
        }
        seatEl.classList.add('dealt-flash');
        setTimeout(() => seatEl.classList.remove('dealt-flash'), Math.max(80, flightMs * 0.3 - 10));
        flight += 1;
        setTimeout(flyNext, flightMs * 0.3);
      }, travelMs);
    }
    // One rAF so the browser actually paints the center starting position
    // before the first seat-bound transition kicks in (without this, the
    // very first flight would jump straight to its target with no visible
    // travel, since the "instant" center placement and the first animated
    // move would otherwise be batched into the same paint).
    requestAnimationFrame(() => { if (!cancelled) flyNext(); });
  }

  // Called once the first post-deal game_state arrives (pendingStartReveal
  // was set true by runStartSequence above). Shows the joker rank + open
  // card big or held on screen, then reveals the live board underneath.
  function showStartReveal(game, revealMs) {
    document.getElementById('deal-phase-badge').classList.add('hidden');
    document.getElementById('deal-flyer').classList.add('hidden');
    const overlay = document.getElementById('overlay-start-sequence');
    const revealEl = document.getElementById('start-seq-reveal');
    overlay.classList.remove('hidden');
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
  // Remembers whatever name was last typed/submitted, so returning players
  // never have to retype it -- previously the name field was blank on every
  // fresh visit even though it visually looked like it should be "sticky".
  // Pre-filled once on load below; every submit path re-saves in case they
  // changed it since.
  const NAME_STORAGE_KEY = 'leastcount_name';
  (function prefillSavedName() {
    const saved = localStorage.getItem(NAME_STORAGE_KEY);
    if (saved) document.getElementById('input-name').value = saved;
  })();

  // Opening a shared invite link (?room=CODE, see btn-share-room below)
  // pre-fills the join-room field so whoever tapped the link only has to
  // enter their name and hit Join -- one less thing to type/copy-paste.
  // The param is stripped from the URL afterwards so it doesn't linger in
  // the address bar or get shared again by accident (e.g. a browser
  // "share this page" on the landing screen itself).
  (function prefillRoomCodeFromLink() {
    const params = new URLSearchParams(window.location.search);
    const roomFromLink = (params.get('room') || '').trim().toUpperCase();
    if (roomFromLink) {
      document.getElementById('input-roomcode').value = roomFromLink;
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  })();
  function getPlayerName() {
    const name = document.getElementById('input-name').value.trim();
    if (name) localStorage.setItem(NAME_STORAGE_KEY, name);
    return name;
  }

  document.getElementById('btn-create').onclick = async () => {
    const name = getPlayerName();
    if (!name) return setLandingError('Enter your name');
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('create_room', { name, firebaseIdToken }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      logAnalytics('room_created');
      saveSession(res.roomCode, res.playerId);
      loadChatHistory(res.chatHistory);
      showChatFab();
      showScreen('screen-lobby');
    });
  };

  document.getElementById('btn-join').onclick = async () => {
    const name = getPlayerName();
    const roomCode = document.getElementById('input-roomcode').value.trim().toUpperCase();
    if (!name) return setLandingError('Enter your name');
    if (!roomCode) return setLandingError('Enter room code');
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('join_room', { roomCode, name, firebaseIdToken }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      // room.phase was already 'playing' when the request landed -- the
      // server held it as a pending request instead of joining outright
      // (see server.js' join_room). Show the waiting screen and stop here;
      // join_admitted/join_denied (registered further down) take it from here.
      if (res.pending) {
        pendingJoinRoomCode = res.roomCode;
        pendingJoinPlayerId = res.playerId;
        document.getElementById('waiting-host-name').textContent = 'the host';
        showScreen('screen-waiting-host');
        return;
      }
      logAnalytics('room_joined');
      saveSession(res.roomCode, res.playerId);
      loadChatHistory(res.chatHistory);
      showChatFab();
      showScreen('screen-lobby');
    });
  };

  // Copy just the code, or share a full join-link that pre-fills the room
  // code on the other end (see prefillRoomCodeFromLink above). Both give a
  // short on-screen "Copied!"/"Shared!" confirmation instead of relying on
  // the browser's own (easy-to-miss) clipboard toast.
  let roomcodeFeedbackTimer = null;
  function showRoomcodeFeedback(text) {
    const el = document.getElementById('roomcode-action-feedback');
    el.textContent = text;
    if (roomcodeFeedbackTimer) clearTimeout(roomcodeFeedbackTimer);
    roomcodeFeedbackTimer = setTimeout(() => { el.textContent = ''; }, 2500);
  }
  function roomInviteLink() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', myRoomCode || '');
    return url.toString();
  }
  document.getElementById('btn-copy-roomcode').onclick = async () => {
    if (!myRoomCode) return;
    try {
      await navigator.clipboard.writeText(myRoomCode);
      showRoomcodeFeedback('Copied!');
    } catch (e) {
      showRoomcodeFeedback('Could not copy -- code is ' + myRoomCode);
    }
  };
  document.getElementById('btn-share-room').onclick = async () => {
    if (!myRoomCode) return;
    const link = roomInviteLink();
    const shareText = `Join my Least Count game! Room code: ${myRoomCode}\n${link}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Least Count', text: `Join my Least Count game! Room code: ${myRoomCode}`, url: link });
        return; // native share sheet handles its own confirmation
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user cancelled the share sheet -- not an error
        // fall through to clipboard fallback below
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      showRoomcodeFeedback('Invite link copied!');
    } catch (e) {
      showRoomcodeFeedback('Could not copy -- code is ' + myRoomCode);
    }
  };

  // Only set while genuinely waiting on a mid-game join request -- distinct
  // from myRoomCode/myPlayerId (which mean "I'm an actual member of this
  // room"), since a pending requester isn't in room.players at all yet.
  let pendingJoinRoomCode = null;
  let pendingJoinPlayerId = null;

  document.getElementById('btn-cancel-waiting').onclick = () => {
    if (pendingJoinRoomCode && pendingJoinPlayerId) {
      socket.emit('cancel_join_request', { roomCode: pendingJoinRoomCode, playerId: pendingJoinPlayerId });
    }
    pendingJoinRoomCode = null;
    pendingJoinPlayerId = null;
    showScreen('screen-landing');
  };

  socket.on('join_admitted', ({ roomCode, playerId, chatHistory }) => {
    pendingJoinRoomCode = null;
    pendingJoinPlayerId = null;
    logAnalytics('room_joined_midgame');
    saveSession(roomCode, playerId);
    // Every other join path (create_room/join_room/queue_matched) loads chat
    // history and shows the chat FAB -- this path was missing both, which is
    // why someone admitted mid-game never got a chat option at all.
    loadChatHistory(chatHistory);
    showChatFab();
    // The very next room_update/game_state (already on its way as a side
    // effect of the host's admit on the server) will render the real
    // lobby/game screen; showing the game screen now avoids a flash of the
    // waiting screen lingering for the instant before that arrives.
    showScreen('screen-game');
  });

  socket.on('join_denied', ({ reason }) => {
    pendingJoinRoomCode = null;
    pendingJoinPlayerId = null;
    showScreen('screen-landing');
    const messages = {
      declined: 'The host declined your request to join.',
      timeout: 'The host didn’t respond in time. Try again.',
      disconnected: '',
      cancelled: '',
    };
    setLandingError(messages[reason] || 'Could not join that room.');
  });

  // ---------------- mid-game join approval: host-side banner ----------------
  function renderJoinRequestsBanner(pending) {
    const banner = document.getElementById('join-requests-banner');
    banner.classList.toggle('hidden', !pending || pending.length === 0);
    banner.innerHTML = '';
    (pending || []).forEach((req) => {
      const row = document.createElement('div');
      row.className = 'join-request-row';
      row.innerHTML = `<span class="jr-text"><b>${escapeHtml(req.name)}</b> wants to join</span>
        <button class="jr-admit" type="button">Admit</button>
        <button class="jr-ignore" type="button">Ignore</button>`;
      row.querySelector('.jr-admit').onclick = () => {
        socket.emit('admit_join_request', { roomCode: myRoomCode, playerId: req.playerId });
      };
      row.querySelector('.jr-ignore').onclick = () => {
        socket.emit('ignore_join_request', { roomCode: myRoomCode, playerId: req.playerId });
      };
      banner.appendChild(row);
    });
  }
  socket.on('join_requests', ({ pending }) => renderJoinRequestsBanner(pending));

  // Errors get TWO independent signals now, not just one easy-to-miss one:
  // 1) the inline toast banner in the main page flow (visible regardless of
  //    whether the profile dropdown is open), and 2) the same text inside
  //    the dropdown itself (#landing-error) plus a brief pulse on the
  //    avatar, for anyone who does have it open already. Whichever a
  //    player actually notices, the message gets through.
  function setLandingError(msg) {
    document.getElementById('landing-error').textContent = msg || '';
    const toast = document.getElementById('landing-toast-error');
    if (toast) {
      if (msg) {
        toast.textContent = msg;
        toast.classList.remove('hidden');
        // Restart the shake animation even if the same message fires twice
        // in a row (e.g. tapping "Create Room" repeatedly with no name).
        toast.style.animation = 'none';
        void toast.offsetWidth;
        toast.style.animation = '';
      } else {
        toast.classList.add('hidden');
      }
    }
    const avatar = document.getElementById('btn-profile-menu');
    if (msg && avatar) {
      avatar.classList.remove('attn-pulse');
      void avatar.offsetWidth;
      avatar.classList.add('attn-pulse');
    }
  }

  // ---------------- profile modal (sign-in + name) ----------------
  // Guarded with existence checks (unlike a plain .onclick= on a possibly-
  // missing element) -- if index.html and app.js ever get out of sync during
  // a deploy (old index.html + new app.js, or vice versa), a missing element
  // here would otherwise throw and silently kill every handler registered
  // AFTER this point in the file, which explains a lot more than just the
  // profile button not responding.
  // #profile-menu-panel is itself the full-screen .overlay now (see
  // index.html) -- opening/closing it is just toggling one class on one
  // element, no separate backdrop to keep in sync.
  const btnProfileMenu = document.getElementById('btn-profile-menu');
  const profileMenuPanel = document.getElementById('profile-menu-panel');
  function openProfileMenu() {
    if (profileMenuPanel) profileMenuPanel.classList.remove('hidden');
  }
  function closeProfileMenu() {
    if (profileMenuPanel) profileMenuPanel.classList.add('hidden');
  }
  if (btnProfileMenu && profileMenuPanel) {
    btnProfileMenu.onclick = (e) => {
      e.stopPropagation();
      openProfileMenu();
    };
    const btnCloseProfileMenu = document.getElementById('btn-close-profile-menu');
    if (btnCloseProfileMenu) btnCloseProfileMenu.onclick = closeProfileMenu;
    // Tapping the dimmed backdrop itself (i.e. the overlay element but not
    // its inner card) closes it too, same as tapping Close.
    profileMenuPanel.addEventListener('click', (e) => {
      if (e.target === profileMenuPanel) closeProfileMenu();
    });
  }

  // Tapping the toast jumps straight to fixing the problem -- opens the
  // dropdown (if it wasn't already) and focuses the name field, since
  // "enter your name" is by far the most common reason it appears.
  const landingToastError = document.getElementById('landing-toast-error');
  if (landingToastError) {
    landingToastError.onclick = () => {
      openProfileMenu();
      const nameInput = document.getElementById('input-name');
      if (nameInput) nameInput.focus();
    };
  }

  // Clears the error the moment they start fixing it, instead of leaving a
  // stale "enter your name" banner up after they've already typed one.
  const inputNameEl = document.getElementById('input-name');
  if (inputNameEl) {
    inputNameEl.addEventListener('input', () => {
      if (inputNameEl.value.trim()) setLandingError('');
    });
  }

  // ---------------- solo play vs bots ----------------
  const MAX_BOTS = 7;
  (function populateBotCountSelect() {
    const sel = document.getElementById('input-bot-count');
    for (let i = 1; i <= MAX_BOTS; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = i + (i === 1 ? ' bot' : ' bots');
      if (i === 3) opt.selected = true;
      sel.appendChild(opt);
    }
    syncDropdown(sel);
  })();

  // One custom themed dropdown per native <select>, replacing the browser's
  // own unstyleable popup everywhere in the app (see initDropdown above).
  initDropdown('input-online-playercount');
  initDropdown('input-bot-count');
  initDropdown('input-maxscore');
  initDropdown('round-maxscore-select');

  document.getElementById('btn-solo-start').onclick = async () => {
    const name = getPlayerName();
    if (!name) return setLandingError('Enter your name');
    const botCount = Number(document.getElementById('input-bot-count').value) || 3;
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('create_solo_room', { name, botCount, firebaseIdToken }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      logAnalytics('solo_game_started', { bot_count: botCount });
      saveSession(res.roomCode, res.playerId);
      loadChatHistory(res.chatHistory);
      showChatFab();
      // Solo play skips the lobby entirely -- the room's already mid-deal by
      // the time this ack comes back, so head straight to the game screen
      // (the very next room_update/game_starting event drives the rest).
      showScreen('screen-game');
    });
  };

  // Footer nav on the landing screen. Home is just the landing screen itself
  // (no-op, it's already there). Stats is the SAME #btn-my-stats element the
  // header used to also show -- it only lives in the footer now, no
  // duplicate icon, and its real click handler (elsewhere in this file,
  // guarded with `if (myStatsBtn)`) attaches to it exactly the same either
  // way. Rules reuses the existing rules overlay (normally only reachable
  // from the lobby, now also reachable before ever joining a room).
  document.getElementById('btn-footer-rules').onclick = () => document.getElementById('overlay-rules').classList.remove('hidden');

  // ---------------- "Play Online" matchmaking ----------------
  const QUEUE_PROMPT_DELAY_MS = 40000; // ~40s of real waiting before offering wait/bots/cancel
  let queueTimeoutTimer = null;
  let queuedPlayerCount = null;

  function clearQueueTimeoutTimer() {
    if (queueTimeoutTimer) { clearTimeout(queueTimeoutTimer); queueTimeoutTimer = null; }
  }

  document.getElementById('btn-play-online').onclick = async () => {
    const name = getPlayerName();
    if (!name) return setLandingError('Enter your name');
    const playerCount = Number(document.getElementById('input-online-playercount').value) || 3;
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('queue_join', { playerCount, name, firebaseIdToken }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      queuedPlayerCount = playerCount;
      document.getElementById('queue-waiting-count').textContent = String(playerCount);
      document.getElementById('queue-waiting-choice').classList.add('hidden');
      document.getElementById('queue-waiting-hint').classList.remove('hidden');
      showScreen('screen-queue-waiting');
      clearQueueTimeoutTimer();
      queueTimeoutTimer = setTimeout(() => {
        document.getElementById('queue-waiting-hint').classList.add('hidden');
        document.getElementById('queue-waiting-choice').classList.remove('hidden');
      }, QUEUE_PROMPT_DELAY_MS);
    });
  };

  document.getElementById('btn-queue-keep-waiting').onclick = () => {
    // Just re-hides the choice and gives it another full waiting window --
    // still queued the whole time, this only affects when the prompt reappears.
    document.getElementById('queue-waiting-choice').classList.add('hidden');
    document.getElementById('queue-waiting-hint').classList.remove('hidden');
    clearQueueTimeoutTimer();
    queueTimeoutTimer = setTimeout(() => {
      document.getElementById('queue-waiting-hint').classList.add('hidden');
      document.getElementById('queue-waiting-choice').classList.remove('hidden');
    }, QUEUE_PROMPT_DELAY_MS);
  };

  document.getElementById('btn-queue-fill-bots').onclick = () => {
    clearQueueTimeoutTimer();
    socket.emit('queue_fill_bots', {}, (res) => {
      if (!res.ok) { setLandingError(res.error); showScreen('screen-landing'); }
      // On success, queue_matched (below) takes it from here.
    });
  };

  document.getElementById('btn-queue-cancel').onclick = () => {
    clearQueueTimeoutTimer();
    socket.emit('queue_cancel', {});
    queuedPlayerCount = null;
    showScreen('screen-landing');
  };

  socket.on('queue_matched', ({ roomCode, playerId, chatHistory }) => {
    clearQueueTimeoutTimer();
    queuedPlayerCount = null;
    logAnalytics('online_match_found');
    saveSession(roomCode, playerId);
    loadChatHistory(chatHistory);
    showChatFab();
    // Same as solo play -- matched rooms skip the lobby and go straight into
    // the countdown/deal sequence, already in progress by the time this arrives.
    showScreen('screen-game');
  });

  // ---------------- lobby screen ----------------
  populateMaxScoreSelect(document.getElementById('input-maxscore'), DEFAULT_MAX_SCORE, 0);

  document.getElementById('btn-start').onclick = () => {
    const eliminationScore = Number(document.getElementById('input-maxscore').value) || undefined;
    socket.emit('start_game', { roomCode: myRoomCode, eliminationScore }, (res) => {
      if (!res.ok) document.getElementById('lobby-error').textContent = res.error;
    });
  };

  function renderLobby(room) {
    document.getElementById('lobby-roomcode').textContent = room.roomCode;
    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      li.dataset.playerId = p.playerId;
      const hostTag = p.playerId === room.hostPlayerId ? '<span class="host-tag">HOST</span>' : '';
      li.innerHTML = `<span>${escapeHtml(p.name)} ${hostTag}</span><span class="status">${p.connected ? 'online' : 'offline'}</span>`;
      // Tap a player's row to report/mute them before the game even starts --
      // same popover the seats use once play begins. Not wired for yourself
      // or for bots (lobby rows are only ever real players anyway, but the
      // guard is harmless).
      if (p.playerId !== myPlayerId && !p.isBot) {
        li.classList.add('tappable');
        li.dataset.popoverAlign = 'align-right';
        li.onclick = (e) => {
          e.stopPropagation();
          togglePlayerActionPopover(li, p.playerId, p.name, 'align-right');
        };
      }
      list.appendChild(li);
    });
    reopenPlayerActionPopoverIfNeeded(list);
    const isHost = room.hostPlayerId === myPlayerId;
    const btn = document.getElementById('btn-start');
    btn.classList.toggle('hidden', !isHost);
    btn.disabled = room.players.length < 2;
    document.getElementById('lobby-maxscore-row').classList.toggle('hidden', !isHost);
    document.getElementById('lobby-hint').textContent = isHost
      ? (room.players.length < 2 ? 'Need at least 2 players' : `Ready with ${room.players.length} players`)
      : 'Waiting for host to start';
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
    if (opts.hinted) el.classList.add('hint-suggested');
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
  // orderOverride: an explicit array of playerIds (used only during the
  // countdown/dealing phase, before any `game` object exists yet -- see
  // runStartSequence) to pre-build the real seats in the exact order the
  // server just dealt this round with, each starting at 0 cards.
  //
  // Otherwise seating always follows game.turnOrder -- the engine's actual,
  // dealer-rotated play order (which also already excludes anyone eliminated
  // or quit) -- rather than plain join order, so who's sitting next to you
  // on screen always matches who you actually play after/before.
  function renderOvalTable(game, orderOverride) {
    const oval = document.getElementById('oval-table');
    oval.querySelectorAll('.seat').forEach((el) => el.remove());
    if (!latestRoom) return;

    const dealing = !!orderOverride;
    const playerById = new Map(latestRoom.players.map((p) => [p.playerId, p]));
    const orderIds = orderOverride
      || ((game && game.turnOrder && game.turnOrder.length) ? game.turnOrder : latestRoom.players.map((p) => p.playerId));

    const meIdx = orderIds.indexOf(myPlayerId);
    const rotatedIds = meIdx > 0 ? [...orderIds.slice(meIdx), ...orderIds.slice(0, meIdx)] : orderIds.slice();
    const seatOrder = rotatedIds.map((id) => playerById.get(id)).filter(Boolean);
    const n = seatOrder.length;
    if (n === 0) return;

    seatOrder.forEach((p, i) => {
      const angle = Math.PI / 2 + (i / n) * 2 * Math.PI;
      const left = 50 + 43 * Math.cos(angle);
      const top = 50 + 43 * Math.sin(angle);

      const seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.dataset.playerId = p.playerId;
      if (game && !game.roundOver && game.currentPlayer === p.playerId) seatEl.classList.add('active');
      if (game && game.eliminated && game.eliminated.includes(p.playerId)) seatEl.classList.add('eliminated');
      if (game && game.quit && game.quit.includes(p.playerId)) seatEl.classList.add('quit');
      if (p.playerId === myPlayerId && myTurnPulseActive) seatEl.classList.add('my-turn-pulse');
      seatEl.style.left = left + '%';
      seatEl.style.top = top + '%';

      // Tap a seat to report/mute that player -- never wired for yourself
      // or for bots (nothing to report/mute there). Edge seats get an
      // align class so the popover hugs the same edge it would otherwise
      // spill past, same idea as the discard-history/GIF-bubble alignment.
      if (!dealing && p.playerId !== myPlayerId && !p.isBot) {
        seatEl.classList.add('tappable');
        const alignClass = 'align-' + getSeatHAlign(seatEl);
        seatEl.dataset.popoverAlign = alignClass;
        seatEl.onclick = (e) => {
          e.stopPropagation();
          togglePlayerActionPopover(seatEl, p.playerId, p.name, alignClass);
        };
      }

      const count = game && game.handCounts ? game.handCounts[p.playerId] : (dealing ? 0 : undefined);
      const score = game && game.scores ? (game.scores[p.playerId] ?? 0) : 0;

      // Every seat (opponent or you) renders the exact same single chip:
      // name on top, "N cards · M pts" below. No extra icon on top of it,
      // so every seat looks identical regardless of position on the table.
      // While dealing, only the running card count is shown (no score yet).
      const chipEl = document.createElement('div');
      chipEl.className = 'seat-chip';
      const nameEl = document.createElement('div');
      nameEl.className = 'seat-name';
      // Own seat is marked with a neutral ring (see .seat.own-seat in
      // style.css) instead of appending "(You)" text -- that text used to
      // share the exact same 96px truncation-prone width as everyone else's
      // name, so it clipped sooner than it should have for no good reason.
      nameEl.textContent = p.name;
      if (p.playerId === myPlayerId) seatEl.classList.add('own-seat');
      chipEl.appendChild(nameEl);
      const metaEl = document.createElement('div');
      metaEl.className = 'seat-meta';
      metaEl.textContent = count !== undefined ? count + ' cards' + (dealing ? '' : ' · ' + score + ' pts') : '';
      chipEl.appendChild(metaEl);

      // Recent discards for THIS player, this round -- lets you track what
      // opponents have been throwing away, same as you naturally would
      // watching a real discard pile. Sits inside the chip itself (not a
      // separate floating box), so it never needs edge-aware positioning --
      // it just makes the pill a little taller, never wider than the seat.
      const history = (!dealing && game && game.discardHistory) ? game.discardHistory[p.playerId] : null;
      if (history && history.length > 0) {
        const histEl = document.createElement('div');
        histEl.className = 'seat-discard-history';
        const label = document.createElement('span');
        label.className = 'seat-discard-label';
        label.textContent = 'Last:';
        histEl.appendChild(label);
        history.forEach((c) => {
          const cEl = cardEl(c);
          cEl.classList.add('mini');
          histEl.appendChild(cEl);
        });
        chipEl.appendChild(histEl);
      }

      seatEl.innerHTML = '';
      seatEl.appendChild(chipEl);

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

      const chatBubble = chatBubbles[p.playerId];
      if (chatBubble) {
        const elapsed = Date.now() - chatBubble.startedAt;
        if (elapsed < chatBubble.durationMs) {
          const bubbleEl = document.createElement('div');
          // Seats in the top half of the table show the bubble below
          // themselves instead of above, so it never gets clipped by the
          // screen's overflow:hidden near the top edge on mobile.
          bubbleEl.className = 'seat-chat-bubble ' + (top < 50 ? 'below' : 'above');
          if (chatBubble.type === 'gif' && chatBubble.gifUrl) {
            // GIFs render as a small thumbnail instead of a full-size image --
            // at full chat-bubble width a GIF was tall enough to cover the
            // joker/open card in the middle of the table. Same edge-aware
            // left/right hugging as the discard history and old final-hand
            // reveal, so it never runs off-screen on side seats either.
            bubbleEl.classList.add('gif-thumb', 'align-' + getSeatHAlign(seatEl));
            const img = document.createElement('img');
            img.src = chatBubble.gifUrl;
            img.className = 'seat-chat-gif';
            img.alt = 'GIF';
            bubbleEl.appendChild(img);
            const tag = document.createElement('span');
            tag.className = 'seat-chat-gif-tag';
            tag.textContent = 'GIF';
            bubbleEl.appendChild(tag);
          } else {
            bubbleEl.textContent = chatBubble.text;
          }
          // Same negative-animation-delay trick used for the emoji bubble
          // above: renderOvalTable rebuilds every seat from scratch on every
          // game update, which was restarting the little "pop in" animation
          // each time and making the bubble look like it was blinking. A
          // negative delay equal to how long it's already been showing makes
          // the animation render as already-finished on every re-render
          // after the first, instead of replaying from scratch.
          bubbleEl.style.animationDelay = (-elapsed) + 'ms';
          seatEl.appendChild(bubbleEl);
        } else {
          delete chatBubbles[p.playerId];
        }
      }

      oval.appendChild(seatEl);
    });

    reopenPlayerActionPopoverIfNeeded(oval);
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
    const hintCardIds = (currentHint && currentHint.type !== 'declare') ? currentHint.cardIds : null;
    groups.forEach((g) => {
      const rep = g.cards[0];
      let selectable = isMyTurn && !game.roundOver;
      if (duringChain) selectable = selectable && g.rank === '2';
      const allSelected = g.cards.every((c) => selectedIds.has(c.id));
      const isWild = rep.rank !== 'JOKER' && wildRank && rep.rank === wildRank;
      const hinted = !!(hintCardIds && hintCardIds.length && g.cards.some((c) => hintCardIds.includes(c.id)));
      const el = cardEl(rep, { selectable, selected: allSelected, wild: isWild, hinted });
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

    const isMyTurn = game.currentPlayer === myPlayerId;
    const currentName = playerName(game.currentPlayer);

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
      const respondingName = isMyTurn ? 'You' : currentName;
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

    // "Help me play" -- only ever shown in a solo game against bots (no
    // other real player at the table), never in Play Online/Friends. One
    // button, tap any turn -- no separate on/off toggle needed.
    const soloBotMode = !!(latestRoom && latestRoom.players.filter((p) => !p.isBot).length === 1);

    // Clear any hint that belonged to a now-past turn (hand size, current
    // player, chain state, or round changing all mean the old hint is stale).
    const turnKey = `${game.currentPlayer}|${hand.length}|${game.chainCount}|${game.roundNumber}`;
    if (turnKey !== hintTurnKey) {
      currentHint = null;
      hintTurnKey = turnKey;
    }

    const showHintBtn = document.getElementById('btn-show-hint');
    const hintBanner = document.getElementById('hint-banner');
    const canHint = soloBotMode && isMyTurn && !game.roundOver;
    showHintBtn.classList.toggle('hidden', !(canHint && !currentHint));
    if (canHint && !currentHint) {
      showHintBtn.classList.toggle('attn-pulse', localStorage.getItem(HELP_EVER_USED_KEY) !== '1');
    }
    hintBanner.classList.toggle('hidden', !(canHint && currentHint));
    if (canHint && currentHint) {
      document.getElementById('hint-text').textContent = '💡 ' + currentHint.reason;
      if (currentHint.type === 'declare') declareBtn.classList.add('hint-suggested');
    } else {
      declareBtn.classList.remove('hint-suggested');
    }

    // Every round, once it's over, show the merged result screen -- podium,
    // everyone's revealed cards, and the round-score math, all in one place
    // (see showRoundResult / renderHandRevealRows). On the final round this
    // same screen appears too (minus the Next Round button); the celebratory
    // trophy screen only shows once the player taps through it.
    if (game.roundOver && game.lastRoundResult && game.roundNumber !== window.__lastRoundResultShownFor) {
      showRoundResult(game);
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

  document.getElementById('btn-show-hint').onclick = () => {
    localStorage.setItem(HELP_EVER_USED_KEY, '1'); // stop pulsing once they've tapped it once, ever
    socket.emit('request_hint', { roomCode: myRoomCode }, (res) => {
      if (!res.ok) return setGameError(res.error);
      currentHint = res.hint;
      setGameError('');
      renderGame(latestGame);
    });
  };

  function setGameError(msg) { document.getElementById('game-error').textContent = msg || ''; }

  // Remembers every name this client has ever seen for a playerId, and never
  // forgets one -- unlike latestRoom.players, which the server actively
  // DELETES someone from the moment they call leave_room (see server.js'
  // leave_room handler: room.players.delete(playerId)). That's correct for
  // the live lobby/seat list, but it broke the final "Ashok wins!" scoreboard:
  // an eliminated player who then left showed up with their real score but
  // the name "?" instead, because by the time that screen rendered,
  // latestRoom no longer had any record of them at all. This cache is
  // populated every time a name is seen (see the room_update handler below)
  // and is the fallback playerName() reaches for once the live lookup misses.
  const knownPlayerNames = {};

  function playerName(playerId) {
    const p = latestRoom && latestRoom.players.find((x) => x.playerId === playerId);
    if (p) return p.name;
    return knownPlayerNames[playerId] || '?';
  }

  // ---------------- round result / scores / game over overlays ----------------
  // Ranks everyone by cumulative total score, ascending -- lowest total is
  // rank 1, since Least Count rewards staying low. Re-derived fresh every
  // round, so the podium/table are always re-sorted by the latest totals.
  function rankedPlayers(game) {
    return (latestRoom.players || [])
      .map((p) => ({ ...p, total: game.scores[p.playerId] ?? 0 }))
      .sort((a, b) => a.total - b.total);
  }

  // Podium: 1st place centered and visibly higher (via extra padding/scale,
  // not a bar chart), 2nd/3rd flanking lower. Only the top 3 appear here --
  // everyone (including 4th place and below) still appears in the full
  // sorted table underneath.
  function renderPodium(game, ranked) {
    const podium = document.getElementById('podium');
    podium.innerHTML = '';
    const top3 = ranked.slice(0, 3);
    if (top3.length === 0) return;
    const r = game.lastRoundResult;
    const order = [];
    if (top3[1]) order.push({ p: top3[1], place: 2 });
    order.push({ p: top3[0], place: 1 });
    if (top3[2]) order.push({ p: top3[2], place: 3 });

    order.forEach(({ p, place }) => {
      const slot = document.createElement('div');
      // Own slot gets a neutral ring (own-podium, styled in style.css) instead
      // of appending " (You)" as literal text -- that text used to share the
      // exact same tight, already-truncation-prone width as everyone else's
      // name here, so it clipped sooner than it should have for no good
      // reason. Same fix already applied to the oval table's own-seat name.
      slot.className = `podium-slot podium-place-${place}${p.playerId === myPlayerId ? ' own-podium' : ''}`;
      const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : '🥉';
      const elim = game.eliminated && game.eliminated.includes(p.playerId) ? ' (out)' : '';
      const delta = r && r.roundScores ? r.roundScores[p.playerId] : undefined;
      const deltaHtml = delta !== undefined ? `<div class="podium-delta">+${delta} this round</div>` : '';
      slot.innerHTML =
        `<div class="podium-medal">${medal}</div>` +
        `<div class="podium-name">${escapeHtml(p.name)}${elim}</div>` +
        deltaHtml +
        `<div class="podium-score">${p.total} pts</div>`;
      podium.appendChild(slot);
    });
  }

  // Full sorted table below the podium -- everyone, this round's delta, and
  // Same rank-value rule as gameLogic.js's cardValue() -- a printed Joker or
  // this round's wild rank scores 0, Ace is 1, face cards are 10, everything
  // else is its face value. Kept in sync manually since the client only ever
  // receives final hand *values* from the server, not a shared value table.
  function cardValueClient(card, wildRank) {
    if (card.rank === 'JOKER') return 0;
    if (wildRank && card.rank === wildRank) return 0;
    if (card.rank === 'A') return 1;
    if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
    return parseInt(card.rank, 10);
  }

  // Per-player reveal rows on the merged round-result screen -- replaces the
  // old plain scoreboard table AND the old separate at-the-seat card reveal.
  // Shows each player's actual final hand for the round (priciest cards
  // first, same-rank grouped into a x N tile just like your own hand tray,
  // capped to a few tiles with a "+N" count for the rest so a 15+ card hand
  // never blows up the layout), the hand's point value, and the round-score
  // math (this round's points + what they had before = new total).
  const REVEAL_MAX_TILES = 4;
  function renderHandRevealRows(game, ranked) {
    const body = document.getElementById('round-result-hands');
    body.innerHTML = '';
    const r = game.lastRoundResult;
    const finalHands = game.finalHands || {};
    const finalValues = game.finalHandValues || {};
    const wildRank = game.roundJokerRank;

    ranked.forEach((p) => {
      const roundScore = r && r.roundScores ? r.roundScores[p.playerId] : undefined;
      const newTotal = p.total;
      const prevTotal = roundScore !== undefined ? newTotal - roundScore : undefined;
      const elim = game.eliminated && game.eliminated.includes(p.playerId);
      const isDeclarer = r && r.declaredBy === p.playerId;

      const row = document.createElement('div');
      row.className = 'reveal-row' + (isDeclarer ? ' declared' : '') + (elim ? ' eliminated' : '');

      const nameEl = document.createElement('div');
      nameEl.className = 'reveal-name';
      nameEl.textContent = p.name
        + (p.playerId === myPlayerId ? ' (You)' : '')
        + (isDeclarer ? ' (declared)' : '')
        + (elim ? ' (out)' : '');
      row.appendChild(nameEl);

      const mainRow = document.createElement('div');
      mainRow.className = 'reveal-main';

      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'reveal-cards';
      const hand = finalHands[p.playerId] || [];
      const groups = groupHand(hand)
        .slice()
        .sort((a, b) => cardValueClient(b.cards[0], wildRank) - cardValueClient(a.cards[0], wildRank));
      const shownGroups = groups.slice(0, REVEAL_MAX_TILES);
      shownGroups.forEach((g) => {
        const el = cardEl(g.cards[0]);
        el.classList.add('mini');
        if (g.cards.length > 1) {
          const badge = document.createElement('span');
          badge.className = 'card-count-badge';
          badge.textContent = '×' + g.cards.length;
          el.appendChild(badge);
        }
        cardsWrap.appendChild(el);
      });
      const shownCardCount = shownGroups.reduce((sum, g) => sum + g.cards.length, 0);
      const remaining = hand.length - shownCardCount;
      if (remaining > 0) {
        const more = document.createElement('span');
        more.className = 'reveal-more';
        more.textContent = '+' + remaining;
        cardsWrap.appendChild(more);
      }
      if (finalValues[p.playerId] !== undefined) {
        const valueEl = document.createElement('span');
        valueEl.className = 'reveal-value';
        valueEl.textContent = '= ' + finalValues[p.playerId];
        cardsWrap.appendChild(valueEl);
      }
      mainRow.appendChild(cardsWrap);

      const mathEl = document.createElement('div');
      mathEl.className = 'reveal-math';
      if (roundScore !== undefined) {
        mathEl.append(`${roundScore} + ${prevTotal} = `);
        const strong = document.createElement('b');
        strong.textContent = String(newTotal);
        mathEl.appendChild(strong);
      } else {
        mathEl.textContent = `${newTotal} pts`;
      }
      mainRow.appendChild(mathEl);

      row.appendChild(mainRow);
      body.appendChild(row);
    });
  }

  // Re-applies the Next-Round button + max-score dropdown visibility for
  // WHOEVER is currently host. Split out from showRoundResult() (which only
  // runs once per round) so it can also be re-run from the room_update
  // handler -- fixing the bug where, if the host who was showing this screen
  // got eliminated and left (handing host to someone else), the remaining
  // players' already-open popup never found out they were now the host and
  // the Next Round button stayed hidden for everyone.
  function updateRoundResultHostControls() {
    const overlay = document.getElementById('overlay-round-result');
    if (!latestGame || overlay.classList.contains('hidden')) return;
    const game = latestGame;
    const isHost = latestRoom && latestRoom.hostPlayerId === myPlayerId;

    const nextBtn = document.getElementById('btn-next-round');
    nextBtn.classList.toggle('hidden', !isHost || game.gameOver);
    // On the final round there's no next round to start -- instead everyone
    // (not just the host) gets a "See Final Result" button that leads into
    // the separate celebratory trophy screen, at their own pace rather than
    // an automatic timer.
    document.getElementById('btn-see-final-result').classList.toggle('hidden', !game.gameOver);
    document.getElementById('round-result-hint').textContent = (isHost || game.gameOver) ? '' : 'Waiting for host to start next round...';

    const maxScoreRow = document.getElementById('round-maxscore-row');
    if (isHost && !game.gameOver) {
      const maxCurrentScore = Math.max(0, ...Object.values(game.scores));
      populateMaxScoreSelect(document.getElementById('round-maxscore-select'), game.eliminationScore, maxCurrentScore);
      maxScoreRow.classList.remove('hidden');
    } else {
      maxScoreRow.classList.add('hidden');
    }
  }

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
    document.getElementById('round-result-maxscore').textContent = `Playing to ${game.eliminationScore} pts`;

    // Declare emojis show here (not at a seat) since the game redirects to
    // this screen almost instantly after a declare -- a seat reaction
    // would barely be visible before getting covered by this overlay.
    const emojiEl = document.getElementById('round-result-emoji');
    emojiEl.textContent = r.correct ? '🎉' : '😬';
    emojiEl.style.animation = 'none';
    void emojiEl.offsetWidth;
    emojiEl.style.animation = 'scoreCardEmojiPop 3.4s ease 1 both';

    const ranked = rankedPlayers(game);
    renderPodium(game, ranked);
    renderHandRevealRows(game, ranked);

    const noteEl = document.getElementById('round-result-note');
    noteEl.textContent = (r.newlyEliminated && r.newlyEliminated.length)
      ? `Eliminated: ${r.newlyEliminated.map(playerName).join(', ')}`
      : '';

    document.getElementById('overlay-round-result').classList.remove('hidden');
    updateRoundResultHostControls();
  }

  document.getElementById('btn-next-round').onclick = () => {
    document.getElementById('overlay-round-result').classList.add('hidden');
    const maxScoreRow = document.getElementById('round-maxscore-row');
    const sel = document.getElementById('round-maxscore-select');
    const eliminationScore = !maxScoreRow.classList.contains('hidden') && sel.value
      ? Number(sel.value) : undefined;
    socket.emit('next_round', { roomCode: myRoomCode, eliminationScore }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
  };

  // Final round only -- everyone reads the merged reveal+scorecard screen at
  // their own pace, then taps through to the separate trophy/confetti screen.
  document.getElementById('btn-see-final-result').onclick = () => {
    if (latestGame) showGameOver(latestGame);
  };

  // Mute toggle, back on the game screen after being removed from the top
  // bar in an earlier redesign -- the mute state/logic in Sound itself
  // (isMuted/setMuted, localStorage-backed) was never actually removed, so
  // this just restores the button that controls it.
  const btnMute = document.getElementById('btn-mute');
  const btnMuteIconOn = btnMute.querySelector('.icon-sound-on');
  const btnMuteIconOff = btnMute.querySelector('.icon-sound-off');
  function refreshMuteBtn() {
    const isMuted = Sound.isMuted();
    btnMuteIconOn.classList.toggle('hidden', isMuted);
    btnMuteIconOff.classList.toggle('hidden', !isMuted);
    btnMute.setAttribute('aria-label', isMuted ? 'Unmute sound' : 'Mute sound');
  }
  refreshMuteBtn();
  btnMute.onclick = () => {
    Sound.setMuted(!Sound.isMuted());
    refreshMuteBtn();
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

  // Full round-by-round scorecard -- players as rows (capped at 10, so this
  // axis never needs scrolling), rounds as columns (a long game scrolls
  // sideways instead, with the player-name column frozen via CSS so context
  // never scrolls away). Built from game.roundHistory, one entry per
  // completed round; the Total column reads straight from game.scores (the
  // same authoritative cumulative total elimination is based on) rather than
  // summing history client-side, so it can never drift out of sync.
  //
  // This lives on its own dedicated overlay (#overlay-full-scorecard),
  // opened from either the in-game Scores overlay or the round-result
  // screen's own link -- previously this expanded INLINE underneath
  // whichever screen opened it, which made an already-tall round-result
  // panel (podium + full hand reveal) even taller/more cluttered once
  // expanded. A separate screen keeps both entry points short, with only
  // one scorecard table to ever keep in sync.
  function renderFullScorecard() {
    if (!latestGame || !latestRoom) return;
    const history = latestGame.roundHistory || [];
    const table = document.getElementById('scorecard-table');
    table.innerHTML = '';

    const headRow = document.createElement('tr');
    headRow.innerHTML = '<th>Player</th>' +
      history.map((r) => `<th>R${r.round}</th>`).join('') +
      '<th>Total</th>';
    table.appendChild(headRow);

    (latestRoom.players || []).forEach((p) => {
      const row = document.createElement('tr');
      const isOut = latestGame.eliminated.includes(p.playerId) || latestGame.quit.includes(p.playerId);
      const outTag = isOut ? '<span class="scorecard-out">OUT</span>' : '';
      let cells = `<td>${escapeHtml(p.name)}${outTag}</td>`;
      history.forEach((r) => {
        const has = Object.prototype.hasOwnProperty.call(r.roundScores, p.playerId);
        cells += has ? `<td>${r.roundScores[p.playerId]}</td>` : '<td class="scorecard-dash">—</td>';
      });
      cells += `<td>${latestGame.scores[p.playerId] ?? 0}</td>`;
      row.innerHTML = cells;
      table.appendChild(row);
    });

    document.getElementById('scorecard-swipe-hint').classList.toggle('hidden', history.length <= 3);
  }

  function openFullScorecard() {
    renderFullScorecard();
    document.getElementById('overlay-full-scorecard').classList.remove('hidden');
  }
  document.getElementById('btn-open-full-scorecard').onclick = openFullScorecard;
  document.getElementById('btn-open-full-scorecard-rr').onclick = openFullScorecard;
  document.getElementById('btn-close-full-scorecard').onclick = () =>
    document.getElementById('overlay-full-scorecard').classList.add('hidden');

  document.getElementById('btn-game-rules').onclick = () => document.getElementById('overlay-rules').classList.remove('hidden');
  document.getElementById('btn-close-rules').onclick = () => document.getElementById('overlay-rules').classList.add('hidden');

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

    // Matches the current jade/gold/red design tokens (style.css :root) --
    // this used to still be the pre-redesign gold/green/purple palette,
    // clashing with the theme for the ~3 seconds it's on screen.
    const colors = ['#d4a017', '#f2c14e', '#e5252c', '#a8151a', '#ffffff'];
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

  // ---------------- seat edge-aware positioning ----------------
  // Shared by anything pinned to a seat that can grow wider than the seat
  // chip itself (discard history, GIF thumbnails, etc). Seats near the
  // table's left/right edge get a class telling the element to hug that same
  // edge and grow inward toward the center, instead of always centering on
  // the seat -- centering meant it could spill past the screen's clipped
  // edge and vanish entirely for side seats. Seats near top/bottom-center
  // stay centered as before. Pairs with the .align-left/.align-right/
  // (default centered) CSS rules.
  function getSeatHAlign(seatEl) {
    const leftPct = parseFloat(seatEl.style.left);
    if (!Number.isFinite(leftPct)) return 'center';
    if (leftPct < 35) return 'left';
    if (leftPct > 65) return 'right';
    return 'center';
  }

  function showGameOver(game) {
    logAnalytics('game_completed', {
      player_count: latestRoom ? latestRoom.players.length : undefined,
      round_count: game.roundNumber,
      you_won: game.winner === myPlayerId,
    });
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
      closePlayerActionPopover();
      playerStatsCache.clear();
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
    document.getElementById('gif-picker').classList.add('hidden');
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
    div.dataset.playerId = msg.playerId || '';
    if (msg.type === 'gif' && msg.gifUrl) {
      div.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}:</span>`;
      const img = document.createElement('img');
      img.src = msg.gifUrl;
      img.className = 'chat-gif';
      img.alt = 'GIF';
      div.appendChild(img);
    } else {
      div.innerHTML = `<span class="chat-name">${escapeHtml(msg.name)}:</span> <span class="chat-text">${escapeHtml(msg.text)}</span>`;
    }

    // Report/mute used to live here as icons on every message -- moved to a
    // tap-on-their-seat/lobby-row popover instead (see the player action
    // popover section below), so nothing gets attached per-message anymore.

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    const panelOpen = !document.getElementById('chat-panel').classList.contains('hidden');
    if (!panelOpen && msg.playerId !== myPlayerId && !opts.silent) {
      chatUnread += 1;
      updateChatBadge();
    }
  }

  // Mutes a player for the rest of this session (this device only -- never
  // sent to the server, so nobody else is affected). Also clears anything of
  // theirs already sitting in the chat panel, not just future messages.
  function mutePlayer(playerId, name) {
    if (!playerId || mutedPlayerIds.has(playerId)) return;
    mutedPlayerIds.add(playerId);
    document.querySelectorAll('#chat-messages .chat-msg').forEach((el) => {
      if (el.dataset.playerId === playerId) el.remove();
    });
  }

  // Un-mutes a player -- their future chat messages and seat bubbles show up
  // again. Whatever of theirs was already deleted from the chat panel while
  // they were muted stays gone (same as it always has); only new messages
  // come back.
  function unmutePlayer(playerId) {
    mutedPlayerIds.delete(playerId);
  }

  // ---------------- player action popover (report / mute) ----------------
  // Replaces the old always-visible 🚩/🔇 icons that used to sit on every
  // chat bubble. Now: tap a player's seat during the game, or their row in
  // the lobby player list before the game starts, and a small popover with
  // "Report" and "Mute/Unmute" appears anchored to that seat/row. Never
  // shown for yourself or for bots. Only one popover open at a time, tracked
  // by playerId rather than by DOM node -- seats and the lobby list get torn
  // down and rebuilt from scratch on every render, so
  // reopenPlayerActionPopoverIfNeeded() below re-attaches it to the freshly
  // rebuilt element each time, otherwise it would silently vanish mid-tap
  // during a live game (game_state arrives constantly).
  let openPlayerActionForId = null;

  function closePlayerActionPopover() {
    document.querySelectorAll('.player-action-popover').forEach((el) => el.remove());
    openPlayerActionForId = null;
  }

  // playerId -> { gamesPlayed, wins } | null (fetched, no linked account) --
  // cached per session so re-fetching stats every time this popover gets
  // torn down and rebuilt (see reopenPlayerActionPopoverIfNeeded) doesn't
  // spam the server on every game_state update while it happens to be open.
  const playerStatsCache = new Map();

  function applyStatsToEl(el, stats) {
    if (!stats) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.textContent = `🎮 ${stats.gamesPlayed} games · 🏆 ${stats.wins} wins`;
  }

  function loadStatsIntoPopover(playerId, statsEl) {
    if (playerStatsCache.has(playerId)) {
      applyStatsToEl(statsEl, playerStatsCache.get(playerId));
      return;
    }
    statsEl.textContent = 'Loading stats...';
    socket.emit('get_player_stats', { roomCode: myRoomCode, playerId }, (res) => {
      const stats = (res && res.ok) ? res.stats : null;
      playerStatsCache.set(playerId, stats);
      // The popover may have already been closed or swapped to a different
      // player by the time this ack comes back -- only touch the DOM if
      // it's still showing for THIS player.
      if (openPlayerActionForId !== playerId) return;
      const liveEl = document.querySelector('.player-action-popover .player-action-stats');
      if (liveEl) applyStatsToEl(liveEl, stats);
    });
  }

  function buildPlayerActionPopover(playerId, name, alignClass) {
    const pop = document.createElement('div');
    pop.className = 'player-action-popover' + (alignClass ? ' ' + alignClass : '');
    pop.onclick = (e) => e.stopPropagation(); // don't let the outside-click closer catch this

    const statsEl = document.createElement('div');
    statsEl.className = 'player-action-stats';
    pop.appendChild(statsEl);
    loadStatsIntoPopover(playerId, statsEl);

    const flagIcon = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 2a1 1 0 0 1 1 1v18a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Z"/><path d="M6 3.5c2-1 4-1 6 0s4 1 6 0v9c-2 1-4 1-6 0s-4-1-6 0v-9Z"/></svg>';
    const soundOnIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>';
    const soundOffIcon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4Z"/><path d="m17 9 4 4M21 9l-4 4"/></svg>';

    const reportBtn = document.createElement('button');
    reportBtn.type = 'button';
    reportBtn.className = 'player-action-btn report';
    reportBtn.innerHTML = `${flagIcon}<span class="pa-label">Report ${escapeHtml(name)}</span>`;
    reportBtn.onclick = () => {
      reportBtn.disabled = true;
      reportBtn.querySelector('.pa-label').textContent = 'Reporting...';
      socket.emit('report_player', {
        roomCode: myRoomCode,
        reportedPlayerId: playerId,
        reportedName: name,
        messageType: 'general',
        messageText: '',
      }, (res) => {
        reportBtn.querySelector('.pa-label').textContent = res && res.ok ? 'Reported' : 'Failed, try again';
        if (res && res.ok) logAnalytics('player_reported');
        setTimeout(closePlayerActionPopover, 900);
      });
    };

    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'player-action-btn mute';
    const muted = isMuted(playerId);
    muteBtn.innerHTML = `${muted ? soundOnIcon : soundOffIcon}<span class="pa-label">${muted ? 'Unmute' : 'Mute'} ${escapeHtml(name)}</span>`;
    muteBtn.onclick = () => {
      if (isMuted(playerId)) unmutePlayer(playerId); else mutePlayer(playerId, name);
      closePlayerActionPopover();
    };

    pop.appendChild(reportBtn);
    pop.appendChild(muteBtn);
    return pop;
  }

  // anchorEl must already be a positioning context (both .seat and the lobby
  // <li> are) -- the popover is just appended as its child and placed with
  // plain CSS, no JS measurement needed.
  function showPlayerActionPopover(anchorEl, playerId, name, alignClass) {
    closePlayerActionPopover();
    if (!anchorEl) return;
    openPlayerActionForId = playerId;
    anchorEl.appendChild(buildPlayerActionPopover(playerId, name, alignClass));
  }

  function togglePlayerActionPopover(anchorEl, playerId, name, alignClass) {
    if (openPlayerActionForId === playerId) { closePlayerActionPopover(); return; }
    showPlayerActionPopover(anchorEl, playerId, name, alignClass);
  }

  // Called at the end of renderOvalTable()/renderLobby() -- if a popover was
  // open for a player who's still on screen after the rebuild, put it right
  // back instead of letting it silently disappear mid-decision.
  function reopenPlayerActionPopoverIfNeeded(container) {
    if (!openPlayerActionForId) return;
    const anchorEl = container.querySelector(`[data-player-id="${CSS.escape(openPlayerActionForId)}"]`);
    if (!anchorEl) { openPlayerActionForId = null; return; }
    const alignClass = anchorEl.dataset.popoverAlign || '';
    anchorEl.appendChild(buildPlayerActionPopover(openPlayerActionForId, playerName(openPlayerActionForId), alignClass));
  }

  document.addEventListener('click', () => closePlayerActionPopover());

  function loadChatHistory(history) {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const visible = (history || []).filter((m) => !isMuted(m.playerId));
    if (visible.length === 0) {
      container.innerHTML = '<div class="chat-empty">No messages yet</div>';
      return;
    }
    visible.forEach((m) => appendChatMessage(m, { silent: true }));
  }

  // Used both by the manual close button and by the auto-minimize-on-your-
  // turn hook in playSoundsForTransition() -- safe to call even if the
  // panel is already closed (chat-fab just re-shows itself, a no-op if
  // it's already visible).
  function minimizeChatPanel() {
    const panel = document.getElementById('chat-panel');
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    document.getElementById('chat-fab').classList.remove('hidden');
  }

  // Timestamp of the last time the player actually touched the chat panel
  // (scrolling history, or typing) -- used below to stop the your-turn
  // auto-minimize hook from yanking the panel shut mid-scroll/mid-type.
  // Without this, minimizeChatPanel() fires unconditionally the instant
  // your turn starts, even if you're mid-gesture reading old messages --
  // which felt exactly like "the chat won't let me scroll", because it got
  // ripped away under your finger every time turns cycled back to you.
  let chatLastInteractionAt = 0;
  const markChatInteraction = () => { chatLastInteractionAt = Date.now(); };
  document.querySelector('.chat-messages').addEventListener('scroll', markChatInteraction, { passive: true });
  document.querySelector('.chat-messages').addEventListener('touchstart', markChatInteraction, { passive: true });
  document.getElementById('chat-input').addEventListener('input', markChatInteraction);
  document.getElementById('chat-input').addEventListener('focus', markChatInteraction);

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
    socket.emit('chat_message', { roomCode: myRoomCode, type: 'text', text }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
    input.value = '';
  }
  document.getElementById('btn-chat-send').onclick = sendChat;
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  socket.on('chat_message', (msg) => {
    if (isMuted(msg.playerId)) return; // muted -- skip both the panel message and the seat bubble
    appendChatMessage(msg);
    // Speech bubble at the sender's seat, in addition to the panel above --
    // only meaningful once seats actually exist (mid-game), not lobby chat.
    if (latestGame) triggerChatBubble(msg.playerId, msg);
  });

  // ---------------- GIF picker ----------------
  // The quick-tap chips now load from a small self-hosted meme library
  // (public/memes/<category>/*.gif, ~150 GIFs total) instead of hitting the
  // live Giphy API on every tap -- instant, no rate limit, no network call.
  // The free-text search box still falls back to live Giphy search for
  // anything outside that curated set.
  const GIF_CATEGORIES = [
    { label: 'Telugu', key: 'telugu_memes_general' },
    { label: 'Tollywood', key: 'tollywood_memes' },
    { label: 'Brahmanandam', key: 'brahmanandam' },
    { label: 'Ali', key: 'ali' },
    { label: 'Venu Madhav', key: 'venu_madhav' },
    { label: 'MS Narayana', key: 'ms_narayana' },
    { label: 'Sunil', key: 'sunil' },
    { label: 'Satya', key: 'satya_akkala' },
  ];
  let localMemeManifest = null; // { category: [filenames] }, fetched once
  let gifSearchTimer = null;

  // Giphy's free key is capped at 100 calls/hour total, shared by everyone
  // in every room on the whole app. Only the free-text search box below
  // still uses it now, but results are still cached for a few minutes so
  // retyping/retapping the same query doesn't fire a fresh call each time.
  const GIF_CACHE_TTL_MS = 10 * 60 * 1000;
  const gifResultsCache = new Map(); // normalized query -> { gifs, ts }

  function loadLocalManifest() {
    if (localMemeManifest) return Promise.resolve(localMemeManifest);
    return fetch('/memes/manifest.json')
      .then((r) => r.json())
      .then((data) => { localMemeManifest = data; return data; })
      .catch(() => { localMemeManifest = {}; return {}; });
  }

  function renderGifSuggestions() {
    const wrap = document.getElementById('gif-suggestions');
    wrap.innerHTML = '';
    GIF_CATEGORIES.forEach((cat) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gif-suggestion-chip';
      chip.textContent = cat.label;
      chip.onclick = () => {
        document.getElementById('gif-search-input').value = '';
        loadLocalCategory(cat.key);
      };
      wrap.appendChild(chip);
    });
  }

  function loadLocalCategory(categoryKey) {
    const results = document.getElementById('gif-results');
    results.innerHTML = '<div class="gif-results-hint">Loading...</div>';
    loadLocalManifest().then((manifest) => {
      const files = manifest[categoryKey] || [];
      const gifs = files.map((f) => {
        const url = `/memes/${categoryKey}/${f}`;
        return { preview: url, full: url };
      });
      renderGifTiles(gifs);
    });
  }

  // Default view when the picker opens: a shuffled sample pulled across
  // every local category, so there's always something to browse without
  // typing or tapping a chip first.
  function loadLocalMixed() {
    const results = document.getElementById('gif-results');
    results.innerHTML = '<div class="gif-results-hint">Loading...</div>';
    loadLocalManifest().then((manifest) => {
      const all = [];
      Object.keys(manifest).forEach((cat) => {
        (manifest[cat] || []).forEach((f) => all.push({ cat, f }));
      });
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      const gifs = all.slice(0, 24).map(({ cat, f }) => {
        const url = `/memes/${cat}/${f}`;
        return { preview: url, full: url };
      });
      renderGifTiles(gifs);
    });
  }

  function openGifPicker() {
    document.getElementById('gif-picker').classList.remove('hidden');
    const input = document.getElementById('gif-search-input');
    input.value = '';
    input.focus();
    renderGifSuggestions();
    loadLocalMixed();
  }
  function closeGifPicker() {
    document.getElementById('gif-picker').classList.add('hidden');
  }
  document.getElementById('btn-gif-open').onclick = () => {
    const picker = document.getElementById('gif-picker');
    if (picker.classList.contains('hidden')) openGifPicker();
    else closeGifPicker();
  };
  document.getElementById('btn-gif-close').onclick = closeGifPicker;
  document.getElementById('gif-search-input').addEventListener('input', (e) => {
    const q = e.target.value;
    if (gifSearchTimer) clearTimeout(gifSearchTimer);
    if (!q.trim()) {
      // Empty box -- back to the local mixed view, no API call at all.
      loadLocalMixed();
      return;
    }
    // Waits a bit longer after you stop typing before actually searching --
    // fewer wasted calls for someone still mid-word, at the cost of feeling
    // very slightly less instant. This still hits live Giphy search since
    // it's a custom typed query, not one of the local quick-tap categories.
    gifSearchTimer = setTimeout(() => loadGifResults(q), 550);
  });

  function renderGifTiles(gifs) {
    const results = document.getElementById('gif-results');
    results.innerHTML = '';
    if (!gifs || gifs.length === 0) {
      results.innerHTML = '<div class="gif-results-hint">No GIFs found</div>';
      return;
    }
    gifs.forEach((g) => {
      const img = document.createElement('img');
      img.src = g.preview;
      img.loading = 'lazy';
      img.alt = 'GIF result';
      img.onclick = () => sendGif(g.full);
      results.appendChild(img);
    });
  }

  function loadGifResults(query) {
    const key = (query || '').trim().toLowerCase();
    const cached = gifResultsCache.get(key);
    if (cached && Date.now() - cached.ts < GIF_CACHE_TTL_MS) {
      renderGifTiles(cached.gifs);
      return;
    }
    const results = document.getElementById('gif-results');
    results.innerHTML = '<div class="gif-results-hint">Searching...</div>';
    fetch('/api/gif-search?q=' + encodeURIComponent(query || ''))
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) {
          results.innerHTML = `<div class="gif-results-hint">${escapeHtml(data.error || 'GIF search unavailable')}</div>`;
          return;
        }
        gifResultsCache.set(key, { gifs: data.gifs || [], ts: Date.now() });
        renderGifTiles(data.gifs);
      })
      .catch(() => {
        results.innerHTML = '<div class="gif-results-hint">GIF search failed</div>';
      });
  }

  function sendGif(url) {
    socket.emit('chat_message', { roomCode: myRoomCode, type: 'gif', gifUrl: url }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
    closeGifPicker();
  }

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
      // Chat panel is a fixed bottom sheet that can cover the whole table
      // and timer -- if it's open right as your turn starts, minimize it
      // back to the floating bubble automatically so you can't miss your
      // own turn. Chat is still one tap away via the bubble; this doesn't
      // close it forever, just stops it from silently sitting over the
      // timer during the moment that matters most.
      // EXCEPTION: skip this if the player touched the chat panel (scrolled
      // or typed) within the last 3 seconds -- otherwise this fires mid-
      // scroll/mid-type and rips the panel away, which is what made chat
      // feel broken/unscrollable during real games with fast turn cycles.
      if (Date.now() - chatLastInteractionAt > 3000) {
        minimizeChatPanel();
      }
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
      ? `You drew ${cards.length} cards`
      : 'You drew';
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
        // Same cleanup leaveRoom() already does -- without it, a failed
        // rejoin sent you back to the landing screen but left the red chat
        // FAB (and, if it was open, the whole chat panel) floating on top,
        // covering the footer nav underneath.
        hideChatUI();
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
    // Top up the name cache with everyone currently in the room -- see
    // knownPlayerNames/playerName() above. Cheap no-op for names already known.
    room.players.forEach((p) => { knownPlayerNames[p.playerId] = p.name; });
    if (room.phase === 'lobby') {
      latestGame = null;
      window.__lastRoundResultShownFor = null;
      document.getElementById('overlay-round-result').classList.add('hidden');
      document.getElementById('overlay-gameover').classList.add('hidden');
      renderLobby(room);
      showScreen('screen-lobby');
    } else if (room.phase === 'starting') {
      // The countdown/dealing sequence (driven entirely by the separate
      // 'game_starting' event, via runStartSequence) owns the screen during
      // this phase. room_update for 'starting' arrives an instant BEFORE
      // 'game_starting' every time a new round begins -- calling
      // renderGame(latestGame) here would briefly redraw the board using
      // last round's already-finished data (its real joker/open card still
      // sitting in latestGame), flashing it on screen before the new deal
      // even starts. Just make sure we're on the game screen and let
      // runStartSequence take it from here.
      showScreen('screen-game');
    } else if (latestGame) {
      showScreen('screen-game');
      renderGame(latestGame);
      // Keep the round-result popup's host controls (Next Round button,
      // max-score dropdown) in sync even when the popup itself isn't being
      // freshly shown -- e.g. a host who was eliminated leaves mid-popup and
      // hands host to someone else; this re-evaluates who can now act.
      updateRoundResultHostControls();
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
    updateMyTurnPulseTimer(prev, game);
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
