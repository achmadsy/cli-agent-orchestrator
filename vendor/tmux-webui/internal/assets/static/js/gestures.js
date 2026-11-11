/**
 * gestures.js — Touch gesture handling (Blink Shell / iSH inspired)
 * - Swipe left/right: switch tmux pane
 * - Pinch zoom: adjust font size
 * - Long press: trigger text selection
 */

(function() {
  const container = document.getElementById('pane-container');
  const indicator = document.getElementById('gesture-indicator');
  const isMobile = () => window.matchMedia('(max-width:600px)').matches;

  // ── Font size persistence ──
  // Precedence: localStorage (user pinched) > config (ui.theme.fontSize, already
  // applied by app.js applyTheme) > CSS default 12. Fall through to config only
  // when the user hasn't pinched, so a pinch always overrides the operator's
  // configured size.
  let storedFont = null;
  try { if (!window.__CAO_WORKSPACE__) storedFont = localStorage.getItem('tmux-webui-font-size'); } catch (_) {}
  const cfgFont = window.cfgGet ? window.cfgGet('theme.fontSize', null) : null;
  let fontSize = parseFloat(storedFont != null ? storedFont : (cfgFont != null ? cfgFont : 14));
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');

  // ── Gesture state ──
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  let isPinching = false, initialPinchDist = 0, initialFontSize = 12;
  let longPressTimer = null;
  const SWIPE_THRESHOLD = 80;
  const LONG_PRESS_MS = 500;

  function showIndicator(text) {
    if (!indicator) return;
    indicator.textContent = text;
    indicator.classList.add('show');
    setTimeout(() => indicator.classList.remove('show'), 400);
  }

  // ── Swipe: switch pane (mobile) or send arrow keys ──

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // Browser zoom remains available in CAO; explicit A-/A+ changes text.
      if (window.__CAO_WORKSPACE__) return;
      // Start pinch
      isPinching = true;
      initialPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      initialFontSize = fontSize;
      return;
    }
    if (e.touches.length !== 1) return;

    isPinching = false;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();

    // Long press: show hint (let browser handle native selection)
    longPressTimer = setTimeout(() => {
      showIndicator('Select');
    }, LONG_PRESS_MS);
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    // Cancel long press on move
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    // Handle pinch zoom
    if (isPinching && e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const scale = dist / initialPinchDist;
      fontSize = Math.max(8, Math.min(24, Math.round(initialFontSize * scale)));
      document.documentElement.style.setProperty('--font-size', fontSize + 'px');
      return;
    }
  }, { passive: true });

  container.addEventListener('touchend', (e) => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    // Save font size after pinch
    if (isPinching) {
      isPinching = false;
      localStorage.setItem('tmux-webui-font-size', String(fontSize));
      return;
    }

    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    // Only process quick swipes (<300ms)
    if (elapsed > 300) return;
    if (Math.abs(dy) > Math.abs(dx)) return; // vertical, ignore
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;

    if (isMobile() && window.switchMobilePane) {
      // Mobile: switch pane tabs
      if (dx > 0) {
        window.switchMobilePane(-1);
        showIndicator('\u25C0');
      } else {
        window.switchMobilePane(1);
        showIndicator('\u25B6');
      }
    } else if (window.tmuxWs && window.tmuxWs.isConnected()) {
      // Desktop: send pane direction to tmux
      const dir = dx > 0 ? 'right' : 'left';
      window.tmuxWs.send({
        type: 'select_pane_direction',
        pane: window.tmuxState.focusedPane,
        direction: dir,
      });
      showIndicator(dx > 0 ? '\u25B6' : '\u25C0');
    }
  }, { passive: true });

  // ── Virtual keyboard height tracking ──
  // Events settle animations; focused touch editing also needs a watchdog:
  // a native keyboard may be dismissed silently long after those events stop.
  // Keep semantic occlusion separate from the remaining local iframe inset.

  if (window.visualViewport) {
    const workspace = !!window.__CAO_WORKSPACE__;
    const host = workspace ? window.parent : window;
    const viewport = host.visualViewport || window.visualViewport;
    const detach = [];
    // A child viewport can report zero safe-area env values. Read the physical
    // host once per sample and subtract clearance its iframe already provides.
    const makeSafeProbe = doc => {
      const probe = doc.createElement('div');
      probe.dataset.caoSafeProbe = '';
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-right:env(safe-area-inset-right,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px)';
      doc.documentElement.appendChild(probe);
      return probe;
    };
    const safeProbe = workspace ? makeSafeProbe(host.document) : null;
    const localSafeProbe = workspace && host !== window ? makeSafeProbe(document) : safeProbe;
    let disposed = false, timer = null, lastKey = '', settleUntil = 0;
    // Some mobile browsers shrink BOTH layout and visual viewports for the
    // keyboard. Preserve a same-width pre-edit baseline; overlap alone is zero.
    let layoutBase = { width: host.innerWidth, height: host.innerHeight };
    const visible = () => !document.hidden && !host.document.hidden;
    const editable = () => !!document.activeElement?.matches('textarea, input:not([type="checkbox"]), [contenteditable="true"]');
    const touch = () => matchMedia('(pointer: coarse)').matches;
    const queue = delay => {
      clearTimeout(timer);
      timer = setTimeout(sample, delay);
    };
    function sample() {
      clearTimeout(timer); timer = null;
      if (disposed || !visible()) return;
      const editing = editable(), scale = viewport.scale;
      // VisualViewport is top-level even when the focused editable is inside
      // the iframe. The semantic occlusion pauses real tmux sizing. The local
      // CSS inset is only the part not ALREADY removed by the iframe's layout.
      const overlap = host.innerHeight - viewport.height - viewport.offsetTop;
      if (scale === 1) {
        if (Math.abs(layoutBase.width - host.innerWidth) > 2 || !editing || !touch()) {
          layoutBase = { width: host.innerWidth, height: host.innerHeight };
        } else layoutBase.height = Math.max(layoutBase.height, host.innerHeight);
      }
      // A substantial same-width touch/editing shrink is semantic keyboard
      // occlusion, even when the layout already removed ALL of that space.
      // Small toolbar changes are not keyboards; rotation rebases above.
      const layoutDrop = layoutBase.height - host.innerHeight;
      const contentKb = editing && touch() && scale === 1 && layoutDrop > Math.max(120, layoutBase.height * 0.18)
        ? layoutDrop : 0;
      const occlusion = Math.max(overlap, contentKb);
      const kb = editing && scale === 1 && occlusion > 25
        ? Math.min(occlusion, Math.max(layoutBase.height, host.innerHeight) * 0.8) : 0;
      const rect = workspace && host !== window ? window.frameElement?.getBoundingClientRect() : null;
      const bottom = rect?.height > 0 ? rect.bottom : host.innerHeight;
      // Presentation is an intersection, NOT a keyboard-height guess. Layout
      // and visual metrics can settle before the fixed iframe does, including
      // residual clipping below the semantic keyboard threshold. Never apply
      // pinch zoom as a keyboard inset or subtract already-removed space twice.
      const remaining = Math.max(0, bottom - viewport.height - viewport.offsetTop);
      const inset = workspace && scale === 1
        ? Math.min(rect?.height || host.innerHeight, viewport.height > 0 ? remaining : Math.min(kb, remaining))
        : !workspace && kb && overlap > 25 ? Math.min(kb, remaining) : 0;
      const safe = [0, 0, 0]; // remaining bottom, left, right content clearance
      if (safeProbe && scale === 1) {
        const style = host.getComputedStyle(safeProbe);
        const local = localSafeProbe === safeProbe ? style : getComputedStyle(localSafeProbe);
        const physicalHeight = Math.max(layoutBase.height, host.innerHeight, bottom);
        const physicalWidth = Math.max(host.innerWidth, rect?.right || 0);
        const rawBottom = Math.max(parseFloat(style.paddingBottom) || 0, parseFloat(local.paddingBottom) || 0);
        const rawLeft = Math.max(parseFloat(style.paddingLeft) || 0, parseFloat(local.paddingLeft) || 0);
        const rawRight = Math.max(parseFloat(style.paddingRight) || 0, parseFloat(local.paddingRight) || 0);
        safe[0] = Math.min(rawBottom, Math.max(0, bottom - inset - (physicalHeight - rawBottom)));
        safe[1] = Math.min(rawLeft, Math.max(0, rawLeft - (rect?.left || 0)));
        safe[2] = Math.min(rawRight, Math.max(0, (rect?.right ?? host.innerWidth) - (physicalWidth - rawRight)));
        for (const [i, edge] of ['bottom', 'left', 'right'].entries()) {
          document.documentElement.style.setProperty('--cao-safe-' + edge, safe[i] + 'px');
        }
      }
      document.documentElement.style.setProperty('--kb-height', inset + 'px');
      const geometry = [viewport.width, viewport.height, viewport.offsetTop, viewport.offsetLeft,
        host.innerWidth, host.innerHeight, rect?.width, rect?.height, rect?.left, rect?.top];
      const key = JSON.stringify([kb, inset, scale, ...safe, ...geometry.map(n => Math.round((n || 0) * 2) / 2)]);
      if (key !== lastKey) {
        lastKey = key;
        settleUntil = Date.now() + 1000;
        if (workspace) {
          // Geometry can change at kb=0 (toolbar, iframe or width restoration).
          // One source/event, no second parent offset or speculative focus.
          window.__caoViewport = { keyboardHeight: kb, scale };
          window.dispatchEvent(new Event('cao:viewport'));
        }
      }
      // A keyboard may close much later with no resize/blur at all. Watch only
      // the visible editing/occlusion lifecycle, not every page forever. One
      // cancellable timer replaces the previous branching settle timers.
      if (Date.now() < settleUntil) queue(120);
      else if (touch() && host.document.hasFocus() && (editing || kb > 0)) queue(400);
    }
    const trigger = () => {
      if (disposed) return;
      settleUntil = Date.now() + 1000;
      sample();
    };
    const on = (obj, name, fn = trigger) => {
      obj.addEventListener(name, fn);
      detach.push(() => obj.removeEventListener(name, fn));
    };
    for (const v of new Set([window.visualViewport, viewport])) {
      on(v, 'resize'); on(v, 'scroll');
    }
    for (const win of new Set([window, host])) {
      on(win, 'resize'); on(win, 'orientationchange'); on(win, 'focus');
      // Focusout/blur activeElement is settled only after event dispatch.
      on(win, 'blur', () => { clearTimeout(timer); if (!disposed) timer = setTimeout(trigger, 0); });
    }
    on(document, 'focusin');
    on(document, 'focusout', () => { clearTimeout(timer); if (!disposed) timer = setTimeout(trigger, 0); });
    for (const doc of new Set([document, host.document])) on(doc, 'visibilitychange');
    const destroy = () => {
      disposed = true; clearTimeout(timer); timer = null;
      safeProbe?.remove();
      if (localSafeProbe !== safeProbe) localSafeProbe?.remove();
      detach.forEach(remove => remove());
    };
    on(window, 'pagehide', destroy);
    sample();
  }
})();
