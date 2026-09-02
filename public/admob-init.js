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
    window.LCAds = { showBanner() {}, hideBanner() {} };
    return;
  }

  const AdMob = window.Capacitor.Plugins.AdMob;

  // Real, live AdMob banner ad unit ID for this app (test ads confirmed
  // working end-to-end on a real device, switched over for release).
  const BANNER_AD_ID = 'ca-app-pub-1398110480284026/3640352329';

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

  function ensureInit() {
    if (!initPromise) {
      initPromise = AdMob.initialize({ initializeForTesting: false }).catch((e) => {
        console.warn('[AdMob] initialize failed:', e && e.message);
      });
    }
    return initPromise;
  }

  async function showBanner() {
    if (bannerShown) return;
    ensureSizeListener();
    await ensureInit();
    try {
      await AdMob.showBanner({
        adId: BANNER_AD_ID,
        adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER',
        margin: 0,
      });
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

  window.LCAds = { showBanner, hideBanner };
})();
