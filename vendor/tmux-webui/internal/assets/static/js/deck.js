// deck.js — Deck Mode (Slice 2a: static grid + low-risk context detection).
//
// 100% additive. Toggles #app.deck-mode (mirrors existing #app.fullscreen-mode),
// fetches /api/deck, renders a Stream-Deck style button wall, and dispatches each
// button through the EXISTING WebSocket send paths — no new backend protocol:
//   - action.type "input" -> window.sendSkillOrAction (app.js, sends {type:'input'})
//   - action.type "key"   -> window.tmuxWs.send({type:'key', ...})
//
// Slice 2a adds context awareness for LOW-RISK states only: when the focused pane
// shows Claude Code "working", swap to an interrupt panel; otherwise show the
// static panel (graceful degrade). Detection (deck-detect.js) is read-only.
// High-risk auto-send of menu selections (permission / plan / numbered choice)
// is deliberately NOT done here.
(function () {
  'use strict';

  var DECK = { panels: [] };
  var loaded = false;
  var pollTimer = null;
  var renderedSig = null;
  var candidate = null;
  var candidateCount = 0;
  var lastStatusSig = null;
  var lastRailSig = null;

  // ---- persistent chrome (status strip + session rail) -----------------------
  // The chrome (live token/cost/context/mode badges + window pills) sits ABOVE the
  // swappable panel area so it stays put while poll() swaps panels underneath.
  // mountLayout builds it once; updateChrome refreshes values each tick (sig-gated,
  // so unchanged frames cost nothing and the :active feel on a pill isn't clobbered).
  function mountLayout() {
    var root = document.getElementById('deck-root');
    if (!root || document.getElementById('deck-panels')) return; // already mounted
    root.innerHTML = '';
    var chrome = document.createElement('div');
    chrome.id = 'deck-chrome';
    var strip = document.createElement('div');
    strip.id = 'deck-status-strip';
    strip.style.display = 'none';
    var rail = document.createElement('div');
    rail.id = 'deck-rail';
    rail.style.display = 'none';
    var widgets = document.createElement('div'); // S2 interactive widgets: scrollback scrub + permission mode pills
    widgets.id = 'deck-widgets';
    var dialZone = document.createElement('div');
    dialZone.id = 'deck-dial-zone';
    var sliderZone = document.createElement('div');
    sliderZone.id = 'deck-slider-zone';
    widgets.appendChild(dialZone);
    widgets.appendChild(sliderZone);
    chrome.appendChild(strip);
    chrome.appendChild(rail);
    chrome.appendChild(widgets);
    var panels = document.createElement('div');
    panels.id = 'deck-panels';
    root.appendChild(chrome);
    root.appendChild(panels);
    // mount the interactive widgets once (they manage their own pointer capture)
    var dd = window.deckDetect;
    if (window.deckDial) window.deckDial.render(dialZone);
    if (window.deckSlider) window.deckSlider.render(sliderZone, dd && dd.detectPermMode ? dd.detectPermMode(dd.focusedPaneText()) : null);
  }

  function panelsRoot() { return document.getElementById('deck-panels'); }

  function badge(cls, icon, value) {
    var b = document.createElement('span');
    b.className = 'deck-badge ' + cls;
    var i = document.createElement('span');
    i.className = 'deck-badge-ico'; i.textContent = icon;
    var v = document.createElement('span');
    v.className = 'deck-badge-val'; v.textContent = value;
    b.appendChild(i); b.appendChild(v);
    return b;
  }

  var MODE_LABEL = { plan: 'PLAN', accept: 'ACCEPT EDITS', auto: 'AUTO', bypass: 'BYPASS' };

  // updateChrome refreshes the status badges + session rail from the focused pane.
  // Both are sig-gated so a steady screen does no DOM work.
  function updateChrome(text) {
    var dd = window.deckDetect;
    var st = dd && dd.detectStatus ? dd.detectStatus(text) : null;
    var ssig = st ? [st.model, st.cost, st.context, st.tokens, st.mode].join('|') : 'none';
    if (ssig !== lastStatusSig) {
      lastStatusSig = ssig;
      var strip = document.getElementById('deck-status-strip');
      if (strip) {
        strip.innerHTML = '';
        if (st) {
          if (st.model)   strip.appendChild(badge('m-model', '🤖', st.model));
          if (st.context) strip.appendChild(badge('m-ctx', '✍️', st.context));
          if (st.cost)    strip.appendChild(badge('m-cost', '💰', '$' + st.cost));
          if (st.mode)    strip.appendChild(badge('m-mode mode-' + st.mode, '⏵', MODE_LABEL[st.mode] || st.mode));
        }
        strip.style.display = strip.children.length ? '' : 'none';
      }
    }
    var rail = document.getElementById('deck-rail');
    if (rail && window.deckRail) {
      var rsig = window.deckRail.sig();
      if (rsig !== lastRailSig) { lastRailSig = rsig; window.deckRail.render(rail); }
    }
  }

  function staticPanels() {
    return (DECK.panels || []).filter(function (p) { return p && p.source === 'static'; });
  }

  // working -> dynamic panels whose when === state; otherwise static (degrade).
  function panelsForState(state) {
    var dyn = (DECK.panels || []).filter(function (p) {
      return p && p.source === 'dynamic' && p.when === state;
    });
    return dyn.length ? dyn : staticPanels();
  }

  // send() performs the actual WS dispatch for a button's action (no confirmation).
  function send(btn) {
    var a = btn.action || {};
    if (a.type === 'input') {
      // Reuses connection + focusedPane guards and trailing-space convention.
      window.sendSkillOrAction(a.payload);
    } else if (a.type === 'key') {
      if (!window.tmuxWs || !window.tmuxWs.isConnected() || !window.tmuxState ||
          !window.tmuxState.focusedPane) return;
      window.tmuxWs.send({ type: 'key', pane: window.tmuxState.focusedPane, key: a.payload });
    } else if (a.type === 'macro') {
      runMacro(a.steps, a.delays);
    }
  }

  // runMacro plays a sequence of atomic steps ({type:'input'|'key', payload}) with
  // an inter-step delay, re-checking the connection + focused pane BEFORE each step
  // and aborting LOUD (no remaining steps) on failure — a half-sent /model stuck in
  // a menu is worse than nothing. Macro input is sent raw (not via sendSkillOrAction,
  // whose trailing-space branch would fill-not-send); Enter is its own 'key' step.
  function runMacro(steps, delays) {
    if (!Array.isArray(steps) || !steps.length) return;
    var inter = (delays && typeof delays.inter === 'number') ? delays.inter : 350;
    var i = 0;
    function ok() {
      return window.tmuxWs && window.tmuxWs.isConnected() && window.tmuxState && window.tmuxState.focusedPane;
    }
    function step() {
      if (i >= steps.length) return;
      if (!ok()) { console.warn('[deck] macro aborted at step ' + i + ' — disconnected / no focused pane'); return; }
      var s = steps[i++] || {};
      var pane = window.tmuxState.focusedPane;
      if (s.type === 'input') window.tmuxWs.send({ type: 'input', pane: pane, text: s.payload });
      else if (s.type === 'key') window.tmuxWs.send({ type: 'key', pane: pane, key: s.payload });
      else { console.warn('[deck] macro: unknown step type ' + s.type); return; }
      if (i < steps.length) setTimeout(step, inter);
    }
    step();
  }
  window.runMacro = runMacro;

  // feedback() is the tactile "sent" confirm (deck redesign B): a visual ripple
  // (.is-sent flash, removed after 350ms) + a short haptic buzz. Remote control —
  // the effect lands on the Mac, so the iPad button must SAY "sent" or the user
  // re-taps (community research: missing feedback → repeat taps on remote controls).
  function feedback(el) {
    if (!el) return;
    el.classList.remove('is-sent');
    void el.offsetWidth; // reflow so a rapid re-tap restarts the animation
    el.classList.add('is-sent');
    setTimeout(function () { el.classList.remove('is-sent'); }, 350);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
  }

  // setButtonsEnabled toggles data-disabled on rendered buttons (B state-driven):
  // a tap can't be delivered when the WS is down, so the deck dims + blocks them.
  function setButtonsEnabled(connected) {
    var root = panelsRoot();
    if (!root) return;
    var btns = root.querySelectorAll('.deck-btn');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('data-disabled', connected ? '' : '1');
  }

  // dispatch() gates send() by the button's confirm mode:
  //   "slide" -> slide-to-confirm overlay (irreversible actions, the drag is the gate)
  //   true    -> native confirm (back-compat)
  //   omitted -> send immediately
  // Feedback fires on the REAL send (slide-commit included), not the tap.
  function dispatch(btn, el) {
    var run = function () { send(btn); feedback(el); };
    if (btn.confirm === 'slide' && window.deckConfirm) {
      window.deckConfirm.show(btn.label, run);
    } else if (btn.confirm) {
      if (window.confirm('Run "' + (btn.label || '') + '" ?')) run();
    } else {
      run();
    }
  }

  function makeButton(btn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'deck-btn';
    if (btn.color) b.setAttribute('data-color', btn.color);
    if (btn.title) b.title = btn.title;
    if (btn.icon) {
      var ico = document.createElement('span');
      ico.className = 'deck-ico';
      ico.textContent = btn.icon;
      b.appendChild(ico);
    }
    var lbl = document.createElement('span');
    lbl.className = 'deck-lbl';
    lbl.textContent = btn.label || '';
    b.appendChild(lbl);
    b.addEventListener('click', function () { dispatch(btn, b); });
    return b;
  }

  function renderPanels(panels) {
    var root = panelsRoot();
    if (!root) return;
    root.innerHTML = '';
    if (!panels.length) {
      var empty = document.createElement('div');
      empty.className = 'deck-panel-title';
      empty.textContent = 'No deck panels configured';
      root.appendChild(empty);
      return;
    }
    panels.forEach(function (panel) {
      if (panel.title) {
        var h = document.createElement('div');
        h.className = 'deck-panel-title';
        h.textContent = panel.title;
        root.appendChild(h);
      }
      var grid = document.createElement('div');
      grid.className = 'deck-grid';
      (panel.buttons || []).forEach(function (btn) { grid.appendChild(makeButton(btn)); });
      root.appendChild(grid);
    });
  }

  function renderForState(state) {
    renderPanels(panelsForState(state));
  }

  // renderContextMenu shows parsed menu options as labeled buttons. Each goes
  // through slide-to-confirm and sends the option NUMBER (CC supports number
  // hotkeys). The label text is shown verbatim so you can decide on the iPad
  // without looking at the Mac.
  function renderContextMenu(menu) {
    var root = panelsRoot();
    if (!root) return;
    root.innerHTML = '';
    var h = document.createElement('div');
    h.className = 'deck-panel-title';
    h.textContent = menu.title || 'Claude 在問你';
    root.appendChild(h);
    (menu.options || []).forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'deck-ctx-btn';
      var num = document.createElement('span');
      num.className = 'deck-ctx-num';
      num.textContent = String(opt.n);
      var lbl = document.createElement('span');
      lbl.className = 'deck-ctx-lbl';
      lbl.textContent = opt.label;
      b.appendChild(num);
      b.appendChild(lbl);
      b.addEventListener('click', function () {
        var run = function () { window.sendSkillOrAction(String(opt.n)); };
        if (window.deckConfirm) window.deckConfirm.show(opt.n + '. ' + opt.label, run);
        else run();
      });
      root.appendChild(b);
    });
  }

  // Hysteresis: a new signature must persist 2 consecutive polls before it swaps
  // the panel, avoiding flicker while the TUI is mid-render. A real menu (option
  // parsing) takes priority over working/idle state. Detection is read-only;
  // the actual send still passes through slide-to-confirm.
  function poll() {
    var dd = window.deckDetect;
    if (!dd) return;
    var text = dd.focusedPaneText ? dd.focusedPaneText() : '';
    updateChrome(text); // persistent badges + rail (sig-gated, independent of panel swap)
    if (window.deckRail && window.deckRail.pollAgents) window.deckRail.pollAgents(); // U3: cross-session pill tint (shares this tick — no second timer)
    if (window.deckSlider && dd.detectPermMode) window.deckSlider.setMode(dd.detectPermMode(text)); // authoritative mode read-back (slider ignores while dragging)
    setButtonsEnabled(window.tmuxWs && window.tmuxWs.isConnected()); // B: dim buttons when not connected (can't send)
    var menu = dd.detectMenu ? dd.detectMenu(text) : null;
    var sig, doRender;
    if (menu) {
      sig = 'menu:' + menu.options.map(function (o) { return o.n + o.label; }).join('|');
      doRender = function () { renderContextMenu(menu); };
    } else {
      var state = dd.detectState ? dd.detectState(text) : 'unknown';
      sig = 'state:' + state;
      doRender = function () { renderForState(state); };
    }
    if (sig === renderedSig) { candidate = null; candidateCount = 0; return; }
    if (sig === candidate) {
      candidateCount++;
      if (candidateCount >= 2) {
        candidate = null; candidateCount = 0;
        renderedSig = sig;
        doRender();
      }
    } else {
      candidate = sig;
      candidateCount = 1;
    }
  }

  function startPoll() {
    renderedSig = null;
    lastStatusSig = null; lastRailSig = null;
    mountLayout();                 // build persistent chrome + panel container once
    renderForState('unknown');     // immediate baseline = static panel
    if (window.deckDetect) updateChrome(window.deckDetect.focusedPaneText()); // first paint
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, 600);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    candidate = null; candidateCount = 0;
    lastStatusSig = null; lastRailSig = null;
  }

  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    // basePath handles the nginx /apps/tmux/ prefix (mirrors app.js / autocomplete.js);
    // it is empty when served at root (direct :10105), so both paths resolve correctly.
    var basePath = location.pathname.replace(/\/+$/, '') || '';
    return fetch(basePath + '/api/deck')
      .then(function (r) { return r.ok ? r.json() : { panels: [] }; })
      .then(function (cfg) { DECK = cfg || { panels: [] }; loaded = true; })
      .catch(function () { DECK = { panels: [] }; loaded = true; });
  }

  // updateRailStates colours the rail's window pills from a pane_states WS frame
  // (per-window enum pushed by the backend). Registered as window.__deckPaneStates
  // so app.js's onmessage can hand frames over without knowing deck internals.
  // Pills are updated in place (no rebuild) so the :active tap feel isn't clobbered.
  function updateRailStates(states, panes) {
    if (window.deckAgent && window.deckAgent.onPaneStates) window.deckAgent.onPaneStates(states, panes); // agent deck lights + strip + waiting badge
    var rail = document.getElementById('deck-rail');
    if (!rail || !window.deckRail || !window.deckRail.applyStates) return; // deck not mounted → ignore
    window.deckRail.applyStates(rail, states || {});
  }
  window.__deckPaneStates = updateRailStates;

  // setMode applies one of the deck modes ('' = off, 'deck-dock' = split/co-exist,
  // 'deck-mode' = fullscreen). Both mode classes are mutually exclusive.
  function setMode(mode) {
    var app = document.getElementById('app');
    if (!app) return;
    if (window.deckAgent && window.deckAgent.active && window.deckAgent.active()) window.deckAgent.stop();
    app.classList.remove('deck-dock', 'deck-mode');
    var t = document.getElementById('deck-toggle');
    if (!mode) { if (t) t.classList.remove('active'); stopPoll(); return; }
    if (mode === 'deck-dock') {
      // pin the landscape dock rail BELOW the header so it never covers the toggle
      // (otherwise dock mode is inescapable — the rail eats the toggle click).
      var header = document.querySelector('header');
      if (header) app.style.setProperty('--deck-header-h', header.offsetHeight + 'px');
    }
    app.classList.add(mode);
    if (t) t.classList.add('active');
    if (window.deckAgent) {
      // Agent Deck renders BOTH modes: fullscreen device frame (deck-mode) and
      // the compact dock column (deck-dock). The legacy chrome/panels renderer
      // below survives only as a fallback when deck-agent.js is absent.
      stopPoll();
      ensureLoaded().then(function () {
        window.deckAgent.start(document.getElementById('deck-root'), DECK,
          { compact: mode === 'deck-dock' });
      });
      return;
    }
    ensureLoaded().then(function () { startPoll(); });
  }
  window.deckSetMode = setMode; // agent deck's dock/close buttons route back through here

  // Two-state toggle: off ↔ dock. Dock keeps the terminal visible (the point of
  // the side rail), so it's the single open/close state. Fullscreen (#app.deck-mode,
  // the v1 wall-of-buttons) stays available via setMode but is off the main toggle —
  // one tap opens dock, one tap closes, no cycling-through-fullscreen to exit.
  function toggle() {
    var app = document.getElementById('app');
    if (!app) return;
    if (app.classList.contains('deck-dock') || app.classList.contains('deck-mode')) setMode('');
    else setMode('deck-dock');
  }

  function init() {
    var t = document.getElementById('deck-toggle');
    if (t) t.addEventListener('click', toggle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
