/**
 * autocomplete.js — Enhanced autocomplete with / and @ triggers
 * Scans Claude Code skills, commands, agents, MCP servers via HTTP API
 */

(function() {
  const acList = document.getElementById('ac-list');
  const inputEl = document.getElementById('input');
  let acIdx = -1;
  let acItems = [];
  let debounceTimer = null;
  let currentToken = null;

  const basePath = location.pathname.replace(/\/+$/, '') || '';

  // ── Token detection ──

  // Pure: classify the token ending at cursor. Split out from the DOM so
  // node --test can exercise the trigger rules directly.
  function tokenAt(text, cursor) {
    // Walk backward from cursor to find token start
    let start = cursor;
    while (start > 0 && text[start - 1] !== ' ' && text[start - 1] !== '\n') {
      start--;
    }

    const token = text.substring(start, cursor);
    if (!token) return null;

    // Path patterns
    if (token.startsWith('~/') || token.startsWith('./')) {
      return { type: 'path', query: token, start, end: cursor };
    }

    // Slash trigger → skills + commands
    if (token.startsWith('/') && !token.includes('/', 1)) {
      return { type: 'slash', query: token, start, end: cursor };
    }

    // @ trigger → agents + MCP servers + files
    if (token.startsWith('@')) {
      return { type: 'at', query: token, start, end: cursor };
    }

    // Bare-word shortcut trigger — the user's own command set (yazi,
    // lazygit, …). Only the FIRST token of the input (start 0): shortcuts
    // are things you launch, not words mid-sentence, and this keeps the
    // menu out of ordinary prose. Min 2 chars; '/' means a path, not a
    // keyword.
    if (start === 0 && token.length >= 2 && !token.includes('/')) {
      return { type: 'shortcut', query: token, start, end: cursor };
    }

    return null;
  }

  function getTokenAtCursor() {
    const text = inputEl.value;
    const cursor = inputEl.selectionStart ?? text.length;
    return tokenAt(text, cursor);
  }

  // ── API call ──

  async function fetchCompletions(query, type) {
    try {
      const params = new URLSearchParams({ q: query, type });
      // "@" completes files relative to the focused pane's cwd — the CLI in
      // that pane is what will resolve the inserted @path.
      const pane = window.tmuxState?.focusedPane;
      if (pane) params.set('pane', pane);
      const res = await fetch(`${basePath}/api/autocomplete?${params}`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  // ── Render ──

  function acOpen(items) {
    acItems = items;
    acList.innerHTML = '';

    items.forEach((item, i) => {
      const div = document.createElement('div');
      div.className = 'ac-item' + (i === acIdx ? ' active' : '');

      const icon = document.createElement('span');
      icon.className = 'ac-icon';
      icon.textContent = item.icon || (item.type === 'path' ? '/' : '/');
      div.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'ac-name';
      name.textContent = item.display_name || item.name;
      div.appendChild(name);

      if (item.description) {
        const desc = document.createElement('span');
        desc.className = 'ac-desc';
        desc.textContent = item.description;
        div.appendChild(desc);
      }

      const badge = document.createElement('span');
      badge.className = 'ac-badge ' + (item.type || '');
      badge.textContent = item.type || '';
      div.appendChild(badge);

      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        acSelect(item);
      });
      acList.appendChild(div);
    });

    acList.classList.toggle('open', items.length > 0);
  }

  function acClose() {
    acList.classList.remove('open');
    acIdx = -1;
    acItems = [];
    currentToken = null;
  }

  // Pure: what text a picked suggestion becomes in the input buffer.
  // "builtin" names arrive without the leading "/" (builtin.go strips it),
  // exactly like skills/commands — all three are slash-invocable.
  function buildReplacement(item) {
    if (item.type === 'skill' || item.type === 'command' || item.type === 'builtin') {
      return '/' + item.name + ' ';
    }
    if (item.type === 'agent' || item.type === 'mcp' || item.type === 'file') {
      return '@' + item.name + ' ';
    }
    if (item.type === 'shortcut') {
      // Verbatim — the insert field carries the full command/prompt,
      // including any trailing space the user wants.
      return item.insert || item.name;
    }
    return item.name;
  }

  function acSelect(item) {
    if (!currentToken) { acClose(); return; }

    const text = inputEl.value;
    const replacement = buildReplacement(item);

    const before = text.substring(0, currentToken.start);
    const after = text.substring(currentToken.end);
    inputEl.value = before + replacement + after;
    const newCursor = currentToken.start + replacement.length;
    inputEl.selectionStart = inputEl.selectionEnd = newCursor;
    inputEl.focus();
    acClose();
  }

  // ── Filter logic ──

  async function acFilter() {
    const val = inputEl.value;
    if (!val || val.includes('\n')) { acClose(); return; }

    const token = getTokenAtCursor();
    if (!token) { acClose(); return; }

    currentToken = token;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const results = await fetchCompletions(token.query, token.type);
      if (results.length === 0) {
        acClose();
        return;
      }
      acIdx = -1;
      acOpen(results);
    }, 80);
  }

  // ── Keyboard navigation ──

  inputEl.addEventListener('keydown', (e) => {
    // Enter selecting an IME candidate is not message submission (Safari may
    // report keyCode 229 without isComposing on the final composing keydown).
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (acList.classList.contains('open')) {
      const items = acList.querySelectorAll('.ac-item');

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        acIdx = Math.min(acIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('active', i === acIdx));
        items[acIdx]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        acIdx = Math.max(acIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === acIdx));
        items[acIdx]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && acIdx >= 0)) {
        e.preventDefault();
        if (acItems[acIdx]) acSelect(acItems[acIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        acClose();
        return;
      }
    }

    // Normal Enter → send input
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      acClose();
      window.sendInput?.();
    }
  });

  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    acFilter();
  });

  inputEl.addEventListener('blur', () => setTimeout(acClose, 150));

  // Expose
  window.acClose = acClose;
  window.__acTest = { buildReplacement, tokenAt };
})();
