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

  // The freshest CustomerInfo we've actually SEEN, from whichever call last
  // returned one (logIn/restorePurchases/purchasePackage/getCustomerInfo).
  // isEntitled() below prefers this over making its own fresh
  // getCustomerInfo() call -- confirmed via live device testing that a
  // standalone getCustomerInfo() call can report an entitlement as inactive
  // even seconds after restorePurchases() (in the very same session, same
  // identity) had just returned that exact entitlement as active. Rather
  // than trust whichever call happens to run last, we trust the most
  // authoritative one we've actually observed succeed.
  let latestCustomerInfo = null;

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
        const { customerInfo } = await Purchases.logIn({ appUserID: firebaseUid });
        latestCustomerInfo = customerInfo;
      } catch (e) {
        console.warn('[RevenueCat] logIn failed:', e && e.message);
      }
      // logIn() alone doesn't reliably surface entitlements from purchases
      // made under a PRIOR identity that later got merged/aliased into this
      // uid (e.g. a purchase made while still on RevenueCat's own temporary
      // anonymous id, before this uid was known) -- confirmed via live
      // testing: getCustomerInfo() right after logIn() reported "not
      // entitled" even for a real, already-paid purchase, while
      // restorePurchases() immediately found and reconciled it correctly.
      // Running it here, every time, means this self-heals on every launch
      // instead of requiring a manual "Restore Purchases" tap. Safe/cheap
      // no-op if there's nothing new to reconcile.
      try {
        const { customerInfo } = await Purchases.restorePurchases();
        latestCustomerInfo = customerInfo; // most authoritative -- see isEntitled()
      } catch (e) {
        console.warn('[RevenueCat] restorePurchases failed:', e && e.message);
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
    latestCustomerInfo = result.customerInfo;
    return result.customerInfo;
  }

  function hasEntitlement(customerInfo, entitlementId) {
    return !!(customerInfo && customerInfo.entitlements && customerInfo.entitlements.active
      && customerInfo.entitlements.active[entitlementId]);
  }

  // Checks whether the signed-in identity currently holds a given
  // "entitlement" (e.g. 'removeads') -- the thing app.js actually gates
  // features on, rather than checking specific product ids directly.
  //
  // Deliberately calls Purchases.restorePurchases() directly here, every
  // single time, rather than Purchases.getCustomerInfo() or a cached
  // snapshot. Confirmed via repeated live device testing that
  // getCustomerInfo() (and even the customerInfo returned directly from
  // logIn()) can under-report an entitlement that IS genuinely active on
  // this account, while restorePurchases() is the one call that has
  // consistently, reliably surfaced the correct state every time it's been
  // tried. It's a slightly heavier call, but this only runs a couple of
  // times per app launch (not in a hot loop), so that's a fine trade for
  // actually being correct.
  async function isEntitled(entitlementId) {
    await ensureConfigured();
    try {
      const { customerInfo } = await Purchases.restorePurchases();
      latestCustomerInfo = customerInfo;
      return hasEntitlement(customerInfo, entitlementId);
    } catch (e) {
      console.warn('[RevenueCat] restorePurchases (via isEntitled) failed:', e && e.message);
      // If the network call itself failed, fall back to whatever we last
      // knew rather than flatly assuming "not purchased".
      if (latestCustomerInfo) return hasEntitlement(latestCustomerInfo, entitlementId);
      return false;
    }
  }

  // Lets someone who reinstalls the app, or switches devices, get back
  // whatever they already paid for without paying again -- required by
  // both Google and Apple store policy for non-consumable purchases.
  async function restorePurchases() {
    await ensureConfigured();
    const result = await Purchases.restorePurchases();
    latestCustomerInfo = result.customerInfo;
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
