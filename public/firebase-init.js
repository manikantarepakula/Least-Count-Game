// --------------------------------------------------------------------------
// Firebase client setup. Handles ONLY sign-in identity for now (anonymous
// guest sessions, upgradeable to a real Google account) -- Firestore
// reads/writes for stats, cosmetics, and purchases come in a later step,
// once the server-side (Admin SDK) piece exists too, so real game results
// stay authoritative and can't just be edited from a browser console.
//
// This file's config values (apiKey, authDomain, etc.) are NOT secret --
// they identify the Firebase project to the browser, the same way any
// website's client-side config is public. The one piece that IS secret is
// the service-account key generated separately in the Firebase console,
// which never belongs in this file or in the GitHub repo.
// --------------------------------------------------------------------------
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  getAuth,
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  linkWithPopup,
  linkWithCredential,
  signInWithCredential,
  signOut as fbSignOut,
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  getAnalytics,
  logEvent,
  isSupported as analyticsIsSupported,
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-analytics.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDY1DlnH5F3FZvU0Y0ePFdiw0nx7mhwvPE',
  authDomain: 'least-count-ad558.firebaseapp.com',
  projectId: 'least-count-ad558',
  storageBucket: 'least-count-ad558.firebasestorage.app',
  messagingSenderId: '288085056604',
  appId: '1:288085056604:web:335c242ed2bb5452cd5a99',
  measurementId: 'G-QNWDER2WET',
};

const app = initializeApp(firebaseConfig);

// On the regular website, plain getAuth() is fine -- browsers persist
// Firebase's sign-in state on their own (IndexedDB under the hood already).
// Inside the native Android app's embedded WebView, though, that default
// persistence isn't reliably picked up again on a full app restart unless
// we explicitly tell Firebase to use indexedDBLocalPersistence -- without
// this, every cold start could silently mint a BRAND NEW anonymous uid
// instead of resuming the previous one. That, in turn, is why RevenueCat's
// identify(uid) call in onAuthStateChanged below would end up pointing at a
// different customer than the one who actually purchased "Remove Ads",
// making the entitlement (and the ad banner) look like it was never bought.
const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const auth = isNativeApp
  ? initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })
  : getAuth(app);

// ---------------- analytics (Google Analytics for Firebase, free/unlimited
// up to 500 distinct event types) ----------------
// analyticsIsSupported() rejects in a handful of environments (very old
// browsers, some in-app browsers, ad-blockers) -- guarded so a failure here
// can never break sign-in or gameplay, it just means that session's events
// silently don't get counted. `logEvent` is a no-op safe wrapper so app.js
// never needs to check whether analytics actually initialized.
let analytics = null;
analyticsIsSupported()
  .then((supported) => {
    if (supported) analytics = getAnalytics(app);
  })
  .catch((err) => console.warn('[Analytics] not supported in this browser:', err.message));

function logAnalyticsEvent(name, params) {
  if (!analytics) return;
  try {
    logEvent(analytics, name, params || {});
  } catch (err) {
    console.warn('[Analytics] logEvent failed:', err.message);
  }
}

let currentUser = null;
const listeners = [];

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  listeners.forEach((cb) => cb(user));
  if (!user) {
    // No session yet (first visit, or just signed out) -- sign in
    // anonymously right away so every player always has a stable identity,
    // even before they ever choose to link a real Google account.
    signInAnonymously(auth).catch((err) => {
      console.error('[Firebase] anonymous sign-in failed:', err.message);
    });
    return;
  }
  // Keep RevenueCat's identity in sync with this same uid (safe no-op on
  // the regular website, and safe even if revenuecat-init.js hasn't
  // finished loading yet -- see the guard below).
  if (window.LCPurchases) {
    window.LCPurchases.identify(user.uid);
  }
});

// Upgrades the current anonymous session to a real Google account while
// KEEPING the same uid (and therefore the same future stats/purchases),
// instead of starting a brand new identity -- important so nobody loses
// progress just by signing in with Google after already playing as a guest.
//
// Two different code paths depending on where this is running:
//  - Regular website (any browser): Firebase's own signInWithPopup/
//    linkWithPopup opens a Google login popup right in the page. Unchanged.
//  - Native Android app (wrapped with Capacitor): Google blocks OAuth popups
//    inside embedded WebViews, so the popup above just hangs forever. Instead
//    we use the @capacitor-firebase/authentication plugin, which drives the
//    REAL native Google Sign-In screen (a system UI, not a WebView popup) and
//    hands back a Google ID token. We then feed that token into the exact
//    same Firebase JS SDK (signInWithCredential/linkWithCredential) used on
//    the web, so both platforms end up in the same signed-in state and the
//    same uid-preserving upgrade-from-guest logic applies either way.
async function signInWithGoogle() {
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  if (isNative && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAuthentication) {
    const FirebaseAuthentication = window.Capacitor.Plugins.FirebaseAuthentication;
    const nativeResult = await FirebaseAuthentication.signInWithGoogle();
    const idToken = nativeResult && nativeResult.credential && nativeResult.credential.idToken;
    if (!idToken) throw new Error('Google sign-in did not return a token.');
    const credential = GoogleAuthProvider.credential(idToken);
    if (currentUser && currentUser.isAnonymous) {
      try {
        const result = await linkWithCredential(currentUser, credential);
        return result.user;
      } catch (err) {
        if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
          const result = await signInWithCredential(auth, credential);
          return result.user;
        }
        throw err;
      }
    }
    const result = await signInWithCredential(auth, credential);
    return result.user;
  }

  const provider = new GoogleAuthProvider();
  if (currentUser && currentUser.isAnonymous) {
    try {
      const result = await linkWithPopup(currentUser, provider);
      return result.user;
    } catch (err) {
      // Most likely cause: this Google account is already linked to a
      // different uid from a previous session (e.g. a different device) --
      // fall back to a normal sign-in with that existing account instead of
      // failing outright.
      if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
        const result = await signInWithPopup(auth, provider);
        return result.user;
      }
      throw err;
    }
  }
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

async function signInWithGoogleAndLog() {
  const user = await signInWithGoogle();
  logAnalyticsEvent('google_sign_in');
  return user;
}

// Small global surface for app.js (a plain, non-module script) to use --
// keeps all the Firebase-specific import/setup detail contained to this file.
window.LCAuth = {
  getUser: () => currentUser,
  onUserChange: (cb) => {
    listeners.push(cb);
    if (currentUser !== null) cb(currentUser); // fire immediately if already known
  },
  signInWithGoogle: signInWithGoogleAndLog,
  signOut: () => fbSignOut(auth),
};

// Separate namespace (rather than piling onto LCAuth) since this covers
// gameplay events too, not just auth -- app.js calls window.LCAnalytics.log(...)
// at the handful of funnel moments that matter (room created/joined, solo
// game started, game completed, player reported). Safe to call even before
// analytics has finished initializing -- logAnalyticsEvent() just no-ops.
window.LCAnalytics = {
  log: logAnalyticsEvent,
};
