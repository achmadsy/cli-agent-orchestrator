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

  if (window.visualViewport) {
    const updateKeyboard = () => {
      // Zoom is not a keyboard resize. Inside a same-origin CAO iframe the
      // top-level visual viewport owns the soft keyboard occlusion.
      const host = window.__CAO_WORKSPACE__ ? window.parent : window;
      const viewport = host.visualViewport || window.visualViewport;
      const editing = document.activeElement?.tagName === 'TEXTAREA';
      const kbH = editing && viewport.scale === 1 ? Math.max(0, host.innerHeight - viewport.height - viewport.offsetTop) : 0;
      document.documentElement.style.setProperty('--kb-height', kbH + 'px');
    };
    window.visualViewport.addEventListener('resize', updateKeyboard);
    if (window.__CAO_WORKSPACE__ && window.parent !== window) {
      const viewport = window.parent.visualViewport;
      viewport?.addEventListener('resize', updateKeyboard);
      window.addEventListener('pagehide', () => viewport?.removeEventListener('resize', updateKeyboard), { once: true });
    }
    document.addEventListener('focusin', updateKeyboard);
    document.addEventListener('focusout', () => setTimeout(updateKeyboard, 0));
  }
})();
