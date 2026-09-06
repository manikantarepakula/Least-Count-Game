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
  console.log('[AdMob] using', useTestAds ? 'TEST' : 'REAL', 'banner unit:', BANNER_AD_ID);
  console.log('[AdMob] interstitial unit:', INTERSTITIAL_AD_ID,
    REAL_INTERSTITIAL_AD_ID ? '' : '(TEST -- real interstitial ID not set yet)');

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
  let bannerShown = false;
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
        if (bannerShown && size && typeof size.height === 'number' && size.height > 0) {
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

  async function showBanner() {
    if (bannerShown) return;
    ensureSizeListener();
    ensureDiagListeners();
    await ensureInit();
    try {
      await AdMob.showBanner({
        adId: BANNER_AD_ID,
        adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER',
        margin: 0,
      });
      // NOTE: reaching here only means the native call returned -- see the
      // long comment above. Watch for the BANNER LOADED / BANNER FAILED TO
      // LOAD log that follows this one; that's the real outcome.
      console.log('[AdMob] showBanner() native call returned (ad not necessarily loaded yet)');
      bannerShown = true;
      setSafeBottom(FALLBACK_BANNER_HEIGHT_PX);
    } catch (e) {
      console.warn('[AdMob] showBanner failed:', e && e.message);
    }
  }

  async function hideBanner() {
    if (!bannerShown) return;
    try {
      await AdMob.hideBanner();
    } catch (e) {
      console.warn('[AdMob] hideBanner failed:', e && e.message);
    } finally {
      bannerShown = false;
      setSafeBottom(0);
    }
  }

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
    }
  }

  window.LCAds = { showBanner, hideBanner, prepareInterstitial, showInterstitial };
})();
