/* Restricted workspace sizing. No terminal input, upstream fit FSM or global options. */
(() => {
  window.createCaoAutoFit = ({ measure, report }) => {
    let enabled = true, owned = false, requested = false, measurable = true, disposed = false, timer, observer, heartbeat;
    let last = '', pending = '', seq = 0, latest = 0, composing = false, fontReady = !document.fonts;
    let target = '', topology = 0, stableHeight = 0, stableWidth = 0, stableGeometry;
    let kbWas = 0, kbUnsettledUntil = 0; // keyboard-close grace: URL bar keeps moving
    const host = window.parent || window;
    const listeners = [];
    const listen = (obj, name, fn) => { obj.addEventListener(name, fn); listeners.push(() => obj.removeEventListener(name, fn)); };
    const state = () => window.tmuxState;
    const info = () => state()?.paneInfo?.[state()?.focusedPane];
    const connected = () => window.tmuxWs?.isConnected();
    const available = () => !document.hidden && !host.document.hidden && host.document.hasFocus()
      && !composing && !(window.__caoViewport?.keyboardHeight > 0) && (window.__caoViewport?.scale ?? 1) === 1;
    const status = reason => report(reason, enabled);
    const send = (data, pane = state()?.focusedPane) => {
      if (!connected() || !pane) return false;
      latest = ++seq;
      window.tmuxWs.send({ type: 'resize', pane, resize_seq: latest, ...data });
      requested = !data.release;
      return true;
    };
    const release = () => {
      clearTimeout(timer); timer = null;
      if (owned || pending || requested) send({ release: true }, target || state()?.focusedPane);
      owned = false; requested = false; pending = ''; last = '';
    };
    const eligibility = () => {
      if (!enabled) return 'off';
      if (!connected()) return 'disconnected';
      if (!available()) return 'paused';
      if (info()?.window_panes !== 1) return 'shared_window';
      if (!fontReady) return 'loading';
      return '';
    };
    function fit(manual = false) {
      if (disposed) return;
      if (window.caoSelection?.owns()) { clearTimeout(timer); status('paused'); return; }
      if (!manual) {
        const reason = eligibility();
        if (reason) { release(); status(reason); return; }
      } else if (!connected() || !available()) { status('paused'); return; }
      const raw = measure();
      measurable = !!raw;
      let dims = raw;
      if (!manual && raw) {
        const width = host.innerWidth, height = host.innerHeight;
        const touch = matchMedia('(pointer: coarse)').matches;
        // Both ResizeObserver and visualViewport can report URL-bar jitter.
        // Keep the last stable row count until a real size/font change occurs.
        // Right after a keyboard closes, everything still moves — measure fresh.
        if (touch && Date.now() >= kbUnsettledUntil && stableWidth === width && stableHeight && Math.abs(height - stableHeight) < 80 && stableGeometry?.cols === raw.cols) {
          dims = { ...raw, rows: stableGeometry.rows };
        } else { stableWidth = width; stableHeight = height; stableGeometry = raw; }
      }
      if (!dims) { release(); status('viewport_small'); return; }
      const key = `${state().focusedPane}:${dims.cols}x${dims.rows}`;
      if (!manual && (key === last || key === pending)) return;
      pending = key;
      if (!send({ ...dims, auto: !manual, takeover: manual })) { pending = ''; status('disconnected'); }
    }
    function schedule() {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(() => fit(), 200);
    }
    function observe() {
      observer?.disconnect();
      if (!enabled || disposed) return;
      const container = document.getElementById('pane-container');
      if (window.ResizeObserver && container) {
        observer = new ResizeObserver(schedule);
        observer.observe(container);
      }
    }
    const onPanes = () => {
      const next = state()?.focusedPane || '', count = info()?.window_panes || 0;
      if (next !== target || count !== topology) {
        release(); target = next; topology = count; observe(); schedule();
      }
    };
    listen(window, 'cao:panes', onPanes);
    listen(window, 'cao:connection', e => {
      release();
      if (e.detail === 'connected') { observe(); schedule(); }
      else { observer?.disconnect(); status('disconnected'); }
    });
    listen(window, 'cao:sizing', e => {
      const d = e.detail;
      if (d.resize_seq !== latest) return; // no obsolete ACK can restore a lost claim
      requested = false;
      owned = d.state === 'owned';
      if (owned && pending) last = pending;
      if (!owned) last = '';
      pending = '';
      status(enabled ? d.state : 'off');
      if (owned && !last && enabled) schedule(); // newly acquired by a dimensionless claim
    });
    listen(window, 'cao:selection', () => {
      clearTimeout(timer); timer = null;
      if (window.caoSelection?.owns()) status('paused');
      else { stableGeometry = null; schedule(); }
    });
    listen(window, 'cao:font-size', () => { last = ''; stableGeometry = null; schedule(); });
    listen(window, 'cao:terminal-layout', () => {
      // Composer hide/show is intentional layout, not browser toolbar jitter.
      stableWidth = 0; stableHeight = 0; stableGeometry = null;
      // Direct mode frees composer space in the initiating foreground gesture.
      // A resize-content keyboard can arrive before the 200ms debounce; measure
      // this intentional layout now through the SAME focus/IME/ownership gates.
      last = ''; fit();
    });
    listen(window, 'cao:viewport', () => {
      const kb = window.__caoViewport?.keyboardHeight || 0;
      if (!kb && kbWas > 0) {
        // Keyboard just closed: the URL bar/toolbar keeps settling for a
        // moment. Refuse retained geometry; rebuild stable state from live
        // measurements instead of keeping toolbar-hidden rows.
        kbUnsettledUntil = Date.now() + 1000;
        stableWidth = 0; stableHeight = 0; stableGeometry = null;
      }
      kbWas = kb;
      if (!available()) { release(); status('paused'); }
      else schedule();
    });
    listen(document, 'compositionstart', () => { composing = true; release(); status('paused'); });
    listen(document, 'compositionend', () => { composing = false; schedule(); });
    const activity = () => {
      if (!available()) { release(); status('paused'); }
      else schedule();
    };
    listen(document, 'visibilitychange', activity);
    if (host.document !== document) listen(host.document, 'visibilitychange', activity);
    // hasFocus includes the same-origin iframe: clicking between it and its
    // parent isn't a different browser viewer and must not steal/release sizing.
    listen(host, 'focus', activity);
    listen(host, 'blur', () => { clearTimeout(timer); timer = setTimeout(activity, 0); });
    listen(window, 'focus', activity);
    const viewportResize = () => {
      const width = host.innerWidth, height = host.innerHeight;
      const touch = matchMedia('(pointer: coarse)').matches;
      if (touch && Date.now() < kbUnsettledUntil) { schedule(); return; }
      if (touch && stableWidth === width && stableHeight && Math.abs(height - stableHeight) < 80) return;
      schedule();
    };
    listen(host, 'resize', viewportResize);
    listen(host, 'orientationchange', () => { stableWidth = 0; stableHeight = 0; stableGeometry = null; schedule(); });
    heartbeat = setInterval(() => {
      if (window.caoSelection?.owns() || eligibility() || !measurable) return;
      // Renew/try a claim, but never resend old geometry on a timer. Geometry
      // changes only from a real measurement event or newly granted ownership.
      send({ auto: true });
    }, 8000);
    if (document.fonts) document.fonts.ready.then(() => { fontReady = true; schedule(); });
    const destroy = () => {
      if (disposed) return;
      release(); disposed = true; observer?.disconnect(); clearInterval(heartbeat);
      for (const remove of listeners) remove();
    };
    listen(window, 'pagehide', destroy);
    onPanes();
    schedule();
    return {
      setEnabled(value) {
        enabled = !!value; release(); observer?.disconnect();
        status(enabled ? 'loading' : 'off');
        if (enabled) { observe(); schedule(); }
      },
      fitHere: () => fit(true),
      schedule,
      destroy,
    };
  };
})();
