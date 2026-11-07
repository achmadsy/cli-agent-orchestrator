/**
 * keys.js — Virtual keys with Modifier FSM (Blink Shell style)
 *
 * Modifier FSM:
 *   IDLE ──tap──→ ARMED ──key──→ send combo → IDLE
 *                   │               (auto-clear non-locked mods)
 *                   ├──timeout(3s)──→ IDLE (flash cancel)
 *                   ├──double-tap──→ LOCKED ──key──→ send combo → LOCKED
 *                   │                  └──tap──→ IDLE
 *                   └──tap again──→ IDLE (deactivate)
 */

(function() {
  const extraKeysEl = document.getElementById('extra-keys');
  const arrowPad = document.getElementById('arrow-pad');
  const inputEl = document.getElementById('input');

  // ── Modifier FSM ──

  const MOD_TIMEOUT = 3000; // Auto-expire armed modifiers after 3s
  const DOUBLE_TAP_MS = 350;

  // Per-modifier state: { state: 'idle'|'armed'|'locked', timer: null, lastTap: 0, btn: el }
  const modState = {};

  document.querySelectorAll('.ek.mod').forEach(btn => {
    const mod = btn.dataset.mod;
    modState[mod] = { state: 'idle', timer: null, lastTap: 0, btn };

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const ms = modState[mod];
      const now = Date.now();

      switch (ms.state) {
        case 'idle':
          // Activate → ARMED with timeout
          ms.state = 'armed';
          btn.classList.add('active');
          btn.classList.remove('locked');
          clearTimeout(ms.timer);
          ms.timer = setTimeout(() => {
            // Auto-expire: ARMED → IDLE
            ms.state = 'idle';
            btn.classList.remove('active');
            btn.classList.add('flash-cancel');
            setTimeout(() => btn.classList.remove('flash-cancel'), 300);
          }, MOD_TIMEOUT);
          break;

        case 'armed':
          if (now - ms.lastTap < DOUBLE_TAP_MS) {
            // Double-tap → LOCKED (no timeout)
            clearTimeout(ms.timer);
            ms.state = 'locked';
            btn.classList.add('locked');
          } else {
            // Single tap again → deactivate → IDLE
            clearTimeout(ms.timer);
            ms.state = 'idle';
            btn.classList.remove('active');
          }
          break;

        case 'locked':
          // Tap while locked → IDLE
          ms.state = 'idle';
          btn.classList.remove('active', 'locked');
          break;
      }
      ms.lastTap = now;
    });
  });

  function getActiveModifiers() {
    const mods = [];
    for (const [mod, ms] of Object.entries(modState)) {
      if (ms.state === 'armed' || ms.state === 'locked') mods.push(mod);
    }
    return mods;
  }

  function hasActiveModifiers() {
    return Object.values(modState).some(ms => ms.state !== 'idle');
  }

  function clearArmedModifiers() {
    // After sending a combo: armed → idle, locked stays locked
    for (const [mod, ms] of Object.entries(modState)) {
      if (ms.state === 'armed') {
        clearTimeout(ms.timer);
        ms.state = 'idle';
        ms.btn.classList.remove('active');
      }
    }
  }

  function clearAllModifiers() {
    for (const [mod, ms] of Object.entries(modState)) {
      clearTimeout(ms.timer);
      ms.state = 'idle';
      ms.btn.classList.remove('active', 'locked');
    }
  }

  // ── Send key with current modifiers ──

  function sendEk(key) {
    if (!window.tmuxWs || !window.tmuxWs.isConnected() || !window.tmuxState.focusedPane) {
      window.flashInputError?.('Not connected');
      return;
    }
    const mods = getActiveModifiers();
    window.tmuxWs.send({
      type: 'key',
      pane: window.tmuxState.focusedPane,
      key,
      modifiers: mods,
    });
    const pe = window.tmuxState.paneEls[window.tmuxState.focusedPane];
    if (pe) pe.resetScroll();
    clearArmedModifiers(); // Armed → idle after send; locked stays
  }

  // Expose for gestures.js and other modules
  window.sendEk = sendEk;
  window.hasActiveModifier = hasActiveModifiers;

  // ── Phone keyboard combo: intercept when modifier active ──

  if (inputEl) {
    // Desktop/keydown path
    inputEl.addEventListener('keydown', (e) => {
      if (!hasActiveModifiers()) return;

      const key = e.key;
      if (!key) return;
      // Allow single chars + special keys
      if (key.length > 1 && !['Enter','Tab','Escape','Backspace','Delete'].includes(key)) return;

      e.preventDefault();
      e.stopPropagation();
      sendEk(key.length === 1 ? key : key);
      // Keep keyboard open on mobile — re-focus input after combo
      requestAnimationFrame(() => inputEl.focus());
    });

    // Mobile fallback: 'input' event for keyboards that skip keydown
    let lastInputValue = '';
    inputEl.addEventListener('focus', () => { lastInputValue = inputEl.value; });
    inputEl.addEventListener('input', () => {
      if (!hasActiveModifiers()) { lastInputValue = inputEl.value; return; }

      const newVal = inputEl.value;
      const inserted = newVal.slice(lastInputValue.length);
      if (inserted.length >= 1) {
        // Undo insertion, send as combo
        inputEl.value = lastInputValue;
        sendEk(inserted[0]);
        // Keep keyboard open on mobile
        requestAnimationFrame(() => inputEl.focus());
      }
      lastInputValue = inputEl.value;
    });
  }

  // ── Extra key buttons ──

  document.querySelectorAll('.ek[data-ek]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      sendEk(btn.dataset.ek);
    });
  });

  // ── Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+L standalone buttons ──

  document.querySelectorAll('.ek[data-ctrl]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!window.tmuxWs || !window.tmuxWs.isConnected() || !window.tmuxState.focusedPane) return;
      window.tmuxWs.send({
        type: 'key',
        pane: window.tmuxState.focusedPane,
        key: btn.dataset.ctrl,
        modifiers: ['C'],
      });
    });
  });

  // ── Arrow Touchpad (shared logic for all .arrow-pad elements) ──

  function initArrowPad(pad) {
    if (!pad) return;
    const THRESHOLD = 18;
    const COOLDOWN = 150;
    const REPEAT_DELAY = 400;
    const REPEAT_RATE = 120;
    let tracking = false, lastX = 0, lastY = 0, dirClass = '', lastSendTime = 0;
    let currentKey = null, repeatTimer = null;

    function clearDir() {
      if (dirClass) { pad.classList.remove(dirClass); dirClass = ''; }
    }

    function stopRepeat() {
      clearInterval(repeatTimer);
      repeatTimer = null;
      currentKey = null;
    }

    function startRepeat(key) {
      stopRepeat();
      currentKey = key;
      repeatTimer = setTimeout(() => {
        repeatTimer = setInterval(() => {
          if (currentKey) sendEk(currentKey);
        }, REPEAT_RATE);
      }, REPEAT_DELAY);
    }

    function handleMove(cx, cy) {
      const dx = cx - lastX, dy = cy - lastY;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax < THRESHOLD && ay < THRESHOLD) return;
      const now = Date.now();
      if (now - lastSendTime < COOLDOWN) return;
      let key, cls;
      if (ax > ay) {
        key = dx > 0 ? 'Right' : 'Left';
        cls = dx > 0 ? 'dir-right' : 'dir-left';
      } else {
        key = dy > 0 ? 'Down' : 'Up';
        cls = dy > 0 ? 'dir-down' : 'dir-up';
      }
      lastX = cx; lastY = cy;
      lastSendTime = now;
      clearDir();
      dirClass = cls;
      pad.classList.add(cls);
      sendEk(key);
      startRepeat(key);
    }

    function stop() { tracking = false; clearDir(); stopRepeat(); }

    pad.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      tracking = true; lastX = t.clientX; lastY = t.clientY;
    }, { passive: false });

    pad.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!tracking) return;
      handleMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    pad.addEventListener('touchend', stop);
    pad.addEventListener('touchcancel', stop);

    // Mouse fallback
    pad.addEventListener('mousedown', (e) => {
      e.preventDefault();
      tracking = true; lastX = e.clientX; lastY = e.clientY;
      const onMove = (ev) => handleMove(ev.clientX, ev.clientY);
      const onUp = () => {
        stop();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Init both arrow pads (extra-keys + quick-actions)
  initArrowPad(arrowPad);
  initArrowPad(document.getElementById('quick-arrow-pad'));

  // ── Extra Keys Visibility ──

  function isTouch() { return matchMedia('(pointer:coarse)').matches; }
  function isPWA() { return matchMedia('(display-mode: standalone)').matches; }

  function loadEkPref() {
    const isPhone = window.matchMedia('(max-width:600px)').matches;
    if (isPWA() && !isPhone) return true;
    const stored = localStorage.getItem('tmux-webui-show-extra-keys');
    if (stored !== null) return stored === '1';
    return isTouch() && !isPhone;
  }

  extraKeysEl.classList.toggle('visible', loadEkPref());

  if (window.matchMedia('(max-width:600px)').matches) {
    const footerEl = document.querySelector('footer');
    if (footerEl) footerEl.classList.add('mobile-collapsed');
  }

  // ── Extra Keys Toggle Button ──
  const ekToggle = document.getElementById('ek-toggle');
  if (ekToggle) {
    ekToggle.addEventListener('click', (e) => {
      e.preventDefault();
      const show = !extraKeysEl.classList.contains('visible');
      extraKeysEl.classList.toggle('visible', show);
      localStorage.setItem('tmux-webui-show-extra-keys', show ? '1' : '0');
      const footerEl = document.querySelector('footer');
      if (footerEl && show) footerEl.classList.remove('mobile-collapsed');
      else if (footerEl && !show && window.matchMedia('(max-width:600px)').matches) footerEl.classList.add('mobile-collapsed');
      if (window._fitAllPanes) window._fitAllPanes();
    });
  }
})();
