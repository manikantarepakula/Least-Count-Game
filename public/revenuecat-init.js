// --------------------------------------------------------------------------
// RevenueCat (in-app purchases) -- native Android app only, same idea as
// admob-init.js: purchases only make sense inside the real Play
// Store-connected app, so every function here is a safe no-op on the
// regular website.
//
// UNLIKE admob-init.js, this file has to be loaded as a real ES module
// (type="module", like firebase-init.js) that imports the actual published
// @revenuecat/purchases-capacitor package, instead of reaching straight
// into window.Capacitor.Plugins.Purchases. Reason: Capacitor only wires a
// plugin's native bridge calls into real, spec-compliant Promises once
// that plugin's OWN JS package code runs and calls registerPlugin() --
// window.Capacitor.Plugins.Purchases exists even before that (a raw,
// unwrapped stub), which is what caused "Purchases.configure(...).then is
// not a function" when this file first tried the direct-access shortcut
// (that shortcut happens to still work for simpler plugins like AdMob, but
// isn't reliable in general). Importing the real package from a CDN -- the
// exact same code RevenueCat's own docs use -- avoids that entirely.
//
// Purchases are tied to the SAME identity as everything else in this app
// (the Firebase uid already used for stats/chat moderation) via
// Purchases.logIn(), called from firebase-init.js whenever the signed-in
// user changes. That way, whatever someone buys while playing as a guest
// is still theirs after they later upgrade to a real Google account --
// same uid, same RevenueCat customer record.
// --------------------------------------------------------------------------
import { Purchases } from 'https://cdn.jsdelivr.net/npm/@revenuecat/purchases-capacitor@13.4.1/+esm';

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

if (!isNative) {
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
} else {
  // RevenueCat public SDK key. Safe to keep in client code, same as the
  // Firebase config values in firebase-init.js -- it only lets this app
  // start purchases and read its own product catalog, not move money or
  // read other users' data.
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
  //
  // Tracked in `identifyPromise` (rather than just awaited by the caller)
  // because firebase-init.js calls this fire-and-forget from
  // onAuthStateChanged. Anything that needs to check entitlements --
  // app.js's refreshRemoveAdsUI() -- should await whenIdentified() first,
  // otherwise it can run against the wrong (not-yet-logged-in) customer on
  // a fresh app launch and wrongly report "not purchased".
  let identifyPromise = null;
  async function identify(firebaseUid) {
    identifyPromise = (async () => {
      await ensureConfigured();
      if (!firebaseUid) return;
      try {
        await Purchases.logIn({ appUserID: firebaseUid });
      } catch (e) {
        console.warn('[RevenueCat] logIn failed:', e && e.message);
      }
    })();
    return identifyPromise;
  }

  function whenIdentified() {
    return identifyPromise || Promise.resolve();
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
    whenIdentified,
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
}
```
