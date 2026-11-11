/* User-gesture clipboard handling; no remote OS clipboard or automatic submit. */
(() => {
  const composer = document.getElementById('input');
  const status = document.createElement('output'); status.className = 'cao-clipboard-status'; status.setAttribute('role', 'status');
  document.querySelector('footer').append(status);
  let statusTimer;
  const showStatus = text => { clearTimeout(statusTimer); status.textContent = text; if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, 6000); };
  window.caoClipboardStatus = showStatus;
  const direct = () => document.getElementById('app').classList.contains('cao-direct-active');
  const pending = new Map();
  const context = () => ({ pane: window.tmuxState?.focusedPane, socket: window.tmuxWs?.connectionId?.() });
  function valid(c) { return c.pane && c.pane === window.tmuxState?.focusedPane && window.tmuxWs?.isConnected() && c.socket === window.tmuxWs?.connectionId?.(); }
  function putDraft(text) {
    if (direct()) document.querySelector('.cao-direct-toggle').click();
    composer.setRangeText(text, composer.selectionStart, composer.selectionEnd, 'end');
    composer.dispatchEvent(new Event('input', { bubbles: true })); composer.focus({ preventScroll: true });
  }
  function sendPaste(text, c = context(), confirmed = false) {
    if (!valid(c)) { status.textContent = 'Target changed or disconnected. Nothing was pasted.'; return false; }
    if (new TextEncoder().encode(text).length > 60000) { status.textContent = 'Paste is too large (maximum 60,000 UTF-8 bytes).'; return false; }
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) { status.textContent = 'Paste contains unsupported controls (including carriage return or Escape). Nothing was sent.'; return false; }
    if (/[\n\t]/.test(text)) {
      const snapshot = window.tmuxState.paneEls[c.pane]?.screenController?.snapshot;
      if (!snapshot?.bracket_paste) { showPreview(text, c, false); return false; }
      if (!confirmed) { showPreview(text, c, true); return false; }
    }
    const nonce = crypto.randomUUID();
    pending.set(nonce, { c, timeout: setTimeout(() => { pending.delete(nonce); status.textContent = 'Paste delivery uncertain. Inspect terminal before retrying.'; }, 8000) });
    window.tmuxWs.send({ type: 'paste', pane: c.pane, text, nonce });
    status.textContent = 'Pasting…'; return true;
  }
  function showPreview(text, c, allowed) {
    const dialog = document.createElement('dialog'); dialog.className = 'cao-paste-dialog';
    const title = document.createElement('h2'); title.textContent = 'Review pasted text';
    const note = document.createElement('p'); note.textContent = allowed ? 'Multiline paste can have application-specific effects. Paste does not press Enter.' : 'This tmux target cannot confirm bracketed paste. Use the editable composer for multiline text.';
    const preview = document.createElement('textarea'); preview.value = text; preview.readOnly = true; preview.setAttribute('aria-label', 'Paste preview');
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
    const draft = document.createElement('button'); draft.textContent = 'Use composer'; draft.onclick = () => { if (valid(c)) putDraft(text); dialog.close(); };
    dialog.append(title, note, preview, cancel, draft);
    if (allowed) { const paste = document.createElement('button'); paste.textContent = 'Paste text'; paste.onclick = () => { sendPaste(text, c, true); dialog.close(); }; dialog.append(paste); }
    dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
  }
  document.addEventListener('copy', e => {
    const selection = getSelection();
    if (selection?.toString() && document.querySelector('.pane-terminal')?.contains(selection.anchorNode) && e.clipboardData) {
      e.clipboardData.setData('text/plain', selection.toString()); e.preventDefault();
    }
  });
  window.caoPasteText = sendPaste;
  window.addEventListener('cao:input-ack', e => {
    const item = pending.get(e.detail.nonce); if (!item) return;
    clearTimeout(item.timeout); pending.delete(e.detail.nonce);
    showStatus(e.detail.ok ? 'Pasted. Press Enter only when ready.' : e.detail.message || 'Paste delivery uncertain. Inspect terminal.');
  });
  window.addEventListener('cao:terminal-reset', () => { for (const p of pending.values()) clearTimeout(p.timeout); pending.clear(); });
  document.addEventListener('paste', e => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('dialog') || !window.tmuxWs?.isConnected()) return;
    if (target?.closest('input, textarea, [contenteditable]') && target !== composer && target.id !== 'cao-direct-funnel') return;
    const files = [...(e.clipboardData?.items || [])].filter(x => x.kind === 'file').map(x => x.getAsFile()).filter(Boolean);
    const text = e.clipboardData?.getData('text/plain') || '';
    if (files.length) { e.preventDefault(); window.caoAttachImages?.(files); if (text) direct() ? sendPaste(text) : putDraft(text); return; }
    if (direct() && text && (target?.id === 'cao-direct-funnel' || target?.closest('.pane-terminal') || target === document.body)) {
      e.preventDefault(); e.stopImmediatePropagation(); sendPaste(text);
    }
  }, true);
  for (const [label, action] of [
    ['Copy', async () => { const text = getSelection()?.toString(); if (!text) { status.textContent = 'Select terminal text first.'; return; } await navigator.clipboard.writeText(text); status.textContent = 'Copied.'; }],
    ['Paste', async () => {
      const c = context(), wasDirect = direct();
      const apply = (text, files = []) => {
        if (!valid(c) || wasDirect !== direct()) { showStatus('Target or input mode changed. Nothing was pasted.'); return; }
        if (files.length) window.caoAttachImages?.(files);
        if (text) wasDirect ? sendPaste(text, c) : putDraft(text);
      };
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read(); const files = []; let text = '';
        for (const item of items) { const type = item.types.find(t => /^image\/(png|jpeg|webp)$/.test(t)); if (type) files.push(new File([await item.getType(type)], 'clipboard', { type })); if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text(); }
        apply(text, files);
      } else { apply(await navigator.clipboard.readText()); }
    }],
  ]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ek cao-clipboard-button'; button.textContent = label;
    button.addEventListener('pointerdown', e => { if (label === 'Copy') e.preventDefault(); });
    button.onclick = () => Promise.resolve(action()).catch(() => { status.textContent = `${label} unavailable. Use the browser clipboard menu or Attach image.`; });
    document.querySelector('.quick-actions').append(button);
  }
})();
