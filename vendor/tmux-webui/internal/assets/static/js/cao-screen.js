/* CAO v2 active-grid presentation. History is opt-in, never viewport filler. */
(() => {
  window.createCaoScreen = (term, pane, jump) => {
    let current = null, reading = false, generation = 0, request = null, frame = 0;
    let history = '', historySnapshot = '', offset = 0, exhausted = false, disposed = false;
    let touchY = null, touching = false, towardLive = false, returnTimer = null;
    const cancelReturn = () => { clearTimeout(returnTimer); returnTimer = null; };
    const listeners = [];
    const listen = (el, name, fn, opts) => { el.addEventListener(name, fn, opts); listeners.push(() => el.removeEventListener(name, fn, opts)); };
    const invalidate = () => { generation++; request?.abort(); request = null; cancelAnimationFrame(frame); frame = 0; };
    const lineHeight = () => window.caoCell?.measure(term).h || parseFloat(getComputedStyle(term).lineHeight) || 21;
    function draw(content) {
      // The existing diff renderer remains the single escaping/SGR path.
      term.dataset.caoFullGrid = 'true';
      window.caoLineDiffUpdate(term, content);
    }
    function anchor() {
      cancelAnimationFrame(frame);
      const ticket = generation;
      frame = requestAnimationFrame(() => {
        if (disposed || ticket !== generation || reading || !current || selected()) return;
        const h = lineHeight();
        // The keyboard reduces the viewer, not the preserved active grid. Its
        // last row is the live endpoint regardless of cursor or application.
        // Outside that shrink keep normal cursor positioning; never trim blank
        // grid rows or use shell history as viewport filler.
        const style = getComputedStyle(term);
        const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const viewport = window.__caoViewport;
        const followGrid = viewport?.keyboardHeight > 0 && viewport.scale === 1
          && current.rows * h + padding > term.clientHeight;
        const endRow = followGrid ? current.rows : current.cursor_y + 1;
        const top = Math.max(0, endRow * h + padding - term.clientHeight);
        term.scrollTop = top;
        delete term.dataset.caoScrollProg;
      });
    }
    function live() {
      cancelReturn(); towardLive = false;
      invalidate(); reading = false; history = ''; historySnapshot = ''; offset = 0; exhausted = false;
      jump.hidden = true;
      if (current) { draw(current.content); anchor(); }
    }
    async function older() {
      if (!current || current.alternate || request || exhausted || disposed) return;
      const ticket = generation, boundary = current.boundary;
      const controller = new AbortController(); request = controller;
      const oldHeight = term.scrollHeight, oldTop = term.scrollTop;
      try {
        const base = location.pathname.replace(/\/+$/, '');
        const r = await fetch(`${base}/api/history?pane=${encodeURIComponent(pane)}&lines=500&offset=${offset}&boundary=${encodeURIComponent(boundary)}&snapshot=${encodeURIComponent(historySnapshot)}`, { signal: controller.signal });
        if (ticket !== generation || disposed) return;
        if (r.status === 409) { live(); return; }
        if (!r.ok) return;
        const data = await r.json();
        if (ticket !== generation || disposed || data.boundary !== boundary || current.boundary !== boundary || current.alternate) return;
        const content = data.content.replace(/\n$/, '');
        const count = content ? content.split('\n').length : 0;
        if (offset && count <= 1) { exhausted = true; return; }
        reading = true; jump.hidden = false;
        history = offset ? content + '\n' + history : content;
        draw(history);
        term.scrollTop = Math.max(0, oldTop + term.scrollHeight - oldHeight);
        historySnapshot = data.snapshot || ''; offset += 500;
        exhausted = data.exhausted === true || count < 500;
      } catch (error) { if (error.name !== 'AbortError') window.caoClipboardStatus?.('History unavailable.'); }
      finally { if (ticket === generation && request === controller) request = null; }
    }
    const atBottom = () => term.scrollTop + term.clientHeight >= term.scrollHeight - 2;
    const selected = () => { const s = getSelection(); return !!s?.toString() && term.contains(s.anchorNode); };
    function settleReturn() {
      cancelReturn();
      if (disposed || touching || !towardLive || !reading || request || selected() || !atBottom()) return;
      // Do not replace the scroll extent under a finger or while momentum still
      // delivers scroll events. A reversed/new gesture cancels this transition.
      returnTimer = setTimeout(() => {
        returnTimer = null;
        if (!disposed && !touching && towardLive && reading && !request && !selected() && atBottom()) live();
      }, 140);
    }
    function intent(delta) {
      if (!current || !delta || window.tmuxState?.paneInfo[pane]?.mouse_mode) return;
      if (delta < 0) {
        cancelReturn(); towardLive = false;
        // A live grid can itself overflow when the keyboard is open. Explicit
        // reading starts there, not only at the older-history loading boundary.
        if (term.scrollHeight > term.clientHeight + 1 || (term.scrollTop < 80 && !current.alternate)) {
          reading = true; jump.hidden = false; cancelAnimationFrame(frame); frame = 0;
        }
        if (!current.alternate && term.scrollTop < 80) older();
      } else if (reading) { towardLive = true; settleReturn(); }
    }
    listen(term, 'wheel', e => intent(e.deltaY), { passive: true });
    listen(term, 'touchstart', e => {
      cancelReturn(); towardLive = false;
      touching = e.touches.length === 1;
      touchY = touching ? e.touches[0].clientY : null;
    }, { passive: true });
    listen(term, 'touchmove', e => {
      if (touchY == null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY; intent(touchY - y); touchY = y;
    }, { passive: true });
    listen(term, 'touchend', e => {
      if (e.touches.length) return;
      touching = false; touchY = null; settleReturn();
    }, { passive: true });
    listen(term, 'touchcancel', () => { touching = false; touchY = null; towardLive = false; cancelReturn(); }, { passive: true });
    listen(term, 'scroll', settleReturn, { passive: true });
    listen(term, 'keydown', e => { if (e.key === 'PageUp') intent(-1); });
    listen(jump, 'click', live);
    for (const name of ['cao:viewport', 'cao:terminal-layout', 'cao:font-size']) listen(window, name, anchor);
    listen(window, 'cao:connection', () => { cancelReturn(); towardLive = false; touching = false; touchY = null; invalidate(); current = null; reading = false; history = ''; historySnapshot = ''; offset = 0; exhausted = false; jump.hidden = true; });
    listen(window, 'cao:terminal-reset', () => { cancelReturn(); towardLive = false; touching = false; touchY = null; invalidate(); });
    const observer = new ResizeObserver(() => anchor()); observer.observe(term);
    return {
      apply(snapshot) {
        if (disposed || current && snapshot.seq <= current.seq) return;
        const transition = !current || snapshot.epoch !== current.epoch || snapshot.cols !== current.cols || snapshot.rows !== current.rows || snapshot.alternate !== current.alternate;
        const boundaryChanged = current && snapshot.boundary !== current.boundary;
        const modeChanged = current && snapshot.alternate !== current.alternate;
        if (transition || boundaryChanged) {
          cancelReturn(); towardLive = false;
          invalidate(); offset = 0; exhausted = false;
          // Keep an intentional reader's frozen DOM, but never append pages
          // addressed relative to a newer screen onto the previous history.
          history = ''; historySnapshot = '';
          // A resize invalidates paging coordinates, not an intentional reader.
          if (!current || modeChanged) { reading = false; history = ''; jump.hidden = true; }
        }
        current = snapshot; term.dataset.caoAlternate = String(snapshot.alternate);
        if (reading) return;
        const sel = getSelection();
        if (!transition && sel?.toString() && term.contains(sel.anchorNode)) return;
        draw(snapshot.content); anchor();
      },
      live, resetTarget() { cancelReturn(); towardLive = false; touching = false; touchY = null; invalidate(); reading = false; history = ''; historySnapshot = ''; offset = 0; exhausted = false; jump.hidden = true; }, get snapshot() { return current; }, get reading() { return reading; },
      destroy() { disposed = true; cancelReturn(); invalidate(); observer.disconnect(); listeners.forEach(f => f()); }
    };
  };
})();
