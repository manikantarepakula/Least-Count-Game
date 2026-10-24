/* ==========================================================================
   layout.js -- fit every screen to the phone it is on (Oct 2026)
   ==========================================================================

   THE PROBLEM
   Measured on the live build before this file existed (px of content that
   did not fit, with the 64px ad banner the app shows):

                              360x720   393x780   laptop 1366x650
     Home (vs Bots)              74        14          67
     Lobby, just you             94        34         145
     Lobby, 4 players           234       174         285
     Group screen               399       339         398

   Breakpoints can't fix this, because the space a screen gets depends on
   things CSS can't see: the ad banner's real height, the number of players
   or members, the phone's font-size setting, error lines coming and going.

   THE FIX
   Each screen (and each popup panel) gets a "fit level" that this file picks
   by measuring, from roomiest to tightest:

     ''                       -- the normal design, untouched
     'snug'                   -- less padding and gap
     'snug compact'           -- + hides the nice-to-have lines (.fit-optional)
     'snug compact tight'     -- + smallest spacing; buttons stay >= 44px

   The level is written to the root's data-fit attribute and style.css does
   the rest ([data-fit~="snug"] ...). Lists that can grow without limit carry
   data-fit-list="<min px>": when they are the reason a screen doesn't fit,
   they scroll inside their own box (never below that minimum) instead of
   pushing Start Game or the menu off the bottom. Whatever still doesn't fit
   at the tightest level (a tiny screen with huge fonts) falls back to the
   screen's own scroll, which was always there and still is.

   WHEN IT RUNS
   When a screen or popup opens, when its content changes (players join, a
   message arrives), when the window resizes or rotates, when the ad banner's
   reserved space changes, and once fonts have loaded. Each run is
   synchronous -- try a level, measure, try the next -- inside a microtask,
   so the browser never paints a half-fitted state.

   It never runs while the on-screen keyboard is up (an input has focus):
   squeezing the layout to the space left above a keyboard would make it
   jump while you type. It catches up when the input loses focus.

   Nothing here touches app.js state or game logic; it only reads sizes and
   sets data-fit / max-height. If this file failed to load, every screen
   would simply look and scroll exactly as it did before.
   ========================================================================== */
