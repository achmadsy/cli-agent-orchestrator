// deck-rail.js — Session + Window Rail (v2 wave1).
//
// Two stacked strips of pills at the top of the deck so you can navigate tmux
// from the iPad without the (deck-hidden) chrome:
//   • session row — switch which tmux session this client views. In tmux-webui a
//     session IS a WebSocket connection, so switching = disconnect()+connect(name)
//     (exactly what the session <select> does). Shown only when >=2 sessions exist.
//   • window row  — switch window within the current session via the existing
//     switch_window WS message.
// Both lists are read from tmuxState (app.js exposes .sessions / .windows). Render
// is read-only; the only side effects are the connect / switch_window the user taps.
(function () {
  'use strict';

  // U3 cross-session awareness: sessionStates maps a session name to the WORST
  // state of any agent pane in it (from GET /api/agents, the all-sessions
  // snapshot the Monitor maintains) so the session rail marks which OTHER
  // project's agent needs you WITHOUT connecting to it. The connected session's
  // WINDOW pills are still coloured by the live pane_states WS frame (applyStates);
  // this adds the coarser per-SESSION tint on top. Filled by pollAgents() off the
  // existing deck tick — no second timer.
  var sessionStates = {};   // { sessionName: 'working'|'waiting'|'idle' } (absent = neutral)
  var lastAgentSig = null;  // skip re-tinting on unchanged snapshots
  // I5 per-pane context/token burn, keyed session+"\x00"+paneID from the same
  // /api/agents snapshot U3 already polls (no second fetch). deck-agent's grid
  // reads it to show a per-key % badge. Refreshed every poll (before the
  // state-sig short-circuit) so a pct-only change still lands.
  var agentIndex = {};      // { "session\x00paneID": {pct, used, max, window} }
  // I3 per-pane state timeline, keyed the same way from the same /api/agents
  // snapshot (no extra fetch). Carries the pane's current state, the unix second
  // it entered it (sinceUnix, for the live "waiting 4m12s"), and its recent[]
  // transition ring (for the working/waiting/idle mini split). deck-agent reads it.
  var timelineIndex = {};   // { "session\x00paneID": {state, sinceUnix, recent[]} }
  // I4 replay: the raw agent list from the last /api/agents poll (same snapshot,
  // no extra fetch). The replay picker reads it to list recordable agent panes
  // with their REAL tmux paneID (%N) — the unambiguous id the record/frames API
  // resolves on (pane INDEX collides across windows; paneID does not).
  var lastAgents = [];      // [{session, paneID, window, windowName, pane, state}]

  // agentsToSessionState reduces the /api/agents list to one worst-state per
  // session (waiting > working > idle). unknown / absent states never contribute,
  // so a session with only unknown agents stays neutral (no entry). PURE — the
  // hard-gate unit test (deck-rail-agents.test.js) exercises this directly.
  // pure helper for tests
  function agentsToSessionState(agents) {
    var RANK = { idle: 1, working: 2, waiting: 3 };
    var out = {};
    if (!Array.isArray(agents)) return out;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a || !a.session) continue;
      var r = RANK[a.state];
      if (!r) continue; // ignore unknown / missing — only real states tint
      var cur = out[a.session];
      if (!cur || r > RANK[cur]) out[a.session] = a.state;
    }
    return out;
  }

  // agentsToPaneIndex reduces the /api/agents list to a per-pane context index
  // keyed "session\x00paneID". Only entries carrying real token/percent burn
  // (contextPct > 0 or tokensMax > 0) are kept, so a pane without a status line
  // is simply absent (the deck badge stays blank, never "0%"). PURE — the
  // deck-rail-context.test.js hard-gates this directly.
  // pure helper for tests
  function agentsToPaneIndex(agents) {
    var out = {};
    if (!Array.isArray(agents)) return out;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a || !a.session || !a.paneID) continue;
      var pct = +a.contextPct || 0;
      var max = +a.tokensMax || 0;
      if (pct <= 0 && max <= 0) continue; // no real burn → leave blank
      out[a.session + '\x00' + a.paneID] = {
        pct: pct, used: +a.tokensUsed || 0, max: max,
        window: (a.window == null ? null : +a.window)
      };
    }
    return out;
  }

  // agentsToTimelineIndex reduces the /api/agents list to a per-pane timeline
  // index keyed "session\x00paneID": the pane's current state, the unix second it
  // entered it (sinceUnix), and its bounded recent[] transition ring. Only
  // classified agent panes (a real, non-empty state) are kept; entries missing
  // session/paneID are dropped. PURE — deck-rail-timeline.test.js hard-gates it.
  // pure helper for tests
  function agentsToTimelineIndex(agents) {
    var out = {};
    if (!Array.isArray(agents)) return out;
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a || !a.session || !a.paneID || !a.state) continue;
      out[a.session + '\x00' + a.paneID] = {
        state: a.state,
        sinceUnix: +a.sinceUnix || 0,
        recent: Array.isArray(a.recent) ? a.recent : []
      };
    }
    return out;
  }

  // stateSig — order-independent signature of a {session: state} map so pollAgents
  // only touches the DOM when the worst-state picture actually changed.
  function stateSig(map) {
    return Object.keys(map).sort().map(function (k) { return k + ':' + map[k]; }).join('|');
  }

  // applySessionStates tints each session pill in place from sessionStates,
  // reusing the same st-working/st-waiting/st-idle vocabulary the window pills use
  // (deck.css targets .deck-rail-pill.st-*). In-place (no rebuild) so an
  // in-progress tap isn't clobbered. Neutral (no st-* class) when the session has
  // no agents.
  function applySessionStates(container) {
    if (!container) return;
    var pills = container.querySelectorAll('.deck-rail-session');
    for (var i = 0; i < pills.length; i++) {
      var name = pills[i].getAttribute('data-session');
      var st = sessionStates[name];
      pills[i].classList.remove('st-working', 'st-waiting', 'st-idle');
      if (st) pills[i].classList.add('st-' + st);
    }
  }

  // pollAgents fetches the cross-session snapshot and re-tints session pills when
  // it changes. Called from the EXISTING 600ms deck tick (deck.js poll()), never
  // its own timer. Same-origin fetch carries the tw_token cookie already; basePath
  // handles the nginx /apps/tmux/ prefix (mirrors deck.js / app.js). Returns the
  // promise so callers/tests can await it; failures are swallowed (a missing
  // snapshot just leaves pills neutral).
  function pollAgents() {
    var base = (typeof location !== 'undefined' && location.pathname
      ? location.pathname.replace(/\/+$/, '') : '') || '';
    return fetch(base + '/api/agents')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        // Always refresh the per-pane burn index — a %-only change (state
        // unchanged) must still reach the deck grid, so this is before the
        // state-sig short-circuit below.
        agentIndex = agentsToPaneIndex(data && data.agents);
        timelineIndex = agentsToTimelineIndex(data && data.agents);
        lastAgents = (data && Array.isArray(data.agents)) ? data.agents : [];
        var next = agentsToSessionState(data && data.agents);
        var sig = stateSig(next);
        if (sig === lastAgentSig) return;
        lastAgentSig = sig;
        sessionStates = next;
        applySessionStates(document.getElementById('deck-rail'));
      })
      .catch(function () { /* snapshot unavailable → keep last tint */ });
  }

  // railSig() — cheap content signature so the caller skips a rebuild when nothing
  // changed (avoids clobbering the :active feel on a pill mid-tap).
  function railSig() {
    var S = window.tmuxState;
    if (!S) return 'none';
    var sess = (S.sessions || []).map(function (s) {
      return s.name + ',' + (s.windows || 0) + ',' + (s.attached ? 1 : 0);
    }).join('|');
    var wins = (S.windows || []).map(function (w) {
      return w.index + ',' + w.name + ',' + (w.panes || 1);
    }).join('|');
    return (S.currentSession || '') + '#' + sess + '##' + S.activeWindowIdx + '#' + wins;
  }

  function switchSession(name) {
    var S = window.tmuxState;
    if (!S || name === S.currentSession) return; // already connected here
    var sel = document.getElementById('sessions');
    if (sel) sel.value = name;                   // keep the hidden <select> in sync
    if (window.tmuxWs) {
      if (window.tmuxWs.isConnected()) window.tmuxWs.disconnect();
      window.tmuxWs.connect(name);
    }
  }

  function sessionPill(s) {
    var active = s.name === window.tmuxState.currentSession;
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'deck-rail-pill deck-rail-session' + (active ? ' active' : '');
    pill.setAttribute('data-session', s.name); // pollAgents()/applySessionStates() tint in place
    var ast = sessionStates[s.name];           // seed the cross-session tint on (re)build
    if (ast) pill.classList.add('st-' + ast);
    pill.title = s.name + ' (' + (s.windows || 0) + ' windows' + (s.attached ? ', attached' : '') + ')';

    var ico = document.createElement('span');
    ico.className = 'deck-rail-sico';
    ico.textContent = '⊞'; // ⊞
    pill.appendChild(ico);

    var nm = document.createElement('span');
    nm.className = 'deck-rail-name';
    nm.textContent = s.name;
    pill.appendChild(nm);

    if (s.windows) {
      var c = document.createElement('span');
      c.className = 'deck-rail-panes';
      c.textContent = s.windows + 'w';
      pill.appendChild(c);
    }
    if (s.attached) {
      var dot = document.createElement('span');
      dot.className = 'deck-rail-attached';
      dot.title = 'attached in a real terminal';
      pill.appendChild(dot);
    }
    pill.addEventListener('click', function () { switchSession(s.name); });
    return pill;
  }

  function windowPill(w) {
    var S = window.tmuxState;
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'deck-rail-pill' + (w.index === S.activeWindowIdx ? ' active' : '');
    pill.setAttribute('data-window', w.index); // applyStates() colours pills in place by window index
    pill.title = w.index + ': ' + (w.name || '') + ' (' + (w.panes || 1) + ' panes)';

    var idx = document.createElement('span');
    idx.className = 'deck-rail-idx';
    idx.textContent = w.index;
    pill.appendChild(idx);

    var nm = document.createElement('span');
    nm.className = 'deck-rail-name';
    nm.textContent = w.name || '';
    pill.appendChild(nm);

    if (w.panes > 1) {
      var p = document.createElement('span');
      p.className = 'deck-rail-panes';
      p.textContent = w.panes;
      pill.appendChild(p);
    }
    pill.addEventListener('click', function () {
      if (w.index === window.tmuxState.activeWindowIdx) return; // already here
      if (window.tmuxWs && window.tmuxWs.isConnected()) {
        window.tmuxWs.send({ type: 'switch_window', window: w.index });
        if (window.linkBroadcast) window.linkBroadcast({ window: w.index });
      }
    });
    return pill;
  }

  function makeRow(cls, items, makePill) {
    var row = document.createElement('div');
    row.className = 'deck-rail-row ' + cls;
    items.forEach(function (it) { row.appendChild(makePill(it)); });
    return row;
  }

  function render(container) {
    var S = window.tmuxState;
    container.innerHTML = '';
    var sessions = (S && S.sessions) || [];
    var wins = (S && S.windows) || [];
    if (sessions.length < 2 && wins.length === 0) { container.style.display = 'none'; return; }
    container.style.display = '';
    // session row only when there's a real choice (>=2 sessions)
    if (sessions.length >= 2) container.appendChild(makeRow('sessions', sessions, sessionPill));
    if (wins.length) container.appendChild(makeRow('windows', wins, windowPill));
  }

  // applyStates colours each window pill in place from a per-window state map
  // { windowIndex: "working"|"waiting"|"idle"|"unknown" }. Called every poll tick
  // by deck.js (via __deckPaneStates); it only swaps st-* classes — no rebuild — so
  // an in-progress tap isn't clobbered. Replaces the old separate status-lights row,
  // folding pane status into the rail the user already reads for window names.
  function applyStates(container, winStates) {
    if (!container) return;
    var pills = container.querySelectorAll('.deck-rail-pill[data-window]');
    for (var i = 0; i < pills.length; i++) {
      var idx = pills[i].getAttribute('data-window');
      var st = (winStates && winStates[idx]) || 'unknown';
      pills[i].classList.remove('st-working', 'st-waiting', 'st-idle', 'st-unknown');
      pills[i].classList.add('st-' + st);
    }
  }

  window.deckRail = {
    sig: railSig, render: render, applyStates: applyStates,
    // U3 cross-session tint (pollAgents shares the deck tick; agentsToSessionState
    // is the pure reducer under test; sessionState() lets other surfaces — e.g. I5's
    // deck-agent grid — read the same worst-per-session map without re-fetching).
    agentsToSessionState: agentsToSessionState,
    pollAgents: pollAgents,
    applySessionStates: applySessionStates,
    sessionState: function (name) { return name ? sessionStates[name] : sessionStates; },
    // I5: per-pane context/token burn from the same snapshot (deck-agent grid
    // reads these to badge each key). agentsToPaneIndex is the pure reducer
    // under test; agentContext correlates by session+paneID; agentWindowContext
    // returns the worst (highest-%) pane in a window.
    agentsToPaneIndex: agentsToPaneIndex,
    agentContext: function (session, paneID) {
      if (!session || !paneID) return null;
      return agentIndex[session + '\x00' + paneID] || null;
    },
    agentWindowContext: function (session, winIdx) {
      if (!session || winIdx == null) return null;
      var w = +winIdx, best = null, k;
      for (k in agentIndex) {
        if (k.indexOf(session + '\x00') !== 0) continue;
        var e = agentIndex[k];
        if (e.window !== w) continue;
        if (!best || e.pct > best.pct) best = e;
      }
      return best;
    },
    // I3: per-pane state timeline from the same snapshot (deck-agent reads it for
    // the live "waiting Xm" + mini split). agentsToTimelineIndex is the pure
    // reducer under test; agentTimeline correlates by session+paneID.
    agentsToTimelineIndex: agentsToTimelineIndex,
    agentTimeline: function (session, paneID) {
      if (!session || !paneID) return null;
      return timelineIndex[session + '\x00' + paneID] || null;
    },
    // I4 replay: the raw agent list from the last poll (deck-agent's replay
    // picker lists recordable panes from this — each carries the real paneID).
    agents: function () { return lastAgents; }
  };
})();
