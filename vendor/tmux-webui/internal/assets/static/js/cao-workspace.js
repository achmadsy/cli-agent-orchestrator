/* CAO composition hooks: lifecycle stays in the parent application. */
(() => {
  const input = document.getElementById('input');
  input.setAttribute('aria-label', 'Message the active agent');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  document.querySelector('header h1').textContent = 'Terminal workspace';
  document.getElementById('send-btn').setAttribute('aria-label', 'Send message to active agent');

  const controls = document.createElement('div');
  controls.className = 'cao-reading-controls';
  controls.setAttribute('aria-label', 'Terminal reading controls');
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
    if (pane?.terminal) { pane.terminal.scrollTop = pane.terminal.scrollHeight; pane.terminal.dispatchEvent(new Event('scroll')); }
  });
  controls.append(live);
  // A pane last used from a phone keeps phone columns, so its text wraps on a
  // wide screen no matter the font size. Explicit, one-shot geometry sync for
  // this terminal's own window; automatic fitting stays disabled.
  window.__caoSendResize = (cols, rows) => {
    const pane = window.tmuxState?.focusedPane;
    if (!window.tmuxWs?.isConnected() || !pane) { window.flashInputError?.('Not connected'); return false; }
    const c = Math.min(400, Math.max(20, Math.round(cols)));
    const r = Math.min(200, Math.max(6, Math.round(rows)));
    window.tmuxWs.send({ type: 'resize', pane, cols: c, rows: r });
    return true;
  };
  const fit = document.createElement('button');
  fit.type = 'button'; fit.className = 'btn cao-fit'; fit.textContent = 'Fit terminal';
  fit.setAttribute('aria-label', 'Fit the tmux window to this viewer');
  fit.title = 'Match the terminal width to this window (fixes mobile-width wrapping)';
  fit.addEventListener('click', () => {
    const entry = window.tmuxState?.paneEls?.[window.tmuxState.focusedPane];
    const term = entry?.terminal;
    if (!term || !window.__caoSendResize) { window.flashInputError?.('No terminal'); return; }
    const probe = document.createElement('span');
    probe.textContent = '0000000000';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    const style = getComputedStyle(term);
    // Longhands, not the `font` shorthand: Chromium returns "" for computed
    // font whenever any longhand is non-default, and assigning "" is a no-op.
    probe.style.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    term.appendChild(probe);
    const box = probe.getBoundingClientRect();
    probe.remove();
    const cs = getComputedStyle(term);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const cellW = box.width / 10, cellH = parseFloat(cs.lineHeight) || box.height || cellW * 2;
    const cols = (term.clientWidth - padX) / (cellW || 1);
    const rows = (term.clientHeight - padY) / (cellH || 1);
    if (cols < 20 || rows < 6) { window.flashInputError?.('Viewport too small'); return; }
    window.__caoSendResize(cols, rows);
  });
  controls.append(fit);
  document.querySelector('.header-controls').prepend(controls);

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
  // Upstream already owns visualViewport/--kb-height. No second keyboard offset.
})();
