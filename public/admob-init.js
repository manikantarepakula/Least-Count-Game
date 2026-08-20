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

  // Google's official, permanent test banner ad unit ID -- safe to leave
  // calling this as much as we want during development without generating
  // real (invalid) impressions/clicks on the real ad unit.
  //
  // TODO: once test ads are confirmed working end-to-end on a real device,
  // swap this for the real ad unit ID: ca-app-pub-1398110480284026/3640352329
  const BANNER_AD_ID = 'ca-app-pub-3940256099942544/6300978111';

  let initPromise = null;
  let bannerShown = false;

  function ensureInit() {
    if (!initPromise) {
      initPromise = AdMob.initialize({ initializeForTesting: true }).catch((e) => {
        console.warn('[AdMob] initialize failed:', e && e.message);
      });
    }
    return initPromise;
  }

  async function showBanner() {
    if (bannerShown) return;
    await ensureInit();
    try {
      await AdMob.showBanner({
        adId: BANNER_AD_ID,
        adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER',
        margin: 0,
      });
      bannerShown = true;
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
    }
  }

  window.LCAds = { showBanner, hideBanner };
})();
