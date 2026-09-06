// --------------------------------------------------------------------------
// AdMob banner ads -- native Android app only. The site is played inside a
// regular browser too (its original, primary form), and window.Capacitor
// only exists when this same code is running inside the wrapped Android app
// built with Capacitor. Every function below is a safe no-op on the regular
// website, so this file is harmless to load there.
//
// The banner itself is a NATIVE view drawn by the Android AdMob SDK on top
// of the WebView -- it isn't part of this page's HTML/CSS at all, which is
// why there's no markup or styling for it anywhere else in this app.
// --------------------------------------------------------------------------
(function () {
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  if (!isNative || !window.Capacitor.Plugins || !window.Capacitor.Plugins.AdMob) {
    // Same shape as the real object below, so callers in app.js never have
    // to check which one they got. showInterstitial() resolves false (as in
    // "no ad was shown") rather than undefined, matching the real one.
    window.LCAds = {
      showBanner() {},
      hideBanner() {},
      prepareInterstitial() {},
      showInterstitial() { return Promise.resolve(false); },
      showResultAd() {},
      hideResultAd() {},
    };
    return;
  }

  const AdMob = window.Capacitor.Plugins.AdMob;

  // Real, live AdMob banner ad unit ID for this app (test ads confirmed
  // working end-to-end on a real device, switched over for release).
  const REAL_BANNER_AD_ID = 'ca-app-pub-1398110480284026/3640352329';

  // Google's official, always-fills test banner unit. Not our account, not
  // billable, and it serves 100% of the time on any device -- which makes it
  // the one decisive way to tell the two possible causes of "no ads" apart:
  //   - test ad SHOWS  -> the integration (plugin, manifest app ID, init,
  //     showBanner call, placement, safe-zone) is all correct, and the real
  //     unit is silent for an AdMob-side reason: account/app still pending
  //     review, unit created too recently, or genuine no-fill.
  //   - test ad ALSO BLANK -> the problem is on our side (plugin/native
  //     wiring), and no amount of waiting on AdMob will fix it.
  // Toggle it from the chrome://inspect console with:
  //   localStorage.setItem('lc_test_ads','1'); location.reload();
  // and turn it back off with:
  //   localStorage.removeItem('lc_test_ads'); location.reload();
  const TEST_BANNER_AD_ID = 'ca-app-pub-3940256099942544/6300978111';

  // ---- Interstitial (full screen, shown when leaving a room) ----
  // Real interstitial unit, created in the AdMob console Sept 2026. This is
  // a DIFFERENT unit from the banner above -- same publisher number
  // (1398110480284026), different digits after the slash -- and the two are
  // not interchangeable: a banner ID will not serve a full-screen ad.
  // Both sit under app ID ca-app-pub-1398110480284026~3196770244, which is
  // the value already registered in AndroidManifest.xml.
  const REAL_INTERSTITIAL_AD_ID = 'ca-app-pub-1398110480284026/1563848703';
  const TEST_INTERSTITIAL_AD_ID = 'ca-app-pub-3940256099942544/1033173712';

  // ---- Large banner (320x100), shown on the round-result screen ----
  // A SEPARATE banner ad unit from the bottom banner above: same format
  // (banner), different size, and worth its own unit so the two placements
  // report and optimise independently.
  //
  // This started as a 300x250 medium rectangle (matching what chess.com does
  // on its game-over screen) and was cut down after measuring the real panel:
  // at 6 players on a 375x812 phone the scorecard needs 950px against 778px
  // available, so a 250px ad left it scrolling with Next Round below the fold
  // even after dropping the podium, the card rows and the emoji. 320x100
  // gives back 150px, which is what actually lets every player and every
  // control fit on one screen -- including on shorter phones, where a
  // rectangle was never going to work.
  // Real round-result banner unit, created in the AdMob console Sept 2026.
  // Third unit under the same app (ca-app-pub-1398110480284026~3196770244),
  // alongside the bottom banner and the interstitial.
  const REAL_RECT_AD_ID = 'ca-app-pub-1398110480284026/9607658553';
  const TEST_RECT_AD_ID = 'ca-app-pub-3940256099942544/6300978111';

  let useTestAds = false;
  try {
    useTestAds = localStorage.getItem('lc_test_ads') === '1';
  } catch (e) { /* storage blocked -- fall through to real ads */ }

  const BANNER_AD_ID = useTestAds ? TEST_BANNER_AD_ID : REAL_BANNER_AD_ID;
  // Falls back to the test unit whenever the real one is still blank, so a
  // missing ID can never send a malformed/empty adId into the native SDK.
  const INTERSTITIAL_AD_ID = (useTestAds || !REAL_INTERSTITIAL_AD_ID)
    ? TEST_INTERSTITIAL_AD_ID
    : REAL_INTERSTITIAL_AD_ID;
  const RECT_AD_ID = (useTestAds || !REAL_RECT_AD_ID) ? TEST_RECT_AD_ID : REAL_RECT_AD_ID;
  console.log('[AdMob] using', useTestAds ? 'TEST' : 'REAL', 'banner unit:', BANNER_AD_ID);
  console.log('[AdMob] interstitial unit:', INTERSTITIAL_AD_ID,
    REAL_INTERSTITIAL_AD_ID ? '' : '(TEST -- real interstitial ID not set yet)');
  console.log('[AdMob] round-result banner unit:', RECT_AD_ID,
    REAL_RECT_AD_ID ? '' : '(TEST -- real round-result ID not set yet)');

  // The banner is a native view with zero footprint in the page's own
  // layout, so every screen -- including the game table -- needs to reserve
  // real space for it (bottom padding) or its bottom-most buttons/nav get
  // covered. This CSS var is that reserved space; style.css reads it on
  // every screen and overlay uniformly. A conservative guess is set the
  // instant the banner is requested so there's no flash of unprotected UI
  // while we wait for AdMob to report the real adaptive height, which then
  // corrects it.
  const FALLBACK_BANNER_HEIGHT_PX = 50;

  function setSafeBottom(px) {
    document.documentElement.style.setProperty('--ad-safe-bottom', px + 'px');
  }

  let initPromise = null;
  let listenerAdded = false;

  function ensureSizeListener() {
    if (listenerAdded) return;
    listenerAdded = true;
    // Runtime event name for BannerAdPluginEvents.SizeChanged -- using the
    // raw string since this file talks to the plugin via window.Capacitor
    // rather than importing the TS enum. This name was a best guess (not
    // verified against the actual installed plugin version), and it turned
    // out to break EVERY banner on EVERY screen: addListener() is called
    // unconditionally at the top of showBanner(), so if it throws (sync or
    // via a rejected promise) it can take the whole call down with it before
    // the real AdMob.showBanner() below ever runs. Wrapped defensively so a
    // bad/unsupported event name only costs the size-refinement feature
    // (banner falls back to FALLBACK_BANNER_HEIGHT_PX and stays there),
    // never the banner itself.
    try {
      const result = AdMob.addListener('bannerAdSizeChanged', (size) => {
        if (appliedKind === BANNER_BOTTOM && size && typeof size.height === 'number' && size.height > 0) {
          setSafeBottom(size.height);
        }
      });
      if (result && typeof result.catch === 'function') {
        result.catch((e) => console.warn('[AdMob] size listener failed:', e && e.message));
      }
    } catch (e) {
      console.warn('[AdMob] addListener threw:', e && e.message);
    }
  }

  // The missing piece in every previous round of this investigation:
  // showBanner()'s promise resolves as soon as the NATIVE CALL completes
  // (container created, ad request sent) -- NOT when an ad has actually
  // loaded and become visible. So a totally silent, totally successful-
  // looking showBanner() is exactly what both "the ad loaded fine" and "the
  // ad request came back empty" look like from JS. These listeners are the
  // only way to see which one actually happened: bannerAdLoaded fires on
  // success, bannerAdFailedToLoad carries the SDK's own error code, which
  // is the thing that says whether this is our bug or AdMob's answer.
  //
  // AdMob error codes (from the Android SDK):
  //   0 = INTERNAL_ERROR   -- SDK-side problem
  //   1 = INVALID_REQUEST  -- bad ad unit ID / app ID mismatch (OUR bug)
  //   2 = NETWORK_ERROR    -- device couldn't reach the ad servers
  //   3 = NO_FILL          -- request was valid, AdMob simply had no ad to
  //                           give (the normal answer for a brand-new app or
  //                           an account/app still pending review)
  // Every name is wrapped defensively, same reasoning as the size listener
  // above -- an unsupported event name must never take the banner down.
  function addDiagListener(eventName, handler) {
    try {
      const result = AdMob.addListener(eventName, handler);
      if (result && typeof result.catch === 'function') {
        result.catch((e) => console.warn('[AdMob] listener', eventName, 'rejected:', e && e.message));
      }
    } catch (e) {
      console.warn('[AdMob] listener', eventName, 'threw:', e && e.message);
    }
  }

  function ensureDiagListeners() {
    addDiagListener('bannerAdLoaded', () => {
      console.log('[AdMob] BANNER LOADED -- an ad really is on screen now.');
    });
    addDiagListener('bannerAdFailedToLoad', (err) => {
      console.warn('[AdMob] BANNER FAILED TO LOAD:', JSON.stringify(err));
      console.warn('[AdMob]   code 3 = NO_FILL (AdMob had no ad -- account/app' +
        ' still pending review, or unit too new). code 1 = INVALID_REQUEST' +
        ' (our ad unit / app ID is wrong). code 2 = NETWORK_ERROR.');
    });
    addDiagListener('bannerAdOpened', () => console.log('[AdMob] banner opened'));
    addDiagListener('bannerAdClosed', () => console.log('[AdMob] banner closed'));
    addDiagListener('bannerAdImpression', () => console.log('[AdMob] banner impression recorded'));
  }

  function ensureInit() {
    if (!initPromise) {
      initPromise = AdMob.initialize({ initializeForTesting: false })
        .then((res) => {
          console.log('[AdMob] initialize OK:', JSON.stringify(res));
        })
        .catch((e) => {
          console.warn('[AdMob] initialize failed:', e && e.message);
        });
    }
    return initPromise;
  }

  // ------------------------------------------------------------------------
  // Banner state: intent, not mirrored native state.
  //
  // Every banner bug in this app has had the same shape. There is ONE native
  // banner slot, and we used to track what was in it with booleans
  // (bannerShown / rectShown) that were only ever updated by our own calls.
  // But the slot changes underneath us -- most importantly, showing an
  // interstitial makes the plugin hide the banner itself (visible in the
  // device log as showInterstitial immediately followed by hideBanner). Our
  // boolean still said "banner is up", so showBanner() early-returned and
  // the banner never came back. That's why the landing-page banner vanished
  // after an interstitial, and why a stuck flag could kill every ad in the
  // app for the rest of the session.
  //
  // So: `desired` records what SHOULD be on screen, `applied` records what we
  // last actually told the native side, and apply() reconciles the two. Any
  // time the native slot might have changed without us (after an
  // interstitial), applied is invalidated and the desired state is simply
  // re-issued. Nothing latches, and no failure can leave ads permanently off
  // -- the worst case is one redundant native call.
  // ------------------------------------------------------------------------
  const BANNER_NONE = 'none';
  const BANNER_BOTTOM = 'bottom';
  const BANNER_RESULT = 'result';

  let desiredKind = BANNER_NONE;
  let desiredMargin = 0;
  let appliedKind = null;   // null = unknown, must re-issue
  let appliedMargin = null;
  let applyRunning = null;

  function requestBanner(kind, margin) {
    desiredKind = kind;
    desiredMargin = Math.max(0, Math.round(margin || 0));
    scheduleApply();
  }

  // Marks our record of the native slot as unknown, so the next apply()
  // re-issues the desired state even if it looks unchanged.
  function invalidateBannerState(why) {
    appliedKind = null;
    appliedMargin = null;
    if (why) console.log('[AdMob] banner state invalidated:', why);
  }

  function scheduleApply() {
    if (applyRunning) return;   // the running loop re-checks desired at the end
    applyRunning = (async () => {
      try {
        ensureSizeListener();
        ensureDiagListeners();
        await ensureInit();
        // Loop until native matches intent -- intent can change while an
        // await is in flight, which is exactly the race that used to let a
        // game_state push steal the slot mid-swap.
        for (let guard = 0; guard < 10; guard++) {
          const kind = desiredKind;
          const margin = desiredMargin;
          if (kind === appliedKind && margin === appliedMargin) break;
          try {
            if (kind === BANNER_NONE) {
              await AdMob.hideBanner();
              setSafeBottom(0);
            } else if (kind === BANNER_BOTTOM) {
              await AdMob.showBanner({
                adId: BANNER_AD_ID,
                adSize: 'ADAPTIVE_BANNER',
                position: 'BOTTOM_CENTER',
                margin: 0,
              });
              // Reaching here only means the native call returned, not that
              // an ad loaded -- watch for BANNER LOADED / FAILED TO LOAD.
              console.log('[AdMob] bottom banner requested');
              setSafeBottom(FALLBACK_BANNER_HEIGHT_PX);
            } else {
              await AdMob.showBanner({
                adId: RECT_AD_ID,
                adSize: 'LARGE_BANNER',
                position: 'TOP_CENTER',
                margin: margin,
              });
              console.log('[AdMob] round-result banner requested at top margin', margin);
              // The round-result ad floats over the scorecard, not above the
              // bottom nav, so it reserves no bottom safe-zone of its own.
              setSafeBottom(0);
            }
            appliedKind = kind;
            appliedMargin = margin;
          } catch (e) {
            console.warn('[AdMob] banner apply failed for "' + kind + '":', e && e.message);
            // Leave applied as unknown so the next request retries rather
            // than assuming this state stuck.
            invalidateBannerState(null);
            break;
          }
        }
      } finally {
        applyRunning = null;
        // Intent may have changed during the final await -- run again if so.
        if (desiredKind !== appliedKind || desiredMargin !== appliedMargin) scheduleApply();
      }
    })();
  }

  // Is the scorecard actually on screen right now? Asked of the DOM every
  // time rather than tracked in a variable: this decides whether the bottom
  // banner should stand down, and a variable saying "stand down" can get
  // stuck (it did, and it killed every ad in the app), whereas the overlay's
  // real visibility cannot.
  function resultOverlayOpen() {
    const el = document.getElementById('overlay-round-result');
    return !!el && !el.classList.contains('hidden');
  }

  function showBanner() {
    // showScreen('screen-game') calls this on EVERY game_state push, and
    // those keep arriving while the scorecard is open. Without this the
    // bottom banner would immediately reclaim the single slot and replace
    // the round-result ad a fraction of a second after it appeared.
    if (resultOverlayOpen()) return;
    requestBanner(BANNER_BOTTOM, 0);
  }
  function hideBanner() { requestBanner(BANNER_NONE, 0); }

  // ------------------------------------------------------------------------
  // Interstitial -- the full-screen ad shown when a player leaves a room.
  //
  // Two rules shape everything below, both from Google's own policy (an
  // account can be suspended for breaking them, which matters a lot more
  // than the few rupees an extra impression earns):
  //   1. Never interrupt play. It fires on the way OUT of a room, at a
  //      natural stopping point -- never mid-hand, never on a timer.
  //   2. Never make the ad feel mandatory or trap the user. Leaving the room
  //      happens regardless of whether the ad loads, fails, or is skipped.
  //
  // An interstitial must be LOADED before it can be shown, and loading takes
  // a few seconds, so prepare() is called early (when a game screen opens)
  // and show() just presents whatever is already in hand. If nothing is
  // ready, show() gives up immediately rather than making the player wait.
  // ------------------------------------------------------------------------
  const MIN_MS_BETWEEN_INTERSTITIALS = 3 * 60 * 1000; // ~1 ad per 3 minutes, max
  let interstitialReady = false;
  let interstitialLoading = false;
  let lastInterstitialAt = 0;

  async function prepareInterstitial() {
    if (interstitialReady || interstitialLoading) return;
    interstitialLoading = true;
    try {
      await ensureInit();
      await AdMob.prepareInterstitial({ adId: INTERSTITIAL_AD_ID });
      interstitialReady = true;
      console.log('[AdMob] interstitial prepared and ready');
    } catch (e) {
      // Most often a no-fill, same as the banner -- nothing to do but carry
      // on without one. Deliberately not retried in a loop; the next
      // prepare() call comes from the next natural trigger.
      interstitialReady = false;
      console.warn('[AdMob] prepareInterstitial failed:', e && e.message);
    } finally {
      interstitialLoading = false;
    }
  }

  async function showInterstitial() {
    if (!interstitialReady) {
      // Nothing loaded -- leave silently and start loading one for next time.
      prepareInterstitial();
      return false;
    }
    if (Date.now() - lastInterstitialAt < MIN_MS_BETWEEN_INTERSTITIALS) {
      console.log('[AdMob] interstitial skipped (frequency cap)');
      return false;
    }
    try {
      await AdMob.showInterstitial();
      lastInterstitialAt = Date.now();
      console.log('[AdMob] interstitial shown');
      return true;
    } catch (e) {
      console.warn('[AdMob] showInterstitial failed:', e && e.message);
      return false;
    } finally {
      // A given interstitial is single-use -- once shown (or once it failed)
      // the loaded ad is spent, so queue the next one up for later.
      interstitialReady = false;
      prepareInterstitial();
      // THE landing-page-banner bug: showing a full-screen ad makes the
      // plugin hide the banner ITSELF (device logs show showInterstitial
      // immediately followed by hideBanner, which nothing in this file
      // asked for). Our record still claimed a banner was up, so every
      // later request was skipped as redundant and the landing page stayed
      // blank for the rest of the session. Forget what we believe the slot
      // holds and re-assert the desired banner, which brings it back.
      invalidateBannerState('interstitial hid the banner natively');
      scheduleApply();
    }
  }

  // ------------------------------------------------------------------------
  // Round-result banner (320x100).
  //
  // The plugin holds exactly ONE banner instance, so this can't sit alongside
  // the bottom banner -- showing the rectangle replaces it, and hiding the
  // rectangle has to put the bottom banner back. That swap is the whole
  // complexity here, and it's why both directions are funnelled through these
  // two functions rather than callers poking showBanner/hideBanner directly.
  //
  // Like the bottom banner, this is a NATIVE view floating over the WebView --
  // it isn't in the page's layout. So the round-result panel reserves a real
  // 320x100 hole for it (see #round-result-ad in index.html/style.css) and the
  // ad is positioned to land in that hole, measured fresh each time because
  // the panel's height changes with the number of players.
  // ------------------------------------------------------------------------
  // Both directions are just intent changes now -- the reconciler above owns
  // every native call, so the swap can't race a game_state push, and no
  // failure can leave the slot in a state that nobody restores.
  function showResultAd(topOffsetPx) {
    requestBanner(BANNER_RESULT, topOffsetPx);
  }

  function hideResultAd() {
    // Back to the bottom banner. Safe to call even if the round-result ad
    // never actually appeared -- reconciling to "bottom" is always valid.
    requestBanner(BANNER_BOTTOM, 0);
  }

  window.LCAds = {
    showBanner, hideBanner,
    prepareInterstitial, showInterstitial,
    showResultAd, hideResultAd,
  };
})();
