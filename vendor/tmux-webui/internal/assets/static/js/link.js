/**
 * link.js — Link Mode ("party") client logic.
 * Wire protocol + full slice roadmap: docs/link-spec.md.
 *
 * Current scope: Slice 1 (window follow) + Slice 2 (session follow via
 * disconnect/reconnect, pane follow via focusPaneCrossWindow, input
 * follow-lock) + Slice 3 (party panel: create/join, code+URL+QR, member
 * list, leader-only-drive toggle).
 *
 * window.linkBroadcast() is the ONLY emit path, window.applyLinkState() is
 * the ONLY apply path — every call site (app.js, deck-rail.js) funnels
 * through these two functions so the LWW/self-echo guards live in one place.
 */
(function () {
  'use strict';

  const S = window.tmuxState;

  // ── Identity / persistence ──────────────────────────────────────────────

  function loadClientId() {
    try {
      let id = localStorage.getItem('tmux-webui-client-id');
      if (!id) { id = crypto.randomUUID(); localStorage.setItem('tmux-webui-client-id', id); }
      return id;
    } catch (e) { return crypto.randomUUID(); } // localStorage unavailable — id won't survive reload
  }

  function loadGroup() {
    try { return localStorage.getItem('tmux-webui-party') || ''; } catch (e) { return ''; }
  }

  // Platform sniff + random 2-digit suffix, persisted so it's stable across
  // reloads (spec §3). Generated once per browser profile, not per party.
  function deviceName() {
    try {
      const saved = localStorage.getItem('tmux-webui-device-name');
      if (saved) return saved;
    } catch (e) {}
    const ua = navigator.userAgent || '';
    let base = 'Device';
    if (/iPad/.test(ua)) base = 'iPad';
    else if (/iPhone/.test(ua)) base = 'iPhone';
    else if (/Android/.test(ua)) base = 'Android';
    else if (/Macintosh/.test(ua)) base = 'Mac';
    else if (/Windows/.test(ua)) base = 'PC';
    const suffix = String(Math.floor(Math.random() * 100)).padStart(2, '0');
    const name = `${base}-${suffix}`;
    try { localStorage.setItem('tmux-webui-device-name', name); } catch (e) {}
    return name;
  }

  // A-Z2-9: drops 0/1, the two digits most often misread against O/I when a
  // code is read aloud or typed from a photo (spec §3). Uint8-mod-34 has a
  // slight bias (256 % 34 != 0) — fine for a 4-char lobby code, not a secret.
  const PARTY_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';
  function mintPartyCode() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < 4; i++) code += PARTY_CODE_ALPHABET[bytes[i] % PARTY_CODE_ALPHABET.length];
    return code;
  }

  // Read the LAN-mode access token from the (deliberately non-httponly)
  // tw_token cookie. Empty on a tokenless localhost bind — then joinURL stays
  // byte-identical to the no-auth path.
  function readToken() {
    const m = document.cookie.match(/(?:^|;\s*)tw_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function joinURL(code) {
    const basePath = location.pathname.replace(/\/+$/, '') || '';
    const token = readToken();
    // Token goes in the URL FRAGMENT, not a ?query — the browser never sends a
    // fragment to the server, so a link pasted into a chat app can't leak the
    // token to link-preview unfurlers (SEC1). The server's tokenGate bootstrap
    // reads #token= client-side.
    const tokenFrag = token ? `#token=${encodeURIComponent(token)}` : '';
    return `${location.origin}${basePath}/?party=${code}${tokenFrag}`;
  }

  S.clientId = loadClientId();
  S.linkGroup = loadGroup();
  // Auto-rejoin (spec §3): a persisted party code means this device already
  // opted in before the reload — "defaults OFF" (spec §0) governs a browser
  // that has NEVER joined a party, not a resume. linkLeave() clears the
  // stored code, so a fresh browser (no code) still lands OFF here.
  S.linkOn = !!S.linkGroup;
  S.linkSeq = 0;
  S.linkApplying = false;
  S.linkMembers = [];
  S.linkLeader = '';
  S.linkLeaderOnly = false;
  S.linkApplyCount = 0; // observable counter for the Slice-1 E2E no-self-bounce assertion (spec §4)
  S.linkPendingState = null; // Slice 2: link_state whose window/pane is deferred until the followed session's first frame

  let linkApplyTimer = null;
  let linkApplyPending = false;

  // ── Input follow-lock (spec §3 Slice 2) ─────────────────────────────────
  // #app.following disables the composer/qbtns/extra-keys while a remote view
  // is being applied (CSS pointer-events + dim). pendingFocusPane (set in
  // app.js focusPaneCrossWindow) also arms it so a mid-switch keystroke can't
  // land on the wrong pane during a cross-window latch.
  function updateFollowLock() {
    const appEl = document.getElementById('app');
    if (appEl) appEl.classList.toggle('following', !!(S.linkApplying || S.pendingFocusPane));
  }
  window.updateFollowLock = updateFollowLock;

  function clearApplying() {
    clearTimeout(linkApplyTimer);
    linkApplyTimer = null;
    linkApplyPending = false;
    S.linkApplying = false;
    S.linkPendingState = null;
    updateFollowLock();
  }

  // ── Emit — the ONLY emit path (spec §3) ─────────────────────────────────
  window.linkBroadcast = function (partial) {
    partial = partial || {};
    if (!S.linkOn || S.linkApplying) return; // opt-in guard + don't re-emit a link-driven change
    if (!window.tmuxWs || !window.tmuxWs.isConnected()) return;
    S.linkSeq += 1;
    window.tmuxWs.send({
      type: 'link_update',
      client_id: S.clientId,
      seq: S.linkSeq,
      session: partial.session !== undefined ? partial.session : S.currentSession,
      window: partial.window !== undefined ? partial.window : S.activeWindowIdx,
      pane: partial.pane !== undefined ? partial.pane : (S.focusedPane || ''),
    });
  };

  // Apply the window/pane portion of a link_state onto the CURRENT session.
  // Returns true when a switch_window was issued and we must wait for the next
  // panes frame before clearing linkApplying.
  function applyWindowPane(st) {
    const havePane = typeof st.pane === 'string' && st.pane !== '';
    if (havePane) {
      // Pane follow. focusPaneCrossWindow does a plain setFocus when the pane
      // is already rendered, else switch_window + latch (renderPanes focuses it
      // on the next frame). It NEVER bare-setFocuses an unrendered pane — the
      // war-game S7 focus-ghost guard lives inside it (spec §3 Slice 2).
      const rendered = !!S.paneEls[st.pane];
      window.focusPaneCrossWindow?.(st.window, st.pane);
      return !rendered;
    }
    if (typeof st.window === 'number' && st.window !== S.activeWindowIdx) {
      window.tmuxWs?.send({ type: 'switch_window', window: st.window });
      return true;
    }
    return false;
  }

  // ── Apply — the ONLY apply path (spec §3) ───────────────────────────────
  window.applyLinkState = function (st) {
    if (!st) return;
    // A party's shared view is only meaningful once a member has broadcast one
    // (seq > 0). A fresh party's catch-up snapshot carries seq 0 with zero-value
    // window/pane; applying it would yank every joiner to window 0 (a phantom
    // window under tmux base-index 1). Membership refreshes after a real update
    // still carry seq > 0, so late joiners converge correctly.
    if (!st.seq) return;
    // Advance our client-monotonic seq past the group's so our NEXT broadcast
    // clears the server's strict `seq > group.seq` LWW gate. Without this a
    // follower's independent counter (also starting low) collides with the
    // driver's last seq and the server silently drops the follower's update —
    // breaking symmetric follow (spec §4 Slice-1: B's switch must drive A too).
    if (st.seq > S.linkSeq) S.linkSeq = st.seq;
    S.linkApplying = true;
    S.linkApplyCount += 1;
    updateFollowLock();

    // Session follow (spec §3 Slice 2, war-game S4): the followed pane ids are
    // relative to the OTHER session's server conn. Disconnect + reconnect first
    // (mirror the session-dropdown row click), then defer window/pane until the
    // new session's first panes frame (linkOnPanesFrame). Applying window/pane
    // now would target a dead conn.
    if (st.session && st.session !== S.currentSession) {
      S.linkPendingState = st;
      clearTimeout(linkApplyTimer);
      linkApplyPending = true;
      linkApplyTimer = setTimeout(clearApplying, 4000); // reconnect is slower than a same-session switch
      window.linkFollowSession?.(st.session);
      return;
    }

    const waited = applyWindowPane(st);
    clearTimeout(linkApplyTimer);
    if (!waited) { clearApplying(); return; }
    linkApplyPending = true;
    linkApplyTimer = setTimeout(clearApplying, 1500); // safety fallback if the panes frame never lands
  };

  // Hook app.js's renderPanes calls once a link-driven switch materializes,
  // instead of always waiting out the full fallback timeout. On the first frame
  // after a session-follow reconnect the deferred window/pane is finally safe
  // to apply (pane ids are now valid for this session's conn).
  window.linkOnPanesFrame = function () {
    if (S.linkPendingState) {
      const st = S.linkPendingState;
      S.linkPendingState = null;
      const waited = applyWindowPane(st);
      clearTimeout(linkApplyTimer);
      if (waited) {
        linkApplyPending = true;
        linkApplyTimer = setTimeout(clearApplying, 1500);
      } else {
        clearApplying();
      }
      return;
    }
    if (linkApplyPending) clearApplying();
  };

  // ── Input follow-lock hard guard (spec §3 Slice 2) ──────────────────────
  // Shared drop-guard for every key/input send path: never deliver a keystroke
  // while a remote view is being applied, or to a focused pane that isn't
  // currently rendered (its window is mid-switch — the keystroke would hit the
  // wrong pane / a ghost). A no-op when link is off and focus is a live pane,
  // so it preserves the byte-identical off-path (spec §0).
  window.linkSendBlocked = function () {
    return !!S.linkApplying || !S.paneEls[S.focusedPane];
  };

  // ── Join / leave ─────────────────────────────────────────────────────
  function sendJoin(create) {
    if (!window.tmuxWs || !window.tmuxWs.isConnected() || !S.linkGroup) return;
    const msg = { type: 'link_join', group: S.linkGroup, client_id: S.clientId, device: deviceName() };
    if (create) msg.create = true;
    window.tmuxWs.send(msg);
  }

  let urlPartyConsumed = false;
  function urlPartyCode() {
    try { return new URL(location.href).searchParams.get('party') || ''; } catch (e) { return ''; }
  }
  // Strip ?party=CODE after consuming it so a reload/share of the current URL
  // doesn't re-trigger the join (spec §3).
  function stripPartyParam() {
    try {
      const url = new URL(location.href);
      url.searchParams.delete('party');
      history.replaceState(null, '', url.toString());
    } catch (e) {}
  }

  // Hook for app.js's ws.onopen. Priority: an explicit ?party=CODE in the URL
  // (share link, consumed once) beats the persisted party (auto-rejoin);
  // either way link_join must be re-sent on every reconnect, not just the
  // first join (spec §3).
  window.linkOnOpen = function () {
    const urlParty = urlPartyCode();
    if (urlParty && !urlPartyConsumed) {
      urlPartyConsumed = true;
      S.linkGroup = urlParty;
      try { localStorage.setItem('tmux-webui-party', urlParty); } catch (e) {}
      S.linkOn = true;
      sendJoin(false);
      stripPartyParam();
      updateToggleUI();
      renderPartyPanel();
      return;
    }
    if (S.linkOn) sendJoin(false);
  };

  window.linkLeave = function () {
    if (window.tmuxWs && window.tmuxWs.isConnected() && S.linkGroup) {
      window.tmuxWs.send({ type: 'link_leave', client_id: S.clientId });
    }
    S.linkOn = false;
    S.linkGroup = '';
    S.linkMembers = [];
    S.linkLeader = '';
    S.linkLeaderOnly = false;
    try { localStorage.removeItem('tmux-webui-party'); } catch (e) {} // so a reload doesn't auto-rejoin
    updateToggleUI();
    renderPartyPanel();
  };

  // Permanent programmatic API (spec §4 E2E recipe: window.linkTest_join) —
  // joins an existing (or not-yet-existing) group without claiming leadership.
  window.linkTest_join = function (group) {
    S.linkGroup = group;
    try { localStorage.setItem('tmux-webui-party', group); } catch (e) {}
    S.linkOn = true;
    sendJoin(false);
    updateToggleUI();
    renderPartyPanel();
  };

  // Mints a fresh code and claims leadership (spec §3 "Create party").
  window.linkCreateParty = function () {
    S.linkGroup = mintPartyCode();
    try { localStorage.setItem('tmux-webui-party', S.linkGroup); } catch (e) {}
    S.linkOn = true;
    sendJoin(true);
    updateToggleUI();
    renderPartyPanel();
  };

  // Leader-only-drive toggle (spec §3) — server rejects this from non-leaders
  // (link.go configGroup), so the checkbox is only rendered for the leader.
  window.linkSetLeaderOnly = function (on) {
    if (!window.tmuxWs || !window.tmuxWs.isConnected() || !S.linkGroup) return;
    window.tmuxWs.send({ type: 'link_config', client_id: S.clientId, leader_only: !!on });
  };

  // ── Join by code / camera QR scan ────────────────────────────────────────
  // PWA standalone can't follow ?party= links back into the installed app
  // (they open a browser tab instead), so in-app entry points are primary:
  // type the 4-char code, or point the camera at the leader's QR.

  // Accepts a bare code ("aguj") or any URL carrying ?party=CODE; returns the
  // normalized code or '' when the input can't be a party code.
  function parsePartyCode(raw) {
    raw = (raw || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) {
      try { raw = new URL(raw).searchParams.get('party') || ''; } catch (e) { return ''; }
    }
    const code = raw.toUpperCase();
    return /^[A-Z2-9]{4,8}$/.test(code) ? code : '';
  }
  window.linkParsePartyCode = parsePartyCode; // exposed for E2E assertions

  function joinByCode(raw) {
    const code = parsePartyCode(raw);
    if (!code) return false;
    window.linkTest_join(code);
    return true;
  }

  // jsQR is vendored (static/js/vendor/jsqr.js, MIT) but heavy — inject it
  // only on the first scan on platforms without BarcodeDetector (iOS Safari).
  function loadJsQR() {
    return new Promise((resolve, reject) => {
      if (window.jsQR) return resolve();
      const s = document.createElement('script');
      const basePath = location.pathname.replace(/\/+$/, '') || '';
      s.src = basePath + '/static/js/vendor/jsqr.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('jsQR failed to load'));
      document.head.appendChild(s);
    });
  }

  function openScanner() {
    const modal = document.createElement('div');
    modal.className = 'qr-scan-modal';
    const video = document.createElement('video');
    video.className = 'qr-scan-video';
    video.setAttribute('playsinline', ''); // iOS: stay inline, don't fullscreen
    video.muted = true;
    const hint = document.createElement('div');
    hint.className = 'qr-scan-hint';
    hint.textContent = 'Point at the party QR';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn qr-scan-cancel';
    cancel.textContent = 'Cancel';
    modal.append(video, hint, cancel);
    document.body.appendChild(modal);

    let stream = null, timer = 0, done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
      modal.remove();
      document.removeEventListener('keydown', onEsc);
    };
    const onEsc = (e) => { if (e.key === 'Escape') cleanup(); };
    cancel.addEventListener('click', cleanup);
    document.addEventListener('keydown', onEsc);

    const onDecoded = (text) => {
      if (done || !joinByCode(text)) return false;
      cleanup();
      openPartyPanel(); // show the joined-party view (members etc.)
      return true;
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      // Insecure origin (plain-http LAN) or ancient browser — camera API absent.
      hint.textContent = 'Camera unavailable (needs HTTPS) — type the code instead';
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        if (done) { s.getTracks().forEach(t => t.stop()); return; }
        stream = s;
        video.srcObject = s;
        await video.play().catch(() => {});
        if ('BarcodeDetector' in window) {
          const det = new BarcodeDetector({ formats: ['qr_code'] });
          timer = setInterval(async () => {
            try {
              const codes = await det.detect(video);
              for (const c of codes) if (onDecoded(c.rawValue)) return;
            } catch (e) { /* detector hiccup on a frame — keep scanning */ }
          }, 250);
        } else {
          await loadJsQR();
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          timer = setInterval(() => {
            if (done || !video.videoWidth) return;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (res && res.data) onDecoded(res.data);
          }, 300);
        }
      })
      .catch((err) => {
        hint.textContent = (err && err.name === 'NotAllowedError')
          ? 'Camera permission denied — type the code instead'
          : 'Camera unavailable — type the code instead';
      });
  }

  // ── Header party button + panel (spec §3) ───────────────────────────────
  // Reuses the .session-dd-panel pattern: position:fixed anchored under the
  // trigger, Esc/outside-click close (main.css .party-dd-panel).
  const btn = document.getElementById('link-toggle');
  const partyPanel = document.getElementById('party-dd-panel');

  function updateToggleUI() {
    if (!btn) return;
    const count = S.linkMembers.length;
    btn.classList.toggle('active', S.linkOn);
    btn.textContent = count > 1 ? `🔗 ${count}` : '🔗';
    btn.title = S.linkOn ? `Linked (${S.linkGroup})` : 'Link mode: off';
  }

  function renderPartyPanel() {
    if (!partyPanel) return;
    partyPanel.innerHTML = '';

    // Explicit ✕ — touch-first escape hatch (outside-tap works too, but an
    // always-visible close affordance beats a hidden gesture on a tablet).
    const closeX = document.createElement('button');
    closeX.type = 'button';
    closeX.className = 'party-close-x';
    closeX.textContent = '×';
    closeX.title = 'Close';
    closeX.addEventListener('click', (e) => { e.stopPropagation(); closePartyPanel(); });
    partyPanel.appendChild(closeX);

    if (!S.linkOn || !S.linkGroup) {
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'btn btn-sm party-create-btn';
      create.textContent = 'Create party';
      // stopPropagation: linkCreateParty() re-renders the panel in place
      // (this button gets replaced), so by bubble time e.target would be
      // detached and the document outside-click listener below would
      // misread that as "clicked outside" and close the panel we just
      // populated. Stop it from ever reaching that listener.
      create.addEventListener('click', (e) => { e.stopPropagation(); window.linkCreateParty(); });
      partyPanel.appendChild(create);

      const sep = document.createElement('div');
      sep.className = 'party-sep';
      sep.textContent = 'or join';
      partyPanel.appendChild(sep);

      // Join by code — the PWA-safe path (share links open a browser tab,
      // not the installed app; a 4-char code types faster than any of that).
      const joinRow = document.createElement('div');
      joinRow.className = 'party-join-row';
      const codeInput = document.createElement('input');
      codeInput.type = 'text';
      codeInput.className = 'party-code-input';
      codeInput.placeholder = 'CODE';
      codeInput.maxLength = 8;
      codeInput.autocapitalize = 'characters';
      codeInput.autocomplete = 'off';
      codeInput.spellcheck = false;
      codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });
      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'btn btn-sm party-join-btn';
      joinBtn.textContent = 'Join';
      const tryJoin = (e) => {
        e.stopPropagation(); // same detached-target trap as the create button
        if (joinByCode(codeInput.value)) { renderPartyPanel(); return; }
        codeInput.classList.add('party-code-bad');
        setTimeout(() => codeInput.classList.remove('party-code-bad'), 600);
      };
      joinBtn.addEventListener('click', tryJoin);
      codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(e); });
      codeInput.addEventListener('click', (e) => e.stopPropagation());
      joinRow.append(codeInput, joinBtn);
      partyPanel.appendChild(joinRow);

      const scan = document.createElement('button');
      scan.type = 'button';
      scan.className = 'btn btn-sm party-scan-btn';
      scan.textContent = '📷 Scan QR';
      scan.addEventListener('click', (e) => { e.stopPropagation(); closePartyPanel(); openScanner(); });
      partyPanel.appendChild(scan);
      return;
    }

    const url = joinURL(S.linkGroup);

    const codeRow = document.createElement('div');
    codeRow.className = 'party-code-row';
    const codeEl = document.createElement('span');
    codeEl.className = 'party-code';
    codeEl.textContent = S.linkGroup;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-sm party-copy-btn';
    copyBtn.textContent = 'Copy link';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(url).catch(() => {});
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1200);
    });
    codeRow.append(codeEl, copyBtn);
    partyPanel.appendChild(codeRow);

    const urlEl = document.createElement('div');
    urlEl.className = 'party-url';
    urlEl.textContent = url;
    urlEl.title = url;
    partyPanel.appendChild(urlEl);

    // Server-side PNG (rsc.io/qr, already a transitive dep of qrterminal —
    // see internal/network/qr.go RenderPNG). No client QR library needed.
    const qr = document.createElement('img');
    qr.className = 'party-qr';
    qr.alt = 'Party join QR code';
    const basePath = location.pathname.replace(/\/+$/, '') || '';
    qr.src = `${basePath}/api/link/qr?text=${encodeURIComponent(url)}`;
    partyPanel.appendChild(qr);

    const memberList = document.createElement('div');
    memberList.className = 'party-members';
    (S.linkMembers || []).forEach(m => {
      const row = document.createElement('div');
      row.className = 'party-member-row';
      const name = document.createElement('span');
      name.className = 'party-member-name';
      name.textContent = m.device || m.client_id.slice(0, 8);
      row.appendChild(name);
      if (m.client_id === S.linkLeader) {
        const star = document.createElement('span');
        star.className = 'party-leader-star';
        star.textContent = '★';
        star.title = 'Leader';
        row.appendChild(star);
      }
      memberList.appendChild(row);
    });
    partyPanel.appendChild(memberList);

    if (S.clientId === S.linkLeader) {
      const label = document.createElement('label');
      label.className = 'party-leader-only-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!S.linkLeaderOnly;
      cb.addEventListener('change', () => window.linkSetLeaderOnly(cb.checked));
      label.append(cb, document.createTextNode(' Leader-only drive'));
      partyPanel.appendChild(label);
    }

    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'btn btn-sm party-leave-btn';
    leave.textContent = 'Leave party';
    leave.addEventListener('click', () => { window.linkLeave(); closePartyPanel(); });
    partyPanel.appendChild(leave);
  }

  function openPartyPanel() {
    renderPartyPanel();
    const r = btn.getBoundingClientRect();
    partyPanel.style.top = (r.bottom + 4) + 'px';
    partyPanel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 268)) + 'px';
    partyPanel.hidden = false;
  }
  function closePartyPanel() {
    partyPanel.hidden = true;
  }

  // Exported so app.js's ws.onmessage 'link_state' case can refresh the
  // toggle + (if open) the panel after updating S.linkMembers/leader/leaderOnly
  // (dispatched from app.js, not here).
  window.updateLinkUI = function () {
    updateToggleUI();
    if (partyPanel && !partyPanel.hidden) renderPartyPanel();
  };

  if (btn && partyPanel) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (partyPanel.hidden) openPartyPanel(); else closePartyPanel();
    });
    // pointerdown in capture phase, not click: iOS Safari never dispatches a
    // click for taps on non-interactive elements (empty deck space), so the
    // panel was unclosable on iPad — no Esc, and outside taps never reached a
    // document click listener. Pointer events fire for every tap; capture
    // phase is immune to widget stopPropagation. The toggle button is
    // excluded so its own click toggler doesn't fight a pre-close.
    document.addEventListener('pointerdown', (e) => {
      if (!partyPanel.hidden && !partyPanel.contains(e.target) && !btn.contains(e.target)) closePartyPanel();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !partyPanel.hidden) closePartyPanel();
    });
    window.addEventListener('resize', closePartyPanel);
  }
  updateToggleUI();
})();
