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
  for (const [label, delta] of [['Smaller text', -1], ['Larger text', 1]]) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn';
    button.textContent = delta < 0 ? 'A−' : 'A+';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => {
      const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-size')) || 14;
      const next = Math.min(24, Math.max(12, current + delta));
      document.documentElement.style.setProperty('--font-size', `${next}px`);
      try { localStorage.setItem('tmux-webui-font-size', String(next)); } catch (_) {}
    });
    controls.append(button);
  }
  const live = document.createElement('button');
  live.type = 'button'; live.className = 'btn cao-jump-live'; live.textContent = 'Jump to live';
  live.addEventListener('click', () => {
    const pane = window.tmuxState?.paneEls[window.tmuxState.focusedPane];
    if (pane?.terminal) { pane.terminal.scrollTop = pane.terminal.scrollHeight; pane.terminal.dispatchEvent(new Event('scroll')); }
  });
  controls.append(live);
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
  // Upstream already owns visualViewport/--kb-height. No second keyboard offset.
})();
