/* CAO composition hooks: lifecycle stays in the parent application. */
(() => {
  const input = document.getElementById('input');
  input.setAttribute('aria-label', 'Message the active agent');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  document.querySelector('header h1').textContent = 'Terminal workspace';
  document.getElementById('send-btn').setAttribute('aria-label', 'Send message to active agent');

  document.documentElement.classList.add('cao-workbench');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  const header = document.querySelector('header');
  const headerControls = document.querySelector('.header-controls');
  const view = document.createElement('button');
  view.type = 'button'; view.className = 'btn cao-view-toggle'; view.textContent = 'View';
  view.setAttribute('aria-expanded', 'false'); view.setAttribute('aria-controls', 'cao-view-panel');
  const panel = document.createElement('section');
  panel.id = 'cao-view-panel'; panel.className = 'cao-view-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Terminal view settings');
  const controls = document.createElement('div');
  controls.className = 'cao-reading-controls';
  controls.setAttribute('aria-label', 'Terminal reading controls');
  const sizeTitle = document.createElement('span'); sizeTitle.textContent = 'Text size';
  controls.append(sizeTitle);
  panel.append(controls);
  headerControls.append(view);
  header.append(panel);
  const keysToggle = document.getElementById('ek-toggle');
  function closeView(focus = false) {
    panel.hidden = true; view.setAttribute('aria-expanded', 'false');
    if (focus) view.focus();
  }
  view.addEventListener('click', () => {
    const opening = panel.hidden;
    if (opening && keysToggle.getAttribute('aria-expanded') === 'true') keysToggle.click();
    panel.hidden = !opening; view.setAttribute('aria-expanded', String(opening));
  });
  keysToggle.addEventListener('click', () => closeView());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeView(true); }
  }, true);
  const layout = matchMedia('(max-width:600px)');
  const root = document.documentElement;
  const sizeLabel = document.createElement('output');
  sizeLabel.setAttribute('aria-label', 'Terminal text size');
  let size;
  const preference = () => `cao-terminal-font-v2-${layout.matches ? 'mobile' : 'desktop'}`;
  const defaultSize = () => parseFloat(getComputedStyle(root).getPropertyValue(
    layout.matches ? '--font-size-mobile' : '--font-size-desktop')) || (layout.matches ? 14 : 16);
  function applySize(next) {
    size = Math.min(24, Math.max(12, next));
    root.style.setProperty('--font-size', `${size}px`);
    sizeLabel.textContent = `${size}px`;
    window.dispatchEvent(new Event('cao:font-size'));
  }
  function loadSize() {
    let stored;
    try { stored = localStorage.getItem(preference()); } catch (_) {}
    const parsed = stored == null ? NaN : Number(stored);
    applySize(Number.isFinite(parsed) && parsed >= 12 && parsed <= 24 ? parsed : defaultSize());
  }
  for (const [label, delta] of [['Smaller text', -1], ['Larger text', 1]]) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn';
    button.textContent = delta < 0 ? 'A−' : 'A+';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => {
      applySize(size + delta);
      try { localStorage.setItem(preference(), String(size)); } catch (_) {}
    });
    controls.append(button);
    if (delta < 0) controls.append(sizeLabel);
  }
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'btn'; reset.textContent = 'Reset';
  reset.setAttribute('aria-label', 'Reset text size');
  reset.addEventListener('click', () => {
    try { localStorage.removeItem(preference()); } catch (_) {}
    applySize(defaultSize());
  });
  controls.append(reset);
  layout.addEventListener('change', loadSize);
  loadSize();
  const live = document.createElement('button');
  live.type = 'button'; live.className = 'btn cao-jump-live'; live.textContent = 'Jump to live';
  live.addEventListener('click', () => {
    const pane = window.tmuxState?.paneEls[window.tmuxState.focusedPane];
    pane?.jumpToLive?.();
  });
  headerControls.prepend(live);
  // The restricted resize path owns only this pinned real window.
  window.__caoSendResize = (cols, rows) => {
    const pane = window.tmuxState?.focusedPane;
    if (!window.tmuxWs?.isConnected() || !pane) { window.flashInputError?.('Not connected'); return false; }
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 20 || rows < 6) return false;
    window.tmuxWs.send({ type: 'resize', pane, cols: Math.min(400, Math.floor(cols)), rows: Math.min(200, Math.floor(rows)), takeover: true });
    return true;
  };
  function measureTerminal() {
    const term = window.tmuxState?.paneEls?.[window.tmuxState.focusedPane]?.terminal;
    if (!term || !term.clientWidth || !term.clientHeight) return null;
    const probe = document.createElement('span');
    probe.textContent = '0000000000';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    const style = getComputedStyle(term);
    probe.style.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    term.appendChild(probe);
    const box = probe.getBoundingClientRect(); probe.remove();
    const px = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const py = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const cell = window.caoCell?.measure(term);
    const cw = cell?.w || box.width / 10, ch = cell?.h || parseFloat(style.lineHeight) || box.height;
    if (!(cw > 0 && ch > 0)) return null;
    const cols = Math.floor((term.clientWidth - px) / cw), rows = Math.floor((term.clientHeight - py) / ch);
    return cols >= 20 && rows >= 6 ? { cols: Math.min(400, cols), rows: Math.min(200, rows) } : null;
  }
  const fit = document.createElement('button');
  fit.type = 'button'; fit.className = 'btn cao-fit'; fit.textContent = 'Fit here';
  fit.setAttribute('aria-label', 'Fit the tmux window to this viewer');
  fit.title = 'Take sizing control and fit this terminal window (affects its panes)';
  const autoLabel = document.createElement('label'); autoLabel.className = 'cao-auto-label';
  const auto = document.createElement('input'); auto.type = 'checkbox'; auto.checked = true;
  auto.setAttribute('role', 'switch'); auto.setAttribute('aria-label', 'Auto-fit terminal');
  autoLabel.append(auto, document.createTextNode('Auto-fit'));
  const fitStatus = document.createElement('output'); fitStatus.className = 'cao-fit-status';
  fitStatus.setAttribute('aria-live', 'polite');
  const messages = {
    owned: 'Fits automatically', off: 'Auto-fit off', loading: 'Waiting for layout',
    other_viewer: 'Auto-fit paused · another viewer controls size', shared_window: 'Manual fit only · affects the whole window',
    paused: 'Auto-fit paused', disconnected: 'Waiting for connection', viewport_small: 'Viewport too small to fit',
    resize_unavailable: 'Resize unavailable', target_changed: 'Terminal changed', released: 'Auto-fit paused',
  };
  panel.append(autoLabel, fit, fitStatus);
  const autoFit = window.createCaoAutoFit?.({ measure: measureTerminal, report: state => {
    fitStatus.textContent = messages[state] || 'Auto-fit paused';
  } });
  auto.addEventListener('change', () => autoFit?.setEnabled(auto.checked));
  fit.addEventListener('click', () => {
    if (autoFit) autoFit.fitHere();
    else { const d = measureTerminal(); if (d) window.__caoSendResize(d.cols, d.rows); }
  });
  window.__caoAutoFit = autoFit;
  // Presentation state only: neither the status label nor this hook probes tmux.
  const updatePresentation = () => {
    const panes = Object.values(window.tmuxState?.paneEls || {});
    document.getElementById('app').classList.toggle('cao-single-pane', panes.length === 1);
    live.hidden = !panes.some(p => p.scrolledByUser?.());
    const status = document.getElementById('status');
    const connected = window.tmuxWs?.isConnected();
    status.setAttribute('aria-label', connected ? 'Terminal connected' : 'Terminal disconnected');
    status.title = connected ? 'Viewer transport connected; not agent readiness' : 'Viewer transport disconnected';
  };
  window.addEventListener('cao:panes', updatePresentation);
  window.addEventListener('cao:connection', updatePresentation);
  document.getElementById('pane-container').addEventListener('scroll', updatePresentation, true);
  updatePresentation();

  // A sole authorized window/pane is chosen server-side. Cached UI preferences
  // must not redirect the viewer to an agent it was not launched for.
  const originalSend = window.tmuxWs.send;
  window.tmuxWs.send = (message) => {
    if (message.type === 'focus' && message.pane) {
      parent.postMessage({type: 'cao:terminal-pane', pane: message.pane}, location.origin);
    }
    originalSend(message);
  };
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !input.value && event.target === input) input.blur();
  });
  let sequence = 0;
  const cancelSequence = () => { sequence++; };
  window.addEventListener('cao:terminal-reset', cancelSequence);
  window.addEventListener('cao:key-intent', cancelSequence);
  input.addEventListener('focus', cancelSequence);
  window.addEventListener('blur', cancelSequence);
  // Defaults from each TUI's own documented bindings; CAO never edits keymaps.
  // "input" actions type the command + Enter exactly like the composer.
  const GENERIC_ACTIONS = [
    { name: 'Interrupt · Esc', keys: [['Escape', []]] },
    { name: 'Stop · Ctrl+C', keys: [['c', ['C']]] },
  ];
  const PROVIDER_KEYS = {
    claude_code: {
      label: 'Claude Code',
      actions: [
        { name: 'Models · /model', input: '/model' },
        { name: 'Plan/auto · Shift+Tab', keys: [['BTab', []]] },
        ...GENERIC_ACTIONS,
      ],
    },
    codex: {
      label: 'Codex',
      actions: [
        { name: 'Models · /model', input: '/model' },
        ...GENERIC_ACTIONS,
      ],
    },
    opencode_cli: {
      label: 'OpenCode',
      actions: [
        { name: 'Palette · Ctrl+P', keys: [['p', ['C']]] },
        { name: 'Models · Ctrl+X → M', keys: [['x', ['C']], ['m', []]] },
        { name: 'Next model · F2', keys: [['F2', []]] },
        { name: 'Previous model · Shift+F2', keys: [['F2', ['Shift']]] },
      ],
    },
  };
  const GENERIC_PROVIDERS = {
    hermes: 'Hermes', kiro_cli: 'Kiro', kimi_cli: 'Kimi', gemini_cli: 'Gemini',
    q_cli: 'Q', cursor_cli: 'Cursor', grok_cli: 'Grok', copilot_cli: 'Copilot',
    antigravity_cli: 'Antigravity', omp: 'OMP', mcode: 'MiniMax',
  };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'cao:terminal-context') return;
    document.getElementById('cao-provider-keys')?.remove();
    const provider = event.data.provider;
    const known = PROVIDER_KEYS[provider];
    const group = known ?? { label: GENERIC_PROVIDERS[provider] || 'Terminal', actions: GENERIC_ACTIONS };
    const box = document.createElement('div');
    box.id = 'cao-provider-keys'; box.className = 'cao-provider-keys';
    const label = document.createElement('span');
    label.textContent = `${group.label} keys`;
    box.append(label);
    for (const action of group.actions) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ek'; button.textContent = action.name;
      button.addEventListener('click', async () => {
        const pane = window.tmuxState.focusedPane;
        if (action.input != null) {
          if (!window.tmuxWs?.isConnected() || !pane) return;
          window.tmuxWs.send({ type: 'input', pane, text: action.input,
            nonce: (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`) });
          return;
        }
        const ticket = ++sequence;
        for (const [key, modifiers] of action.keys) {
          if (ticket !== sequence || !window.tmuxWs.isConnected() || pane !== window.tmuxState.focusedPane) return;
          window.sendEk(key, modifiers, true, true);
          if (action.keys.length > 1) await new Promise(resolve => setTimeout(resolve, 100));
        }
      });
      box.append(button);
    }
    const drawer = document.getElementById('extra-keys');
    drawer.querySelector('.cao-key-help')?.after(box);
    drawer.scrollTop = 0;
  });
  // Direct keyboard passthrough for physical keyboards (desktop browsers)
  // and the on-screen keyboard on touch layouts, which needs a real focused
  // input to open. Explicitly toggled; the message composer keeps working
  // when focused.
  let directKeys = false;
  const coarsePointer = matchMedia('(pointer: coarse)');
  const funnel = document.createElement('input');
  funnel.id = 'cao-direct-funnel';
  funnel.type = 'text';
  funnel.setAttribute('aria-label', 'Terminal direct typing');
  funnel.setAttribute('autocapitalize', 'off');
  funnel.setAttribute('autocomplete', 'off');
  funnel.setAttribute('autocorrect', 'off');
  funnel.setAttribute('spellcheck', 'false');
  funnel.setAttribute('enterkeyhint', 'send');
  funnel.tabIndex = -1; // focused only programmatically, never in Tab order
  document.querySelector('footer').append(funnel);
  const DIRECT_SPECIAL = {
    Enter: 'Enter', Backspace: 'BSpace', Delete: 'DC', Insert: 'IC', Escape: 'Escape',
    Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage',
  };
  document.addEventListener('keydown', (e) => {
    if (!directKeys) return;
    const target = e.target instanceof Element ? e.target : null;
    // The funnel is the direct-mode on-screen keyboard source; other
    // inputs/editables/controls keep their normal keyboard behavior.
    const funneling = target === funnel;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !e.altKey && !funneling && target?.closest('.pane-terminal, body') && !target?.closest('input, textarea, button, a, dialog')) funnel.focus({ preventScroll: true });
    if (target && !funneling && (target.isContentEditable || target.closest('input, textarea, select, button, a, [role="button"], [contenteditable]:not([contenteditable="false"])'))) return;
    if (e.isComposing || e.keyCode === 229) return;
    const key = e.key;
    if (['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Process', 'CapsLock', 'NumLock', 'ScrollLock', 'Unidentified'].includes(key)) return;
    // Browser copy/paste must run before terminal Ctrl-letter dispatch.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key.toLowerCase() === 'v' || key.toLowerCase() === 'c' && (e.shiftKey || window.getSelection()?.toString()))) return;
    if (e.metaKey) return; // OS/browser combinations stay native
    // Never swallow tab/window management, reload, or devtools keys.
    if ((e.ctrlKey || e.metaKey) && ['w', 't', 'n'].includes(key.toLowerCase()) && !e.altKey) return;
    if (key === 'F5' || key === 'F11' || key === 'F12') return;
    let send, mods;
    if (key.length === 1) {
      // e.key already carries Shift for printable characters (Shift+p → "P").
      send = key;
      mods = [e.ctrlKey && 'C', e.altKey && 'M'].filter(Boolean);
    } else if (DIRECT_SPECIAL[key] || /^F([1-9]|1[0-2])$/.test(key)) {
      send = DIRECT_SPECIAL[key] || key;
      mods = [e.ctrlKey && 'C', e.altKey && 'M', e.shiftKey && 'Shift'].filter(Boolean);
    } else {
      return; // unknown browser keys stay native
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    window.sendEk(send, mods, true);
    // preventDefault suppresses the follow-up input event; clear any text a
    // keyboard inserted before the keydown reached us.
    if (funneling) funnel.value = '';
  }, true);
  // On-screen keyboards (Gboard/SwiftKey) emit keyCode-229 keydowns and
  // deliver text only through input/composition events on the funnel.
  let composingText = false, compositionPane = '';
  const canType = () => directKeys && window.tmuxWs?.isConnected() && !!window.tmuxState?.focusedPane;
  funnel.addEventListener('compositionstart', () => { composingText = true; compositionPane = canType() ? window.tmuxState.focusedPane : ''; });
  funnel.addEventListener('compositionend', () => {
    composingText = false;
    const text = funnel.value; funnel.value = '';
    if (!canType() || !compositionPane || compositionPane !== window.tmuxState.focusedPane) { compositionPane = ''; return; }
    compositionPane = '';
    for (const ch of text) {
      if (ch === '\n') window.sendEk('Enter', [], true);
      else if (ch >= ' ') window.sendEk(ch, [], true);
    }
  });
  funnel.addEventListener('input', (e) => {
    if (!canType()) { funnel.value = ''; return; }
    if (composingText) return; // interim IME text is sent once, at compositionend
    // Single-line value sanitization strips newlines: Enter arrives as an
    // input type, never as a character in funnel.value.
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertNewline') {
      funnel.value = '';
      window.sendEk('Enter', [], true);
      return;
    }
    const deletes = e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward'
      || e.inputType === 'deleteContentForward';
    const text = funnel.value; funnel.value = '';
    if (deletes) { window.sendEk('BSpace', [], true); return; }
    for (const ch of text) {
      if (ch === '\n') window.sendEk('Enter', [], true);
      else if (ch >= ' ') window.sendEk(ch, [], true); // control chars dropped
    }
  });
  const clearDirectComposition = () => { composingText = false; compositionPane = ''; funnel.value = ''; funnel.blur(); };
  window.addEventListener('cao:terminal-reset', clearDirectComposition);
  window.addEventListener('pagehide', clearDirectComposition);
  funnel.addEventListener('focus', () => { if (!canType()) funnel.blur(); });
  window.caoDirectTapToType = pane => {
    if (!canType() || !coarsePointer.matches || composingText || pane !== window.tmuxState.focusedPane) return;
    if (window.getSelection()?.toString()) return;
    // Dismissing a phone keyboard can leave its input focused. A synchronous
    // blur/refocus in this genuine user gesture requests the keyboard again.
    if (document.activeElement === funnel && !(window.__caoViewport?.keyboardHeight > 0)) funnel.blur();
    if (document.activeElement !== funnel) funnel.focus({ preventScroll: true });
  };
  coarsePointer.addEventListener?.('change', mq => {
    if (!mq.matches && document.activeElement === funnel) funnel.blur();
  });
  const toolbar = document.querySelector('.footer-top');
  const directLayout = matchMedia('(max-width:600px), (max-height:500px)');
  const directToggle = document.createElement('button');
  directToggle.type = 'button';
  directToggle.className = 'ek cao-direct-toggle';
  directToggle.textContent = 'Direct keys';
  directToggle.setAttribute('aria-pressed', 'false');
  directToggle.setAttribute('aria-describedby', 'cao-direct-hint');
  const directTitle = () => coarsePointer.matches
    ? 'Type straight into the terminal; opens your keyboard'
    : 'Type straight into the terminal from your keyboard';
  directToggle.title = directTitle();
  coarsePointer.addEventListener?.('change', () => { directToggle.title = directTitle(); });
  const directHint = document.createElement('span');
  directHint.id = 'cao-direct-hint';
  directHint.className = 'cao-direct-hint';
  directHint.setAttribute('role', 'status');
  directHint.hidden = true;
  const updateDirectPresentation = () => {
    document.getElementById('app').classList.toggle('cao-direct-active', directKeys);
    directToggle.setAttribute('aria-pressed', String(directKeys));
    directHint.hidden = !directKeys;
    directHint.textContent = coarsePointer.matches
      ? 'Tap the terminal to type. Turn Direct keys off to compose a message.'
      : 'Keyboard → terminal. Turn Direct keys off to compose a message.';
  };
  coarsePointer.addEventListener?.('change', updateDirectPresentation);
  updateDirectPresentation();
  directToggle.addEventListener('click', () => {
    directKeys = !directKeys;
    updateDirectPresentation();
    if (directKeys) {
      input.blur(); directToggle.blur();
      // Same user gesture: focusing a real input opens the on-screen keyboard.
      if (coarsePointer.matches && canType()) funnel.focus({ preventScroll: true });
    } else { clearDirectComposition(); }
    window.dispatchEvent(new Event('cao:terminal-layout'));
  });
  function placeDirect() {
    if (directLayout.matches) headerControls.prepend(directToggle);
    else toolbar.prepend(directToggle);
  }
  directLayout.addEventListener('change', placeDirect);
  placeDirect();
  toolbar.after(directHint);
  // Reuse the same nodes/listeners; only secondary quick actions move into
  // Keys on compact layouts. Root shortcuts stay beside arrows and Keys.
  const quickActions = document.querySelector('.quick-actions');
  const quickKeys = [...quickActions.querySelectorAll('.qbtn[data-key]')];
  const compactGroup = document.createElement('div'); compactGroup.className = 'cao-compact-keys';
  document.getElementById('extra-keys').prepend(compactGroup);
  function placeCompactKeys() {
    for (const button of quickKeys) {
      if (directLayout.matches) {
        if (!button.hasAttribute('data-root-shortcut')) compactGroup.append(button);
      } else quickActions.insertBefore(button, quickActions.querySelector('[data-ek]'));
    }
  }
  directLayout.addEventListener('change', placeCompactKeys);
  placeCompactKeys();
  // Inline upstream decorative colors do not belong to terminal chrome. Never
  // strip colors inside pane-terminal: those are the real agent's ANSI output.
  document.querySelectorAll('#extra-keys button').forEach(button => button.style.removeProperty('color'));
  // Upstream already owns visualViewport/--kb-height. No second keyboard offset.
})();
