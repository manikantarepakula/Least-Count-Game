(function () {
  const socket = io();

  // Which build is this player actually on? The same server and the same
  // web code back both the website and the Capacitor-wrapped Android app,
  // so without this flag the two are indistinguishable server-side -- which
  // made the tester-activity report unable to answer the one question it
  // exists for: "are my PLAY STORE testers playing, or is that traffic just
  // people on the website?". window.Capacitor only exists inside the native
  // app (same check admob-init.js uses to decide whether to show ads).
  const CLIENT_PLATFORM =
    (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
      ? 'android-app'
      : 'web';

  // --------------------------------------------------------------------
  // Feature flags (Sept 2026). Both of these are FINISHED, WORKING features
  // that are deliberately hidden for launch -- flip either to true to bring
  // it back, no other change needed. Nothing else in the app is gated on
  // them, which is exactly why they can be hidden safely:
  //
  //   googleSignIn -- Firebase signs EVERY player in anonymously on load
  //     (see firebase-init.js), and that anonymous uid is what stats, the
  //     activity log, the tester-activity report, opponent stats and
  //     RevenueCat all key off. Google is only an upgrade path, so that the
  //     same uid can follow someone to a new device. Hidden for now because
  //     native Google Sign-In returns "no credentials available" on phones
  //     other than the dev device, and a visibly failing button on the
  //     Profile screen is worse than no button at all. The only thing lost
  //     while it's off: a reinstall or a new phone starts a fresh uid, so
  //     that player's win count resets.
  //
  //   removeAdsPurchase -- hides the BUY button only. The entitlement check
  //     below still runs in full, so anyone who already purchased keeps
  //     their ad-free experience; they simply can't be sold it again, and
  //     nobody new is offered it. Deliberate: monetisation waits until
  //     people are playing regularly.
  //
  //   installPrompt -- ON. A card at the foot of the game-over scorecard
  //     asking website players to install the Android app. Never shows inside
  //     the app itself (the gate's first line is CLIENT_PLATFORM !== 'web')
  //     and never on arrival, only after a FINISHED game.
  //
  //     Who it actually converts, while the app is in closed testing: people
  //     already on the tester list who keep playing on the website anyway.
  //     That is the single biggest risk to the 14-day window, so this is
  //     aimed straight at it. Anyone NOT on the tester list who taps Install
  //     will be told they aren't eligible -- unavoidable until the tester
  //     list is a public Google Group, or production access is granted.
  //
  //     After production access: change INSTALL_URL to the /store/apps/details
  //     link below and it converts everyone. Nothing else needs to move.
  // --------------------------------------------------------------------
  const FEATURES = {
    googleSignIn: false,
    removeAdsPurchase: false,
    installPrompt: true,
  };

  // Group chat sheet state. Declared HERE, at the very top, rather than with
  // the rest of the group state further down: showScreen() reads
  // groupChatExpanded, and showScreen is defined (and can be called) well
  // above that point. `let` is not hoisted, so declaring it lower down would
  // leave a temporal-dead-zone window where an early showScreen() throws.
  let groupChatExpanded = false;
  let groupChatSeenAt = 0;

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
  // Our own Firebase uid. Group payloads identify people by uid (never by
  // playerId, which is per-room and changes every session), so the screen
  // needs this to tell which row is us.
  function myFirebaseUid() {
    const user = window.LCAuth && window.LCAuth.getUser();
    return user ? user.uid : null;
  }

  // --------------------------------------------------------------------
  // WAIT for sign-in rather than giving up on it.
  //
  // Firebase's anonymous sign-in is asynchronous, and LCAuth.getUser() is
  // null until it resolves. This function used to return null in that
  // window -- and the server turns a null token into
  //   "Could not identify you -- try again in a moment."
  // for EVERY group action (join/raise hand, chat, start marathon, start
  // game; see verifyFirebaseToken in server.js). Reported by real players
  // who entered a group code and were refused.
  //
  // First-time visitors are hit hardest: they need a full anonymous
  // SIGN-UP round trip, not a cached-token refresh -- which is exactly the
  // person arriving from a shared WhatsApp link on mobile data. A returning
  // player's session is already in IndexedDB and resolves almost at once,
  // which is why this looked like "works for some people, not others".
  //
  // This is very likely the same root cause as the group-start deadlock
  // hunt, where LCAuth.getUser() was found returning null inside a client
  // that was otherwise working. That one was worked around by removing the
  // dependency; this fixes the cause.
  // --------------------------------------------------------------------
  const AUTH_WAIT_MS = 8000;
  let authReadyPromise = null;

  function whenFirebaseUser() {
    const existing = window.LCAuth && window.LCAuth.getUser();
    if (existing) return Promise.resolve(existing);
    if (!window.LCAuth) return Promise.resolve(null);
    if (!authReadyPromise) {
      authReadyPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (u) => {
          if (settled) return;
          settled = true;
          resolve(u || null);
        };
        // Bounded. A sign-in that never completes must not leave a button
        // dead forever -- after the timeout we hand back null, the server
        // refuses with its own message, and the player can retry. Clearing
        // the cached promise is what makes that retry a FRESH wait rather
        // than an instant replay of this null.
        const timer = setTimeout(() => { authReadyPromise = null; finish(null); }, AUTH_WAIT_MS);
        window.LCAuth.onUserChange((u) => {
          if (!u) return;
          clearTimeout(timer);
          finish(u);
        });
      });
    }
    return authReadyPromise;
  }

  async function currentFirebaseIdToken() {
    let user = window.LCAuth && window.LCAuth.getUser();
    if (!user) user = await whenFirebaseUser();
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

  // Hides the whole signin row (status text AND button) rather than just the
  // button, so the Profile panel doesn't keep a stranded "Playing as Guest"
  // label with nothing to do about it -- and so the failed-sign-in error
  // that was rendering into this row can't appear either.
  const signinRowEl = document.querySelector('.signin-row');
  if (!FEATURES.googleSignIn && signinRowEl) signinRowEl.classList.add('hidden');

  function updateSigninUI(user) {
    if (!FEATURES.googleSignIn) return;
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

  // Developer override: forces ads back on for THIS device even when the
  // Remove Ads entitlement is active. Exists because making a test purchase
  // permanently hides every ad on the tester's own phone, which then makes
  // it impossible to check ad work without borrowing somebody else's device.
  //
  // Purely a display override -- it does not touch the purchase, the
  // entitlement, or RevenueCat in any way, and it only affects the phone
  // it's typed on. Turn on from the chrome://inspect console with:
  //   localStorage.setItem('lc_force_ads','1'); location.reload();
  // and off again with:
  //   localStorage.removeItem('lc_force_ads'); location.reload();
  let forceAdsForTesting = false;
  try {
    forceAdsForTesting = localStorage.getItem('lc_force_ads') === '1';
  } catch (e) { /* storage blocked -- behave normally */ }
  if (forceAdsForTesting) {
    console.log('[AdMob] lc_force_ads is ON -- ads shown even though Remove Ads may be purchased.');
  }

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
    // Applied after the real check, so the entitlement is still read and
    // logged normally -- this only overrides what the UI does about it.
    if (forceAdsForTesting) adsRemoved = false;
    if (adsRemoved) {
      removeAdsBtn.classList.add('hidden');
      if (window.LCAds) window.LCAds.hideBanner();
    } else if (FEATURES.removeAdsPurchase) {
      removeAdsBtn.classList.remove('hidden');
    } else {
      // Purchase hidden for launch. Note this branch is reached only when
      // adsRemoved is FALSE -- the entitlement check above still ran, and an
      // existing purchaser took the branch before this one and kept their
      // ad-free experience. Hiding the button sells to nobody new; it takes
      // nothing away from anyone who already paid.
      removeAdsBtn.classList.add('hidden');
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
        // The purchase itself always goes through; the override only decides
        // whether THIS device then acts on it, so a tester can buy again and
        // still keep seeing ads to check them.
        adsRemoved = !forceAdsForTesting;
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
    // Guarded: this runs at module construction, so a localStorage throw
    // here (private mode, storage disabled) would take out the entire
    // Sound object and with it every call site in the app.
    let muted = (() => {
      try { return localStorage.getItem('leastcount_muted') === '1'; } catch (e) { return false; }
    })();

    // Never throws. Constructing an AudioContext can fail outright -- some
    // Android WebViews refuse it under autoplay policy, and a device that
    // has hit its audio-context limit throws too. This is the bottom of
    // the sound stack, so a throw here would escape through every cue.
    let ctxFailed = false;
    function ensureCtx() {
      if (ctxFailed) return null;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { ctxFailed = true; return null; }
        if (!ctx) ctx = new AC();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch (e) {
        // Latch the failure: retrying on every single card tap would mean
        // a throw-and-catch hundreds of times a game.
        ctxFailed = true;
        ctx = null;
        console.warn('[sound] audio unavailable on this device:', e && e.message);
        return null;
      }
    }

    // ------------------------------------------------------------------
    // MASTER BUS + REVERB SEND (Sept 2026 rebuild)
    //
    // Every voice used to connect straight to ctx.destination. That is the
    // single biggest reason the old cues were described as "dry and
    // lifeless": a sound that stops dead the instant its envelope closes
    // has no space around it, and the ear reads that as cheap. Real game
    // audio is almost never heard bone-dry -- there is always a short tail.
    //
    // So: everything now goes through master, and voices that want depth
    // also feed a send into a small convolution reverb. The impulse
    // response is generated here rather than loaded, so this still costs
    // zero bytes of download.
    //
    // MASTER_GAIN is deliberately the one knob that controls overall
    // loudness. If the whole game is too loud or too quiet after this
    // rebuild, that is the number to move -- not the 12 individual cues.
    // ------------------------------------------------------------------
    const MASTER_GAIN = 0.95;
    const REVERB_GAIN = 0.22;
    let master = null;
    let reverbSend = null;

    // A decaying noise burst IS an impulse response -- that's all a small
    // room is, mathematically. Stereo, slightly different per channel so
    // the tail has a little width instead of sitting dead centre.
    function buildImpulse(c, seconds, decay) {
      const len = Math.max(1, Math.floor(c.sampleRate * seconds));
      const buf = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          // (1 - i/len)^decay gives the exponential-ish fade; the noise
          // gives it the density that makes it read as a room.
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
      }
      return buf;
    }

    // Returns { master, send } or null. Built lazily on first sound and
    // cached. If anything in here fails (old WebView, no ConvolverNode)
    // we fall back to a bare master gain with no send, and every cue
    // still plays -- just dry. Never throws.
    function ensureBus() {
      const c = ensureCtx();
      if (!c) return null;
      if (master) return { master, send: reverbSend };
      try {
        master = c.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(c.destination);
      } catch (e) {
        master = null;
        return null;
      }
      try {
        const conv = c.createConvolver();
        conv.buffer = buildImpulse(c, 0.45, 2.6);
        const wet = c.createGain();
        wet.gain.value = REVERB_GAIN;
        reverbSend = c.createGain();
        reverbSend.gain.value = 1;
        reverbSend.connect(conv).connect(wet).connect(master);
      } catch (e) {
        // No reverb available -- dry is worse, but silent is far worse.
        reverbSend = null;
      }
      return { master, send: reverbSend };
    }

    // Connect a voice's output to the master, and optionally bleed some of
    // it into the reverb. `wet` is 0..1.
    function routeOut(node, wet) {
      const bus = ensureBus();
      if (!bus) return false;
      node.connect(bus.master);
      if (wet > 0 && bus.send) {
        try {
          const c = ensureCtx();
          const s = c.createGain();
          s.gain.value = wet;
          node.connect(s).connect(bus.send);
        } catch (e) { /* dry is fine */ }
      }
      return true;
    }

    // Small random spread, used everywhere below. Repetition is the enemy
    // of a good game sound: the discard cue fires hundreds of times in a
    // single game, and byte-identical playback is precisely what makes
    // players reach for the mute button. A few percent of pitch and timing
    // jitter is enough for the ear to stop noticing the loop.
    function rnd(a, b) { return a + Math.random() * (b - a); }

    // Deal-tick throttle state. Lives here (module scope) rather than at the
    // call site so the rate holds no matter who calls dealTick() or how
    // often -- the deal animation's own pace scales with player count and
    // must not be allowed to set the audio pace.
    let lastDealTickAt = 0;
    let dealTickGap = 170;

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
      osc.connect(gain);
      if (!routeOut(gain, opts.wet || 0)) return;
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

      src.connect(filter).connect(gain);
      if (!routeOut(gain, opts.wet === undefined ? 0.18 : opts.wet)) return;
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
    function cardRiffle(count, gainScale) {
      count = Math.max(1, count || 1);
      const gs = gainScale === undefined ? 1 : gainScale;
      const n = Math.min(count, 8); // cap the sound even if the draw itself is huge
      for (let i = 0; i < n; i++) {
        const delay = (i / n) * (0.1 + n * 0.02) + Math.random() * 0.015;
        noiseBurst({
          duration: 0.04, filterType: 'bandpass',
          freqStart: 3200 + Math.random() * 1400, freqEnd: 1800, q: 1.5,
          gain: 0.38 * gs, delay, wet: gs < 1 ? 0.55 : 0.24,
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

    // ==================================================================
    // RECORDED SAMPLES
    //
    // Every cue goes through play(name, fallback). If recorded audio has
    // been loaded for that cue it plays; otherwise the synthesised
    // fallback runs. So a pack can replace ONE cue or ALL of them, in any
    // order, and a missing file is never an error -- it just means that
    // particular cue stays synthesised.
    //
    // Synthesis got the CHARACTER right (layering, levels, space). What it
    // can't produce is the TEXTURE of real cardstock -- that needs a
    // recording. This is the path for that.
    //
    // Install: drop files into public/sounds/ and list them in
    // public/sounds/manifest.json. Nothing else in the app changes.
    //
    // Three things this deliberately does:
    //
    //  1. VARIANTS. A cue can have several files and picks one at random
    //     per play. The discard fires hundreds of times a game -- a single
    //     recorded file repeated identically is far MORE fatiguing than
    //     synthesis was, because a real recording has no natural jitter.
    //     This is the most common way a sample pack makes a game worse.
    //
    //  2. PER-CUE GAIN. Packs are mastered at wildly different levels.
    //     Trim in the manifest rather than re-encoding audio.
    //
    //  3. THE MASTER BUS. Samples route through the same gain and reverb
    //     send as the synth (the old code here connected straight to
    //     ctx.destination, which would have made recorded cues bypass both
    //     and sit oddly dry and loud next to the synthesised ones).
    // ==================================================================
    const SAMPLES = Object.create(null);   // name -> { buffers: [], gain, wet }
    let samplesReady = false;

    function play(name, fallback) {
      if (muted) return;
      const entry = SAMPLES[name];
      if (!entry || !entry.buffers.length) { fallback(); return; }
      const c = ensureCtx();
      if (!c) { fallback(); return; }
      try {
        const buf = entry.buffers.length === 1
          ? entry.buffers[0]
          : entry.buffers[Math.floor(Math.random() * entry.buffers.length)];
        const src = c.createBufferSource();
        const g = c.createGain();
        g.gain.value = entry.gain;
        // Small random detune on every play. Costs nothing and is most of
        // what stops a repeated sample from sounding mechanical.
        src.playbackRate.value = rnd(0.97, 1.03);
        src.buffer = buf;
        src.connect(g);
        if (!routeOut(g, entry.wet)) { fallback(); return; }
        src.start();
      } catch (e) {
        // A decoded buffer that won't play is still better handled by the
        // synth than by silence.
        fallback();
      }
    }

    // Reads public/sounds/manifest.json, if it exists. Absent manifest =
    // exactly one 404 and then pure synthesis, forever, silently -- which
    // is the state the app ships in today.
    //
    // Manifest shape:
    //   { "discard": { "files": ["card_a.wav","card_b.wav"], "gain": 0.9 },
    //     "opponentDiscard": { "sameAs": "discard", "gain": 0.4, "wet": 0.6 } }
    //
    // "sameAs" reuses another cue's already-decoded audio at a different
    // level -- that is how an opponent's discard becomes the same card at
    // a distance without shipping the file twice.
    async function loadSamples() {
      if (samplesReady) return;
      samplesReady = true;
      const c = ensureCtx();
      if (!c || !window.fetch) return;

      let manifest = null;
      try {
        const res = await fetch('sounds/manifest.json', { cache: 'force-cache' });
        if (!res.ok) return;              // no pack installed
        manifest = await res.json();
      } catch (e) {
        return;                            // offline, malformed JSON, whatever
      }
      if (!manifest || typeof manifest !== 'object') return;

      const direct = Object.keys(manifest).filter((k) => !manifest[k].sameAs);
      const aliases = Object.keys(manifest).filter((k) => manifest[k].sameAs);

      await Promise.all(direct.map(async (cue) => {
        const spec = manifest[cue] || {};
        const files = Array.isArray(spec.files) ? spec.files : (spec.file ? [spec.file] : []);
        const buffers = [];
        await Promise.all(files.map(async (f) => {
          try {
            const r = await fetch('sounds/' + f, { cache: 'force-cache' });
            if (!r.ok) return;
            const bytes = await r.arrayBuffer();
            // decodeAudioData is promise-based in modern engines but
            // callback-only in older WebViews -- support both.
            const buf = await new Promise((resolve, reject) => {
              const p = c.decodeAudioData(bytes, resolve, reject);
              if (p && typeof p.then === 'function') p.then(resolve, reject);
            });
            if (buf) buffers.push(buf);
          } catch (e) {
            console.warn('[sound] could not load sounds/' + f + ':', e && e.message);
          }
        }));
        if (buffers.length) {
          SAMPLES[cue] = {
            buffers,
            gain: typeof spec.gain === 'number' ? spec.gain : 0.9,
            wet: typeof spec.wet === 'number' ? spec.wet : 0.25,
          };
        }
      }));

      aliases.forEach((cue) => {
        const spec = manifest[cue];
        const base = SAMPLES[spec.sameAs];
        if (!base) return;                 // source cue had no usable files
        SAMPLES[cue] = {
          buffers: base.buffers,
          gain: typeof spec.gain === 'number' ? spec.gain : base.gain,
          wet: typeof spec.wet === 'number' ? spec.wet : base.wet,
        };
      });

      const loaded = Object.keys(SAMPLES);
      if (loaded.length) {
        console.log('[sound] recorded audio active for: ' + loaded.join(', ')
          + ' (all other cues remain synthesised)');
      }
    }

    // Two-oscillator voice with a soft attack. The old cues were bare sine
    // and sawtooth tones with an instant onset, which is exactly what makes
    // a sound read as a "beep" -- a detuned second voice and a few ms of
    // attack are most of the difference between a beep and a note.
    function warm(freq, duration, opts) {
      opts = opts || {};
      if (muted) return;
      const c = ensureCtx();
      if (!c) return;
      const t0 = c.currentTime + (opts.delay || 0);
      const g = c.createGain();
      const peak = opts.gain || 0.16;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + duration);
      const filt = c.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(opts.cutoff || 2600, t0);
      [0, opts.detune || 7].forEach((cents, i) => {
        const o = c.createOscillator();
        o.type = i === 0 ? (opts.type || 'triangle') : 'sine';
        o.frequency.setValueAtTime(freq, t0);
        o.detune.setValueAtTime(cents, t0);
        o.connect(filt);
        o.start(t0);
        o.stop(t0 + duration + 0.05);
      });
      filt.connect(g);
      routeOut(g, opts.wet === undefined ? 0.3 : opts.wet);
    }
    function warmSeq(notes) {
      notes.forEach((n) => warm(n[0], n[1], { delay: n[2], gain: n[3], type: n[4] }));
    }

    // ------------------------------------------------------------------
    // LAYERING HELPERS (Sept 2026 rebuild)
    //
    // "Juicy" game audio is not a property of any single recording -- it is
    // a stack. A satisfying discard in a polished card game is typically
    // four things fired within ~20ms of each other:
    //
    //   1. a swoosh   (the card moving through air)
    //   2. a transient (the snap of it landing)
    //   3. a thump     (low-end body, so it has weight on a phone speaker)
    //   4. a blip      (a PITCHED element -- the part that makes it feel
    //                   designed rather than recorded)
    //
    // The old cues had exactly one of those four, which is why they read as
    // thin no matter how the noise was filtered. Layer 4 in particular was
    // completely absent from every card sound.
    // ------------------------------------------------------------------

    // A pitched tone that glides from one frequency to another. Short
    // downward glides feel like something landing; upward feels like
    // something being picked up or confirmed.
    function blip(from, to, duration, opts) {
      opts = opts || {};
      if (muted) return;
      const c = ensureCtx();
      if (!c) return;
      const t0 = c.currentTime + (opts.delay || 0);
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = opts.type || 'triangle';
      osc.frequency.setValueAtTime(from, t0);
      if (to && to !== from) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + duration);
      }
      const peak = opts.gain || 0.12;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + duration);
      osc.connect(g);
      if (!routeOut(g, opts.wet === undefined ? 0.25 : opts.wet)) return;
      osc.start(t0);
      osc.stop(t0 + duration + 0.04);
    }

    // Air movement. A wide bandpass swept across the spectrum -- downward
    // for something arriving, upward for something leaving.
    function swoosh(opts) {
      opts = opts || {};
      noiseBurst({
        duration: opts.duration || 0.13,
        filterType: 'bandpass',
        freqStart: opts.from || 5200,
        freqEnd: opts.to || 1100,
        q: 0.8,
        gain: opts.gain || 0.18,
        delay: opts.delay || 0,
        wet: opts.wet === undefined ? 0.3 : opts.wet,
      });
    }

    // Low-end weight. Phone speakers can barely reproduce this, but the
    // little they do produce is the difference between a sound that feels
    // like an object and one that feels like a notification.
    function thump(freq, duration, gain, delay) {
      blip(freq, freq * 0.6, duration, { gain, delay, type: 'sine', wet: 0.15 });
    }

    // Ascending high blips -- the "reward" garnish on good outcomes.
    // Intervals widen as it climbs so it reads as a flourish, not a scale.
    function sparkle(n, base, gain, delay) {
      for (let i = 0; i < n; i++) {
        const f = base * Math.pow(1.5, i) * rnd(0.97, 1.03);
        blip(f, f * 1.06, 0.09, {
          gain: Math.max(0.02, (gain || 0.07) * (1 - i * 0.12)),
          delay: (delay || 0) + i * 0.045,
          type: 'sine',
          wet: 0.42,
        });
      }
    }

    // A cue must NEVER be able to throw. A sound bug took the live game
    // down once already (the flourish ran before socket.emit and an
    // exception ate the turn). Wrapping here means that class of bug can
    // no longer escape this module, regardless of what the call site does.
    function safe(fn) {
      try { fn(); } catch (e) {
        console.warn('[sound] cue failed (ignored):', e && e.message);
      }
    }

    return {
      isMuted: () => muted,
      setMuted(v) {
        muted = v;
        // localStorage throws in private-mode WebViews and when storage is
        // full. Muting must still work for the session even if it can't be
        // remembered for the next one.
        try { localStorage.setItem('leastcount_muted', v ? '1' : '0'); } catch (e) { /* session-only */ }
      },
      // Runs on the first tap (audio can't start before a user gesture
      // anyway), so sample loading piggybacks on a moment the player is
      // already waiting through. Everything stays synthesised until the
      // files finish decoding -- there is no silent window.
      init() {
        safe(() => {
          ensureCtx();
          ensureBus();
          const p = loadSamples();
          if (p && p.catch) p.catch(() => { /* synth-only is a fine outcome */ });
        });
      },
      // Manual install, e.g. from the console while tuning:
      //   Sound.useSample('discard', decodedAudioBuffer, 0.9)
      useSample(name, buffer, gain, wet) {
        safe(() => {
          if (!buffer) return;
          if (!SAMPLES[name]) SAMPLES[name] = { buffers: [], gain: 0.9, wet: 0.25 };
          SAMPLES[name].buffers.push(buffer);
          if (typeof gain === 'number') SAMPLES[name].gain = gain;
          if (typeof wet === 'number') SAMPLES[name].wet = wet;
        });
      },

      // ---- your own actions ----
      // Selecting a card fires constantly, so it stays small and dry on
      // purpose: a big sound here would be exhausting inside two minutes.
      // Up for select, down for deselect, so the two are distinguishable
      // without looking at the screen.
      select() {
        safe(() => play('select', () => {
          const p = rnd(0.97, 1.03);
          cardSnap({ gain: 0.2 });
          blip(660 * p, 820 * p, 0.06, { gain: 0.07, type: 'sine', wet: 0.12 });
        }));
      },
      deselect() {
        safe(() => play('deselect', () => {
          const p = rnd(0.97, 1.03);
          cardSnap({ gain: 0.14 });
          blip(700 * p, 520 * p, 0.06, { gain: 0.055, type: 'sine', wet: 0.12 });
        }));
      },
      declareTap() {
        safe(() => play('declareTap', () => {
          warmSeq([[440, 0.1, 0, 0.18], [660, 0.14, 0.07, 0.18]]);
          sparkle(2, 1180, 0.05, 0.12);
        }));
      },

      // THE most important sound in the game -- it fires on every single
      // turn, hundreds of times a session. All four layers, and jittered
      // so the hundredth one doesn't sound like the first.
      discard() {
        safe(() => play('discard', () => {
          const p = rnd(0.94, 1.06);
          swoosh({ duration: 0.1, from: 5200, to: 1100, gain: 0.2 });
          cardSnap({ gain: 0.62 });
          thump(180 * p, 0.09, 0.16, 0.005);
          blip(880 * p, 520 * p, 0.13, { gain: 0.1, delay: 0.015, wet: 0.35 });
        }));
      },

      // ------------------------------------------------------------------
      // Penalty draw, WITH VALENCE.
      //
      // The old version knew only how many cards arrived, so dumping three
      // 10s and drawing a 2 (an excellent turn) sounded exactly like
      // shedding a 3 and drawing a King (a terrible one). Same cue, opposite
      // feelings -- which is precisely the complaint.
      //
      // `band` is decided by the caller from the net change in hand points
      // (see penaltyValence() further down). The riffle is common to all
      // bands -- cards physically arrive either way -- and the VERDICT is a
      // tonal phrase that lands just after it. Rising means you came out
      // ahead, falling means you didn't.
      //
      // Defaults to 'neutral' if no band is passed, so nothing breaks.
      // ------------------------------------------------------------------
      penaltyDraw(count, band) {
        safe(() => play('penaltyDraw', () => {
          const n = Math.max(1, count || 1);
          cardRiffle(n);
          const t = Math.min(n, 8) * 0.045;   // verdict lands after the riffle
          switch (band) {
            case 'jackpot':
              // Drew a Joker or this round's wild rank -- worth zero points.
              // You shed real value and picked up nothing. The one "penalty"
              // that is genuinely good news, and it should sound like it.
              blip(660, 990, 0.16, { gain: 0.14, delay: t, wet: 0.4 });
              sparkle(4, 1180, 0.085, t + 0.1);
              break;
            case 'good':
              blip(523, 784, 0.22, { gain: 0.13, delay: t, wet: 0.4 });
              sparkle(2, 1046, 0.06, t + 0.14);
              break;
            case 'bad':
              blip(520, 300, 0.32, { gain: 0.14, delay: t, wet: 0.4 });
              thump(140, 0.24, 0.15, t + 0.02);
              break;
            case 'brutal':
              // Reserved for a big net loss, or any multi-card +2 chain
              // penalty. Two falling layers and a double thump so it reads
              // as heavier than 'bad' rather than merely lower.
              blip(420, 190, 0.5, { gain: 0.16, delay: t, wet: 0.45 });
              blip(210, 130, 0.55, { gain: 0.1, delay: t + 0.05, type: 'sawtooth', wet: 0.35 });
              thump(120, 0.4, 0.2, t + 0.02);
              thump(100, 0.3, 0.14, t + 0.22);
              break;
            default: // neutral -- roughly a fair swap
              blip(560, 430, 0.26, { gain: 0.12, delay: t, wet: 0.4 });
              thump(150, 0.2, 0.12, t + 0.02);
          }
        }));
      },

      reshuffle() { safe(() => play('reshuffle', () => cardReshuffle())); },

      // Someone extended the +2 chain at you. Rising and tense, with real
      // low-end -- this is the one moment that should make you look up.
      chainAlert() {
        safe(() => play('chainAlert', () => {
          cardSnap({ gain: 0.7 });
          thump(150, 0.26, 0.2, 0.01);
          blip(300, 460, 0.28, { gain: 0.14, delay: 0.05, type: 'sawtooth', wet: 0.35 });
        }));
      },

      yourTurn() {
        safe(() => play('yourTurn', () => {
          warmSeq([[587, 0.12, 0, 0.2], [880, 0.2, 0.09, 0.2]]);
          sparkle(2, 1320, 0.05, 0.1);
        }));
      },

      declareCorrect() {
        safe(() => play('declareCorrect', () => {
          warmSeq([[523, 0.14, 0, 0.2], [659, 0.14, 0.1, 0.2], [784, 0.3, 0.2, 0.22]]);
          sparkle(4, 1046, 0.075, 0.24);
        }));
      },

      // Wrong declare. Falling, with a slight buzz underneath -- the
      // sawtooth is what makes it read as a mistake rather than just a
      // quieter success.
      declareWrong() {
        safe(() => play('declareWrong', () => {
          warmSeq([[311, 0.24, 0, 0.2, 'triangle'], [233, 0.38, 0.14, 0.19, 'triangle']]);
          blip(180, 120, 0.4, { gain: 0.1, delay: 0.06, type: 'sawtooth', wet: 0.3 });
        }));
      },

      win() {
        safe(() => play('win', () => {
          warmSeq([[523, 0.17, 0, 0.2], [659, 0.17, 0.12, 0.2], [784, 0.17, 0.24, 0.21], [1046, 0.45, 0.36, 0.23]]);
          sparkle(5, 1046, 0.085, 0.4);
          thump(160, 0.4, 0.16, 0.36);
        }));
      },

      // ==================================================================
      // OTHER PLAYERS' MOVES
      //
      // Until now only YOUR actions made any sound. In a six-player game
      // that means five of every six events at the table were silent --
      // the opponent's card visibly flew to the pile making no noise at
      // all. That is the single biggest reason the audio felt patchy.
      //
      // These are the same sounds as your own, but quieter and much wetter.
      // More reverb with less direct signal is how the ear judges distance,
      // so an opponent's discard lands as "across the table" rather than
      // "in my hands" -- you can tell whose turn it just was without
      // looking up, and your own moves stay unambiguously front and centre.
      // ==================================================================
      opponentDiscard() {
        safe(() => play('opponentDiscard', () => {
          const p = rnd(0.94, 1.06);
          swoosh({ duration: 0.11, from: 4200, to: 900, gain: 0.075, wet: 0.6 });
          cardSnap({ gain: 0.26 });
          blip(820 * p, 500 * p, 0.12, { gain: 0.042, delay: 0.015, wet: 0.6 });
        }));
      },

      // No valence here, and it isn't an oversight: the server only tells
      // you privately what YOU drew. For everyone else it broadcasts the
      // count and nothing more, so the value of their card is genuinely
      // unknown to this client. Making it valenced needs a server change.
      opponentDraw(count) {
        safe(() => play('opponentDraw', () => {
          cardRiffle(Math.max(1, count || 1), 0.4);
        }));
      },

      // ==================================================================
      // MOVES THAT USED TO BE SILENT
      // ==================================================================

      // Playing a 2 to push the chain on to the next player. The most
      // aggressive thing you can do in this game, and it made no sound
      // whatsoever. Rising and biting -- the mirror of chainAlert(), which
      // is what the victim hears.
      chainTwoPlay() {
        safe(() => play('chainTwoPlay', () => {
          cardSnap({ gain: 0.55 });
          blip(330, 620, 0.26, { gain: 0.15, delay: 0.02, type: 'sawtooth', wet: 0.3 });
          blip(660, 990, 0.18, { gain: 0.08, delay: 0.1, wet: 0.45 });
        }));
      },

      // Giving up and accepting the +2/+4/+6. Fires on the TAP, so the
      // button responds immediately; the cards themselves arrive a moment
      // later with their own (always brutal) penaltyDraw. Resigned, heavy,
      // no tonal rise at all.
      takePenalty() {
        safe(() => play('takePenalty', () => {
          thump(190, 0.2, 0.2, 0);
          blip(300, 180, 0.3, { gain: 0.12, delay: 0.02, type: 'triangle', wet: 0.35 });
        }));
      },

      // Somebody is out of the game. Heavier and lower when it's you.
      eliminated(isMe) {
        safe(() => play('eliminated', () => {
          const g = isMe ? 1 : 0.5;
          const base = isMe ? 330 : 392;
          warmSeq([[base, 0.3, 0, 0.19 * g, 'triangle'], [base * 0.75, 0.42, 0.18, 0.18 * g, 'triangle']]);
          blip(base * 0.5, base * 0.32, 0.6, { gain: 0.12 * g, delay: 0.1, type: 'sawtooth', wet: 0.4 });
          if (isMe) thump(110, 0.5, 0.18, 0.3);
        }));
      },

      // ------------------------------------------------------------------
      // DEALING. Rebuilt -- the first version was machine-gun clicking.
      //
      // The deal animation fires one card every 90ms, i.e. ELEVEN per
      // second, for 13 passes: 78 flights in a six-player game, 130 in a
      // ten-player one. A cue on every flight is a buzzsaw, not a deal. A
      // real dealer puts out three or four cards a second.
      //
      // Two changes. First, this throttles ITSELF rather than trusting the
      // call site, so the rate is right at any table size: extra calls
      // inside the window are dropped. Second, the pitched layer is gone.
      // Dealing has no pitch -- 78 rising tones read as a broken arpeggio,
      // and that was most of what made it grate.
      //
      // The interval is jittered so it lands like a hand, not a metronome.
      // ------------------------------------------------------------------
      dealTick() {
        safe(() => {
          const now = Date.now();
          if (now - lastDealTickAt < dealTickGap) return;
          lastDealTickAt = now;
          dealTickGap = rnd(140, 205);   // next gap: never mechanical
          play('dealTick', () => {
            // Flick only -- no low thud. A card leaving a dealer's hand is
            // all high-frequency transient; the body belongs to the card
            // LANDING, which is a different sound (discard).
            noiseBurst({
              duration: rnd(0.022, 0.032),
              filterType: 'bandpass',
              freqStart: rnd(3600, 5200),
              freqEnd: rnd(1600, 2300),
              q: 1.4,
              gain: rnd(0.085, 0.135),
              wet: 0.4,
            });
          });
        });
      },

      // Played once when the deal finishes: the dealer squaring the pile.
      // Gives the sequence an ending instead of the ticks just stopping.
      dealSettle() {
        safe(() => play('dealSettle', () => {
          cardSnap({ gain: 0.2 });
          thump(150, 0.14, 0.1, 0.01);
          shuffleBurst(7, 0.09, { gain: 0.07, dur: 0.012 });
        }));
      },

      // The deck-intro riffle. The visual shuffle (two halves zippering
      // together) played in silence, so the sequence opened with a moving
      // picture and no sound at all. Softer than the mid-game reshuffle --
      // this is scene-setting, not an event you need to notice.
      deckShuffle() {
        safe(() => play('deckShuffle', () => {
          shuffleBurst(26, 0.5, { gain: 0.13, dur: 0.015 });
          shuffleBurst(22, 0.5, { gain: 0.1, dur: 0.014, freqSpread: 2400 });
        }));
      },

      // Quiet, high and short. Chat must never compete with the table.
      chatMessage() {
        safe(() => play('chatMessage', () => {
          blip(880, 1170, 0.07, { gain: 0.055, wet: 0.45 });
          blip(1170, 1170, 0.09, { gain: 0.04, delay: 0.06, wet: 0.5 });
        }));
      },

      // Pairs with the existing 5-second vibration. Haptics alone reached
      // only the players whose phones vibrate -- a phone on loud-with-
      // vibration-off got no warning at all, and one on silent got no
      // sound. Two channels, so the warning actually lands either way.
      timerWarning() {
        safe(() => play('timerWarning', () => {
          blip(980, 980, 0.07, { gain: 0.13, type: 'square', wet: 0.2 });
          blip(980, 980, 0.07, { gain: 0.13, delay: 0.14, type: 'square', wet: 0.2 });
        }));
      },
    };
  })();

  // ------------------------------------------------------------------
  // PENALTY VALENCE
  //
  // A penalty draw is not one feeling. Shedding three 10s and picking up a
  // 2 is a great turn; shedding a single 3 and picking up a King is a
  // miserable one. Both currently cost you exactly one penalty card, and
  // both used to make exactly the same noise.
  //
  // What actually matters is the NET change in your hand's point total:
  //
  //     net = (points drawn) - (points discarded)
  //
  // Negative is good (your hand got lighter), positive is bad. This also
  // correctly rewards the big play: releasing three 10s for one penalty
  // card is a huge negative swing and should sound like a triumph.
  //
  // Jokers and the round's wild rank are worth ZERO, so drawing one is the
  // best possible outcome -- you gave up real points and took on none.
  // That gets its own band rather than being lumped in with "good".
  // ------------------------------------------------------------------
  function cardPoints(card, jokerRank) {
    if (!card) return 0;
    if (card.rank === 'JOKER') return 0;
    if (jokerRank && card.rank === jokerRank) return 0;
    if (card.rank === 'A') return 1;
    if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
    const n = parseInt(card.rank, 10);
    return isNaN(n) ? 0 : n;   // never NaN -- a NaN here would poison every comparison below
  }

  // What the player just put down, remembered only long enough to compare
  // it against what comes back. Cleared after use and time-limited, so a
  // stale discard can never be paired with an unrelated later draw.
  let lastDiscardInfo = null;
  const DISCARD_PAIRING_MS = 6000;

  function noteDiscardForValence(cards, jokerRank) {
    if (!cards || !cards.length) { lastDiscardInfo = null; return; }
    lastDiscardInfo = {
      points: cards.reduce((s, c) => s + cardPoints(c, jokerRank), 0),
      at: Date.now(),
    };
  }

  function penaltyValence(drawnCards, jokerRank) {
    const cards = drawnCards || [];
    if (!cards.length) return 'neutral';

    // Multi-card draws are ALWAYS a +2 chain penalty, and a chain penalty is
    // always bad news regardless of arithmetic: you take cards and give up
    // nothing in exchange, so there is no trade to evaluate.
    if (cards.length > 1) return 'brutal';

    const drawnPts = cardPoints(cards[0], jokerRank);

    // A zero-point card (Joker or this round's wild rank) is a free card.
    // Worth calling out even when you discarded almost nothing for it.
    if (drawnPts === 0) return 'jackpot';

    // No paired discard -- e.g. taking the penalty outright, or the draw
    // arriving late enough that pairing it would be a guess. Judge the card
    // on its own merits instead of inventing a comparison.
    const fresh = lastDiscardInfo && (Date.now() - lastDiscardInfo.at) < DISCARD_PAIRING_MS;
    if (!fresh) return drawnPts >= 10 ? 'bad' : 'neutral';

    const net = drawnPts - lastDiscardInfo.points;
    lastDiscardInfo = null;   // consume it: one discard pairs with one draw

    // Thresholds are deliberately SYMMETRIC around zero. An earlier cut had
    // 'good' at net <= -8, which made "discard a 10, draw a 4" (net -6) come
    // out neutral even though "discard a 4, draw a 10" (net +6) came out bad
    // -- the exact pair of moves that has to sound opposite. Mirror them.
    if (net <= -15) return 'jackpot';  // a huge swing: dumped a big group, took back almost nothing
    if (net <= -3) return 'good';      // came out ahead
    if (net < 3) return 'neutral';     // roughly a fair swap
    if (net < 12) return 'bad';        // the 4-for-a-10 case
    return 'brutal';
  }

  // ------------------------------------------------------------------
  // The intro splash is dismissed by a CSS animation ALONE (introFadeOut,
  // 2.2s delay, forwards). The markup says a JS timer isn't needed so it
  // "can never get stuck open" -- that is backwards: with no JS path, an
  // animation that never runs or never completes leaves a full-screen
  // element at z-index 999 with pointer-events on, and nothing in the app
  // can remove it.
  //
  // Observed stuck at opacity 1 during the audit, after the tab was
  // backgrounded during load -- on a phone that is just "the screen locked
  // while the game was opening". An OS-level "remove animations" setting
  // would do the same.
  //
  // Removing the node outright is the safe way out: the animation has run
  // its course by 2.8s (2.2 delay + 0.6 duration) and the splash has no
  // other job afterwards.
  // ------------------------------------------------------------------
  setTimeout(() => {
    const intro = document.getElementById('screen-intro');
    if (intro && intro.parentNode) intro.parentNode.removeChild(intro);
  }, 3200);

  document.addEventListener('click', function initAudioOnce() {
    Sound.init();
    document.removeEventListener('click', initAudioOnce);
  }, { once: true });

  // Sound toggle button was removed from the game screen's top bar by
  // request; Sound.isMuted()/setMuted() are still available if a toggle is
  // reintroduced elsewhere later.

  // ---------------- screen management ----------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    // The group chat button belongs to the group screen only. Handled here
    // rather than in each navigation path because there are several ways off
    // that screen (back, joining a room, a game starting under you), and a
    // chat button left floating over the table or the landing screen would
    // open a sheet for a group you're no longer looking at.
    (function syncGroupChatChrome() {
      const onGroup = id === 'screen-group';
      const fab = document.getElementById('group-chat-fab');
      const panel = document.getElementById('group-chat-panel');
      const backdrop = document.getElementById('group-chat-backdrop');
      if (!fab || !panel || !backdrop) return;
      if (!onGroup) {
        panel.classList.add('hidden');
        backdrop.classList.add('hidden');
        groupChatExpanded = false;
      }
      // Never show the button while the sheet itself is open.
      fab.classList.toggle('hidden', !onGroup || !panel.classList.contains('hidden'));
    })();
    // The game screen locks the page to one viewport (no drag/scroll needed);
    // other screens (lobby, overlays) are allowed to scroll normally.
    document.body.classList.toggle('game-active', id === 'screen-game');
    // Banner ad (native Android app only -- see admob-init.js) now shows on
    // every screen including the game table -- the game screen's layout was
    // reworked (fixed-height hand tray, merged joker/normal cards, reserved
    // --ad-safe-bottom padding) specifically to make room for it here too,
    // instead of the banner being the one thing hidden during actual play.
    if (window.LCAds) {
      // adsRemoved (see the Remove Ads purchase block above) overrides
      // everything else -- once someone's paid to remove ads, the banner
      // should never come back, on any screen.
      if (adsRemoved) window.LCAds.hideBanner();
      else {
        window.LCAds.showBanner();
        // Start loading the leave-room interstitial as soon as a room is
        // entered. An interstitial takes a few seconds to fetch and can
        // only be shown once loaded, so waiting until the player actually
        // taps Leave would mean there's nothing ready to show. Preparing it
        // here -- minutes ahead of the moment it's needed -- is what makes
        // the ad appear instantly instead of not at all. Safe to call
        // repeatedly: it no-ops if one is already loaded or in flight.
        if (id === 'screen-game' || id === 'screen-lobby') {
          window.LCAds.prepareInterstitial();
        }
      }
    }
    if (id === 'screen-game') {
      applyKeyboardSafeLayout();
    } else {
      // Leaving the game screen -- release the inline pixel height back to
      // CSS, since landing/lobby are meant to scroll normally and were never
      // part of this problem.
      document.body.style.height = '';
      const screenGameEl = document.getElementById('screen-game');
      if (screenGameEl) screenGameEl.style.height = '';
      const chatPanelEl = document.getElementById('chat-panel');
      if (chatPanelEl) {
        // Hand every edge back to CSS. `top` matters as much as `bottom`
        // now that both are set inline on the game screen -- leaving a
        // stale pixel top behind would strand the lobby's sheet at a
        // game-screen position.
        chatPanelEl.style.top = '';
        chatPanelEl.style.bottom = '';
        chatPanelEl.style.height = '';
        chatPanelEl.style.maxHeight = '';
      }
      chatSheetTopPx = null;
      // No round can be counting down once we're off the game screen (left
      // the room, game reset to lobby) -- don't leave the ticker running.
      setAutoNextRoundDeadline(null);
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
  //   - CORRECTION (Sept 2026, after the fix below made things visibly
  //     WORSE on a real device -- table squishing live while typing):
  //     window.innerHeight is NOT actually keyboard-immune on this device,
  //     despite interactive-widget=overlays-content being set (see the meta
  //     tag in index.html) -- that's the exact same unreliability the
  //     original comment above already warned about ("neither CSS viewport
  //     units nor the native interactive-widget settings reliably stopped
  //     the keyboard from shrinking the visible area"). A brief attempt to
  //     replace the tracking below with a live window.innerHeight read
  //     caused the whole oval table to visibly compress into a tiny strip
  //     the instant the keyboard opened, because window.innerHeight shrinks
  //     right along with it here. Reverted back to the tracking approach:
  //   - Tracks the tallest visualViewport.height seen since page load --
  //     that's "keyboard closed", since the keyboard only ever shrinks the
  //     visible area, never grows it past the real full-screen value.
  //     Seeded once at script load (nothing can have focus yet, so no
  //     keyboard can be open), and ONLY EVER GROWS from there -- it must
  //     never be reset back down just because the game screen re-renders,
  //     which is exactly the bug fixed separately below.
  //   - Pins #screen-game and body to exactly that many pixels via inline
  //     style, which wins over any CSS vh/dvh/svh rule regardless of
  //     whether THIS device's browser/OS actually respects those units for
  //     the keyboard case.
  //   - Separately computes the keyboard's own height (baseline minus
  //     current visible height) to lift the chat panel above it, instead of
  //     relying on env(keyboard-inset-height) support.
  //   - The ONE legitimate reason to reset this baseline is a genuine
  //     device rotation (width/height actually swap) -- handled in the
  //     orientationchange listener below, not here. Round transitions,
  //     game-state pushes, and every other routine re-render must leave it
  //     alone -- resetting it there was the earlier, now-fixed bug where a
  //     round starting while chat+keyboard were still open baked the
  //     keyboard-shrunk height in as "full screen" for the rest of the
  //     session (matches the "Setting up decks.../Shuffling.../Dealing
  //     cards..." flicker from the previous report).
  // --------------------------------------------------------------------
  let maxViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  function applyKeyboardSafeLayout() {
    if (!window.visualViewport || !document.body.classList.contains('game-active')) return;
    const vv = window.visualViewport;
    maxViewportHeight = Math.max(maxViewportHeight, vv.height);

    document.body.style.height = maxViewportHeight + 'px';
    const screenGameEl = document.getElementById('screen-game');
    if (screenGameEl) screenGameEl.style.height = maxViewportHeight + 'px';
  }
  // --------------------------------------------------------------------
  // Chat sheet positioning -- REWRITTEN Sept 2026 (see style.css for the
  // matching CSS rationale). This replaces applyChatPanelKeyboardOffset(),
  // which had two defects that between them produced every symptom in the
  // user's screen recording ("once I start typing it breaks down and goes
  // up and I can't see what I'm typing"):
  //
  //   DEFECT 1 -- DOUBLE LIFT. The old code did:
  //       bottom = (maxViewportHeight - visualViewport.height) + adSafe
  //   i.e. it manually pushed the sheet up by the keyboard's height. That
  //   is only correct if the browser leaves the LAYOUT viewport at full
  //   size when the keyboard opens (interactive-widget=overlays-content).
  //   On the actual device it does NOT -- the layout viewport shrinks,
  //   which was already established earlier when window.innerHeight was
  //   observed shrinking along with the keyboard. And when the layout
  //   viewport shrinks, a position:fixed element with bottom:0 is ALREADY
  //   resting on top of the keyboard, because the initial containing block
  //   for fixed positioning IS the layout viewport. So the manual offset
  //   was a second lift on top of the browser's own, launching the sheet
  //   a full keyboard-height off the top of the screen -- header, close
  //   button and message list all above y=0, only the input row left, and
  //   the caret sitting somewhere invisible.
  //
  //   The fix is to stop *assuming* which mode the browser is in and
  //   instead MEASURE the discrepancy:
  //       anchorBottom  = document.documentElement.clientHeight
  //                       (layout viewport height == where the browser
  //                        actually places `bottom: 0`)
  //       visibleBottom = visualViewport.offsetTop + visualViewport.height
  //                       (where the genuinely visible area ends)
  //       lift          = max(0, anchorBottom - visibleBottom)
  //   In resizes-content behaviour those two are equal, so lift is 0 and
  //   we add nothing -- no double lift. In overlays-content behaviour
  //   anchorBottom stays full-height, so lift comes out as exactly the
  //   keyboard height and we lift by precisely that much. One expression,
  //   correct in both worlds, and self-correcting if a future WebView
  //   update changes which one this device uses. Nothing here depends on
  //   maxViewportHeight, which is a heuristic (tallest height ever seen)
  //   and was the thing quietly going stale.
  //
  //   DEFECT 2 -- THE TOP EDGE WAS AN OUTPUT, NOT AN INPUT. The sheet was
  //   anchored only at the bottom with a height/max-height, so its top
  //   edge landed wherever `bottom + height` happened to fall. Every
  //   earlier attempt at this bug was an attempt to keep that derived
  //   number inside the screen (a 480px ceiling, then a 160px floor, then
  //   removing the floor again). It cannot be made safe, because height
  //   and bottom are computed from different, occasionally-disagreeing
  //   sources. Now BOTH edges are set explicitly and each is independently
  //   clamped into the visible area, so the sheet physically cannot spill
  //   past the top: its height is a *consequence* of two known-good
  //   points. The flex column then does the rest -- .chat-messages has
  //   flex:1/min-height:0 so it, and only it, absorbs the squeeze, exactly
  //   like Instagram's comment sheet shrinking its list while the composer
  //   stays glued above the keyboard.
  // --------------------------------------------------------------------

  // Fraction of the visible screen the sheet covers with no keyboard up.
  // 0.60 keeps the oval table, seats, turn indicator and timer readable
  // above it -- the whole reason the backdrop is no longer dimmed.
  const CHAT_SHEET_FRACTION = 0.60;
  // Below this the sheet is useless (header + composer alone are ~110px),
  // so we start moving the TOP edge up rather than squeezing further.
  const CHAT_SHEET_MIN_HEIGHT = 210;
  // Absolute floor: never leave less than the composer + a sliver of list.
  const CHAT_SHEET_HARD_MIN = 120;
  // Captured when the sheet is opened -- at that instant the keyboard is
  // guaranteed closed (we deliberately don't autofocus the input), so it's
  // the one moment a clean full-height reading is available. Keeping the
  // top edge pinned to this value is what makes the keyboard squeeze the
  // list instead of sliding the whole sheet around under your thumb.
  let chatSheetTopPx = null;

  function chatAdSafeBottom() {
    return parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--ad-safe-bottom')
    ) || 0;
  }

  // Which sheet the positioner below is currently driving. There are two
  // chat sheets -- the table chat (#chat-panel) and the group chat
  // (#group-chat-panel) -- but they live on different screens and only one
  // can ever be open, so they share this one implementation rather than
  // carrying two copies of the keyboard maths. Everything below was tuned
  // against a real Android WebView over several rounds; duplicating it would
  // mean every future fix has to be made twice and one copy would drift.
  let activeChatPanelId = 'chat-panel';
  let activeChatListId = 'chat-messages';

  function positionChatSheet() {
    const panel = document.getElementById(activeChatPanelId);
    if (!panel || panel.classList.contains('hidden')) return;

    const vv = window.visualViewport;
    const adSafe = chatAdSafeBottom();
    // Layout viewport == the containing block for position:fixed. In
    // standards mode documentElement.clientHeight is exactly that.
    const anchorBottom = document.documentElement.clientHeight;
    const visibleTop = vv ? vv.offsetTop : 0;
    const visibleH = vv ? vv.height : window.innerHeight;
    const lift = Math.max(0, Math.round(anchorBottom - (visibleTop + visibleH)));

    const bottom = lift + adSafe;
    const bottomEdge = anchorBottom - bottom; // y of the sheet's bottom, in fixed coords

    if (chatSheetTopPx === null) {
      chatSheetTopPx = Math.round(visibleTop + visibleH * (1 - CHAT_SHEET_FRACTION));
    }
    let top = chatSheetTopPx;
    // Keyboard ate the room: raise the top edge rather than clip the sheet.
    top = Math.min(top, bottomEdge - CHAT_SHEET_MIN_HEIGHT);
    // ...but never above the visible area (this is the clamp the old code
    // had no way to express, because it never knew where its top was).
    top = Math.max(visibleTop + 8, top);
    // Degenerate case (absurdly tall keyboard on a short screen): give up
    // height before giving up being on-screen.
    if (bottomEdge - top < CHAT_SHEET_HARD_MIN) {
      top = Math.max(visibleTop, bottomEdge - CHAT_SHEET_HARD_MIN);
    }

    panel.style.top = Math.round(top) + 'px';
    panel.style.bottom = Math.round(bottom) + 'px';
    // Explicitly cleared: any leftover from the old implementation would
    // silently override the top/bottom pair and reintroduce defect 2.
    panel.style.height = '';
    panel.style.maxHeight = '';
  }

  // Keeps the newest message in view when the keyboard steals list height
  // -- otherwise opening the keyboard scrolls the conversation "away".
  function scrollChatToLatest() {
    const container = document.getElementById(activeChatListId);
    if (container) container.scrollTop = container.scrollHeight;
  }

  if (window.visualViewport) {
    // 'resize' fires on keyboard open/close; 'scroll' fires when the
    // browser pans the visual viewport to reveal a focused input (which
    // changes offsetTop and therefore where "visible" actually is).
    const onViewportChange = () => {
      applyKeyboardSafeLayout();
      positionChatSheet();
    };
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
  }
  // A genuine device rotation (not just the keyboard) should get a fresh
  // baseline instead of staying pinned to the previous orientation's height
  // -- re-read immediately (best-effort) and again after a short delay,
  // since visualViewport doesn't always settle to the new orientation's
  // real value instantly. The sheet's own top anchor is dropped too, so it
  // re-derives from the new orientation rather than keeping a portrait
  // percentage on a landscape screen.
  window.addEventListener('orientationchange', () => {
    maxViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    chatSheetTopPx = null;
    setTimeout(() => {
      maxViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      chatSheetTopPx = null;
      applyKeyboardSafeLayout();
      positionChatSheet();
    }, 300);
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
    document.getElementById('overlay-scorecard').classList.add('hidden');
    // A new round dealing means every rejoin decision for the last one is
    // settled (the server won't start one while any are pending). Clear the
    // offer and its interval here rather than leaving a countdown running
    // against a deadline that has already passed.
    hideRejoinOffer();
    rejoinAsked = false;

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
    // #hand is now the shared tray for both sub-groups (see index.html) --
    // clear the two inner containers individually rather than wiping
    // #hand's own innerHTML, which would delete those containers outright.
    document.getElementById('hand-normal').innerHTML = '';
    document.getElementById('hand-jokers').innerHTML = '';
    document.getElementById('hand-divider').classList.add('hidden');
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
      // The riffle animation ran silently. Sound here also means the deal
      // that follows reads as the second half of a sequence rather than
      // ticking out of nowhere.
      Sound.deckShuffle();
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
      if (flight >= totalFlights) {
        flyer.style.opacity = '0';
        Sound.dealSettle();   // the dealer squaring the pile: gives it an ending
        return;
      }
      const p = players[flight % players.length];
      const seatEl = seatFor(p.playerId);
      if (!seatEl) { flight += 1; flyNext(); return; }
      // NO SOUND PER CARD -- deliberately, after two attempts.
      //
      // First cut played a cue on every flight: 11 per second, 78 of them
      // in a six-player deal. Second cut throttled it to a dealer's pace
      // (~4.5/s) and stripped the pitched layer. Both still read as
      // clicking rather than dealing.
      //
      // The reason is structural, not a tuning problem: this animation
      // deals 13 passes in one uninterrupted burst, which no real deal
      // does. A per-card sound faithfully tracking that is going to sound
      // like a machine whatever its rate or timbre. The deal is now
      // bracketed by sound instead -- a riffle as it starts, a settle as it
      // ends -- and silent in between.
      //
      // Sound.dealTick() still exists and is self-throttling if this is
      // ever worth revisiting; re-enabling is this one line.
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

  // Landing panes. Four stacked blocks overflowed the viewport; a player
  // wants either their permanent tables or a one-off game, never both at
  // once. Invite mode hides the whole .mode-blocks wrapper, so these don't
  // need to know about it.
  (function wireLandingTabs() {
    const tabs = document.getElementById('landing-tabs');
    if (!tabs) return;
    tabs.querySelectorAll('.seg').forEach((seg) => {
      seg.onclick = () => {
        tabs.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s === seg));
        const want = seg.dataset.pane;
        document.getElementById('pane-groups').classList.toggle('hidden', want !== 'groups');
        document.getElementById('pane-quick').classList.toggle('hidden', want !== 'quick');
      };
    });
  })();

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
  // ====================================================================
  // Persistent groups (client side)
  // ====================================================================
  // A group is a named, permanent table. Its code and link never change,
  // so one pinned WhatsApp message keeps working, and it carries a running
  // leaderboard across every session.
  //
  // Membership is deliberately just "whoever holds the link" -- there is no
  // account, no member list, nothing to sign into. The only thing stored on
  // this device is the list of groups you've opened, so the landing screen
  // can offer them as one tap. Lose that list (new phone, cleared storage)
  // and the WhatsApp link puts you straight back in.
  // ====================================================================
  const GROUPS_STORAGE_KEY = 'leastcount_groups';
  const GROUPS_MAX_REMEMBERED = 8;

  function readRememberedGroups() {
    try {
      const raw = JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((g) => g && g.code) : [];
    } catch (e) { return []; }
  }

  // The set of codes we're watching, order-independent. Only this decides
  // whether the server needs telling again -- the list's ORDER changes every
  // time a group is opened (most recent first) and that's a local display
  // concern the server has no interest in.
  function watchedCodesKey() {
    return readRememberedGroups().map((g) => g.code).sort().join(',');
  }

  function rememberGroup(code, name) {
    if (!code) return;
    const before = watchedCodesKey();
    try {
      const list = readRememberedGroups().filter((g) => g.code !== code);
      list.unshift({ code, name: name || code, lastOpenedAt: Date.now() });
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(list.slice(0, GROUPS_MAX_REMEMBERED)));
    } catch (e) { /* storage blocked -- the link still works, just no shortcut */ }
    renderGroupsBlock();
    // ------------------------------------------------------------------
    // THIS CALL USED TO BE UNCONDITIONAL, AND IT WAS A FEEDBACK LOOP.
    //
    // socket.on('group_update') calls rememberGroup() to keep names fresh.
    // rememberGroup() called watchGroups(). watchGroups() emits watch_groups.
    // The server answered watch_groups by broadcasting group_update -- to
    // EVERY member of the group. Each of those arrivals started the cycle
    // again, once per member, so it amplified rather than settling:
    //
    //   one person opening a 6-member group, five round trips deep
    //   -> ~9,300 group_update messages and ~1,550 Firestore reads
    //
    // It never terminated on its own; it just ran at whatever rate the
    // network allowed, for as long as anyone had a group open. That is the
    // slowdown that arrived with permanent groups.
    //
    // Re-registering only when the set of codes actually changed breaks it.
    // ------------------------------------------------------------------
    if (watchedCodesKey() !== before) watchGroups();
  }

  function groupInviteLinkFor(code) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('g', code);
    return url.toString();
  }

  // The CODE is given as well as the link, because typing a code keeps the
  // whole journey inside the app. A tapped link opens the web version, which
  // carries no ads at all -- so a player who joins that way is permanently
  // worth nothing. The code is the reliable fix for that leak.
  function groupInviteTextFor(code, name) {
    const who = (localStorage.getItem(NAME_STORAGE_KEY) || '').trim();
    const lead = who ? `${who} invited you` : 'You are invited';
    return `${lead} to play Least Count with "${name}".\n`
      + `Open the app and enter code ${code}, or tap: ${groupInviteLinkFor(code)}`;
  }

  function renderGroupsBlock() {
    const list = document.getElementById('groups-list');
    const empty = document.getElementById('groups-empty');
    if (!list) return;
    const groups = readRememberedGroups();
    if (empty) empty.classList.toggle('hidden', groups.length > 0);
    list.innerHTML = '';
    groups.forEach((g) => {
      const li = document.createElement('li');
      li.className = 'group-row';
      // Tapping the row PLAYS. Managing the group (share, rename, remove,
      // delete) lives behind the "..." -- creating and managing a group are
      // deliberately separate from sitting down at it.
      // Tapping a group opens the GROUP, not a game lobby. That single
      // change is why the first version felt dead -- tap, land alone in an
      // empty lobby, leave. Management now lives inside the group behind the
      // settings gear, so there's no menu on this row at all.
      li.innerHTML = `<span class="group-row-name">${escapeHtml(g.name)}</span>
        <span class="group-row-go">Open</span>`;
      li.onclick = () => openGroupScreen(g.code, g.name);
      list.appendChild(li);
    });
  }

  // ---------------- group management menu ----------------
  let groupMenuCode = null;
  let groupMenuName = '';

  function setGroupMenuError(msg) {
    const el = document.getElementById('group-menu-error');
    if (el) el.textContent = msg || '';
  }

  // Closing only dismisses the dropdown -- it deliberately does NOT clear
  // groupMenuCode, because Rename and Delete open their own dialogs from the
  // menu and still need to know which group they're acting on.
  function closeGroupMenu() {
    document.getElementById('group-menu').classList.add('hidden');
    document.getElementById('group-menu-backdrop').classList.add('hidden');
  }
  function closeGroupDialogs() {
    document.getElementById('group-rename-dialog').classList.add('hidden');
    document.getElementById('group-delete-dialog').classList.add('hidden');
    setGroupMenuError('');
  }

  async function openGroupMenu(code, name) {
    groupMenuCode = code;
    groupMenuName = name;
    document.getElementById('input-group-rename').value = name;
    setGroupMenuError('');
    // Rename/Delete are admin-only. Hidden until the server confirms who we
    // are -- the server enforces it too, this only avoids offering a button
    // that would fail.
    document.getElementById('btn-group-rename').classList.add('hidden');
    document.getElementById('btn-group-delete').classList.add('hidden');
    document.getElementById('group-menu').classList.remove('hidden');
    document.getElementById('group-menu-backdrop').classList.remove('hidden');
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('get_group', { code, firebaseIdToken }, (res) => {
      if (!res || !res.ok || !res.group || groupMenuCode !== code) return;
      groupMenuName = res.group.name;
      document.getElementById('input-group-rename').value = res.group.name;
      document.getElementById('btn-group-rename').classList.toggle('hidden', !res.group.isAdmin);
      document.getElementById('btn-group-delete').classList.toggle('hidden', !res.group.isAdmin);
    });
  }

  // Tap anywhere off the menu to dismiss it -- there's no Close row, the
  // same as any Android overflow menu.
  document.getElementById('group-menu-backdrop').onclick = closeGroupMenu;

  document.getElementById('btn-group-share').onclick = () => {
    if (!groupMenuCode) return;
    closeGroupMenu();
    logAnalytics('invite_shared_whatsapp');
    openWhatsAppShare(groupInviteTextFor(groupMenuCode, groupMenuName));
  };

  document.getElementById('btn-group-copy').onclick = async () => {
    if (!groupMenuCode) return;
    closeGroupMenu();
    try {
      await navigator.clipboard.writeText(groupInviteTextFor(groupMenuCode, groupMenuName));
      setLandingError('Invite link copied.');
    } catch (e) {
      setLandingError('Could not copy — code is ' + groupMenuCode);
    }
  };

  // The overflow list never contains inputs or confirmations -- it launches
  // them, the way WhatsApp does.
  document.getElementById('btn-group-rename').onclick = () => {
    closeGroupMenu();
    document.getElementById('group-rename-dialog').classList.remove('hidden');
    setTimeout(() => { try { document.getElementById('input-group-rename').focus(); } catch (e) {} }, 60);
  };
  document.getElementById('btn-group-rename-cancel').onclick = closeGroupDialogs;
  document.getElementById('btn-group-delete-cancel').onclick = closeGroupDialogs;

  document.getElementById('btn-group-rename-save').onclick = async () => {
    const code = groupMenuCode;
    const newName = document.getElementById('input-group-rename').value.trim();
    if (!code || !newName) return setGroupMenuError('Enter a name.');
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('rename_group', { code, groupName: newName, firebaseIdToken }, (res) => {
      if (!res || !res.ok) return setGroupMenuError((res && res.error) || 'Could not rename.');
      rememberGroup(code, res.name);
      if (groupScreenCode === code) openGroupScreen(code, res.name);
      closeGroupDialogs();
    });
  };

  // Local only -- membership is "whoever holds the link", so leaving is just
  // forgetting the shortcut on this device. Nobody else is affected, and the
  // link still works if they change their mind.
  document.getElementById('btn-group-remove').onclick = () => {
    if (!groupMenuCode) return;
    try {
      const list = readRememberedGroups().filter((g) => g.code !== groupMenuCode);
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(list));
    } catch (e) { /* storage blocked */ }
    renderGroupsBlock();
    closeGroupMenu();
    showScreen('screen-landing');
  };

  // Destructive and irreversible for everyone, so it gets a proper confirm
  // dialog rather than a tap-again trick -- a dropdown that closes underneath
  // you is the wrong place to arm something dangerous.
  document.getElementById('btn-group-delete').onclick = () => {
    closeGroupMenu();
    document.getElementById('group-delete-dialog').classList.remove('hidden');
  };
  document.getElementById('btn-group-delete-confirm').onclick = async () => {
    const code = groupMenuCode;
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('delete_group', { code, firebaseIdToken }, (res) => {
      if (!res || !res.ok) return setGroupMenuError((res && res.error) || 'Could not delete.');
      try {
        const list = readRememberedGroups().filter((g) => g.code !== code);
        localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(list));
      } catch (e) {}
      renderGroupsBlock();
      closeGroupDialogs();
      showScreen('screen-landing');
    });
  };

  // Single entry point for joining ANY table -- a 4-letter ad-hoc code, a
  // permanent group code, from a typed code, a saved group row, or an invite
  // link. Previously this logic lived inline in the Join button's handler,
  // which meant every new way of arriving at a room needed its own copy of
  // the pending-approval and session-saving branches.
  async function joinRoomByKey(key) {
    const name = getPlayerName();
    const roomCode = (key || '').trim();
    if (!name) return setLandingError('Enter your name');
    if (!roomCode) return setLandingError('Enter room code');
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('join_room', { roomCode, name, firebaseIdToken, platform: CLIENT_PLATFORM, avatar: myAvatar }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      // room.phase was already 'playing' when the request landed -- the
      // server held it as a pending request instead of joining outright
      // (see server.js' join_room). Show the waiting screen and stop here;
      // join_admitted/join_denied take it from there.
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
      // Invite mode has done its job. Without this the invite card (and the
      // pre-filled room code) is still sitting on the landing screen
      // underneath, so leaving the game drops you back onto an invitation to
      // rejoin the room you just left.
      exitInviteMode();
      document.getElementById('input-roomcode').value = '';
      showScreen('screen-lobby');
    });
  }

  // ====================================================================
  // Group screen
  // ====================================================================
  // Tapping a group opens THIS rather than a game lobby. The first version
  // dropped you straight into an empty room, which is why groups felt dead:
  // you tapped, sat alone, and left. This screen says something whether or
  // not anyone is playing.
  // ====================================================================
  let groupScreenCode = null;
  let groupScreenData = null;
  let groupBellTimer = null;
  let groupChatMsgs = [];
  let marathonDays = 7;
  // What the group screen's Play button does right now: 'start' opens the
  // table and brings everyone seated with you, 'join' walks into one that is
  // already open. Set by renderGroupScreen alongside the button's label, so
  // the two can't disagree.
  let groupPlayMode = 'join';

  // Tells the server which groups this client is watching, so it can count us
  // as present and push live updates. Sent on connect and whenever the
  // remembered list changes -- always the COMPLETE list, since the server
  // treats it as a replace.
  // Second guard behind rememberGroup's, because this is reachable from
  // several places and every needless call costs the server a Firestore read
  // per group. `force` is for reconnects, where the server has a new socket
  // id and genuinely does need telling again even though nothing here moved.
  let lastWatchKey = null;
  async function watchGroups(force) {
    const codes = readRememberedGroups().map((g) => g.code);
    if (groupScreenCode && !codes.includes(groupScreenCode)) codes.push(groupScreenCode);
    const name = localStorage.getItem(NAME_STORAGE_KEY) || '';
    const key = codes.slice().sort().join(',') + '|' + name;
    if (!force && key === lastWatchKey) return;
    lastWatchKey = key;
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('watch_groups', { codes, name, firebaseIdToken });
  }

  async function openGroupScreen(code, fallbackName) {
    if (!code) return;
    groupScreenCode = code;
    const gErr = document.getElementById('group-error');
    if (gErr) gErr.textContent = '';   // stale error from a previous visit
    // Collapse chat and treat the whole 30-minute history as unread, so
    // arriving tells you there's something to read rather than hiding it.
    // Also stops one group's messages being counted as "seen" in another.
    groupChatSeenAt = 0;
    setGroupChatExpanded(false);
    document.getElementById('group-title').textContent = fallbackName || 'Group';
    document.getElementById('group-code-text').textContent = code;
    showScreen('screen-group');
    watchGroups();
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('get_group', { code, firebaseIdToken }, (res) => {
      if (!res || !res.ok) {
        setLandingError((res && res.error) || 'Could not open that group.');
        showScreen('screen-landing');
        return;
      }
      if (groupScreenCode !== code) return; // moved on while we waited
      renderGroupScreen(res.group);
    });
  }

  const GROUP_STATUS_LABEL = {
    playing: 'playing',
    table: 'at the table',
    online: 'online',
    away: '',
  };

  function relativeDay(iso) {
    if (!iso) return '';
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return Math.floor(days / 7) + 'w ago';
  }

  function renderGroupScreen(group) {
    if (!group) return;
    groupScreenData = group;
    rememberGroup(group.code, group.name);
    document.getElementById('group-title').textContent = group.name;
    document.getElementById('group-code-text').textContent = group.code;

    // ---- live strip ----
    const liveText = document.getElementById('group-live-text');
    const liveNames = document.getElementById('group-live-names');
    const bellBtn = document.getElementById('btn-group-bell');
    const bellLabel = document.getElementById('btn-group-bell-label');
    const playBtn = document.getElementById('btn-group-play');
    const standBtn = document.getElementById('btn-group-standdown');
    const hint = document.getElementById('group-bell-hint');

    const meAtTable = group.members.some((m) => m.uid === myFirebaseUid() && m.status === 'table');
    const seated = group.atTable || [];

    // groupPlayMode decides what the one Play button does when tapped --
    // start the table, or walk into one that's already open.
    if (group.gameInProgress) {
      liveText.textContent = 'A game is in progress';
      liveNames.textContent = group.members.filter((m) => m.status === 'playing').map((m) => m.name).join(', ');
      bellBtn.classList.add('hidden');
      standBtn.classList.add('hidden');
      playBtn.classList.remove('hidden');
      playBtn.textContent = 'Join the game';
      groupPlayMode = 'join';
      hint.textContent = 'You’ll be dealt in at the start of the next round.';
    } else if (group.roomLive) {
      // The room is open but nothing is dealt yet -- somebody is sitting in
      // the lobby waiting. This branch didn't exist, which is exactly how the
      // host ended up alone with nobody able to reach them.
      const names = (group.inRoom || []).map((p) => p.name);
      liveText.textContent = names.length === 1
        ? `${names[0]} is waiting to start`
        : 'Table is open';
      liveNames.textContent = names.join(', ');
      bellBtn.classList.add('hidden');
      standBtn.classList.add('hidden');
      playBtn.classList.remove('hidden');
      playBtn.textContent = 'Join the table';
      groupPlayMode = 'join';
      hint.textContent = 'Join and the game starts once everyone’s in.';
    } else if (seated.length) {
      liveText.textContent = seated.length === 1
        ? `${seated[0].name} is at the table`
        : `${seated.length} at the table`;
      liveNames.textContent = seated.map((s) => s.name).join(', ');
      bellBtn.classList.toggle('hidden', meAtTable);
      standBtn.classList.toggle('hidden', !meAtTable);
      // Start Game belongs to whoever raised their hand first -- they called
      // the game. Everyone else waits for them, or just joins the table.
      const iAmHost = group.hostUid && group.hostUid === myFirebaseUid();
      playBtn.classList.toggle('hidden', !(iAmHost && seated.length >= 2));
      playBtn.textContent = 'Start Game';
      groupPlayMode = 'start';
      hint.textContent = seated.length >= 2
        ? (iAmHost ? 'Everyone at the table comes with you.' : 'Waiting for the host to start.')
        : 'Waiting for someone else to join.';
    } else {
      liveText.textContent = 'No one at the table';
      liveNames.textContent = '';
      bellBtn.classList.remove('hidden');
      standBtn.classList.add('hidden');
      playBtn.classList.add('hidden');
      // Set even though the button is hidden -- a mode left over from the
      // previous render is exactly the kind of stale flag that has bitten
      // this project before.
      groupPlayMode = 'join';
      hint.textContent = '';
    }

    // The bell's cooldown is shown rather than letting someone tap it and
    // have nothing happen.
    const cooldownLeft = Math.max(0, (group.bellReadyAt || 0) - Date.now());
    if (!meAtTable && cooldownLeft > 0) {
      bellLabel.textContent = `I want to play (quiet for ${Math.ceil(cooldownLeft / 60000)}m)`;
    } else {
      bellLabel.textContent = 'I want to play';
    }

    // ---- members ----
    const list = document.getElementById('group-members');
    document.getElementById('group-member-count').textContent = group.members.length
      ? '· ' + group.members.length : '';
    list.innerHTML = '';
    group.members.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'group-member' + (m.status === 'away' ? ' away' : '');
      const status = GROUP_STATUS_LABEL[m.status];
      // "Played yesterday" carries the list when nobody is around. A column
      // of grey offline dots would read as MORE dead, not less.
      const meta = status || relativeDay(m.lastPlayedAt) || 'not played yet';
      li.innerHTML =
        `<span class="gm-dot ${m.status}"></span>` +
        `<span class="gm-name">${escapeHtml(m.name)}${m.isHost ? ' <span class="gm-host">HOST</span>' : ''}</span>` +
        `<span class="gm-meta">${escapeHtml(meta)}</span>`;
      list.appendChild(li);
    });

    renderMarathonStrip(group);
    renderGroupChat(group.chat || []);
    renderGroupBoard();
  }

  // The marathon is started by the admin and runs a fixed number of days, so
  // this strip has three states rather than one: running (with a countdown),
  // just ended (with the winner), and none at all. Between marathons games
  // still count on the daily board -- the group isn't dead in the gaps.
  // "Sat 27 Sep". Locale-aware, and wrapped because toLocaleDateString can
  // throw on some older WebViews for option combinations it doesn't support
  // -- a missing date is fine, a crashed render of the whole group screen is
  // not.
  function marathonEndLabel(ts) {
    try {
      return new Date(ts).toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
      });
    } catch (e) {
      return '';
    }
  }

  function renderMarathonStrip(group) {
    const state = document.getElementById('group-marathon-state');
    const sub = document.getElementById('group-marathon-sub');
    const startBtn = document.getElementById('btn-start-marathon');
    if (!state || !sub || !startBtn) return;
    const m = (group && group.marathon) || {};

    if (m.running) {
      // The marathon's "name" is its length -- there's no naming step, so the
      // duration is the identity: "7-day marathon". The end DATE goes
      // underneath alongside the countdown, because "ends in 5 days" alone
      // makes people do the arithmetic to work out whether they can play on
      // the last day.
      const days = Math.ceil((m.msLeft || 0) / 86400000);
      state.textContent = m.days ? m.days + '-day marathon' : 'Marathon';
      const when = marathonEndLabel(Date.now() + (m.msLeft || 0));
      sub.textContent = (days <= 1 ? 'Ends today' : 'Ends in ' + days + ' days')
        + (when ? ' · ' + when : '');
      startBtn.classList.add('hidden');
      return;
    }
    if (m.ended) {
      state.textContent = m.winnerName ? 'Marathon over — ' + m.winnerName + ' won' : 'Marathon over';
      sub.textContent = 'Starting another resets the board.';
      startBtn.textContent = 'Start a new marathon';
    } else {
      state.textContent = 'No marathon running';
      sub.textContent = group && group.isAdmin
        ? 'Start one to give everyone a reason to play daily.'
        : 'The group admin can start one.';
      startBtn.textContent = 'Start a marathon';
    }
    // isAdmin only arrives on our own get_group (a broadcast has no viewer);
    // renderGroupScreen already carries it forward across pushes.
    startBtn.classList.toggle('hidden', !(group && group.isAdmin));
  }

  function groupMemberNameByUid(uid) {
    if (!groupScreenData || !uid) return '';
    const m = (groupScreenData.members || []).find((x) => x.uid === uid);
    return m ? m.name : '';
  }

  function groupChatPeople() {
    const me = myFirebaseUid();
    if (!groupScreenData) return [];
    return (groupScreenData.members || [])
      .filter((m) => m.uid && m.uid !== me)
      .map((m) => ({ id: m.uid, name: m.name }));
  }

  function chatClock(ts) {
    const d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // Renders `msgs` into `ul`. Used by BOTH the chat sheet and the read-only
  // preview block on the group screen, so the two can never drift apart in
  // grouping, mention highlighting or clock format -- the preview showing a
  // message differently from the sheet it opens would be its own small bug.
  function paintGroupChatInto(ul, msgs) {
    if (!ul) return;
    ul.innerHTML = '';
    const me = myFirebaseUid();
    let prevUid = null;
    msgs.forEach((m) => {
      // Same grouping as the table chat. The TIME stays, though -- opposite
      // decision, for a reason: with only 30 minutes of history, "25 minutes
      // ago" versus "just now" is how you tell whether somebody is still
      // around and worth waiting for. At the table everyone is already
      // playing, so there it said nothing.
      const grouped = prevUid && m.uid === prevUid;
      const mentionsMe = Array.isArray(m.mentions) && m.mentions.indexOf(me) >= 0;
      const li = document.createElement('li');
      li.className = 'group-chat-msg'
        + (m.uid && m.uid === me ? ' mine' : '')
        + (grouped ? ' grouped' : '')
        + (mentionsMe ? ' mentions-me' : '');
      if (!grouped) {
        const t = document.createElement('span');
        t.className = 'gc-time';
        t.textContent = chatClock(m.at);
        li.appendChild(t);
        const n = document.createElement('span');
        n.className = 'gc-name';
        n.textContent = m.name || 'Player';
        li.appendChild(n);
      }
      const body = document.createElement('span');
      body.className = 'gc-text';
      renderChatText(body, m.text, m.mentions, groupMemberNameByUid, me);
      li.appendChild(body);
      ul.appendChild(li);
      prevUid = m.uid || null;
    });
  }

  // How many messages the read-only preview on the group screen shows.
  const GROUP_CHAT_PREVIEW_COUNT = 5;

  function renderGroupChat(list) {
    const ul = document.getElementById('group-chat-list');
    const empty = document.getElementById('group-chat-empty');
    if (!ul || !empty) return;
    groupChatMsgs = list || [];

    // The sheet: everything.
    paintGroupChatInto(ul, groupChatMsgs);
    empty.classList.toggle('hidden', groupChatMsgs.length > 0);
    ul.classList.toggle('hidden', groupChatMsgs.length === 0);
    ul.scrollTop = ul.scrollHeight;

    // The preview: the last few, same renderer. slice(-N) is safe on a list
    // shorter than N, so no length check is needed.
    const pv = document.getElementById('group-chat-preview');
    const pvEmpty = document.getElementById('group-chat-preview-empty');
    if (pv) {
      const recent = groupChatMsgs.slice(-GROUP_CHAT_PREVIEW_COUNT);
      paintGroupChatInto(pv, recent);
      pv.classList.toggle('hidden', recent.length === 0);
      if (pvEmpty) pvEmpty.classList.toggle('hidden', recent.length > 0);
      pv.scrollTop = pv.scrollHeight;
    }

    // Keeps the FAB's unread count in step with every incoming batch.
    updateGroupChatUnread();
  }

  // Champions rows used to be keyed by calendar month. They now record when
  // the marathon ended and how long it ran -- but old rows are still sitting
  // in Firestore, so both shapes have to render.
  // Currently UNUSED: its only caller was the Champions board tab, removed
  // Sept 2026. Kept deliberately -- the server still sends g.champions, so
  // this is the other half of bringing that view back as a pure UI change.
  // Delete both together if champions are dropped for good.
  function championLabel(c) {
    if (c && c.endedAt) {
      const d = new Date(c.endedAt);
      const when = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return c.days ? c.days + 'd · ' + when : when;
    }
    return (c && c.month) || '';
  }

  // One board now: the standings for the current marathon. The Today /
  // Recent / Champions tabs were removed in Sept 2026 -- see the comment in
  // index.html where the tab row used to be. g.daily, g.recent and
  // g.champions still arrive in the payload and are simply not rendered;
  // left alone deliberately, so bringing any of them back is a UI change
  // rather than a server one.
  function renderGroupBoard() {
    const g = groupScreenData;
    if (!g) return;
    const board = document.getElementById('group-board');
    const empty = document.getElementById('group-board-empty');
    board.innerHTML = '';
    const rows = (g.marathon && g.marathon.standings) || [];

    const me = myFirebaseUid();
    rows.forEach((s, i) => {
      const li = document.createElement('li');
      // Your own row is marked, so you can find yourself without reading
      // every name -- the whole point of a standings table is "where am I".
      li.className = 'standings-row' + (me && s.uid === me ? ' is-me' : '');
      li.innerHTML =
        `<span class="st-rank">${i + 1}</span>` +
        `<span class="st-name">${escapeHtml(s.name)}</span>` +
        `<span class="st-wins">${s.points}</span>`;
      board.appendChild(li);
    });

    empty.classList.toggle('hidden', rows.length > 0);
    // The scoring note explains the points in the table above it, so it only
    // earns its space when there IS a table.
    const note = document.querySelector('.group-scoring-note');
    if (note) note.classList.toggle('hidden', rows.length === 0);
    // Two quite different empty states. "Nothing scored yet" for the
    // no-marathon case reads as though the app has lost your points.
    empty.textContent = !(g.marathon && (g.marathon.running || g.marathon.ended))
      ? 'No marathon running yet.'
      : 'Nothing scored yet — play a game to get on the board.';
  }

  document.getElementById('btn-group-back').onclick = () => {
    groupScreenCode = null;
    groupScreenData = null;
    showScreen('screen-landing');
  };

  document.getElementById('btn-group-settings').onclick = () => {
    if (groupScreenData) openGroupMenu(groupScreenData.code, groupScreenData.name);
  };

  document.getElementById('btn-group-invite').onclick = () => {
    if (!groupScreenData) return;
    logAnalytics('invite_shared_whatsapp');
    openWhatsAppShare(groupInviteTextFor(groupScreenData.code, groupScreenData.name));
  };

  document.getElementById('btn-group-bell').onclick = async () => {
    if (!groupScreenCode) return;
    if (!getPlayerName()) return setLandingError('Enter your name');
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('ring_bell', {
      code: groupScreenCode,
      name: getPlayerName(),
      firebaseIdToken,
    }, (res) => {
      if (!res || !res.ok) setLandingError((res && res.error) || 'Could not do that.');
      else logAnalytics('group_bell_rung');
    });
  };

  document.getElementById('btn-group-standdown').onclick = async () => {
    if (!groupScreenCode) return;
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('stand_down', { code: groupScreenCode, firebaseIdToken });
  };

  // Start Game and Join are NOT the same action -- they used to be, and that
  // was the bug. Joining is local: walk into the room. Starting is a server
  // action that brings everyone at the table with you.
  document.getElementById('btn-group-play').onclick = async () => {
    if (!groupScreenCode) return;
    if (groupPlayMode !== 'start') { joinRoomByKey(groupScreenCode); return; }
    if (!getPlayerName()) return setLandingError('Enter your name');
    // Starting is a SERVER action, not a local navigation. The old code just
    // called joinRoomByKey here, which walked the host into an empty room on
    // their own and left everyone else behind with no way in.
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('start_group_game', { code: groupScreenCode, firebaseIdToken }, (res) => {
      if (!res || !res.ok) return setLandingError((res && res.error) || 'Could not start the game.');
      logAnalytics('group_game_started');
      // We're in the group room too, so the group_game_starting broadcast
      // below brings us in on the same path as everyone else -- one code
      // path, so the host can't end up somewhere the others aren't.
    });
  };

  // Everyone seated at the table walks into the room together. Guests who
  // aren't seated ignore it; they can still tap "Join the table" afterwards,
  // which is also the fallback if this push is missed entirely.
  socket.on('group_game_starting', ({ code, roomCode, seatUids }) => {
    const target = roomCode || code;
    if (!target) return;

    // Already sitting in a room -- the screen is the only honest signal for
    // that. (An earlier version tested myRoomCode, which does NOT mean "in a
    // room": it is seeded from localStorage at load and survives a failed
    // rejoin, so a stale value silently disqualified people.)
    const active = document.querySelector('.screen.active');
    if (active && (active.id === 'screen-lobby' || active.id === 'screen-game')) return;

    // seatUids only arrives on the FALLBACK broadcast. Normally the server
    // sends this event straight to our socket because it knows we're seated,
    // and then there is nothing to match -- being sent it is the whole
    // instruction. Matching on our own Firebase uid was the fragile part:
    // LCAuth.getUser() can be null on a client that is otherwise fine, and a
    // null there meant being left behind with no error and no button.
    if (Array.isArray(seatUids)) {
      const me = myFirebaseUid();
      if (!me || seatUids.indexOf(me) < 0) return;
    }
    joinRoomByKey(target);
  });


  // ---- start a marathon ----
  document.getElementById('btn-start-marathon').onclick = () => {
    if (!groupScreenData) return;
    marathonDays = 7;
    const tabs = document.getElementById('marathon-days-tabs');
    tabs.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s.dataset.days === '7'));
    document.getElementById('marathon-start-error').textContent = '';
    document.getElementById('marathon-start-dialog').classList.remove('hidden');
  };

  (function wireMarathonDayTabs() {
    const tabs = document.getElementById('marathon-days-tabs');
    if (!tabs) return;
    tabs.querySelectorAll('.seg').forEach((seg) => {
      seg.onclick = () => {
        marathonDays = Number(seg.dataset.days);
        tabs.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s === seg));
      };
    });
  })();

  document.getElementById('btn-marathon-cancel').onclick = () => {
    document.getElementById('marathon-start-dialog').classList.add('hidden');
  };

  document.getElementById('btn-marathon-confirm').onclick = async () => {
    if (!groupScreenCode) return;
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('start_marathon', {
      code: groupScreenCode,
      days: marathonDays,
      firebaseIdToken,
    }, (res) => {
      if (!res || !res.ok) {
        // Shown inside the dialog rather than as a landing toast -- the
        // dialog is covering the screen, so a toast behind it is invisible.
        document.getElementById('marathon-start-error').textContent =
          (res && res.error) || 'Could not start it.';
        return;
      }
      document.getElementById('marathon-start-dialog').classList.add('hidden');
      logAnalytics('marathon_started');
      // The server broadcasts the new state, but that broadcast carries no
      // viewer, so re-asking keeps isAdmin and the Start button correct.
      openGroupScreen(groupScreenCode, groupScreenData && groupScreenData.name);
    });
  };

  // ---- group chat: collapsed by default ----
  // The unread count is what makes collapsing safe. A collapsed section with
  // no signal is a section nobody opens twice, and the whole point of this
  // chat is arranging a game -- it has to be able to interrupt you.
  //
  // "Unread" is measured by TIMESTAMP, not by a message count. History only
  // lives 30 minutes server-side, so the list shrinks on its own as messages
  // expire; a count-based marker would go negative and under-report.
  // (groupChatExpanded / groupChatSeenAt are declared with the rest of the
  // group state above.)

  function updateGroupChatUnread() {
    const badge = document.getElementById('group-chat-unread');
    if (!badge) return;
    const me = myFirebaseUid();
    // Your own messages never count as unread.
    const n = groupChatExpanded ? 0 : groupChatMsgs.filter(
      (m) => m && m.at > groupChatSeenAt && m.uid !== me
    ).length;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
  }

  // Open/close the group chat sheet. Mirrors the table chat's handlers
  // deliberately, including NOT auto-focusing the input on open -- focusing
  // it forces the keyboard up the instant the sheet appears, which on a real
  // Android WebView broke the panel's position:fixed layout outright (see
  // the long comment on the table chat's FAB handler).
  function setGroupChatExpanded(open) {
    const panel = document.getElementById('group-chat-panel');
    const backdrop = document.getElementById('group-chat-backdrop');
    const fab = document.getElementById('group-chat-fab');
    if (!panel || !backdrop || !fab) return;
    groupChatExpanded = !!open;

    if (groupChatExpanded) {
      activeChatPanelId = 'group-chat-panel';
      activeChatListId = 'group-chat-list';
      panel.classList.remove('hidden');
      backdrop.classList.remove('hidden');
      fab.classList.add('hidden');
      groupChatSeenAt = Date.now();
      // Re-derive the top anchor from scratch on every open -- the one
      // moment the keyboard is definitionally closed.
      chatSheetTopPx = null;
      positionChatSheet();
      scrollChatToLatest();
    } else {
      // Drop focus FIRST so the keyboard closes with the sheet, otherwise it
      // outlives the panel and the next viewport resize applies an offset to
      // something that's no longer there.
      const input = document.getElementById('input-group-chat');
      if (input) input.blur();
      panel.classList.add('hidden');
      backdrop.classList.add('hidden');
      // Only re-show the button if we're still on the group screen -- backing
      // out to the landing screen closes the sheet too, and a chat button
      // floating over the landing screen would be nonsense.
      fab.classList.toggle('hidden', !groupScreenCode);
      chatSheetTopPx = null;
    }
    updateGroupChatUnread();
  }

  (function wireGroupChatSheet() {
    const fab = document.getElementById('group-chat-fab');
    const closeBtn = document.getElementById('btn-group-chat-close');
    const backdrop = document.getElementById('group-chat-backdrop');
    if (fab) fab.onclick = () => setGroupChatExpanded(true);
    // The whole preview block is the tap target, not a small "Open" link --
    // it's read-only, so there is nothing else you could be reaching for.
    const preview = document.getElementById('group-chat-preview-block');
    if (preview) preview.onclick = () => setGroupChatExpanded(true);
    if (closeBtn) closeBtn.onclick = () => setGroupChatExpanded(false);
    if (backdrop) backdrop.onclick = () => setGroupChatExpanded(false);
    const input = document.getElementById('input-group-chat');
    if (input) {
      input.addEventListener('focus', () => setTimeout(positionChatSheet, 120));
      input.addEventListener('blur', () => setTimeout(positionChatSheet, 120));
    }
  })();

  async function sendGroupChat() {
    const input = document.getElementById('input-group-chat');
    const text = (input.value || '').trim();
    if (!text || !groupScreenCode) return;
    if (!getPlayerName()) return setLandingError('Enter your name');
    // Cleared immediately rather than in the ack: a message that sits in the
    // box until the server answers feels broken on a slow connection.
    input.value = '';
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('group_chat_send', {
      code: groupScreenCode,
      text,
      name: getPlayerName(),
      firebaseIdToken,
      mentions: collectMentions(text, groupChatPeople()),
    }, (res) => {
      if (!res || !res.ok) setLandingError((res && res.error) || 'Could not send that.');
    });
  }

  wireMentionBar('input-group-chat', 'group-chat-mention-bar', groupChatPeople);
  document.getElementById('btn-group-chat-send').onclick = sendGroupChat;
  document.getElementById('input-group-chat').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendGroupChat(); }
  });

  // One message at a time, not a whole group_update -- a full refresh means a
  // Firestore read, and paying for a document read per chat message would be
  // absurd. The 30-minute window is enforced server-side; nothing here needs
  // to expire anything.
  socket.on('group_chat', ({ code, msg }) => {
    if (!msg || code !== groupScreenCode) return;
    groupChatMsgs.push(msg);
    renderGroupChat(groupChatMsgs);
  });

  // Live updates: presence changes, someone raising a hand, a game starting.
  socket.on('group_update', ({ group }) => {
    if (!group) return;
    // Keep the list row's name fresh even for groups we're not looking at.
    rememberGroup(group.code, group.name);
    if (group.code === groupScreenCode) {
      // isAdmin only comes back on our own get_group (broadcasts have no
      // viewer), so preserve what we already learned rather than losing the
      // settings buttons on every push.
      if (groupScreenData && groupScreenData.isAdmin) group.isAdmin = true;
      renderGroupScreen(group);
    }
  });

  // Somebody rang the bell. Until FCM lands this only reaches people who
  // already have the app open -- the mechanic is the same either way, push
  // just makes it reach further.
  socket.on('group_bell', ({ code, byName }) => {
    if (groupBellTimer) clearTimeout(groupBellTimer);
    const el = document.getElementById('landing-toast-error');
    if (!el) return;
    el.textContent = `${byName} wants to play`;
    el.classList.remove('hidden');
    groupBellTimer = setTimeout(() => el.classList.add('hidden'), 6000);
    if (code && code !== groupScreenCode) {
      el.onclick = () => openGroupScreen(code);
    }
  });

  // Forced: a reconnect means a new socket id server-side, so presence has to
  // be re-registered even though nothing changed on this device.
  socket.on('connect', () => { watchGroups(true); });

  // --------------------------------------------------------------------
  // Invite mode: what someone sees after tapping a shared link.
  //
  // Before this existed they landed on the full three-mode menu, and the
  // name field lived only inside the profile modal behind a small avatar
  // icon -- so a first-time visitor went: tap Join -> "Enter your name"
  // error -> hunt for the hidden field -> type -> close -> tap Join again.
  // Five steps and an error message, on the exact path every new player
  // arrives through. Now everything needed is on one card.
  // --------------------------------------------------------------------
  let inviteJoinKey = null;

  function enterInviteMode(key, headline) {
    inviteJoinKey = key;
    const card = document.getElementById('invite-card');
    const blocks = document.querySelector('.mode-blocks');
    if (!card || !blocks) return;
    blocks.classList.add('hidden');
    card.classList.remove('hidden');
    document.getElementById('invite-headline').textContent = headline;
    document.getElementById('invite-roomcode').textContent = key;
    const nameInput = document.getElementById('input-invite-name');
    // Returning players never retype -- same stored name the rest of the app
    // uses, so this is usually already filled and it's a single tap to play.
    nameInput.value = localStorage.getItem(NAME_STORAGE_KEY) || '';
    setTimeout(() => { try { nameInput.focus(); } catch (e) {} }, 60);
  }

  function exitInviteMode() {
    inviteJoinKey = null;
    const card = document.getElementById('invite-card');
    const blocks = document.querySelector('.mode-blocks');
    if (card) card.classList.add('hidden');
    if (blocks) blocks.classList.remove('hidden');
  }

  (function handleInviteLink() {
    const params = new URLSearchParams(window.location.search);
    const groupCode = (params.get('g') || '').trim().toUpperCase();
    // Both kinds of code are uppercase; ?g= vs ?room= only says which sort
    // of table you were invited to.
    const roomFromLink = (params.get('room') || '').trim().toUpperCase();

    if (groupCode) {
      enterInviteMode(groupCode, 'You’ve been invited to play');
      // Ask the server what this group is actually called, so the card says
      // "Sharma Family" rather than the raw code. Purely cosmetic -- if the
      // lookup fails the card still works and they can still join.
      socket.emit('get_group', { code: groupCode }, (res) => {
        if (!res || !res.ok || !res.group) return;
        document.getElementById('invite-headline').textContent = `You’ve been invited to ${res.group.name}`;
        document.getElementById('invite-roomcode').textContent = res.group.name;
      });
    } else if (roomFromLink) {
      document.getElementById('input-roomcode').value = roomFromLink;
      enterInviteMode(roomFromLink, 'You’ve been invited to a game');
    }

    if (groupCode || roomFromLink) {
      // Strip the param so it can't linger in the address bar or get shared
      // onward by accident (e.g. a browser "share this page").
      const url = new URL(window.location.href);
      url.searchParams.delete('g');
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }
  })();

  // --------------------------------------------------------------------
  // Deep link arriving while the app is already open (Android App Links).
  //
  // The IIFE above only runs at page load, which covers the browser and a
  // cold app start. But once App Links are verified, tapping an invite in
  // WhatsApp with the app already running hands the URL to the app instead
  // of reloading the page -- Capacitor fires appUrlOpen and nothing else
  // happens unless we listen for it.
  //
  // Registered now even though the manifest side isn't built yet: it's inert
  // without it (the event simply never fires), and it means the native build
  // is a manifest change only, with no matching web deploy to remember.
  // --------------------------------------------------------------------
  (function listenForDeepLinks() {
    const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!CapApp || !CapApp.addListener) return;
    CapApp.addListener('appUrlOpen', (event) => {
      try {
        const url = new URL(event.url);
        const gcode = (url.searchParams.get('g') || '').trim().toUpperCase();
        const room = (url.searchParams.get('room') || '').trim().toUpperCase();
        if (!gcode && !room) return;
        // Already sitting in that exact table? Don't yank them out of it.
        if (myRoomCode && (myRoomCode === gcode || myRoomCode === room)) return;
        if (gcode) {
          enterInviteMode(gcode, 'You’ve been invited to play');
          socket.emit('get_group', { code: gcode }, (res) => {
            if (!res || !res.ok || !res.group) return;
            document.getElementById('invite-headline').textContent = `You’ve been invited to ${res.group.name}`;
            document.getElementById('invite-roomcode').textContent = res.group.name;
          });
        } else {
          document.getElementById('input-roomcode').value = room;
          enterInviteMode(room, 'You’ve been invited to a game');
        }
        showScreen('screen-landing');
      } catch (e) {
        console.warn('[DeepLink] could not handle', event && event.url, e && e.message);
      }
    });
  })();

  document.getElementById('btn-invite-join').onclick = () => {
    const nameInput = document.getElementById('input-invite-name');
    const name = nameInput.value.trim();
    if (!name) {
      setLandingError('Enter your name');
      try { nameInput.focus(); } catch (e) {}
      return;
    }
    // Mirror into the canonical name field/storage that the rest of the app
    // (and getPlayerName) reads, so this card doesn't become a second source
    // of truth for who you are.
    localStorage.setItem(NAME_STORAGE_KEY, name);
    document.getElementById('input-name').value = name;
    joinRoomByKey(inviteJoinKey);
  };
  document.getElementById('btn-invite-dismiss').onclick = exitInviteMode;

  document.getElementById('btn-create-group').onclick = async () => {
    const nameInput = document.getElementById('input-group-name');
    const groupName = nameInput.value.trim();
    if (!groupName) return setLandingError('Name your group first');
    if (!getPlayerName()) return setLandingError('Enter your name');
    const btn = document.getElementById('btn-create-group');
    btn.disabled = true;
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('create_group', { groupName, firebaseIdToken }, (res) => {
      btn.disabled = false;
      if (!res || !res.ok) return setLandingError((res && res.error) || 'Could not create the group.');
      nameInput.value = '';
      rememberGroup(res.code, res.name);
      logAnalytics('group_created');
      // Creating a group does NOT drop you into a game (Sept 2026, per
      // feedback). Making a group and playing at it are separate acts: the
      // group appears in the list above, and you open it when people are
      // actually around. The menu opens straight away so the obvious next
      // step -- sharing the link -- is one tap, without having sat down at
      // an empty table first.
      // Creating a group does NOT drop you into a game -- making a group and
      // playing at it are separate acts. You land on the group's own screen,
      // where Invite is right there.
      openGroupScreen(res.code, res.name);
    });
  };

  // Quick Play toggle: Play Online and Play with Bots ask the same question
  // ("how many?") so they now share one block. Both sub-blocks stay in the
  // DOM with their original ids -- only visibility switches -- so the
  // existing matchmaking and solo handlers are untouched.
  (function wireQuickPlayToggle() {
    const toggle = document.getElementById('quickplay-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.seg').forEach((seg) => {
      seg.onclick = () => {
        const mode = seg.dataset.mode;
        toggle.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s === seg));
        document.getElementById('quickplay-online').classList.toggle('hidden', mode !== 'online');
        document.getElementById('quickplay-bots').classList.toggle('hidden', mode !== 'bots');
      };
    });
  })();

  renderGroupsBlock();
  function getPlayerName() {
    const name = document.getElementById('input-name').value.trim();
    if (name) localStorage.setItem(NAME_STORAGE_KEY, name);
    return name;
  }

  document.getElementById('btn-create').onclick = async () => {
    const name = getPlayerName();
    if (!name) return setLandingError('Enter your name');
    const firebaseIdToken = await currentFirebaseIdToken();
    socket.emit('create_room', { name, firebaseIdToken, platform: CLIENT_PLATFORM, avatar: myAvatar }, (res) => {
      if (!res.ok) return setLandingError(res.error);
      logAnalytics('room_created');
      saveSession(res.roomCode, res.playerId);
      loadChatHistory(res.chatHistory);
      showChatFab();
      showScreen('screen-lobby');
    });
  };

  // Thin wrapper now -- the actual join lives in joinRoomByKey() above, so
  // typing a code, tapping a saved group and following an invite link all
  // go through exactly the same path.
  // Routes by code length: a 4-letter ad-hoc code drops you straight into
  // that room, but a 5-letter GROUP code opens the group's own screen rather
  // than seating you at a table nobody else is at. Joining a group and
  // sitting down to play are separate acts -- typing a code shouldn't skip
  // the first one.
  // There are TWO of these boxes -- one in each landing pane (Sept 2026).
  //
  // The box accepts both kinds of code, but when the landing screen was split
  // into Groups / Quick Play it ended up filed under Groups only. So someone
  // sent a 4-letter Quick Room code had to switch to the GROUPS tab to type
  // it in. Rather than pick a home for it, it now appears in both, and the
  // code itself decides where you land -- which is what the length already
  // told us. Same wording in both, so neither reads as the "real" one.
  //
  // Both boxes share this handler; only their element ids differ.
  const JOIN_INPUT_IDS = ['input-roomcode', 'input-roomcode-quick'];

  function clearJoinCodeInputs() {
    JOIN_INPUT_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  function submitJoinCode(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const code = input.value.trim().toUpperCase();
    if (!code) return setLandingError('Enter a code');
    // Length is the router. A 5-letter GROUP code opens that group's own
    // screen rather than seating you at a table nobody else is at -- joining
    // a group and sitting down to play are separate acts, and typing a code
    // shouldn't skip the first one. Anything else is a one-off room code and
    // goes straight in.
    if (code.length === 5) {
      clearJoinCodeInputs();
      openGroupScreen(code);
      return;
    }
    joinRoomByKey(code);
  }

  (function wireJoinCodeBoxes() {
    [
      { input: 'input-roomcode', button: 'btn-join' },
      { input: 'input-roomcode-quick', button: 'btn-join-quick' },
    ].forEach(({ input, button }) => {
      const btn = document.getElementById(button);
      const box = document.getElementById(input);
      if (btn) btn.onclick = () => submitJoinCode(input);
      // Enter submits -- on a phone the keyboard's Go key is the natural way
      // to finish typing a code, and reaching for the button instead is
      // friction on the one screen a brand-new player has to get through.
      if (box) {
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitJoinCode(input);
        });
      }
    });
  })();

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
  // Two link shapes, because there are two kinds of table:
  //   ?g=sharma-family-k2p  -- a permanent group. This link never expires,
  //                            so it can be pinned in a WhatsApp group once
  //                            and keep working for years.
  //   ?room=ABCD            -- a one-off room, good only for this session.
  // Separate params rather than one, because the room-code path uppercases
  // its value, and ?g= vs ?room= records which kind of table it was.
  function roomInviteLink() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    const gcode = latestRoom && latestRoom.groupCode;
    if (gcode) url.searchParams.set('g', gcode);
    else url.searchParams.set('room', myRoomCode || '');
    return url.toString();
  }

  // "Ravi invited you..." rather than "Join my Least Count game!" -- an
  // invitation with a person's name attached reads as a message from someone
  // you know, which is the whole point of it landing in a family group chat.
  function inviteShareText() {
    const link = roomInviteLink();
    const who = (localStorage.getItem(NAME_STORAGE_KEY) || '').trim();
    const groupName = latestRoom && latestRoom.groupName;
    const lead = who ? `${who} invited you` : 'You are invited';
    return groupName
      ? `${lead} to play Least Count with "${groupName}".\n${link}`
      : `${lead} to a game of Least Count. Room code: ${myRoomCode}\n${link}`;
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
    const shareText = inviteShareText();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Least Count', text: shareText.split('\n')[0], url: link });
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

  // --------------------------------------------------------------------
  // Share straight to WhatsApp.
  //
  // Why this exists alongside the generic share button above: navigator.share
  // is a Chrome API that Android WebView does not implement, so inside the
  // Capacitor-wrapped app the button above silently falls through to
  // "copied to clipboard" -- leaving the user to open WhatsApp and find the
  // contact themselves, which is exactly the friction the invite loop can't
  // afford. A wa.me URL is just a link, so it works in the WebView with no
  // native plugin and no rebuild, and lands the user on WhatsApp's own
  // contact picker with the message already written.
  //
  // TODO (next native build): install @capacitor/share and prefer it when
  // window.Capacitor.Plugins.Share exists, which restores the full app
  // chooser (WhatsApp / Instagram / Messages) instead of WhatsApp only.
  // Deliberately not done now because it needs an AAB upload and a Play
  // review cycle, and this fix shouldn't wait for that.
  // --------------------------------------------------------------------
  function openWhatsAppShare(text) {
    const url = 'https://wa.me/?text=' + encodeURIComponent(text);
    // _blank so Android hands the https link off to whatever claims it --
    // WhatsApp registers wa.me as an App Link, so it opens the app directly
    // when installed and falls back to the web version when it isn't.
    const win = window.open(url, '_blank');
    if (!win) window.location.href = url; // popup blocked -- navigate instead
  }

  const shareWhatsAppBtn = document.getElementById('btn-share-whatsapp');
  if (shareWhatsAppBtn) {
    shareWhatsAppBtn.onclick = () => {
      if (!myRoomCode) return;
      logAnalytics('invite_shared_whatsapp');
      openWhatsAppShare(inviteShareText());
    };
  }

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
      // Both buttons clear their own row immediately rather than waiting for
      // the server's refreshed list. The server does send one (and it will
      // overwrite this), but a dropped packet or a slow round trip used to
      // leave the banner sitting there as though the tap hadn't registered --
      // so the host taps again, and the second tap errors with "that request
      // is no longer waiting". Removing the row on tap makes the control feel
      // answered and removes the reason to tap twice.
      const settle = () => {
        row.remove();
        if (!banner.children.length) banner.classList.add('hidden');
      };
      row.querySelector('.jr-admit').onclick = () => {
        settle();
        socket.emit('admit_join_request', { roomCode: myRoomCode, playerId: req.playerId });
      };
      row.querySelector('.jr-ignore').onclick = () => {
        settle();
        socket.emit('ignore_join_request', { roomCode: myRoomCode, playerId: req.playerId });
      };
      banner.appendChild(row);
    });
  }
  socket.on('join_requests', ({ pending }) => renderJoinRequestsBanner(pending));

  // ================= rejoin after elimination: client =================
  // Engine + server for this shipped days before the UI did, so until now an
  // eliminated player simply spectated: the server was listening for
  // request_rejoin, the engine was exposing canRejoin/rejoinScore per viewer,
  // and nothing ever asked. These three pieces close that.
  //
  // The server gives the decision REJOIN_DECISION_MS (30s) and auto-denies
  // after it, holding the next round the whole time -- so both sides show a
  // countdown, and neither is allowed to look like it's waiting forever.
  const REJOIN_DECISION_MS = 30000;
  let rejoinAsked = false;       // this player has a request in flight
  let rejoinDeadline = 0;        // epoch ms the server will give up at
  let rejoinTicker = null;

  function rejoinEls() {
    return {
      box: document.getElementById('rejoin-offer'),
      text: document.getElementById('rejoin-offer-text'),
      status: document.getElementById('rejoin-offer-status'),
      ask: document.getElementById('btn-rejoin-ask'),
      no: document.getElementById('btn-rejoin-no'),
    };
  }

  function stopRejoinTicker() {
    if (rejoinTicker) { clearInterval(rejoinTicker); rejoinTicker = null; }
  }

  function secondsLeft() {
    return Math.max(0, Math.ceil((rejoinDeadline - Date.now()) / 1000));
  }

  // Locks the buttons and counts down while the host decides. Reaching zero
  // doesn't decide anything on its own -- the SERVER's timer is the one that
  // matters, and its rejoin_result is what actually closes this out. This
  // just stops the screen claiming time is left when it isn't.
  function startRejoinCountdown() {
    const { status } = rejoinEls();
    stopRejoinTicker();
    const tick = () => {
      const s = secondsLeft();
      status.textContent = s > 0
        ? `Asked the host — ${s}s left`
        : 'Waiting for the host…';
      if (s <= 0) stopRejoinTicker();
    };
    tick();
    rejoinTicker = setInterval(tick, 1000);
  }

  function hideRejoinOffer() {
    stopRejoinTicker();
    const { box, status } = rejoinEls();
    box.classList.add('hidden');
    status.classList.add('hidden');
  }

  // Called from the round-result render. `game.canRejoin` and
  // `game.rejoinScore` are computed per-viewer by the engine, so this needs
  // no eligibility logic of its own -- deliberately, so the screen can never
  // offer something the server would then refuse.
  function renderRejoinOffer(game) {
    const { box, text, status, ask, no } = rejoinEls();
    if (!game || !game.canRejoin) {
      // Not eligible (or no longer eligible -- e.g. the game ended while the
      // scorecard was up). Drop any in-flight state with it.
      if (!rejoinAsked) hideRejoinOffer();
      return;
    }

    box.classList.remove('hidden');
    const back = game.rejoinScore;
    const limit = game.eliminationScore || 200;
    text.textContent = rejoinAsked
      ? 'Waiting for the host to answer.'
      : `You're out. Come back in at ${back} points? The limit is ${limit}.`;
    ask.classList.toggle('hidden', rejoinAsked);
    no.classList.toggle('hidden', rejoinAsked);
    status.classList.toggle('hidden', !rejoinAsked);
  }

  document.getElementById('btn-rejoin-ask').onclick = () => {
    const { status } = rejoinEls();
    // Optimistic: the buttons swap for the countdown immediately rather than
    // after the round trip, because the 30 seconds are already running on the
    // server and a second tap would just be refused as a duplicate.
    rejoinAsked = true;
    rejoinDeadline = Date.now() + REJOIN_DECISION_MS;
    renderRejoinOffer(latestGame);
    startRejoinCountdown();
    socket.emit('request_rejoin', { roomCode: myRoomCode }, (res) => {
      if (res && res.ok) return;
      // Refused (solo vs bots, no longer eligible, rate limited). Put the
      // choice back rather than leaving a countdown that will never resolve.
      rejoinAsked = false;
      stopRejoinTicker();
      renderRejoinOffer(latestGame);
      status.classList.remove('hidden');
      status.textContent = friendlyError((res && res.error) || 'Could not ask to rejoin.');
    });
  };

  document.getElementById('btn-rejoin-no').onclick = () => {
    hideRejoinOffer();
    rejoinAsked = false;
    // Tells the server to stop holding the round for a decision this player
    // has already made. Leaving instead is the player's own call afterwards.
    socket.emit('decline_rejoin', { roomCode: myRoomCode }, () => {});
  };

  socket.on('rejoin_result', ({ ok, score, reason }) => {
    rejoinAsked = false;
    stopRejoinTicker();
    const { box, text, status, ask, no } = rejoinEls();
    box.classList.remove('hidden');
    ask.classList.add('hidden');
    no.classList.add('hidden');
    status.classList.remove('hidden');
    if (ok) {
      text.textContent = 'You’re back in.';
      status.textContent = `Rejoined at ${score} points. Next round deals shortly.`;
      // The seats, scores and your hand all arrive on the next game_state --
      // nothing to reconstruct here.
    } else {
      text.textContent = 'Not this time.';
      status.textContent = friendlyError(reason || 'The host declined.');
    }
  });

  // ---- host side: who's asking to come back ----
  function renderRejoinRequestsBanner(pending) {
    const banner = document.getElementById('rejoin-requests-banner');
    banner.classList.toggle('hidden', !pending || pending.length === 0);
    banner.innerHTML = '';
    (pending || []).forEach((req) => {
      const row = document.createElement('div');
      row.className = 'join-request-row';
      const txt = document.createElement('span');
      txt.className = 'jr-text';
      const b = document.createElement('b');
      b.textContent = req.name;
      txt.appendChild(b);
      // The score is the whole decision for the host -- letting someone back
      // at 45 and at 190 are not the same favour -- so it's stated, not
      // implied, and built as text nodes since the name is user-supplied.
      txt.appendChild(document.createTextNode(` wants back in at ${req.score}`));
      const yes = document.createElement('button');
      yes.className = 'jr-admit'; yes.type = 'button'; yes.textContent = 'Let in';
      const nope = document.createElement('button');
      nope.className = 'jr-ignore'; nope.type = 'button'; nope.textContent = 'No';
      row.appendChild(txt); row.appendChild(yes); row.appendChild(nope);

      // Same reason as the join banner: clear the row on tap so a slow round
      // trip doesn't invite a second tap that errors with "no longer waiting".
      const settle = () => {
        row.remove();
        if (!banner.children.length) banner.classList.add('hidden');
      };
      yes.onclick = () => {
        settle();
        socket.emit('respond_rejoin', { roomCode: myRoomCode, playerId: req.playerId, accept: true }, () => {});
      };
      nope.onclick = () => {
        settle();
        socket.emit('respond_rejoin', { roomCode: myRoomCode, playerId: req.playerId, accept: false }, () => {});
      };
      banner.appendChild(row);
    });
  }
  socket.on('rejoin_requests', ({ pending }) => renderRejoinRequestsBanner(pending));

  // Errors get TWO independent signals now, not just one easy-to-miss one:
  // 1) the inline toast banner in the main page flow (visible regardless of
  //    whether the profile dropdown is open), and 2) the same text inside
  //    the dropdown itself (#landing-error) plus a brief pulse on the
  //    avatar, for anyone who does have it open already. Whichever a
  //    player actually notices, the message gets through.
  // ------------------------------------------------------------------
  // Server error strings are shown to the player verbatim, so anything the
  // server didn't phrase deliberately lands in the UI as-is. Creating a group
  // on the live build printed "8 RESOURCE_EXHAUSTED: Quota exceeded." into
  // the toast -- a raw Firestore gRPC code, to a family playing cards.
  //
  // Messages we wrote ("Only the group admin can start a marathon") pass
  // through untouched; this only rewrites the ones that are plainly not ours,
  // and logs the original so it's still debuggable.
  // ------------------------------------------------------------------
  function friendlyError(msg) {
    const raw = (msg || '').toString().trim();
    if (!raw) return '';
    const looksInternal = /^\d+\s+[A-Z][A-Z_]{3,}/.test(raw)
      || /RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|PERMISSION_DENIED|UNAUTHENTICATED|INTERNAL|ECONNREFUSED|ETIMEDOUT/.test(raw);
    if (!looksInternal) return raw;
    console.warn('[LC] internal error shown as generic:', raw);
    return 'That’s not available right now — please try again in a moment.';
  }

  function setLandingError(rawMsg) {
    const msg = friendlyError(rawMsg);
    document.getElementById('landing-error').textContent = msg || '';
    // Mirror onto the group screen. Both surfaces this writes to below live
    // INSIDE #screen-landing, so anything that failed while the group screen
    // was up was invisible -- a refused start or a join that didn't take just
    // looked like the button did nothing. That silence is most of the reason
    // the group start bug was so hard to pin down.
    const groupErr = document.getElementById('group-error');
    if (groupErr) groupErr.textContent = msg || '';
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
    socket.emit('create_solo_room', { name, botCount, firebaseIdToken, platform: CLIENT_PLATFORM, avatar: myAvatar }, (res) => {
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
    socket.emit('queue_join', { playerCount, name, firebaseIdToken, platform: CLIENT_PLATFORM, avatar: myAvatar }, (res) => {
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

  // ------------------------------------------------------------------
  // Table nickname. Friends rename themselves for a laugh between rounds --
  // this changes what THIS table sees and nothing else: the saved profile
  // name is untouched, and the group marathon board still records the real
  // one (see recordGroupGame on the server).
  //
  // Reachable from your own lobby row and your own seat. Deliberately NOT
  // from the round-result screen, which auto-advances after 10 seconds and
  // would cut people off mid-typing.
  // ------------------------------------------------------------------
  function openNameDialog() {
    const dlg = document.getElementById('table-name-dialog');
    const input = document.getElementById('input-table-name');
    if (!dlg || !input) return;
    input.value = playerName(myPlayerId) || getPlayerName() || '';
    document.getElementById('table-name-error').textContent = '';
    dlg.classList.remove('hidden');
    setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 60);
  }

  function closeNameDialog() {
    const dlg = document.getElementById('table-name-dialog');
    if (dlg) dlg.classList.add('hidden');
  }

  (function wireNameDialog() {
    const cancel = document.getElementById('btn-table-name-cancel');
    const save = document.getElementById('btn-table-name-save');
    const input = document.getElementById('input-table-name');
    if (!cancel || !save || !input) return;
    cancel.onclick = closeNameDialog;
    save.onclick = () => {
      const name = (input.value || '').trim();
      if (!name) {
        document.getElementById('table-name-error').textContent = 'Enter a name.';
        return;
      }
      socket.emit('set_name', { roomCode: myRoomCode, name }, (res) => {
        if (!res || !res.ok) {
          document.getElementById('table-name-error').textContent = (res && res.error) || 'Could not change it.';
          return;
        }
        closeNameDialog();
      });
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.onclick(); });
  })();

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
      } else if (p.playerId === myPlayerId) {
        // Your own row opens the rename box instead of the report popover --
        // there is nothing to report yourself for.
        li.classList.add('tappable', 'own-row');
        const pencil = document.createElement('span');
        pencil.className = 'row-edit';
        pencil.textContent = 'Edit';
        li.appendChild(pencil);
        li.onclick = (e) => { e.stopPropagation(); openNameDialog(); };
      }
      list.appendChild(li);
    });
    reopenPlayerActionPopoverIfNeeded(list);
    // Start Game is available to EVERYONE at the table (Sept 2026), not just
    // the host: six people in a group, four free tonight, and those four
    // shouldn't be blocked by whoever happens to hold the host flag -- who
    // might not even be playing. The max-score selector moves with it, since
    // whoever starts the game is the one choosing how long it runs.
    const btn = document.getElementById('btn-start');
    btn.classList.remove('hidden');
    btn.disabled = room.players.length < 2;
    // While you're the only one here, Start Game is dead weight and inviting
    // is the only thing worth doing -- so it visually steps back and the
    // WhatsApp invite button above is the loudest thing on screen. It becomes
    // primary again the moment there's someone to play with.
    const alone = room.players.length < 2;
    btn.classList.toggle('primary', !alone);
    btn.classList.toggle('secondary', alone);
    document.getElementById('lobby-maxscore-row').classList.remove('hidden');
    document.getElementById('lobby-hint').textContent = alone
      ? 'Invite someone to get started'
      : `Ready with ${room.players.length} players — anyone can start`;

    // ---- persistent group extras ----
    const isGroup = !!room.groupCode;
    const groupHeader = document.getElementById('lobby-group-header');
    const groupNameEl = document.getElementById('lobby-group-name');
    if (groupNameEl) groupNameEl.textContent = room.groupName || '';
    if (groupHeader) groupHeader.classList.toggle('hidden', !isGroup);
    // A group has its own screen carrying the code and the invite, so the
    // lobby's ad-hoc room-code row is redundant while playing in one.
    const codeLabel = document.getElementById('lobby-roomcode-label');
    const codeRow = document.getElementById('lobby-roomcode-row');
    const codeHint = document.getElementById('lobby-code-hint');
    if (codeLabel) codeLabel.classList.toggle('hidden', isGroup);
    if (codeRow) codeRow.classList.toggle('hidden', isGroup);
    if (codeHint) codeHint.classList.toggle('hidden', isGroup);

    if (isGroup) rememberGroup(room.groupCode, room.groupName);
  }

  // Running leaderboard for a permanent group, shown in an overlay from the
  // trophy icon rather than inline -- as a block in the page flow it pushed
  // Start Game and Leave Table below the fold on a phone.
  function loadGroupStandings(code) {
    const list = document.getElementById('lobby-standings');
    const empty = document.getElementById('lobby-standings-empty');
    if (!list) return;
    socket.emit('get_group', { code }, (res) => {
      if (!res || !res.ok || !res.group) return;
      // The lobby's trophy shows THIS MONTH's marathon -- the same table the
      // group screen leads with, so the two never disagree.
      const rows = res.group.marathon.standings || [];
      list.innerHTML = '';
      empty.classList.toggle('hidden', rows.length > 0);
      rows.forEach((s, i) => {
        const li = document.createElement('li');
        li.className = 'standings-row';
        // Average score is per game and LOWER is better in Least Count, so
        // it's labelled explicitly rather than left to be guessed at.
        li.innerHTML =
          `<span class="st-rank">${i + 1}</span>` +
          `<span class="st-name">${escapeHtml(s.name)}</span>` +
          `<span class="st-wins">${s.points}</span>`;
        list.appendChild(li);
      });
    });
  }

  document.getElementById('btn-group-leaderboard').onclick = () => {
    if (!latestRoom || !latestRoom.groupCode) return;
    loadGroupStandings(latestRoom.groupCode);
    document.getElementById('overlay-standings').classList.remove('hidden');
  };
  document.getElementById('btn-close-standings').onclick = () => {
    document.getElementById('overlay-standings').classList.add('hidden');
  };
  document.getElementById('overlay-standings').onclick = (e) => {
    if (e.target.id === 'overlay-standings') e.currentTarget.classList.add('hidden');
  };

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
  // Must match .seat { width } in style.css -- the clamp below is in percent
  // of the table, so it needs the seat's pixel width to convert.
  const SEAT_WIDTH_PX = 96;

  function renderOvalTable(game, orderOverride) {
    const oval = document.getElementById('oval-table');
    oval.querySelectorAll('.seat').forEach((el) => el.remove());
    renderRevealBanner(game);
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

    // ------------------------------------------------------------------
    // Fluid table furniture (Sept 2026).
    //
    // The oval was the ONLY thing on this screen sized from the viewport
    // (max-height: 56vh), so it absorbed every bit of device variation on
    // its own: measured 513px tall on a 412x915 phone but crushed to 286px
    // on a 360x640 one. Meanwhile the seats stayed pinned at 96px and the
    // centre cards at 58px, so a chair went from 19% of the table's height
    // to 34% of it, and on the narrow table the side seats overlapped the
    // open/joker cards by 27px on BOTH sides:
    //
    //   seat 96 + centre (58 + 18 + 58) + seat 96 = 326px of furniture
    //   ...into a table only 273px wide.
    //
    // Those numbers were never wrong, just tuned for the ~372px table a
    // Pixel gives you (326 fits in 372 with room to spare). Expressed as
    // fractions of the table's OWN width they hold everywhere, and on a
    // big phone they resolve to the same values as before -- so nothing
    // changes on the devices where this already looked right.
    //
    // Floors stop it collapsing into unreadability on a 320px screen; the
    // caps are today's values, so this can only ever shrink, never inflate.
    // ------------------------------------------------------------------
    const tableW = oval.getBoundingClientRect().width || 1;
    const px = (v) => Math.round(v) + 'px';
    const seatW = Math.round(Math.max(62, Math.min(SEAT_WIDTH_PX, tableW * 0.26)));
    const centreCardW = Math.round(Math.max(34, Math.min(58, tableW * 0.155)));
    const centreGap = Math.round(Math.max(8, Math.min(18, tableW * 0.04)));
    oval.style.setProperty('--table-w', px(tableW));
    oval.style.setProperty('--seat-w', px(seatW));
    oval.style.setProperty('--centre-card-w', px(centreCardW));
    oval.style.setProperty('--centre-gap', px(centreGap));

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
      // Keep the seat fully on screen. The ring puts side seats at 7% and
      // 93% of the table and, at 96px wide centred on that point, they hung
      // 5px off each edge on a 375px phone -- measured on the live build,
      // both sides, every game. Clamping against the table's real width
      // fixes it at any screen size instead of nudging the radius by feel.
      // Clamp against the seat's ACTUAL rendered width (which now shrinks
      // with the table), not the 96px maximum -- otherwise a 71px seat on a
      // narrow table gets pushed 12px further inboard than it needs to be,
      // straight back into the centre cards this change exists to clear.
      const halfSeatPct = (seatW / 2) / tableW * 100;
      seatEl.style.left = Math.min(100 - halfSeatPct, Math.max(halfSeatPct, left)) + '%';
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
      } else if (!dealing && p.playerId === myPlayerId) {
        // Tapping your own seat renames you. Always available mid-game, and
        // never racing the round-result countdown.
        seatEl.classList.add('tappable');
        seatEl.onclick = (e) => { e.stopPropagation(); openNameDialog(); };
      }

      const count = game && game.handCounts ? game.handCounts[p.playerId] : (dealing ? 0 : undefined);
      const score = game && game.scores ? (game.scores[p.playerId] ?? 0) : 0;

      // Every seat (opponent or you) renders the exact same single chip:
      // name on top, "N cards · M pts" below. No extra icon on top of it,
      // so every seat looks identical regardless of position on the table.
      // While dealing, only the running card count is shown (no score yet).
      const chipEl = document.createElement('div');
      chipEl.className = 'seat-chip';

      // ---- avatar + name on one row (Sept 2026) ----
      // A seat used to be two lines of text, which is why the table read as
      // a status display rather than a place people were sitting. The face
      // is the first thing you should be able to tell apart at a glance,
      // before you can read anything.
      const idRow = document.createElement('div');
      idRow.className = 'seat-id';
      // Guarded because this runs inside renderOvalTable's per-seat loop: an
      // avatar that failed to build would otherwise abort the loop and leave
      // the table half-rendered. A seat with no face is a blemish; a table
      // with no seats is a broken game.
      try {
        idRow.appendChild(avatarEl(p.avatar, p.name, p.playerId, 22));
      } catch (e) { /* seat renders without a face */ }
      const nameEl = document.createElement('div');
      nameEl.className = 'seat-name';
      // Own seat is marked with a neutral ring (see .seat.own-seat in
      // style.css) instead of appending "(You)" text -- that text used to
      // share the exact same 96px truncation-prone width as everyone else's
      // name, so it clipped sooner than it should have for no good reason.
      nameEl.textContent = p.name;
      if (p.playerId === myPlayerId) seatEl.classList.add('own-seat');
      idRow.appendChild(nameEl);
      chipEl.appendChild(idRow);

      // ---- fan of card backs ----
      // "13 cards" is a number you read; three overlapping backs is a hand
      // you see. Deliberately a FIXED three rather than one back per card:
      // seats are 71-96px wide depending on device (see the fluid furniture
      // maths above) and thirteen backs would either not fit or shrink to
      // slivers. The exact count stays on the badge, so nothing is lost --
      // the fan carries "this is a hand", the badge carries "how big".
      // Skipped for your own seat: your real cards are in the tray below,
      // and a fake fan of your own hand would be actively confusing.
      if (count !== undefined && count > 0 && p.playerId !== myPlayerId) {
        const fan = document.createElement('div');
        fan.className = 'seat-fan';
        const backs = Math.min(3, count);
        for (let b = 0; b < backs; b++) {
          const back = document.createElement('span');
          back.className = 'seat-back';
          back.style.setProperty('--i', String(b));
          fan.appendChild(back);
        }
        const badge = document.createElement('span');
        badge.className = 'seat-fan-count';
        badge.textContent = String(count);
        fan.appendChild(badge);
        chipEl.appendChild(fan);
      }

      const metaEl = document.createElement('div');
      metaEl.className = 'seat-meta';
      // The reveal box now carries the running total, so the chip drops it
      // while that box is up -- otherwise moving the total into the box just
      // relocates the duplicate instead of removing it.
      const chipHidesScore = dealing || (revealPhaseActive && p.playerId !== myPlayerId);
      // The fan's badge now carries the card count for opponents, so this
      // line drops it there and shows the score alone -- printing "13" on
      // the badge and "13 cards" underneath it is just the same fact twice
      // in a seat that has no room to spare. Your own seat has no fan, so
      // it keeps the full text.
      const fanShowsCount = count !== undefined && count > 0 && p.playerId !== myPlayerId;
      if (count === undefined) {
        metaEl.textContent = '';
      } else if (fanShowsCount) {
        metaEl.textContent = chipHidesScore ? '' : score + ' pts';
      } else {
        metaEl.textContent = count + ' cards' + (chipHidesScore ? '' : ' · ' + score + ' pts');
      }
      chipEl.appendChild(metaEl);

      // Recent discards for THIS player, this round -- lets you track what
      // opponents have been throwing away, same as you naturally would
      // watching a real discard pile. Sits inside the chip itself (not a
      // separate floating box), so it never needs edge-aware positioning --
      // it just makes the pill a little taller, never wider than the seat.
      const history = (!dealing && game && game.discardHistory) ? game.discardHistory[p.playerId] : null;
      if (history && history.length > 0 && !revealPhaseActive) {
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

      // Round-end reveal: everyone's remaining cards, shown at their own
      // chair before the scorecard appears (see startRevealPhase below).
      // Skipped for your own seat -- your cards are already face-up in the
      // tray, and its header already prints "Your cards (Value: N)", so a
      // box here would only duplicate both.
      if (revealPhaseActive && p.playerId !== myPlayerId) {
        const revealBox = buildSeatRevealBox(game, p.playerId, top);
        if (revealBox) seatEl.appendChild(revealBox);
      }

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
      // The second of the two things that vibrate. Guarded to YOUR turn --
      // buzzing while a bot's clock runs down would mean nothing, and this
      // tick runs for every player's timer, not just yours.
      const isMyTurn = !!(latestGame && !latestGame.roundOver
        && latestGame.currentPlayer === myPlayerId);
      maybeBuzzTurnTimer(remaining, isMyTurn);
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
      // Printed Joker or this round's wild rank -- both score zero, and the
      // engine now refuses to discard either (see playTurn). Blocking the
      // tap here means a player never triggers that error in the first
      // place: the rule shows up as a card you can't pick, not a telling-off
      // after you've picked it.
      const isJoker = rep.rank === 'JOKER' || (wildRank && rep.rank === wildRank);
      // The engine's one exception: a hand holding nothing BUT jokers has to
      // be able to play something, or the turn can never end.
      const hasNonJoker = (game.yourHand || []).some(
        (c) => c.rank !== 'JOKER' && !(wildRank && c.rank === wildRank)
      );
      let selectable = isMyTurn && !game.roundOver && !(isJoker && hasNonJoker);
      if (duringChain) selectable = selectable && g.rank === '2';
      const allSelected = g.cards.every((c) => selectedIds.has(c.id));
      const isWild = rep.rank !== 'JOKER' && wildRank && rep.rank === wildRank;
      const hinted = !!(hintCardIds && hintCardIds.length && g.cards.some((c) => hintCardIds.includes(c.id)));
      const el = cardEl(rep, { selectable, selected: allSelected, wild: isWild, hinted });
      if (isJoker) {
        // Marks BOTH kinds, so the printed Joker and the wild rank read as
        // one category. Previously only the wild rank got a gold border and
        // the printed Joker looked like any other card.
        el.classList.add('is-joker');
        el.title = 'Worth 0 — jokers can’t be discarded';
      }
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

    // A leave that was queued mid-round (see btn-leave-game-confirm) fires
    // the moment the round is over, which is the first point the server will
    // accept it.
    // ...or sooner, if this state push is the one that knocked them out:
    // an eliminated player holds no cards, so the server will take the leave
    // right now and there's nothing left to wait for.
    const nowSpectating =
      myPlayerId &&
      (game.eliminated || []).concat(game.quit || []).indexOf(myPlayerId) !== -1;
    if (leaveAfterRound && (game.roundOver || game.gameOver || nowSpectating)) {
      setLeavePending(false);   // clears the flag AND the button's pending look
      leaveRoom();
      return;
    }

    const isMyTurn = game.currentPlayer === myPlayerId;
    const currentName = playerName(game.currentPlayer);
    // Only on the TRANSITION to your turn, so a chat you deliberately
    // reopened mid-turn isn't slammed shut on every game_state push.
    if (isMyTurn && !game.roundOver && prevCurrentPlayerForChat !== myPlayerId) closeChatForMyTurn();
    prevCurrentPlayerForChat = game.currentPlayer;

    // Round number went into the LEFT of the game bar, which was empty --
    // .game-top was justify-content:flex-end, so everything sat on the right.
    // It was pulled out of this bar once before for crowding it; this time it
    // occupies space nothing else wanted.
    const roundEl = document.getElementById('game-round');
    if (roundEl) roundEl.textContent = game.roundNumber ? 'Round ' + game.roundNumber : '';

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

    // Divider only shows when there's actually a joker/wild group to
    // separate from the normal cards -- with none, #hand-jokers is empty
    // and (being display:contents) takes up no space of its own anyway.
    document.getElementById('hand-divider').classList.toggle('hidden', jokerGroups.length === 0);
    renderHandTiles(document.getElementById('hand-jokers'), jokerGroups, isMyTurn, game, duringChain);
    renderHandTiles(document.getElementById('hand-normal'), normalGroups, isMyTurn, game, duringChain);

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
      // Marked as shown up front, not inside startRevealPhase -- renderGame
      // runs again for every game_state push that arrives DURING the reveal
      // hold, and without this the same round would re-trigger the phase on
      // each one.
      window.__lastRoundResultShownFor = game.roundNumber;
      // Cards face-up at each chair first; the scorecard follows once the
      // player taps or the hold elapses (see startRevealPhase above).
      startRevealPhase(game);
    }
  }

  // --------------------------------------------------------------------
  // Round-end reveal phase.
  //
  // When a round ends the table now holds for a moment with everyone's
  // remaining cards face-up at their own chair, BEFORE the scorecard
  // appears. Two reasons this exists:
  //   - It's how the game is actually played: cards go face-up on the
  //     table, everyone looks, then you tally. Splitting the reveal from
  //     the scoring is the natural seam.
  //   - It lets the scorecard drop its card rows entirely, which is what
  //     frees enough height there to fit every player without scrolling.
  //
  // Layout notes, all settled by testing against the real table rather
  // than guessed (see REVEAL_BOX_* constants in style.css):
  //   - The box hangs directly off its own chair, never dragged toward the
  //     middle. Hanging it INWARD works at 4 players but collapses at 6 --
  //     the top, upper-left and upper-right boxes all land in a heap. So
  //     it sits under the chip instead (over it, for bottom seats), which
  //     survives a full 6-player table with zero collisions.
  //   - The open card / joker / stock badge are hidden for the duration:
  //     the round is over, so they carry no information any more, and
  //     hiding them is what frees the middle of the oval for the boxes.
  // --------------------------------------------------------------------
  const REVEAL_MAX_SEAT_TILES = 5;
  const REVEAL_HOLD_MS = 8000;
  let revealPhaseActive = false;
  // Whose turn it was on the previous render -- used to spot the moment the
  // turn becomes yours (see closeChatForMyTurn).
  let prevCurrentPlayerForChat = null;
  // Someone tapped Leave mid-round. The server won't remove a player whose
  // cards are in play, so the departure waits for the round to end.
  let leaveAfterRound = false;
  let revealTimer = null;
  let revealPendingGame = null;

  // States the outcome in the middle of the table while the cards are on
  // show. Without this the reveal was all evidence and no verdict -- you
  // could see everyone's hands but had to work out for yourself who'd won,
  // and a penalty looked identical to a clean declare.
  function renderRevealBanner(game) {
    const el = document.getElementById('reveal-banner');
    if (!el) return;
    const r = game && game.lastRoundResult;
    if (!revealPhaseActive || !r) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    const declarer = playerName(r.declaredBy);
    const myScore = (r.roundScores || {})[myPlayerId];
    const parts = [];
    parts.push(`<div class="reveal-banner-title${r.correct ? '' : ' wrong'}">` +
      (r.correct
        ? `${escapeHtml(declarer)} got Least Count`
        : `${escapeHtml(declarer)} called wrong`) +
      '</div>');
    if (!r.correct) {
      const penalty = (r.roundScores || {})[r.declaredBy];
      if (penalty !== undefined) {
        parts.push(`<div class="reveal-banner-sub penalty">+${penalty} penalty</div>`);
      }
    }
    // Your own seat gets no reveal box (your cards are already face-up in
    // the tray), so this is the only place your result appears during the
    // reveal.
    if (myScore !== undefined) {
      parts.push(`<div class="reveal-banner-sub">You ${myScore === 0 ? 'scored 0' : '+' + myScore}</div>`);
    }
    el.innerHTML = parts.join('');
    el.classList.remove('hidden');
  }

  // Who came out of this round best. On a correct declare that's the
  // declarer (they score 0); on a wrong one it's whoever actually held the
  // lowest hand, which is exactly what makes a bad declare sting. Returns a
  // Set because ties are possible and both should be marked.
  function roundWinnerIds(game) {
    const scores = (game && game.lastRoundResult && game.lastRoundResult.roundScores) || {};
    const ids = Object.keys(scores);
    if (!ids.length) return new Set();
    const best = Math.min(...ids.map((id) => scores[id]));
    return new Set(ids.filter((id) => scores[id] === best));
  }

  function buildSeatRevealBox(game, playerId, topPercent) {
    const hand = (game.finalHands || {})[playerId];
    if (!hand) return null;
    const r = game.lastRoundResult;
    const wildRank = game.roundJokerRank;
    const roundScore = (r && r.roundScores) ? r.roundScores[playerId] : undefined;
    const isDeclarer = !!(r && r.declaredBy === playerId);
    // A wrong declare is the one genuinely punitive outcome in this game, so
    // it gets its own treatment rather than sharing the declarer's gold.
    const isPenalty = isDeclarer && r && !r.correct;
    const isWinner = roundWinnerIds(game).has(playerId);

    const box = document.createElement('div');
    // Bottom-half seats flip the box above the chip so it never runs off
    // the lower edge of the table into the hand tray.
    box.className = 'seat-reveal-box'
      + (topPercent > 62 ? ' above' : '')
      + (isDeclarer ? ' declared' : '')
      + (isPenalty ? ' penalty' : '')
      + (isWinner && !isPenalty ? ' winner' : '');

    if (isDeclarer || isWinner) {
      const tag = document.createElement('div');
      tag.className = 'seat-reveal-tag';
      // Says what HAPPENED, not just that they acted -- "DECLARED" alone
      // left you reading cards to work out whether it had gone their way.
      tag.textContent = isPenalty ? 'WRONG CALL'
        : isDeclarer ? 'DECLARED ✓'
        : 'LOWEST';
      box.appendChild(tag);
    }

    // What the round cost them, then where that leaves them. The bare hand
    // value used to lead this line, but for everyone except the declarer it
    // IS the round score -- so the same number was printed twice, with the
    // running total sitting a few pixels below in the seat chip as a third.
    // Only the declarer's two numbers ever differed, and their cards are
    // right underneath to be counted.
    const valEl = document.createElement('div');
    valEl.className = 'seat-reveal-value';
    if (roundScore !== undefined) {
      const scoreEl = document.createElement('span');
      scoreEl.className = 'seat-reveal-score' + (roundScore === 0 ? ' zero' : '') + (isPenalty ? ' penalty' : '');
      scoreEl.textContent = roundScore === 0 ? '+0' : '+' + roundScore;
      valEl.appendChild(scoreEl);
    }
    const runningTotal = game.scores ? game.scores[playerId] : undefined;
    // In round one the running total IS the round score, so showing both
    // reintroduces exactly the duplicate this panel was changed to remove --
    // "+11 › 11". Only show where it leads once that tells you something new.
    if (runningTotal !== undefined && runningTotal !== roundScore) {
      const arrow = document.createElement('span');
      arrow.className = 'seat-reveal-arrow';
      arrow.textContent = '\u203a';
      valEl.appendChild(arrow);
      const totalEl = document.createElement('span');
      totalEl.className = 'seat-reveal-total';
      totalEl.textContent = String(runningTotal);
      valEl.appendChild(totalEl);
    }
    box.appendChild(valEl);

    // Same grouping + ordering as the hand tray and the old scorecard rows:
    // duplicates collapse into one tile with a ×N badge, and the priciest
    // cards come first so the "+N more" chip only ever hides cheap ones.
    const grid = document.createElement('div');
    grid.className = 'seat-reveal-grid';
    const groups = groupHand(hand)
      .slice()
      .sort((a, b) => cardValueClient(b.cards[0], wildRank) - cardValueClient(a.cards[0], wildRank));
    const shown = groups.slice(0, REVEAL_MAX_SEAT_TILES);
    shown.forEach((g) => {
      const el = cardEl(g.cards[0]);
      el.classList.add('mini');
      if (g.cards.length > 1) {
        const badge = document.createElement('span');
        badge.className = 'card-count-badge';
        badge.textContent = '×' + g.cards.length;
        el.appendChild(badge);
      }
      grid.appendChild(el);
    });
    const shownCount = shown.reduce((sum, g) => sum + g.cards.length, 0);
    const remaining = hand.length - shownCount;
    if (remaining > 0) {
      const more = document.createElement('div');
      more.className = 'seat-reveal-more';
      // Reads "+2 more", not just "+2": the same grid already carries ×N
      // badges meaning "two copies of THIS card", and the two numbers sit
      // millimetres apart at this size. The word is what keeps "two more
      // cards you can't see" from being read as another multiplier.
      more.textContent = '+' + remaining + ' more';
      grid.appendChild(more);
    }
    box.appendChild(grid);
    return box;
  }

  // Holds the table for a beat, then hands off to the scorecard. Ends early
  // on any tap -- players who've already looked shouldn't be made to wait,
  // and players who want longer than the timeout can't be given it anyway
  // (the host controls when the next round actually starts).
  function startRevealPhase(game) {
    if (revealPhaseActive) return;
    revealPhaseActive = true;
    revealPendingGame = game;
    document.getElementById('screen-game').classList.add('reveal-phase');
    renderGame(game);

    const finish = () => endRevealPhase();
    revealTimer = setTimeout(finish, REVEAL_HOLD_MS);
    // Captured on the game screen only, and removed the moment it fires, so
    // it can never leak into the scorecard's own taps underneath.
    document.getElementById('screen-game').addEventListener('click', finish, { once: true });
  }

  function endRevealPhase() {
    if (!revealPhaseActive) return;
    revealPhaseActive = false;
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    document.getElementById('screen-game').classList.remove('reveal-phase');
    const game = revealPendingGame || latestGame;
    revealPendingGame = null;
    if (game) {
      renderGame(game);
      showRoundResult(game);
    }
  }

  // Selecting a grouped tile selects/deselects every card in that rank-group
  // together (they're always discarded as a set anyway, matching-rank or not).
  function toggleSelectGroup(group) {
    const allSelected = group.cards.every((c) => selectedIds.has(c.id));
    // Sound goes AFTER the selection changes, and guarded -- same rule as
    // the discard and declare handlers. Played first (as it was), a throw in
    // the audio path would have made cards impossible to select at all,
    // which is a dead game from a decoration.
    try {
      if (allSelected) Sound.deselect(); else Sound.select();
    } catch (e) { /* audio is never worth a tap */ }
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
    // Pushing the +2 chain on to the next player is the most aggressive
    // move in the game and it made no sound at all. Emit first, as always.
    try {
      lastDiscardInfo = null;   // a chain 2 draws nothing back; no pairing
      Sound.chainTwoPlay();
    } catch (e) { /* never worth a turn */ }
  }

  document.getElementById('btn-discard').onclick = () => {
    const ids = [...selectedIds];

    // ------------------------------------------------------------------
    // THE MOVE GOES FIRST. Nothing decorative may sit in front of it.
    //
    // This previously ran Sound.discard() and the card-flight animation
    // BEFORE this emit. Both are cosmetic, but a throw in either one meant
    // the emit below never executed -- so the tap did nothing, the turn
    // timer ran down, and the server auto-played on the player's behalf.
    // From the table that reads as the game freezing and then playing
    // itself. Decoration must never be able to cost someone a turn.
    //
    // emit() is non-blocking and its ack is async, so the flourish below
    // still measures the hand in the same tick, before any re-render.
    // ------------------------------------------------------------------
    socket.emit('play_turn', { roomCode: myRoomCode, cardIds: ids }, (res) => {
      if (!res.ok) return setGameError(res.error);
      selectedIds = new Set();
      setGameError('');
    });

    // Everything below here is flourish. It is wrapped so that a failure --
    // a missing element, an audio context the OS refused, anything -- is
    // logged and forgotten rather than propagating into the turn.
    try {
      // Remember what just left the hand, so that when the penalty card
      // comes back we can tell a good trade from a bad one. Must happen
      // here, while yourHand still holds the cards -- the next state push
      // removes them. Inside the flourish try/catch: if this ever fails the
      // sound simply falls back to neutral, it can never cost a turn.
      const handNow = (latestGame && latestGame.yourHand) || [];
      noteDiscardForValence(
        handNow.filter((c) => ids.indexOf(c.id) !== -1),
        latestGame && latestGame.roundJokerRank
      );
      Sound.discard();
      const first = document.querySelector('#hand .card.selected') || document.querySelector('#hand .card');
      const to = openCardSlotRect();
      if (first && to) {
        const from = flyRect(first);
        const hand = (latestGame && latestGame.yourHand) || [];
        const card = hand.find((c) => c.id === ids[0]);
        flyCard({ left: from.left, top: from.top, w: to.w, h: to.h }, to, card || null);
      }
    } catch (e) {
      console.warn('[fx] discard flourish failed (turn was still sent):', e && e.message);
    }
  };

  document.getElementById('btn-declare').onclick = () => {
    // Declare emits first for the same reason as discard: a sound must never
    // be able to swallow the single most consequential tap in the game.
    socket.emit('declare', { roomCode: myRoomCode }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
    // Declaring used to make no sound at all until the RESULT came back from
    // the server, so the riskiest tap you can make was also the deadest one.
    try { Sound.declareTap(); } catch (e) { /* never worth a turn */ }
  };

  document.getElementById('btn-take-penalty').onclick = () => {
    socket.emit('play_turn', { roomCode: myRoomCode, cardIds: [] }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
    // Accepting the +2/+4/+6 used to be completely silent: you tapped a
    // button, nothing acknowledged it, and the cards appeared a beat later.
    // Nothing is being given up here, so there is no trade to weigh --
    // clear any remembered discard so the incoming draw is judged on its
    // own (it will be 'brutal' anyway, being multi-card).
    try {
      lastDiscardInfo = null;
      Sound.takePenalty();
    } catch (e) { /* never worth a turn */ }
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

  function setGameError(msg) {
    document.getElementById('game-error').textContent = friendlyError(msg) || '';
  }

  // ------------------------------------------------------------------
  // The chat sheet covers the hand tray and both action buttons -- measured
  // on the live build, it takes the bottom ~55% of the screen. The turn
  // timer stays visible above it, so with chat open on your turn you can
  // watch 15 seconds run out while unable to reach your cards.
  //
  // So the sheet yields: the moment the turn becomes yours, it closes. The
  // alternative (shrinking it) leaves a cramped chat AND a cramped hand, and
  // still hides the buttons on shorter phones.
  // ------------------------------------------------------------------
  function closeChatForMyTurn() {
    const panel = document.getElementById('chat-panel');
    if (!panel || panel.classList.contains('hidden')) return;
    document.getElementById('btn-chat-close').click();
  }

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

      // No card tiles here any more. Every player's actual cards are now
      // shown face-up at their own chair during the reveal phase that runs
      // before this screen (see startRevealPhase), so repeating them here
      // was pure duplication -- and they were by far the tallest thing on
      // this panel, which is what forced it to scroll once a table had more
      // than a few players. Dropping them is what lets every player fit on
      // one screen, and frees the room the ad slot now occupies.
      // Nothing on the left of the row any more -- no card tiles, and no
      // hand-value text either. The cards AND their value are both shown at
      // each player's chair during the reveal phase that runs just before
      // this screen, so repeating the value here was the third time the same
      // information appeared. The round-score sum on the right (this round +
      // previous = new total) is what this screen is actually for.
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'reveal-cards';
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
  // ---------------- auto-advance countdown ----------------
  // The next round now starts on a server timer (see AUTO_NEXT_ROUND_MS in
  // server.js) instead of waiting on the host, who could previously freeze
  // the whole table indefinitely just by putting their phone down. The server
  // sends the REMAINING milliseconds with every game_state; we convert that
  // to a local deadline each time rather than trusting one reading, so a
  // player who reconnects, unbackgrounds, or joins mid-countdown still sees
  // the correct number instead of a stale one.
  let autoNextRoundDeadline = null;
  let autoNextRoundTicker = null;

  function setAutoNextRoundDeadline(ms) {
    if (ms === null || ms === undefined) {
      autoNextRoundDeadline = null;
      if (autoNextRoundTicker) { clearInterval(autoNextRoundTicker); autoNextRoundTicker = null; }
      return;
    }
    autoNextRoundDeadline = Date.now() + ms;
    // 250ms rather than 1000ms so the displayed second changes promptly after
    // the deadline is re-synced, instead of lagging up to a full second.
    if (!autoNextRoundTicker) {
      autoNextRoundTicker = setInterval(updateRoundResultHostControls, 250);
    }
  }

  function autoNextRoundSecondsLeft() {
    if (autoNextRoundDeadline === null) return null;
    return Math.max(0, Math.ceil((autoNextRoundDeadline - Date.now()) / 1000));
  }

  function updateRoundResultHostControls() {
    const overlay = document.getElementById('overlay-round-result');
    if (!latestGame || overlay.classList.contains('hidden')) return;
    const game = latestGame;
    // Anyone at the table can move the round on, not just the host -- same
    // reasoning as Start Game in the lobby. The countdown starts it anyway;
    // this is only the "we're all ready, skip the wait" shortcut.
    const nextBtn = document.getElementById('btn-next-round');
    nextBtn.classList.toggle('hidden', game.gameOver);
    // On the final round there's no next round to start -- instead everyone
    // (not just the host) gets a "See Final Result" button that leads into
    // the separate celebratory trophy screen, at their own pace rather than
    // an automatic timer.
    document.getElementById('btn-see-final-result').classList.toggle('hidden', !game.gameOver);

    // Everyone now sees the same countdown, host included -- previously
    // non-hosts got "Waiting for host to start next round..." with no idea
    // whether that would ever happen. The host's button is a "start early"
    // override on top of the countdown, not the only way forward.
    const hintEl = document.getElementById('round-result-hint');
    const secs = autoNextRoundSecondsLeft();
    if (game.gameOver) {
      hintEl.textContent = ''; // final scorecard is read at each player's own pace
    } else if (secs !== null) {
      hintEl.textContent = secs > 0
        ? `Next round in ${secs}s...`
        : 'Starting next round...';
    } else {
      // No countdown reported (older server, or a state we didn't expect) --
      // fall back to the previous wording rather than showing nothing.
      hintEl.textContent = '';
    }

    const maxScoreRow = document.getElementById('round-maxscore-row');
    if (!game.gameOver) {
      const maxCurrentScore = Math.max(0, ...Object.values(game.scores));
      populateMaxScoreSelect(document.getElementById('round-maxscore-select'), game.eliminationScore, maxCurrentScore);
      maxScoreRow.classList.remove('hidden');
    } else {
      maxScoreRow.classList.add('hidden');
    }
  }

  // Round-result ad: DISABLED. See the long note in admob-init.js -- showing
  // an ad here means swapping the single native banner slot, and every
  // attempt at that swap broke the bottom banner and/or the interstitial
  // (both of which earn) while the scorecard ad itself never rendered. This
  // keeps the reserved gap hidden so the panel doesn't show 100px of empty
  // space waiting for an ad that isn't coming.
  function showRoundResultAd() {
    const slot = document.getElementById('round-result-ad');
    if (slot) slot.classList.add('hidden');
  }

  function hideRoundResultAd() {
    if (window.LCAds) window.LCAds.hideResultAd();
  }

  // The round-result overlay gets closed from six different places (Next
  // Round, See Final Result, leaving the room, the game-over handoff, the
  // rejoin path...). Hooking each one means one of them eventually gets
  // missed, and a missed one strands a 300x250 native ad floating over the
  // table with no way to dismiss it. Watching the element itself catches
  // every path, including any added later.
  (function watchRoundResultOverlay() {
    const overlay = document.getElementById('overlay-round-result');
    if (!overlay || typeof MutationObserver !== 'function') return;
    let wasHidden = overlay.classList.contains('hidden');
    new MutationObserver(() => {
      const isHidden = overlay.classList.contains('hidden');
      if (isHidden && !wasHidden) hideRoundResultAd();
      wasHidden = isHidden;
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  })();

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
    const rrRound = document.getElementById('round-result-round');
    if (rrRound) rrRound.textContent = game.roundNumber ? 'Round ' + game.roundNumber : '';
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
    // Podium is a FINAL-STANDINGS idea, so it only earns its space once the
    // game is actually over. Mid-game it was showing the top 3 of a race
    // that isn't finished, while the rows below already list every player's
    // round score and running total -- and it silently omitted anyone past
    // 3rd, which on a 4+ player table meant hiding the most interesting
    // number on the screen (whoever is closest to being knocked out).
    const podiumEl = document.getElementById('podium');
    if (game.gameOver) {
      podiumEl.classList.remove('hidden');
      renderPodium(game, ranked);
    } else {
      podiumEl.classList.add('hidden');
      podiumEl.innerHTML = '';
    }
    renderHandRevealRows(game, ranked);

    const noteEl = document.getElementById('round-result-note');
    noteEl.textContent = (r.newlyEliminated && r.newlyEliminated.length)
      ? `Eliminated: ${r.newlyEliminated.map(playerName).join(', ')}`
      : '';

    // Offer the way back BEFORE the overlay is shown, so an eliminated
    // player sees the choice as the screen arrives rather than watching it
    // pop in a frame later. Eligibility is entirely the engine's call
    // (game.canRejoin, per viewer).
    renderRejoinOffer(game);

    document.getElementById('overlay-round-result').classList.remove('hidden');
    // Deliberately AFTER the overlay is unhidden. It used to run before, and
    // relied on requestAnimationFrame firing late enough for the panel to
    // have been laid out -- but until the overlay loses .hidden the whole
    // subtree is display:none, so the slot measures as zero height and the
    // ad request was being skipped. Calling it here means the panel is
    // already visible and measurable, with no timing assumption at all.
    showRoundResultAd();
    updateRoundResultHostControls();
  }

  document.getElementById('btn-next-round').onclick = () => {
    document.getElementById('overlay-round-result').classList.add('hidden');
    const maxScoreRow = document.getElementById('round-maxscore-row');
    const sel = document.getElementById('round-maxscore-select');
    const eliminationScore = !maxScoreRow.classList.contains('hidden') && sel.value
      ? Number(sel.value) : undefined;
    socket.emit('next_round', { roomCode: myRoomCode, eliminationScore }, (res) => {
      // Losing the race with the auto-advance countdown is a normal outcome,
      // not an error worth showing: the host tapped Start Now at the same
      // instant the timer fired, and the round is starting either way.
      // Anything else (not host, game already over) still surfaces.
      if (!res.ok && res.error !== 'Round is no longer waiting to start.') setGameError(res.error);
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

  // ------------------------------------------------------------------
  // Standings pane of the scorecard sheet.
  //
  // Every row carries a bar showing the player's score against the
  // elimination limit, because that is the actual question this screen
  // answers. "Bot 2: 120" means nothing on its own; "Bot 2 is 60% of the way
  // to out" is the thing you change your play over. Three states match the
  // table's own colour language -- safe, close, gone -- so the sheet and the
  // seats never disagree.
  // ------------------------------------------------------------------
  function renderScorecardTotals() {
    const body = document.getElementById('scorecard-totals');
    body.innerHTML = '';
    if (!latestGame || !latestRoom) return;
    const limit = latestGame.eliminationScore || 200;
    const players = (latestRoom.players || []).slice()
      .sort((a, b) => (latestGame.scores[a.playerId] || 0) - (latestGame.scores[b.playerId] || 0));

    players.forEach((p, i) => {
      const score = latestGame.scores[p.playerId] ?? 0;
      const isOut = (latestGame.eliminated || []).includes(p.playerId)
        || (latestGame.quit || []).includes(p.playerId);
      const pct = Math.max(0, Math.min(100, Math.round((score / limit) * 100)));

      const row = document.createElement('div');
      row.className = 'sc-row'
        + (isOut ? ' out' : (pct >= 60 ? ' warn' : ''))
        + (p.playerId === myPlayerId ? ' is-me' : '');

      const top = document.createElement('div');
      top.className = 'sc-row-top';
      // Text nodes, not innerHTML -- player names are user-supplied and this
      // is the one place they'd otherwise be interpolated into markup.
      const rank = document.createElement('span');
      rank.className = 'sc-rank'; rank.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'sc-name'; name.textContent = p.name;
      top.appendChild(rank); top.appendChild(name);
      if (isOut) {
        const tag = document.createElement('span');
        tag.className = 'sc-tag'; tag.textContent = 'OUT';
        top.appendChild(tag);
      }
      const val = document.createElement('span');
      val.className = 'sc-score'; val.textContent = String(score);
      top.appendChild(val);

      const bar = document.createElement('div');
      bar.className = 'sc-bar';
      const fill = document.createElement('span');
      fill.style.width = pct + '%';
      bar.appendChild(fill);

      row.appendChild(top); row.appendChild(bar);
      body.appendChild(row);
    });

    document.getElementById('scorecard-foot').textContent = 'Out at ' + limit;
  }

  // One sheet, two panes. `view` is 'totals' or 'rounds' -- the round-result
  // screen's link opens straight onto the round-by-round grid, the top bar's
  // Scores button onto the standings, but it's the same sheet either way so
  // nothing ever stacks on top of anything else.
  function setScorecardView(view) {
    const rounds = view === 'rounds';
    document.getElementById('scorecard-totals').classList.toggle('hidden', rounds);
    document.getElementById('scorecard-rounds').classList.toggle('hidden', !rounds);
    document.getElementById('seg-scorecard-totals').classList.toggle('active', !rounds);
    document.getElementById('seg-scorecard-rounds').classList.toggle('active', rounds);
    const body = document.querySelector('#overlay-scorecard .sheet-body');
    if (body) body.scrollTop = 0;
  }

  function openScorecard(view) {
    if (!latestGame) return;
    renderScorecardTotals();
    renderFullScorecard();
    setScorecardView(view || 'totals');
    document.getElementById('overlay-scorecard').classList.remove('hidden');
  }
  function closeScorecard() {
    document.getElementById('overlay-scorecard').classList.add('hidden');
  }

  document.getElementById('btn-scores').onclick = () => openScorecard('totals');
  document.getElementById('btn-close-scorecard').onclick = closeScorecard;
  document.getElementById('seg-scorecard-totals').onclick = () => setScorecardView('totals');
  document.getElementById('seg-scorecard-rounds').onclick = () => setScorecardView('rounds');
  // Tap the dimmed area above the sheet to dismiss, like the chat sheet.
  document.getElementById('overlay-scorecard').onclick = (e) => {
    if (e.target.id === 'overlay-scorecard') closeScorecard();
  };

  // Full round-by-round scorecard -- players as rows (capped at 10, so this
  // axis never needs scrolling), rounds as columns (a long game scrolls
  // sideways instead, with the player-name column frozen via CSS so context
  // never scrolls away). Built from game.roundHistory, one entry per
  // completed round; the Total column reads straight from game.scores (the
  // same authoritative cumulative total elimination is based on) rather than
  // summing history client-side, so it can never drift out of sync.
  //
  // This is now the "By round" pane of #overlay-scorecard (was its own
  // dedicated overlay (#overlay-full-scorecard),
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

  // The round-result screen's "See full scorecard" link now opens the shared
  // sheet straight onto its By round tab, instead of a second overlay that
  // used to stack on top of the Scores one. #btn-open-full-scorecard (the
  // link that lived inside the old Scores dialog) is gone with that dialog --
  // the segmented control replaces it.
  document.getElementById('btn-open-full-scorecard-rr').onclick = () => openScorecard('rounds');

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

  // ---------------- install prompt (website -> Play Store) ----------------
  // 47 of 56 players in the fortnight to 19 Sept were on the website, and Play
  // can only count app installs -- which is why production access was refused.
  // This card is the ONLY channel to those players: they're anonymous, so
  // there is no email, no phone, nothing but a nickname to reach them by.
  //
  // Shown only after a FINISHED game, deliberately. A first-time visitor who
  // bounces is exactly the tester Google later flags as unengaged, so pushing
  // them to install costs more than it earns; someone who played a game to the
  // scorecard has already demonstrated the one thing that matters.
  //
  // While the app is in CLOSED TESTING this must be the opt-in url, not the
  // store listing. Verified 19 Sept 2026 from a browser that is not on the
  // tester list:
  //   /store/apps/details?id=com.manikanta.leastcount -> "the requested URL
  //     was not found on this server"  (dead end for every web player)
  //   /apps/testing/com.manikanta.leastcount -> Google sign-in, then
  //     "Become a tester"               (works)
  //
  // The opt-in page still only admits people whose Google account is on the
  // tester list, so this link converts nobody unless that list is a Google
  // Group anyone can join. Swap to the /store/apps/details url once production
  // access is granted -- that is the only change needed here.
  const INSTALL_URL = 'https://play.google.com/apps/testing/com.manikanta.leastcount';
  const INSTALL_CHOICE_KEY = 'leastcount_install_prompt';
  const INSTALL_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
  const INSTALL_DONE = 'installed';

  function installPromptAllowed() {
    if (!FEATURES.installPrompt) return false;
    // Already inside the Capacitor app -- nothing to install.
    if (CLIENT_PLATFORM !== 'web') return false;
    // There is no iOS or desktop build, so the prompt would be a dead end.
    if (!/Android/i.test(navigator.userAgent || '')) return false;
    let stored = null;
    try { stored = localStorage.getItem(INSTALL_CHOICE_KEY); } catch (e) { stored = null; }
    if (stored === INSTALL_DONE) return false;
    const until = Number(stored);
    if (until && Date.now() < until) return false;
    return true;
  }

  function rememberInstallChoice(value) {
    // Private browsing throws on setItem; the prompt reappearing is a far
    // smaller problem than the game erroring out on the scorecard.
    try { localStorage.setItem(INSTALL_CHOICE_KEY, value); } catch (e) { /* ignore */ }
  }

  function buildInstallCard() {
    const card = document.createElement('div');
    card.className = 'install-card';

    const title = document.createElement('div');
    title.className = 'install-card-title';
    title.textContent = 'Playing a lot? Get the app';

    const hint = document.createElement('p');
    hint.className = 'install-card-hint';
    hint.textContent = 'Opens straight to the table, keeps you signed in, and works better on a phone than the browser does.';

    const actions = document.createElement('div');
    actions.className = 'install-card-actions';

    const install = document.createElement('a');
    install.className = 'primary install-card-btn';
    install.href = INSTALL_URL;
    install.target = '_blank';
    install.rel = 'noopener';
    install.textContent = 'Install';
    install.addEventListener('click', () => {
      logAnalytics('install_prompt_accepted', {});
      rememberInstallChoice(INSTALL_DONE);
      card.remove();
    });

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'secondary install-card-btn';
    later.textContent = 'Not now';
    later.addEventListener('click', () => {
      logAnalytics('install_prompt_dismissed', {});
      // Snooze rather than suppress forever: someone on their third game is a
      // better prospect than the same person on their first.
      rememberInstallChoice(String(Date.now() + INSTALL_SNOOZE_MS));
      card.remove();
    });

    actions.appendChild(install);
    actions.appendChild(later);
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(actions);
    return card;
  }

  function maybeShowInstallCard(container) {
    if (!container || !installPromptAllowed()) return;
    logAnalytics('install_prompt_shown', {});
    container.appendChild(buildInstallCard());
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
    maybeShowInstallCard(body);
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
      setLeavePending(false);   // don't carry a queued leave into the next room
      window.__lastRoundResultShownFor = null;
      // Leaving mid-reveal would otherwise strand the phase flag as true,
      // and the next room's table would render every seat's reveal box
      // over a live game.
      revealPhaseActive = false;
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
      revealPendingGame = null;
      document.getElementById('screen-game').classList.remove('reveal-phase');
      closePlayerActionPopover();
      playerStatsCache.clear();
      hideChatUI();
      document.getElementById('overlay-round-result').classList.add('hidden');
      document.getElementById('overlay-gameover').classList.add('hidden');
      document.getElementById('overlay-scorecard').classList.add('hidden');
      // A pending rejoin belongs to the room being left -- drop the offer,
      // its countdown interval and the host banner with it, or the next room
      // inherits a stale prompt and a ticking timer for a finished game.
      hideRejoinOffer();
      rejoinAsked = false;
      document.getElementById('rejoin-requests-banner').classList.add('hidden');
      showScreen('screen-landing');
      // Full-screen interstitial on the way out of a room -- a natural
      // stopping point, never mid-game. Deliberately fired AFTER the leave
      // has fully completed and the landing screen is already showing, so
      // the player is never held up by it: if the ad is missing, slow, or
      // fails outright, they're already where they wanted to be and simply
      // see no ad. It also self-limits (see MIN_MS_BETWEEN_INTERSTITIALS in
      // admob-init.js), so repeatedly hopping in and out of rooms won't
      // produce an ad every time. adsRemoved covers the paid Remove Ads
      // purchase -- those players must never see this.
      if (window.LCAds && !adsRemoved) window.LCAds.showInterstitial();
    });
  }
  // Leaving from the TABLE. Until now the only exits were the lobby, the
  // round-result overlay (which auto-advances in 10 seconds) and game over --
  // so mid-round there was no way out at all, and because a refresh
  // auto-rejoins the stored room there was no way back to the menu either.
  // Confirmed, because it forfeits the game.
  const leaveDialog = () => document.getElementById('leave-game-dialog');

  // ------------------------------------------------------------------
  // Queued-leave state (fixed Sept 2026).
  //
  // The server refuses to let anyone go mid-round ("Cannot leave in the
  // middle of a round"), and it always has -- removing a player whose cards
  // are in play would mean rewriting the turn rotation underneath everyone.
  // So a mid-round leave is QUEUED: the intent is recorded, their turns keep
  // being auto-played as they already would be, and the moment the round
  // ends renderGame() calls leaveRoom() for them.
  //
  // That part worked. What didn't was telling them. The only feedback was
  // setGameError('You'll leave as soon as this round finishes.') -- and the
  // game_state handler clears the error line on every turn change:
  //
  //     if (prev.currentPlayer !== game.currentPlayer || ...) setGameError('');
  //
  // Turns change every few seconds, so the message was gone almost at once
  // and nothing replaced it. Tap, brief flash, silence -- indistinguishable
  // from a dead button, which is exactly how it was reported. There was also
  // no way to change your mind once queued.
  //
  // Now the state lives on the button itself (a class, so it survives every
  // state push) and tapping again offers to cancel.
  // ------------------------------------------------------------------
  function setLeavePending(on) {
    leaveAfterRound = !!on;
    const btn = document.getElementById('btn-leave-game');
    if (!btn) return;
    btn.classList.toggle('leave-pending', !!on);
    // The control is a bare icon, so the accessible name is the only label it
    // has. Keep title in step too -- it's what a long-press surfaces.
    const label = on ? 'Leaving when this round ends — tap to stay' : 'Leave game';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  // Am I out of the game but still sitting at the table? Mirrors the engine's
  // isSpectator(): eliminated or quit. Such a player holds no cards and isn't
  // in the rotation, so the server now lets them go mid-round -- there's no
  // hand of theirs to wait for. Without this the person most likely to want
  // out (they've just been knocked out and the table plays on for another
  // ten minutes) was the only one who couldn't.
  function amSpectator() {
    if (!latestGame || !myPlayerId) return false;
    const out = (latestGame.eliminated || []).concat(latestGame.quit || []);
    return out.indexOf(myPlayerId) !== -1;
  }

  document.getElementById('btn-leave-game').onclick = () => {
    const t = document.getElementById('leave-game-title');
    const p = document.getElementById('leave-game-text');
    const cancel = document.getElementById('btn-leave-game-cancel');
    const confirm = document.getElementById('btn-leave-game-confirm');
    if (amSpectator()) {
      // No "you'll forfeit the game" here -- they already lost it. And no
      // queueing: this leaves at once, so the copy shouldn't imply a wait.
      t.textContent = 'Leave the table?';
      p.textContent = 'You’re out of this game, so you can go now. You’ll head back to the menu.';
      cancel.textContent = 'Keep watching';
      confirm.textContent = 'Leave';
      leaveDialog().classList.remove('hidden');
      return;
    }
    if (leaveAfterRound) {
      // Already queued -- this dialog is now "do you want to call it off?"
      t.textContent = 'Leaving when this round ends';
      p.textContent = 'You’ll go back to the menu as soon as this hand finishes. Your turns are being played for you until then.';
      cancel.textContent = 'Stay in the game';
      confirm.textContent = 'Keep leaving';
    } else {
      t.textContent = 'Leave this game?';
      p.textContent = 'You’ll forfeit the game and go back to the menu. The others carry on without you.';
      cancel.textContent = 'Stay';
      confirm.textContent = 'Leave';
    }
    leaveDialog().classList.remove('hidden');
  };

  document.getElementById('btn-leave-game-cancel').onclick = () => {
    leaveDialog().classList.add('hidden');
    // In the queued state the secondary button means "call it off", so it has
    // to actually clear the queue -- otherwise they'd be dropped anyway and
    // rightly think the game ignored them.
    if (leaveAfterRound) {
      setLeavePending(false);
      setGameError('You’re staying in the game.');
    }
  };

  document.getElementById('btn-leave-game-confirm').onclick = () => {
    leaveDialog().classList.add('hidden');
    // Spectators go immediately -- checked BEFORE the queued-leave branch, so
    // a leave queued while still playing turns into an instant exit the
    // moment they're knocked out, rather than making them sit through the
    // rest of a hand they're no longer in.
    if (amSpectator()) { setLeavePending(false); leaveRoom(); return; }
    if (leaveAfterRound) return;   // "Keep leaving" -- nothing to change
    if (latestGame && !latestGame.roundOver && !latestGame.gameOver) {
      setLeavePending(true);
      setGameError('You’ll leave as soon as this round finishes.');
      return;
    }
    leaveRoom();
  };

  document.getElementById('btn-leave-lobby').onclick = leaveRoom;
  document.getElementById('btn-leave-round-result').onclick = leaveRoom;
  document.getElementById('btn-leave-gameover').onclick = leaveRoom;

  // ---------------- chat ----------------
  function showChatFab() { document.getElementById('chat-fab').classList.remove('hidden'); }
  function hideChatUI() {
    document.getElementById('chat-fab').classList.add('hidden');
    document.getElementById('chat-panel').classList.add('hidden');
    document.getElementById('chat-backdrop').classList.add('hidden');
    chatUnread = 0;
  }

  function updateChatBadge() {
    const badge = document.getElementById('chat-badge');
    // The toggle is a quiet outlined button on the hand-header row now, not a
    // red floating circle, so unread needs to register on the button itself
    // -- at that size the little badge alone is easy to miss mid-turn.
    const fab = document.getElementById('chat-fab');
    if (chatUnread > 0) {
      badge.textContent = chatUnread > 9 ? '9+' : chatUnread;
      badge.classList.remove('hidden');
      if (fab) fab.classList.add('has-unread');
    } else {
      badge.classList.add('hidden');
      if (fab) fab.classList.remove('has-unread');
    }
  }

  // Stable per-player avatar colour: same name/id always gets the same hue,
  // for everyone in the room, with no server round-trip. A plain string hash
  // is enough -- this only needs to be consistent, not unpredictable.
  // ====================================================================
  // Avatars (Sept 2026)
  //
  // Ten original characters, drawn as inline SVG. Inline rather than image
  // files because they cost no requests, stay sharp at every seat size on
  // every screen density, and recolour from CSS -- and because the whole set
  // ships with the app, so a seat never renders empty while something loads.
  //
  // Built from circles and simple paths on purpose: at 26px in a seat chip
  // (the smallest they're drawn) anything more detailed turns to mud, and
  // these have to read instantly at a glance mid-turn.
  //
  // Each carries its own background colour so players are distinguishable
  // by colour alone from across the table, before you can make out the face.
  // The id list must stay in step with AVATAR_IDS in server.js.
  // ====================================================================
  const AVATARS = {
    fox:     { bg: '#D9622F', face: '#F3A469', ink: '#40200C', d: '<path d="M12 46 L22 14 L34 28 L46 14 L56 46 Z"/><circle cx="26" cy="36" r="3.4" fill="#40200C"/><circle cx="42" cy="36" r="3.4" fill="#40200C"/><path d="M30 45 Q34 49 38 45" stroke="#40200C" stroke-width="2.6" fill="none" stroke-linecap="round"/>' },
    owl:     { bg: '#6E5BB8', face: '#9C8BD8', ink: '#241C46', d: '<circle cx="34" cy="34" r="22"/><circle cx="26" cy="30" r="8" fill="#FFF"/><circle cx="42" cy="30" r="8" fill="#FFF"/><circle cx="26" cy="30" r="3.6" fill="#241C46"/><circle cx="42" cy="30" r="3.6" fill="#241C46"/><path d="M30 41 L34 46 L38 41 Z" fill="#E8A33D"/>' },
    cat:     { bg: '#3E9B92', face: '#7FCFC6', ink: '#123833', d: '<path d="M14 24 L20 10 L28 20 Z"/><path d="M54 24 L48 10 L40 20 Z"/><circle cx="34" cy="36" r="20"/><circle cx="27" cy="33" r="3.2" fill="#123833"/><circle cx="41" cy="33" r="3.2" fill="#123833"/><path d="M30 39 L38 39 L34 44 Z" fill="#E88BA0"/><path d="M34 44 L30 47 M34 44 L38 47" stroke="#123833" stroke-width="2.2" fill="none" stroke-linecap="round"/>' },
    panda:   { bg: '#D8D8DE', face: '#FFFFFF', ink: '#22222A', d: '<circle cx="20" cy="18" r="8" fill="#22222A"/><circle cx="48" cy="18" r="8" fill="#22222A"/><circle cx="34" cy="36" r="21"/><ellipse cx="26" cy="33" rx="6" ry="7" fill="#22222A"/><ellipse cx="42" cy="33" rx="6" ry="7" fill="#22222A"/><circle cx="26" cy="33" r="2.2" fill="#FFF"/><circle cx="42" cy="33" r="2.2" fill="#FFF"/><ellipse cx="34" cy="44" rx="4" ry="3" fill="#22222A"/>' },
    tiger:   { bg: '#D98E22', face: '#F6C87C', ink: '#3A2206', d: '<circle cx="34" cy="34" r="22"/><path d="M17 30 L24 31 M17 37 L24 37 M51 30 L44 31 M51 37 L44 37" stroke="#3A2206" stroke-width="3" stroke-linecap="round"/><circle cx="27" cy="33" r="3.2" fill="#3A2206"/><circle cx="41" cy="33" r="3.2" fill="#3A2206"/><path d="M28 44 Q34 49 40 44" stroke="#3A2206" stroke-width="2.6" fill="none" stroke-linecap="round"/>' },
    frog:    { bg: '#6BA630', face: '#9BD45C', ink: '#1E3A08', d: '<circle cx="22" cy="20" r="9"/><circle cx="46" cy="20" r="9"/><circle cx="22" cy="20" r="4" fill="#1E3A08"/><circle cx="46" cy="20" r="4" fill="#1E3A08"/><ellipse cx="34" cy="40" rx="21" ry="17"/><path d="M24 44 Q34 52 44 44" stroke="#1E3A08" stroke-width="3" fill="none" stroke-linecap="round"/>' },
    bear:    { bg: '#9A653F', face: '#C08E63', ink: '#3A2413', d: '<circle cx="18" cy="20" r="8"/><circle cx="50" cy="20" r="8"/><circle cx="34" cy="36" r="21"/><circle cx="27" cy="33" r="3" fill="#3A2413"/><circle cx="41" cy="33" r="3" fill="#3A2413"/><ellipse cx="34" cy="43" rx="7" ry="5" fill="#E3C6A8"/><circle cx="34" cy="41" r="2.6" fill="#3A2413"/>' },
    monkey:  { bg: '#A87345', face: '#CE9A66', ink: '#3A2210', d: '<circle cx="15" cy="34" r="8"/><circle cx="53" cy="34" r="8"/><circle cx="34" cy="34" r="20"/><ellipse cx="34" cy="40" rx="13" ry="11" fill="#E8C9A0"/><circle cx="28" cy="31" r="3" fill="#3A2210"/><circle cx="40" cy="31" r="3" fill="#3A2210"/><path d="M29 43 Q34 47 39 43" stroke="#3A2210" stroke-width="2.4" fill="none" stroke-linecap="round"/>' },
    penguin: { bg: '#34608C', face: '#2B4C6F', ink: '#10263B', d: '<ellipse cx="34" cy="36" rx="21" ry="23"/><ellipse cx="34" cy="41" rx="13" ry="17" fill="#FFF"/><circle cx="28" cy="28" r="3" fill="#10263B"/><circle cx="40" cy="28" r="3" fill="#10263B"/><path d="M30 35 L34 40 L38 35 Z" fill="#E8A33D"/>' },
    rabbit:  { bg: '#C97A96', face: '#F2C3D2', ink: '#43172A', d: '<ellipse cx="25" cy="16" rx="6" ry="14"/><ellipse cx="43" cy="16" rx="6" ry="14"/><circle cx="34" cy="40" r="19"/><circle cx="28" cy="37" r="3" fill="#43172A"/><circle cx="40" cy="37" r="3" fill="#43172A"/><path d="M31 46 Q34 49 37 46" stroke="#43172A" stroke-width="2.4" fill="none" stroke-linecap="round"/>' },
  };
  const AVATAR_IDS = Object.keys(AVATARS);

  // Renders one avatar at a given pixel size. Returns an element, never a
  // string -- these end up next to user-supplied names, and keeping the
  // whole seat built from nodes means no path where a name could be treated
  // as markup.
  function avatarEl(avatarId, name, playerId, size) {
    size = size || 26;
    const wrap = document.createElement('span');
    wrap.className = 'avatar';
    wrap.style.width = size + 'px';
    wrap.style.height = size + 'px';

    const a = AVATARS[avatarId];
    if (a) {
      wrap.style.background = a.bg;
      // viewBox is fixed at 68x68 for every character, so they all sit at
      // the same optical size no matter which one a player picked.
      wrap.innerHTML = `<svg viewBox="0 0 68 68" aria-hidden="true"><g fill="${a.face}">${a.d}</g></svg>`;
      return wrap;
    }

    // No avatar chosen (or an id this build doesn't know): initials on the
    // colour we already derive for chat, so the seat still reads as a person
    // and the whole feature degrades instead of breaking.
    const hue = chatAvatarHue(playerId || name || '');
    wrap.style.background = `hsl(${hue} 45% 42%)`;
    wrap.classList.add('avatar-initials');
    // Deliberately NO unicode property escapes here. /[^\p{L}\p{N} ]/gu is a
    // regex LITERAL, so it's evaluated when this file is parsed, not when
    // this line runs -- on an Android WebView older than Chrome 64 that
    // means the whole of app.js fails to parse and the app is a white
    // screen. Cleaning up initials is not worth that risk.
    //
    // Array.from() splits by code point rather than UTF-16 unit, so a name
    // starting with an emoji or a non-BMP character yields that whole
    // character instead of half a surrogate pair. Non-Latin scripts get
    // their own initial, which is right for Telugu names.
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    const txt = parts.slice(0, 2)
      .map((w) => Array.from(w)[0] || '')
      .join('')
      .toUpperCase() || '?';
    wrap.textContent = txt;
    wrap.style.fontSize = Math.round(size * 0.42) + 'px';
    return wrap;
  }

  let myAvatar = localStorage.getItem('leastcount_avatar') || null;

  // Stored in localStorage rather than on the Firestore user doc, which is
  // where I first meant to put it. Firestore would only buy something if the
  // identity outlived the device -- and it doesn't: sign-in is anonymous, so
  // the uid is regenerated on reinstall anyway (the same limit that resets
  // stats and the avatar together). Until Google Sign-In comes off its flag,
  // a server round trip per read would cost latency and quota to deliver
  // exactly what localStorage already delivers.
  // Renders into EVERY [data-avatar-picker] on the page, so the profile
  // menu's copy and the one in the table dialog stay in step without either
  // needing to know the other exists.
  function renderAvatarPicker() {
    const boxes = document.querySelectorAll('[data-avatar-picker]');
    boxes.forEach((box) => {
      box.innerHTML = '';
      AVATAR_IDS.forEach((id) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-choice' + (id === myAvatar ? ' selected' : '');
        btn.setAttribute('aria-label', id);
        btn.setAttribute('aria-pressed', id === myAvatar ? 'true' : 'false');
        btn.appendChild(avatarEl(id, '', '', 40));
        btn.onclick = () => {
          // Tapping the one you already have clears it, back to initials --
          // otherwise the first pick is permanent, which is a strange thing
          // to discover only after you have made it.
          myAvatar = (myAvatar === id) ? null : id;
          if (myAvatar) localStorage.setItem('leastcount_avatar', myAvatar);
          else localStorage.removeItem('leastcount_avatar');
          renderAvatarPicker();
          // Change the face at the table there and then -- otherwise the
          // picker appears to do nothing until the next game.
          if (myRoomCode) {
            socket.emit('set_avatar', { roomCode: myRoomCode, avatar: myAvatar }, () => {});
          }
        };
        box.appendChild(btn);
      });
    });
  }
  renderAvatarPicker();

  function chatAvatarHue(seed) {
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  // "22:24"-style short clock, matching the reference comment sheet's
  // relative-time column. Falls back to nothing if the server didn't stamp
  // the message (older history entries).
  function chatShortTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    return Math.floor(diff / 3600000) + 'h';
  }

  // How long a silence has to be before the chat bothers printing a time.
  const CHAT_GAP_MS = 5 * 60 * 1000;

  function playerNameById(id) {
    if (!latestRoom || !id) return '';
    const p = latestRoom.players.find((x) => x.playerId === id);
    return p ? p.name : '';
  }

  // ------------------------------------------------------------------
  // Renders message text with @mentions highlighted, WITHOUT putting user
  // input anywhere near innerHTML. Every fragment -- including the name
  // inside the tag, which is user-supplied too -- goes in as a text node.
  //
  // This matters more than it looks: chat text was safe precisely because it
  // was escaped and never treated as markup, and "highlight part of it" is
  // exactly the change that quietly undoes that if done by string joining.
  // ------------------------------------------------------------------
  function renderChatText(target, text, mentions, nameOf, meId) {
    const known = (mentions || [])
      .map((id) => ({ id, name: nameOf(id) }))
      .filter((x) => x.name)
      // Longest name first, or "@Ravi Kumar" gets matched as "@Ravi".
      .sort((a, b) => b.name.length - a.name.length);
    let rest = String(text || '');
    let guard = 0;
    while (rest && known.length && guard++ < 80) {
      let hit = null;
      for (const k of known) {
        const i = rest.indexOf('@' + k.name);
        if (i >= 0 && (!hit || i < hit.i)) hit = { i, k };
      }
      if (!hit) break;
      if (hit.i > 0) target.appendChild(document.createTextNode(rest.slice(0, hit.i)));
      const tag = document.createElement('span');
      tag.className = 'chat-mention' + (hit.k.id === meId ? ' me' : '');
      tag.textContent = '@' + hit.k.name;
      target.appendChild(tag);
      rest = rest.slice(hit.i + 1 + hit.k.name.length);
    }
    if (rest) target.appendChild(document.createTextNode(rest));
  }

  // Mentions are worked out from the finished text at send time rather than
  // tracked as you type. Tracking a selection list means keeping it in step
  // with every edit and backspace; re-reading the text can't drift.
  //
  // This CONSUMES each match rather than just testing indexOf per person --
  // the first version didn't, and "@Ravi Kumar" therefore also matched the
  // shorter "@Ravi", so a different Ravi at the same table was told he'd been
  // mentioned. Scanning left to right, longest name first, mirrors exactly
  // what renderChatText does, so what gets highlighted and who gets flagged
  // can no longer disagree.
  function collectMentions(text, people) {
    const sorted = (people || []).filter((p) => p && p.name)
      .sort((a, b) => b.name.length - a.name.length);
    const out = [];
    let rest = String(text || '');
    let guard = 0;
    while (rest && sorted.length && guard++ < 80) {
      let hit = null;
      for (const p of sorted) {
        const i = rest.indexOf('@' + p.name);
        if (i >= 0 && (!hit || i < hit.i)) hit = { i, p };
      }
      if (!hit) break;
      if (out.indexOf(hit.p.id) < 0) out.push(hit.p.id);
      rest = rest.slice(hit.i + 1 + hit.p.name.length);
    }
    return out.slice(0, 8);
  }

  // Shared by both chats: shows name chips while an @ is being typed, and
  // hides itself the rest of the time so it costs no height.
  function wireMentionBar(inputId, barId, peopleFn) {
    const input = document.getElementById(inputId);
    const bar = document.getElementById(barId);
    if (!input || !bar) return;
    function insert(name) {
      const v = input.value || '';
      const at = v.lastIndexOf('@');
      input.value = (at < 0 ? v : v.slice(0, at)) + '@' + name + ' ';
      input.focus();
      bar.classList.add('hidden');
    }
    function refresh() {
      const v = input.value || '';
      const at = v.lastIndexOf('@');
      const frag = at >= 0 ? v.slice(at + 1) : null;
      // Only while an @ is actively being typed -- no whitespace after it.
      if (frag === null || /\s/.test(frag)) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
      const q = frag.toLowerCase();
      const hits = peopleFn().filter((p) => p.name && p.name.toLowerCase().indexOf(q) === 0).slice(0, 6);
      bar.innerHTML = '';
      if (!hits.length) { bar.classList.add('hidden'); return; }
      hits.forEach((p) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'mention-chip';
        chip.textContent = p.name;
        chip.onclick = () => insert(p.name);
        bar.appendChild(chip);
      });
      bar.classList.remove('hidden');
    }
    input.addEventListener('input', refresh);
    input.addEventListener('blur', () => setTimeout(() => bar.classList.add('hidden'), 180));
  }

  function tableChatPeople() {
    if (!latestRoom) return [];
    return latestRoom.players
      .filter((p) => !p.isBot && p.playerId !== myPlayerId)
      .map((p) => ({ id: p.playerId, name: p.name }));
  }

  function appendChatMessage(msg, opts) {
    opts = opts || {};
    const container = document.getElementById('chat-messages');
    const emptyEl = container.querySelector('.chat-empty');
    if (emptyEl) emptyEl.remove();

    // Comment-sheet row: avatar | (name + text on one wrapped paragraph).
    // Replaces the old flat "Name: text" line -- with 4-6 people talking at
    // once during a round, the avatar column is what makes it scannable
    // without reading every line.
    const isMine = msg.playerId === myPlayerId;
    const ts = msg.ts || Date.now();

    // Read the previous row off the DOM rather than keeping "last sender"
    // in a variable. A variable would have to be reset every time the chat
    // is cleared or a player is muted, and a stale one here would silently
    // eat somebody's name -- this project has lost enough days to flags that
    // latched. The DOM is the state.
    const prev = container.lastElementChild;
    const prevIsMsg = !!(prev && prev.classList && prev.classList.contains('chat-msg'));
    const prevPid = prevIsMsg ? (prev.dataset.playerId || null) : null;
    const prevTs = prevIsMsg ? Number(prev.dataset.ts || 0) : 0;

    // A time is printed only after a real silence. Every message used to
    // carry one on its own line -- a full line each, to say "now" to people
    // who are all sat at the same table playing the same round.
    let brokeByGap = false;
    if (prevTs && ts - prevTs > CHAT_GAP_MS) {
      const sep = document.createElement('div');
      sep.className = 'chat-gap';
      sep.textContent = chatShortTime(ts) || '';
      container.appendChild(sep);
      brokeByGap = true;
    }

    // Consecutive messages from one person share an avatar and name, the way
    // every messaging app does it. People type in bursts, so this is where
    // most of the space was actually going.
    const grouped = !brokeByGap && prevPid && msg.playerId === prevPid;
    const mentionsMe = Array.isArray(msg.mentions) && msg.mentions.indexOf(myPlayerId) >= 0;

    const div = document.createElement('div');
    div.className = 'chat-msg' + (isMine ? ' me' : '') + (grouped ? ' grouped' : '')
      + (mentionsMe ? ' mentions-me' : '');
    div.dataset.playerId = msg.playerId || '';
    div.dataset.ts = String(ts);

    if (!grouped) {
      const avatar = document.createElement('div');
      avatar.className = 'chat-avatar';
      const hue = chatAvatarHue(msg.playerId || msg.name);
      avatar.style.background = `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 55% 30%))`;
      avatar.textContent = (msg.name || '?').trim().charAt(0) || '?';
      div.appendChild(avatar);
    }

    const body = document.createElement('div');
    body.className = 'chat-body';
    if (!grouped) {
      const nameEl = document.createElement('span');
      nameEl.className = 'chat-name';
      nameEl.textContent = msg.name || '?';
      body.appendChild(nameEl);
      body.appendChild(document.createTextNode(' '));
    }
    if (msg.type === 'gif' && msg.gifUrl) {
      const img = document.createElement('img');
      img.src = msg.gifUrl;
      img.className = 'chat-gif';
      img.alt = 'GIF';
      body.appendChild(img);
    } else {
      const textEl = document.createElement('span');
      textEl.className = 'chat-text';
      renderChatText(textEl, msg.text, msg.mentions, playerNameById, myPlayerId);
      body.appendChild(textEl);
    }
    div.appendChild(body);

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
    el.textContent = `${stats.gamesPlayed} games · ${stats.wins} wins`;
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
    // Land on the latest message, same as opening any real chat app --
    // previously this left whatever scroll position the (freshly emptied
    // and rebuilt) container defaulted to, which is the top, so re-joining
    // a room with an active conversation dropped you into old messages
    // instead of where the conversation actually is.
    container.scrollTop = container.scrollHeight;
  }

  // Used both by the manual close button and by the auto-minimize-on-your-
  // turn hook in playSoundsForTransition() -- safe to call even if the
  // panel is already closed (chat-fab just re-shows itself, a no-op if
  // it's already visible).
  function minimizeChatPanel() {
    const panel = document.getElementById('chat-panel');
    if (panel.classList.contains('hidden')) return;
    document.getElementById('chat-input').blur();
    panel.classList.add('hidden');
    document.getElementById('chat-backdrop').classList.add('hidden');
    document.getElementById('chat-fab').classList.remove('hidden');
    chatSheetTopPx = null;
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
  // Belt-and-suspenders alongside the visualViewport listeners: reposition
  // right when the input is actually focused (the moment the keyboard
  // starts opening from a real tap), and again as it settles -- Android
  // WebView's resize events during the keyboard animation are late and
  // sometimes report an intermediate height. Cheap and idempotent, so
  // running it a few extra times costs nothing. Each pass also re-pins the
  // list to the newest message, since a shrinking list would otherwise
  // leave you looking at older messages the instant you tap to type.
  document.getElementById('chat-input').addEventListener('focus', () => {
    const settle = () => { positionChatSheet(); scrollChatToLatest(); };
    settle();
    setTimeout(settle, 120);
    setTimeout(settle, 350);
    setTimeout(settle, 600);
  });
  // Keyboard dismissed via the system back gesture rather than by closing
  // the sheet: resize usually covers it, but blur is the reliable signal.
  document.getElementById('chat-input').addEventListener('blur', () => {
    setTimeout(positionChatSheet, 120);
  });

  document.getElementById('chat-fab').onclick = () => {
    // Point the shared positioner at THIS sheet -- the group chat may have
    // been the last one open, and a stale id here would leave this panel
    // unpositioned while silently resizing one that isn't on screen.
    activeChatPanelId = 'chat-panel';
    activeChatListId = 'chat-messages';
    document.getElementById('chat-panel').classList.remove('hidden');
    document.getElementById('chat-backdrop').classList.remove('hidden');
    document.getElementById('chat-fab').classList.add('hidden');
    chatUnread = 0;
    updateChatBadge();
    // Re-derive the sheet's top anchor from scratch on every open. This is
    // the one moment a clean reading is guaranteed: the sheet is being
    // opened by a tap on the FAB, so the keyboard is definitionally closed
    // (we deliberately don't autofocus the input -- see below).
    chatSheetTopPx = null;
    positionChatSheet();
    // Same fix as loadChatHistory() above -- land on the newest message
    // every time the sheet opens, not wherever it happened to be scrolled
    // last time it was closed.
    scrollChatToLatest();
    // Deliberately NOT auto-focusing the input here anymore (removed Sept
    // 2026). Focusing it immediately forces the on-screen keyboard open the
    // instant the sheet appears, and on the actual Android WebView that
    // fought with this panel's position:fixed layout badly enough to break
    // it entirely -- confirmed via screen recording: header, drag handle,
    // and the dimmed backdrop all disappeared, leaving only the input row
    // stranded near the top of the screen. Also just better UX on its own:
    // WhatsApp/Instagram don't force the keyboard open when you open a
    // chat thread either -- tapping the input to type is a deliberate,
    // separate action.
  };
  document.getElementById('btn-chat-close').onclick = () => {
    // Drop focus FIRST so the on-screen keyboard closes with the sheet.
    // Without this the keyboard lingers over the table after the sheet is
    // gone, and the next visualViewport resize arrives with no sheet to
    // position -- which is how the old code could end up applying a
    // keyboard offset that outlived the keyboard.
    document.getElementById('chat-input').blur();
    document.getElementById('chat-panel').classList.add('hidden');
    document.getElementById('chat-backdrop').classList.add('hidden');
    document.getElementById('chat-fab').classList.remove('hidden');
    chatSheetTopPx = null;
  };
  // Tapping the table behind the sheet closes it too -- standard
  // bottom-sheet behavior (same as tapping outside an Instagram/WhatsApp
  // comment or chat sheet). The layer is invisible now (see .chat-backdrop
  // in style.css) but still catches the tap.
  document.getElementById('chat-backdrop').onclick = () => {
    document.getElementById('btn-chat-close').click();
  };
  function sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat_message', {
      roomCode: myRoomCode, type: 'text', text,
      mentions: collectMentions(text, tableChatPeople()),
    }, (res) => {
      if (!res.ok) setGameError(res.error);
    });
    input.value = '';
  }
  wireMentionBar('chat-input', 'chat-mention-bar', tableChatPeople);
  document.getElementById('btn-chat-send').onclick = sendChat;
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // Swipe-down-to-dismiss on the grab handle / header. The handle has been
  // drawn on this sheet for a while but never actually did anything, which
  // is worse than not drawing it -- people try it, nothing happens, and the
  // sheet reads as broken. Scoped deliberately to the handle and header
  // only: putting it on the whole sheet would fight .chat-messages' own
  // vertical scrolling, which is the single most-used gesture in here.
  (function enableChatSheetDrag() {
    const panel = document.getElementById('chat-panel');
    const grip = document.querySelector('.chat-drag-handle');
    const header = document.querySelector('.chat-header');
    if (!panel || !grip || !header) return;
    const DISMISS_PX = 80;
    let startY = null;
    let dy = 0;

    const onStart = (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      dy = 0;
      panel.style.transition = 'none';
    };
    const onMove = (e) => {
      if (startY === null || !e.touches || !e.touches.length) return;
      // Downward only -- dragging up must not detach the sheet from the
      // top anchor that positionChatSheet() just clamped on-screen.
      dy = Math.max(0, e.touches[0].clientY - startY);
      panel.style.transform = 'translateY(' + dy + 'px)';
    };
    const onEnd = () => {
      if (startY === null) return;
      const shouldClose = dy > DISMISS_PX;
      startY = null;
      if (shouldClose) {
        panel.style.transition = '';
        panel.style.transform = '';
        document.getElementById('btn-chat-close').click();
        return;
      }
      // Snap back.
      panel.style.transition = 'transform 0.18s ease-out';
      panel.style.transform = 'translateY(0)';
      setTimeout(() => { panel.style.transition = ''; panel.style.transform = ''; }, 200);
    };

    [grip, header].forEach((el) => {
      el.addEventListener('touchstart', onStart, { passive: true });
      el.addEventListener('touchmove', onMove, { passive: true });
      el.addEventListener('touchend', onEnd);
      el.addEventListener('touchcancel', onEnd);
    });
  })();
  socket.on('chat_message', (msg) => {
    if (isMuted(msg.playerId)) return; // muted -- skip both the panel message and the seat bubble
    // Quiet tick for incoming chat. Skipped for your own messages (you just
    // typed it, you don't need telling) so a busy table doesn't double up.
    if (msg.playerId !== myPlayerId) Sound.chatMessage();
    appendChatMessage(msg);
    // Speech bubble at the sender's seat, in addition to the panel above --
    // only meaningful once seats actually exist (mid-game), not lobby chat.
    if (latestGame) triggerChatBubble(msg.playerId, msg);
  });

  // ---------------- GIF picker: REMOVED (Sept 2026) ----------------
  // Pulled entirely for now rather than keeping it gated: the self-hosted
  // meme library backing it (public/memes/*) never actually made it into
  // the GitHub repo (confirmed 404 live), and separately, all ~150 memes
  // were Telugu-specific -- not a fair "Remove Ads" perk for the wider
  // audience this app is now aiming for. May come back later with broader,
  // properly-licensed/curated content if that turns out feasible. The
  // server still has the 'gif' chat_message type and /api/gif-search route
  // (harmless, just unreachable with no UI pointing at them) in case this
  // gets revisited rather than rebuilt from scratch.

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
  // ====================================================================
  // Card flight + haptics (Sept 2026)
  //
  // Playing a card was instant and silent: it vanished from the hand and the
  // open card changed underneath. The whole game's motion budget had gone on
  // ceremony -- the intro splash, the dealing sequence, confetti -- which a
  // player sees a handful of times, while the turn itself, which they see
  // hundreds of times, had none.
  //
  // 180ms, ease-out, no arc or spin. Deliberately restrained: the turn timer
  // is 15s and a 4-player table plays three opponent moves between your
  // turns, so a showier animation would add over a second of waiting per
  // round and make the game feel SLOWER, not richer.
  // ====================================================================
  const FLY_MS = 180;

  // When the current card flight lands. Anything that would cover the table
  // (the penalty-draw overlay) waits for this, so two animations can never
  // run on top of each other. Declared with var-like scope at the top of the
  // IIFE so showDrawReveal, defined further down, can read it.
  let flightBusyUntil = 0;

  function flyRect(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  }

  // Animates a card face from one rect to another. Purely decorative -- it
  // never blocks, never calls back into game state, and cleans itself up, so
  // a dropped frame or an interrupted round can't leave anything behind.
  function flyCard(fromRect, toRect, cardData, opts) {
    opts = opts || {};
    const layer = document.getElementById('fly-layer');
    if (!layer || !fromRect || !toRect) return;
    // Respect the OS "reduce motion" setting -- some people get motion sick,
    // and a card game that ignores that is one they stop playing.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let el;
    try {
      el = cardData ? cardEl(cardData, {}) : document.createElement('div');
    } catch (e) {
      el = document.createElement('div');
    }
    if (!cardData) el.className = 'card card-back-mini';
    el.classList.add('flying-card');
    el.style.left = fromRect.left + 'px';
    el.style.top = fromRect.top + 'px';
    el.style.width = fromRect.w + 'px';
    el.style.height = fromRect.h + 'px';
    layer.appendChild(el);

    // Force a reflow so the browser treats the start position as a real
    // frame -- without this the element is created and moved in the same
    // tick and there is nothing to transition FROM, so it just appears at
    // the destination.
    void el.offsetWidth;

    // Claim the table until this lands, so the penalty-draw overlay holds
    // off instead of covering a card that is still moving.
    flightBusyUntil = Date.now() + FLY_MS;

    el.style.transition = `left ${FLY_MS}ms cubic-bezier(.22,.7,.3,1), top ${FLY_MS}ms cubic-bezier(.22,.7,.3,1), width ${FLY_MS}ms ease-out, height ${FLY_MS}ms ease-out, opacity ${FLY_MS}ms ease-out`;
    el.style.left = toRect.left + 'px';
    el.style.top = toRect.top + 'px';
    el.style.width = toRect.w + 'px';
    el.style.height = toRect.h + 'px';
    if (opts.fade) el.style.opacity = '0';

    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, FLY_MS + 60);
  }

  function openCardSlotRect() {
    const slot = document.querySelector('.table-center .card');
    return slot ? flyRect(slot) : null;
  }

  function seatRectFor(playerId) {
    const seat = document.querySelector(`.seat[data-player-id="${CSS.escape(playerId)}"]`);
    return seat ? flyRect(seat) : null;
  }

  // ---- haptics ----
  // Reserved for the two moments that are WARNINGS: a +2 penalty landing on
  // you, and your own turn timer about to expire. Vibrating on every tap
  // would turn it into background noise players tune out or switch off --
  // and then it isn't there for the two places it earns its keep.
  // navigator.vibrate works in the Android WebView with no native plugin, so
  // this ships as a normal web deploy rather than waiting on a native build.
  let hapticsOn = localStorage.getItem('leastcount_haptics') !== '0';
  function buzz(pattern) {
    if (!hapticsOn) return;
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) { /* unsupported or blocked -- never worth breaking play over */ }
  }
  function refreshHapticsToggle() {
    const b = document.getElementById('btn-haptics-toggle');
    if (!b) return;
    b.textContent = hapticsOn ? 'On' : 'Off';
    b.setAttribute('aria-checked', hapticsOn ? 'true' : 'false');
    b.classList.toggle('on', hapticsOn);
  }
  (function wireHapticsToggle() {
    const b = document.getElementById('btn-haptics-toggle');
    if (!b) return;
    refreshHapticsToggle();
    b.onclick = () => {
      hapticsOn = !hapticsOn;
      localStorage.setItem('leastcount_haptics', hapticsOn ? '1' : '0');
      refreshHapticsToggle();
      if (hapticsOn) buzz(20);   // confirm it works, once, on enabling
    };
  })();

  // One buzz per turn at the 5s mark -- a single warning, not an escalating
  // nag. Reset each time the turn changes so it can fire again next turn.
  let timerBuzzArmed = true;
  function maybeBuzzTurnTimer(secondsLeft, isMyTurn) {
    if (!isMyTurn) { timerBuzzArmed = true; return; }
    if (secondsLeft > 5) { timerBuzzArmed = true; return; }
    if (secondsLeft <= 5 && secondsLeft > 0 && timerBuzzArmed) {
      timerBuzzArmed = false;
      buzz([25, 60, 25]);
      // Sound as well as vibration. Vibration alone reached only the
      // players whose phone vibrates: someone on loud-with-vibration-off
      // got no warning at all, and someone on silent got no sound. Two
      // channels means the warning lands either way.
      Sound.timerWarning();
    }
  }

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

    // ---- opponent's card flies to the pile ----
    // Without this the open card silently changes and you have to spot the
    // difference; with it you SEE the move happen at the seat that made it,
    // which is most of what makes the table feel played-at rather than
    // reported-on. Keyed off the open card changing while the round carries
    // on, attributed to whoever's turn it just WAS (prev.currentPlayer).
    // Wrapped for the same reason as the discard handler: this runs inside
    // playSoundsForTransition(), which the game_state handler calls. A throw
    // here would abort the rest of that handler -- so a decorative flight
    // could stop the BOARD updating, which is the worst possible failure for
    // a cosmetic feature. Logged and swallowed instead.
    try {
    const openChanged = prev.openCard && game.openCard
      && (prev.openCard.id !== game.openCard.id);
    const sameRound = prev.roundNumber === game.roundNumber;
    if (openChanged && sameRound && !game.roundOver
        && prev.currentPlayer && prev.currentPlayer !== myPlayerId) {
      // An opponent's discard now makes a sound as well as a movement.
      // Until this line, every move made by anyone other than you was
      // completely silent -- in a six-player game that is five out of every
      // six events at the table.
      Sound.opponentDiscard();
      const from = seatRectFor(prev.currentPlayer);
      const to = openCardSlotRect();
      if (from && to) {
        // Start it at the card's destination size so it reads as a card the
        // whole way, rather than a seat-shaped block that morphs.
        flyCard({ left: from.left + (from.w - to.w) / 2, top: from.top, w: to.w, h: to.h },
          to, game.openCard);
      }
    }

    // ------------------------------------------------------------------
    // ---- somebody ELSE picked cards up ----
    //
    // NOTE, and this is a real bug being fixed here: this block used to
    // read game.lastDraw and vibrate on a +2 penalty. But lastDraw is NOT
    // part of getPublicState() -- it only ever existed engine-side so the
    // server could privately emit 'cards_drawn' to the one player affected.
    // game.lastDraw is therefore permanently undefined on the client, and
    // this condition has never once been true. The +2 vibration has never
    // fired for anybody. Your own draw now buzzes from showDrawReveal(),
    // which is driven by the 'cards_drawn' event that genuinely arrives.
    //
    // For OTHER players there is no draw event at all -- but handCounts is
    // public, and a hand that grew between two states means that player
    // drew exactly that many cards. That is the signal used here.
    // ------------------------------------------------------------------
    const counts = game.handCounts || {};
    const prevCounts = prev.handCounts || {};
    if (prev.roundNumber === game.roundNumber && !game.roundOver) {
      let opponentDrew = 0;
      Object.keys(counts).forEach((pid) => {
        if (pid === myPlayerId) return;
        const grew = (counts[pid] || 0) - (prevCounts[pid] || 0);
        if (grew > 0) opponentDrew = Math.max(opponentDrew, grew);
      });
      // One sound for the table, not one per player -- a reshuffle or a
      // rejoin can move several counts at once and we don't want a pile-up.
      if (opponentDrew > 0) Sound.opponentDraw(opponentDrew);
    }

    // ---- somebody is out ----
    const outNow = game.eliminated || [];
    const outBefore = prev.eliminated || [];
    if (outNow.length > outBefore.length) {
      const justOut = outNow.filter((id) => outBefore.indexOf(id) === -1);
      if (justOut.length) Sound.eliminated(justOut.indexOf(myPlayerId) !== -1);
    }
    } catch (e) {
      console.warn('[fx] table flourish failed (state still applied):', e && e.message);
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

    // ------------------------------------------------------------------
    // Wait for any card still in flight before covering the table.
    //
    // This overlay and the discard flight were firing simultaneously. A
    // discard that MATCHES the open card (or gets the joker free pass) draws
    // no penalty, so no 'cards_drawn' arrives and the flight plays cleanly --
    // but any other discard draws one, and this full-screen overlay landed
    // on top of a card that was still mid-air, 180ms into a 2500ms cover.
    // That is why the animation only looked right on matching discards.
    //
    // Sequencing them also puts the events in their true causal order: your
    // card leaves your hand, THEN the penalty arrives. Simultaneous, it read
    // as one confused moment.
    // ------------------------------------------------------------------
    const wait = Math.max(0, flightBusyUntil - Date.now());
    if (wait > 0) {
      setTimeout(() => showDrawReveal(cards), wait + 40);
      return;
    }

    // The verdict, not just the count. penaltyValence() weighs what you
    // gave up against what you got back -- see its comment block.
    Sound.penaltyDraw(cards.length, penaltyValence(cards, latestGame && latestGame.roundJokerRank));
    // The haptic belongs here, not in the state-diff handler: this event
    // ('cards_drawn') is the only signal that actually tells a client it
    // drew cards. See the note in playSoundsForTransition().
    try { buzz(cards.length > 1 ? [40, 70, 40] : 40); } catch (e) { /* no haptics, no matter */ }
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
        // ALSO clear the in-memory copies. Removing only the stored session
        // left myRoomCode holding a dead room code for the rest of the page's
        // life, and several checks read it as "am I in a room?" -- which it
        // never meant. That is what stopped a group member being pulled into
        // a game: the auto-join saw a stale room code and skipped them, while
        // the manual Join button (no such check) worked, so leaving the table
        // and rejoining appeared to "fix" it.
        myRoomCode = null;
        myPlayerId = null;
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
    // The countdown that led here is finished the moment the round starts.
    setAutoNextRoundDeadline(null);
    showScreen('screen-game');
    runStartSequence(data);
    // Third ad format: an interstitial every 4th round (after rounds 4, 8,
    // 12...), decided server-side so every player at the table gets it at the
    // same moment -- data.adRound. It deliberately plays OVER the countdown ->
    // deal -> joker-reveal sequence that runStartSequence() just kicked off,
    // which is ~8-10 seconds of screen nobody can interact with anyway, so
    // the ad occupies dead time instead of interrupting play. The server
    // separately holds the first turn timer back on these rounds (see
    // AD_ROUND_TIMER_GRACE_MS) so the opening player can't be auto-played
    // while an ad we chose to show them is still on screen.
    //
    // Everything else is deliberately left to LCAds: it no-ops when the
    // player has bought Remove Ads, when nothing is loaded yet, and when the
    // shared 3-minute interstitial cap hasn't elapsed -- which is what stops
    // this colliding with the leave-game interstitial.
    if (data.adRound && window.LCAds && !adsRemoved) {
      window.LCAds.showInterstitial();
    }
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
    // Re-sync the auto-advance countdown from every state push (null clears
    // it), so it can't drift or survive past the round it belongs to.
    setAutoNextRoundDeadline(game.autoNextRoundInMs);
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
