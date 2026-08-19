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
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  linkWithPopup,
  signOut as fbSignOut,
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';

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
const auth = getAuth(app);

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
  }
});

// Upgrades the current anonymous session to a real Google account while
// KEEPING the same uid (and therefore the same future stats/purchases),
// instead of starting a brand new identity -- important so nobody loses
// progress just by signing in with Google after already playing as a guest.
async function signInWithGoogle() {
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

// Small global surface for app.js (a plain, non-module script) to use --
// keeps all the Firebase-specific import/setup detail contained to this file.
window.LCAuth = {
  getUser: () => currentUser,
  onUserChange: (cb) => {
    listeners.push(cb);
    if (currentUser !== null) cb(currentUser); // fire immediately if already known
  },
  signInWithGoogle,
  signOut: () => fbSignOut(auth),
};