(function () {
  'use strict';
  if (typeof document === 'undefined' || !document.documentElement) return;

  var LEVELS = ['', 'snug', 'snug compact', 'snug compact tight'];
  var SCREEN_IDS = ['screen-landing', 'screen-lobby', 'screen-group'];
  var slice = Array.prototype.slice;

  function byId(id) { return document.getElementById(id); }

  // ---- roots: the things that must fit ------------------------------------
  function screenRoots() {
    return SCREEN_IDS.map(byId).filter(Boolean);
  }
  function overlayRoots() {
    // Dialog-style popups only. The bottom sheets (.sheet-panel) are built to
    // scroll their body and are left alone.
    return slice.call(document.querySelectorAll('.overlay > .card-panel'));
  }
  function isScreen(root) { return SCREEN_IDS.indexOf(root.id) >= 0; }
  function scrollerOf(root) {
    if (isScreen(root)) {
      for (var i = 0; i < root.children.length; i++) {
        if (root.children[i].classList.contains('landing-body')) return root.children[i];
      }
      return null;
    }
    return root; // a popup panel scrolls itself
  }
  function isShown(root) {
    if (isScreen(root)) return root.classList.contains('active');
    var ov = root.parentElement;
    return !!ov && !ov.classList.contains('hidden') && root.getClientRects().length > 0;
  }
  function rootOf(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && el !== document.body) {
      if (isScreen(el)) return el;
      if (el.classList && el.classList.contains('card-panel') &&
          el.parentElement && el.parentElement.classList.contains('overlay')) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ---- measuring ------------------------------------------------------------
  function overflow(el) { return el ? el.scrollHeight - el.clientHeight : 0; }

  function setLevel(root, i) {
    var v = LEVELS[i];
    if (v) {
      if (root.getAttribute('data-fit') !== v) root.setAttribute('data-fit', v);
    } else if (root.hasAttribute('data-fit')) {
      root.removeAttribute('data-fit');
    }
  }

  function visibleLists(root) {
    return slice.call(root.querySelectorAll('[data-fit-list]')).filter(function (l) {
      return l.getClientRects().length > 0;
    });
  }
  function uncap(lists) {
    lists.forEach(function (l) {
      if (l.style.maxHeight) l.style.maxHeight = '';
      if (l.style.overflowY) l.style.overflowY = '';
    });
  }
  // Lets each list scroll inside its own box by just enough to remove the
  // overflow, never below its data-fit-list minimum. overflow-y is set only
  // while a list is capped: an uncapped list keeps overflow visible, so the
  // report/mute popover on a lobby row is never clipped by its own list.
  function cap(lists, scroller) {
    var over = overflow(scroller);
    for (var i = 0; i < lists.length && over > 1; i++) {
      var l = lists[i];
      var min = parseFloat(l.getAttribute('data-fit-list')) || 80;
      var h = l.getBoundingClientRect().height;
      var spare = h - min;
      if (spare <= 1) continue;
      l.style.overflowY = 'auto';
      l.style.maxHeight = Math.floor(h - Math.min(spare, over)) + 'px';
      over = overflow(scroller);
    }
    return over;
  }

  // Roomiest level that fits wins. The order matters: a little less padding
  // ('snug') is nearly invisible, so it comes first; after that a long list
  // scrolling in its own box beats squeezing everything else, so lists are
  // capped before the tighter levels are tried.
  function fit(root) {
    var scroller = scrollerOf(root);
    if (!scroller || !isShown(root)) return;
    // Every list starts uncapped, hidden ones included: a cap left on the
    // Marathon list while its tab was hidden would otherwise come back with
    // a height measured for a different screen size.
    uncap(slice.call(root.querySelectorAll('[data-fit-list]')));
    var lists = visibleLists(root);
    setLevel(root, 0);
    if (overflow(scroller) <= 1) return;
    setLevel(root, 1);
    if (overflow(scroller) <= 1) return;
    if (cap(lists, scroller) <= 1) return;
    for (var lvl = 2; lvl < LEVELS.length; lvl++) {
      uncap(lists);
      setLevel(root, lvl);
      if (overflow(scroller) <= 1) return;
      if (cap(lists, scroller) <= 1) return;
    }
    // Still too tall: the scroller's own scroll is the safety net.
  }

  // ---- scheduling -------------------------------------------------------------
  var pending = [];
  var scheduled = false;
  var keyboardPending = false;

  function typing() {
    var a = document.activeElement;
    if (!a) return false;
    var tag = a.tagName;
    return tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|search|email|tel|url|number|password)?$/i.test(a.type || ''));
  }

  function flush() {
    scheduled = false;
    var roots = pending;
    pending = [];
    for (var i = 0; i < roots.length; i++) {
      try { fit(roots[i]); } catch (e) { /* layout must never break the app */ }
    }
  }
  function schedule(root) {
    if (!root || pending.indexOf(root) >= 0) return;
    pending.push(root);
    if (scheduled) return;
    scheduled = true;
    // A microtask: runs after the change that triggered it and before the
    // next paint, so nobody ever sees the unfitted frame.
    Promise.resolve().then(flush);
  }
  function fitAll() {
    screenRoots().concat(overlayRoots()).forEach(function (r) {
      if (isShown(r)) schedule(r);
    });
  }

  // ---- watching ---------------------------------------------------------------
  function watch() {
    if (typeof MutationObserver !== 'function') return;

    // A screen or popup opening (class changes on the root / the overlay).
    var opened = new MutationObserver(function (records) {
      records.forEach(function (rec) {
        var t = rec.target;
        if (isScreen(t)) { if (t.classList.contains('active')) schedule(t); return; }
        if (t.classList.contains('overlay') && !t.classList.contains('hidden')) {
          var panel = t.querySelector('.card-panel');
          if (panel && panel.parentElement === t) schedule(panel);
        }
      });
    });
    screenRoots().forEach(function (s) {
      opened.observe(s, { attributes: true, attributeFilter: ['class'] });
    });
    slice.call(document.querySelectorAll('.overlay')).forEach(function (o) {
      opened.observe(o, { attributes: true, attributeFilter: ['class'] });
    });

    // Content changing inside an open root. data-fit and inline max-height
    // are NOT watched, so this file's own writes never re-trigger it.
    var changed = new MutationObserver(function (records) {
      records.forEach(function (rec) {
        var root = rootOf(rec.target);
        if (root && isShown(root)) schedule(root);
      });
    });
    screenRoots().concat(overlayRoots()).forEach(function (r) {
      changed.observe(r, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'hidden'],
      });
    });

    // The ad banner's reserved space is a CSS variable on <html>.
    new MutationObserver(fitAll).observe(document.documentElement, {
      attributes: true, attributeFilter: ['style'],
    });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (typing()) { keyboardPending = true; return; }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitAll, 60);
  });
  document.addEventListener('focusout', function () {
    if (!keyboardPending) return;
    keyboardPending = false;
    // Give the keyboard time to finish closing before measuring.
    setTimeout(fitAll, 150);
  });

  // ---- group screen tabs ---------------------------------------------------
  // Members and Marathon share one card (see index.html). Plain DOM, no app
  // state: app.js keeps rendering both panels exactly as before; this only
  // decides which one is visible.
  function selectGroupTab(key) {
    var tabs = byId('group-tabs');
    if (!tabs) return;
    slice.call(tabs.querySelectorAll('[data-gtab]')).forEach(function (b) {
      var on = b.getAttribute('data-gtab') === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    slice.call(document.querySelectorAll('#screen-group [data-gpanel]')).forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-gpanel') !== key);
    });
  }
  function wireGroupTabs() {
    var tabs = byId('group-tabs');
    if (!tabs) return;
    tabs.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== tabs && !(t.getAttribute && t.getAttribute('data-gtab'))) t = t.parentElement;
      if (t && t !== tabs) selectGroupTab(t.getAttribute('data-gtab'));
    });
  }

  // ---- start -------------------------------------------------------------------
  function start() {
    wireGroupTabs();
    watch();
    fitAll();
    window.addEventListener('load', fitAll);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(fitAll);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // For debugging from the console, and for tests.
  window.LCLayout = { fit: fit, fitAll: fitAll, selectGroupTab: selectGroupTab, LEVELS: LEVELS };
})();
