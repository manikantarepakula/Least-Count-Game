// --------------------------------------------------------------------------
// RevenueCat (in-app purchases) -- native Android app only, same pattern as
// admob-init.js: window.Capacitor only exists inside the wrapped app, so
// every function here is a safe no-op on the regular website (nobody can
// buy anything from a browser tab, which is intentional -- purchases only
// make sense inside the real Play Store-connected app).
//
// Purchases are tied to the SAME identity as everything else in this app
// (the Firebase uid already used for stats/chat moderation) via
// Purchases.logIn(), called from firebase-init.js whenever the signed-in
// user changes. That way, whatever someone buys while playing as a guest
// is still theirs after they later upgrade to a real Google account --
// same uid, same RevenueCat customer record.
// --------------------------------------------------------------------------
(function () {
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  if (!isNative || !window.Capacitor.Plugins || !window.Capacitor.Plugins.Purchases) {
    window.LCPurchases = {
      isReady: () => false,
      identify: async () => {},
      getOfferings: async () => null,
      purchasePackage: async () => {
        throw new Error('Purchases are only available in the app.');
      },
      isEntitled: async () => false,
      restorePurchases: async () => null,
    };
    return;
  }

  const Purchases = window.Capacitor.Plugins.Purchases;

  // RevenueCat public SDK key. Safe to keep in client code, same as the
  // Firebase config values above -- it only lets this app start purchases
  // and read its own product catalog, not move money or read other users'
  // data.
  //
  // TEMPORARY: pointed at the "Test Store" app right now so we can build
  // and verify the whole purchase flow (button -> purchase -> entitlement
  // unlocked) using fake, no-money purchases, since the real Google Play
  // merchant account is still pending Google's video KYC step.
  //
  // Real Play Store key (swap back in once the merchant account clears and
  // the real "remove_ads" product exists in Play Console):
  //   goog_RYLEYrOOSMJLfryTHvdoOslNOUN
  const RC_API_KEY = 'test_CpMMMcHaECSeYdgRjrrTxPWUpTh';

  let configured = false;
  let configuring = null;

  function ensureConfigured() {
    if (configured) return Promise.resolve();
    if (!configuring) {
      configuring = Purchases.configure({ apiKey: RC_API_KEY })
        .then(() => {
          configured = true;
        })
        .catch((e) => {
          console.warn('[RevenueCat] configure failed:', e && e.message);
          configuring = null;
        });
    }
    return configuring;
  }

  // Called from firebase-init.js once the Firebase uid is known (including
  // right away for anonymous guests) -- switches RevenueCat's identity from
  // its own auto-generated anonymous id over to OUR uid, so it lines up
  // with stats/chat moderation instead of being a second, unrelated id.
  async function identify(firebaseUid) {
    await ensureConfigured();
    if (!firebaseUid) return;
    try {
      await Purchases.logIn({ appUserID: firebaseUid });
    } catch (e) {
      console.warn('[RevenueCat] logIn failed:', e && e.message);
    }
  }

  // Returns the current default "offering" (a named bundle of purchasable
  // packages configured in the RevenueCat dashboard), or null if nothing is
  // set up yet / offline. app.js reads .availablePackages off this to build
  // whatever purchase buttons it wants to show.
  async function getOfferings() {
    await ensureConfigured();
    try {
      const result = await Purchases.getOfferings();
      return (result && result.current) || null;
    } catch (e) {
      console.warn('[RevenueCat] getOfferings failed:', e && e.message);
      return null;
    }
  }

  async function purchasePackage(pkg) {
    await ensureConfigured();
    const result = await Purchases.purchasePackage({ aPackage: pkg });
    return result.customerInfo;
  }

  // Checks whether the signed-in identity currently holds a given
  // "entitlement" (e.g. 'remove_ads') -- the thing app.js actually gates
  // features on, rather than checking specific product ids directly.
  async function isEntitled(entitlementId) {
    await ensureConfigured();
    try {
      const { customerInfo } = await Purchases.getCustomerInfo();
      return !!(customerInfo.entitlements.active && customerInfo.entitlements.active[entitlementId]);
    } catch (e) {
      console.warn('[RevenueCat] getCustomerInfo failed:', e && e.message);
      return false;
    }
  }

  // Lets someone who reinstalls the app, or switches devices, get back
  // whatever they already paid for without paying again -- required by
  // both Google and Apple store policy for non-consumable purchases.
  async function restorePurchases() {
    await ensureConfigured();
    const result = await Purchases.restorePurchases();
    return result.customerInfo;
  }

  window.LCPurchases = {
    isReady: () => configured,
    identify,
    getOfferings,
    purchasePackage,
    isEntitled,
    restorePurchases,
  };

  // Start configuring immediately (with a temporary anonymous id) so
  // getOfferings()/purchasePackage() are ready to go as soon as anyone taps
  // a buy button -- identify() re-points it at the real Firebase uid a
  // moment later without losing anything already in progress.
  ensureConfigured();
})();
