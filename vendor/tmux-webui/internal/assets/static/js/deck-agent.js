// deck-agent.js — Agent Deck: the deck-mode v2 control surface.
//
// Ported from the claude.ai/design "Agent Deck" mock (profile rail · key grid ·
// touch strip · dials) and wired to the REAL tmux-webui data paths instead of
// the mock's simulated sessions:
//   - state/menu/status  -> window.deckDetect (read-only, calibrated to real CC TUI)
//   - sends              -> window.sendSkillOrAction / window.tmuxWs / window.runMacro
//   - irreversible sends -> window.deckConfirm (slide-to-confirm gate)
//   - per-window lights  -> pane_states WS frames (forwarded by deck.js)
//   - PROMPT page keys   -> /api/deck config (claude-idle + claude-macros panels)
// One renderer, two layouts:
//   fullscreen (#app.deck-mode) — the device frame, fluid to the viewport
//   compact    (#app.deck-dock) — the dock column: page tabs · mini strip ·
//     permission pills (deck-slider) · key grid · scrollback scrub (deck-dial).
//     The terminal stays visible in dock, so the strip drops the tail-line/bar
//     (deck.md: status the user already reads isn't duplicated).
// 100% additive: renders only into #deck-root while a deck mode is active and
// deck.js delegates here; stop() restores the root for the legacy renderer.
//
// Slice C adds an on-device editor (rail ✎ toggle → deck-editor.js sheets):
// buttons-page keys and rail tabs become tappable-to-edit; each edit builds a
// candidate clone of cfg.pages and persists it via PUT /api/deck, swapping the
// live cfg to the server's response ONLY on success (a failed save is a no-op,
// so a cancelled/rejected edit can never silently persist on the next save).
// ponytail: reorder is up/down buttons (no drag), ctrl/windows computed keys stay
// non-editable, undo leans on deck.json.bak, and multi-device conflicts are
// last-write-wins — add drag-sort / an undo UI if hand-editing proves painful.
(function () {
  'use strict';

  var root = null;
  var cfg = { panels: [] };
  var timer = null;
  var page = 'ctrl';
  var editMode = false;      // Slice C: rail ✎ toggles page/button edit sheets
  var compact = false;       // dock layout (set per start(); fullscreen = false)
  var paneStates = {};       // { windowIndex: working|waiting|idle|unknown } (SESS LEDs)
  var panePaneStates = {};   // { paneId: state } — backend per-pane truth (strip + waiting count)
  var toastT = null;
  var waitPanelEl = null;    // I2 triage overlay (body-level, like deck-edit); null = closed
  var waitSig = null;        // triage row-render signature (skip DOM churn on unchanged ticks)
  // grid hysteresis (mirrors deck.js): a new signature must persist 2 polls
  var renderedSig = null, candidate = null, candidateCount = 0;
  var stripSig = null, dialSig = null, headSig = null;

  var MODELS = ['sonnet', 'opus', 'haiku'];
  var PERM_MODES = ['default', 'accept', 'plan', 'auto'];

  // ── i18n ────────────────────────────────────────────────────────────────────
  // 繁體中文為主、英文可切換。T(zh,en) 行內雙語（呼叫點即字典，不用 key 間接層）；
  // 語言存 localStorage 'deck-lang'（deck-confirm.js 讀同一把）。deck.json 按鈕走
  // 資料層：label = 繁中（既有欄位），label_en 選用；缺 label_en 時 EN 模式回退繁中。
  var LANG = localStorage.getItem('deck-lang') === 'en' ? 'en' : 'zh';
  function T(zh, en) { return LANG === 'en' ? en : zh; }
  function btnLabel(b) { return (LANG === 'en' && b.label_en) ? b.label_en : (b.label || ''); }
  function setLang(l) {
    if (l === LANG) return;
    LANG = l;
    try { localStorage.setItem('deck-lang', l); } catch (e) {}
    // full rebuild: every label source is re-evaluated at render time
    renderedSig = null; candidate = null; candidateCount = 0;
    stripSig = null; dialSig = null; headSig = null;
    build();
    tick();
  }
  function langBtn() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'dka-x dka-lang';
    b.textContent = T('EN', '中');
    b.title = T('切換英文介面', 'Switch to Traditional Chinese');
    b.addEventListener('click', function () { setLang(LANG === 'zh' ? 'en' : 'zh'); });
    return b;
  }

  function statusText(state) {
    switch (state) {
      case 'working': return T('執行中', 'RUNNING');
      case 'waiting': return T('等你回覆', 'NEEDS YOU');
      case 'idle':    return T('待命', 'IDLE');
    }
    return '—';
  }

  // ── pages model ──────────────────────────────────────────────────────────
  // Rail tabs are data: cfg.pages (served by /api/deck → default.json, with the
  // user file authoritative). BUILTIN_PAGES is the fallback used ONLY when
  // /api/deck is unreachable (deck.js hands us {panels:[]}); it relocates the
  // former hardcoded SLASH/GIT arrays into config-shaped button objects.
  // win/ctrl are frontend-computed (buttons ignored); the prompt fallback is
  // intentionally empty — that mirrors the old empty-panels path; the real
  // 12-button union ships in default.json's prompt page.
  // ponytail: this mirrors static/deck/default.json slash+git; if the two drift
  // the live config wins — the constant only surfaces on a dead fetch.
  function mac(payload) {
    return { type: 'macro', steps: [
      { type: 'input', payload: payload }, { type: 'key', payload: 'Enter' }
    ], delays: { inter: 300 } };
  }
  var BUILTIN_PAGES = [
    { id: 'win',  type: 'windows', glyph: '⊞', label: '窗口', label_en: 'WIN' },
    { id: 'ctrl', type: 'ctrl',    glyph: '◎', label: '控制', label_en: 'CTRL' },
    { id: 'prompt', type: 'buttons', glyph: '»', label: '快捷', label_en: 'PROMPT', buttons: [] },
    { id: 'slash', type: 'buttons', glyph: '/', label: '指令', label_en: 'SLASH', buttons: [
      { label: '切換模型',     label_en: 'sonnet/opus', icon: '❖', action: mac('/model') },
      { label: '費用統計',     label_en: 'tokens $',    icon: '$', action: mac('/cost') },
      { label: 'context 用量', label_en: 'window',      icon: '◔', action: mac('/context') },
      { label: '審查 PR',      label_en: 'PR',          icon: '⌕', action: mac('/review') },
      { label: 'MCP 伺服器',   label_en: 'servers',     icon: '⬡', action: mac('/mcp') },
      { label: '子代理',       label_en: 'subagents',   icon: '⧉', action: mac('/agents') },
      { label: '接續會話',     label_en: 'session',     icon: '☰', action: mac('/resume') },
      { label: '壓縮摘要',     label_en: 'summarize',   icon: '⌗', action: mac('/compact') },
      { label: '指令說明',     label_en: 'commands',    icon: '?', action: mac('/help') },
      { label: '清空對話',     label_en: 'reset',       icon: '⌫', color: 'danger', confirm: 'slide', action: mac('/clear') }
    ] },
    { id: 'git', type: 'buttons', glyph: '⎇', label: 'GIT', label_en: 'GIT', buttons: [
      { label: '狀態',     label_en: 'STATUS',    icon: 'ℹ', action: mac('git status') },
      { label: '差異',     label_en: 'DIFF',      icon: '±', action: mac('git diff') },
      { label: '全部暫存', label_en: 'STAGE ALL', icon: '⊕', action: mac('stage all') },
      { label: '提交',     label_en: 'COMMIT',    icon: '●', color: 'warn', action: mac('commit') },
      { label: '推送',     label_en: 'PUSH',      icon: '↥', color: 'warn', confirm: 'slide', action: mac('push origin') },
      { label: '拉取',     label_en: 'PULL',      icon: '↧', action: mac('pull latest') },
      { label: '開分支',   label_en: 'BRANCH',    icon: '⎇', action: mac('new branch') },
      { label: '暫置',     label_en: 'STASH',     icon: '▤', action: mac('stash') },
      { label: '歷史',     label_en: 'LOG',       icon: '☰', action: mac('git log') },
      { label: '回滾上筆', label_en: 'REVERT',    icon: '⟲', color: 'danger', confirm: 'slide', action: mac('revert last') }
    ] }
  ];

  // drill-down (windows page → pane picker): internal UI state, never persisted.
  var drillWindow = null;   // window index drilled into (null = window list)
  var drillPanes = null;    // fetched pane array for drillWindow (null = loading)

  function pages() { return (cfg.pages && cfg.pages.length) ? cfg.pages : BUILTIN_PAGES; }
  function visiblePages() { return pages().filter(function (p) { return p && !p.hidden; }); }
  function pageById(id) {
    var ps = pages();
    for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
    return null;
  }
  function pageLabel(p) { return (LANG === 'en' && p.label_en) ? p.label_en : (p.label || p.id || ''); }
  function firstWindowsPageId() {
    var ps = visiblePages();
    for (var i = 0; i < ps.length; i++) if (ps[i].type === 'windows') return ps[i].id;
    return null;
  }
  function basePath() { return location.pathname.replace(/\/+$/, '') || ''; }

  // ── deck editor (Slice C): persist edits via PUT /api/deck ────────────────
  // Edits are NEVER applied to the live cfg optimistically. Each handler builds a
  // candidate clone of the effective pages (clonePages), mutates the clone, then
  // PUTs it; cfg is swapped to the server's response ONLY on success. A failed
  // save (network blip, atomic-write error, or a 400 from validateDeckConfig)
  // leaves cfg exactly as it was — so a cancelled/rejected edit can never silently
  // persist on a later save, and an over-limit button can't wedge the editor.
  // clonePages seeds from pages() so a first edit on the dead-fetch fallback
  // persists the full BUILTIN_PAGES set (materialized only once the PUT succeeds).
  function clonePages() { return JSON.parse(JSON.stringify(pages())); }
  function findPage(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  // saveConfig PUTs the full config with `candidate` as the pages payload (panels/
  // version/$schema carried from the current cfg). On 200 it swaps cfg to the
  // server echo (authoritative, post by-id merge); if the echo is unusable it
  // commits the candidate we just persisted. On any error cfg is untouched.
  function saveConfig(candidate, onOk, onErr) {
    var body = { version: cfg.version || 2, pages: candidate || cfg.pages || [], panels: cfg.panels || [] };
    if (cfg.$schema) body['$schema'] = cfg.$schema;
    fetch(basePath() + '/api/deck', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(
          function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); },
          function () { throw new Error('HTTP ' + r.status); });
      }
      return r.json();
    }).then(function (merged) {
      if (merged && (merged.pages || merged.panels)) cfg = merged;
      else if (candidate) cfg.pages = candidate;
      if (onOk) onOk();
    }).catch(function (e) {
      if (onErr) onErr((e && e.message) || String(e));
    });
  }
  // afterSave: close the sheet, repaint rail + grid, confirm toast.
  function afterSave(ctx) {
    if (ctx && ctx.close) ctx.close();
    renderRail();
    forceRetick();
    toast(T('已儲存', 'saved'), 'green');
  }

  function openButtonSheet(pageId, idx) {
    if (!window.deckEditor) return;
    var pg = pageById(pageId);
    if (!pg) return;
    var isNew = (idx == null);
    var btn = isNew ? {} : JSON.parse(JSON.stringify((pg.buttons && pg.buttons[idx]) || {}));
    window.deckEditor.showButton({
      button: btn, isNew: isNew,
      onSave: function (nb, ctx) {
        var next = clonePages();
        var np = findPage(next, pageId);
        if (!np) { ctx.error('page not found'); return; }
        if (!np.buttons) np.buttons = [];
        if (isNew) {
          np.buttons.push(nb);
        } else {
          // 保留 schema 外欄位（如 default.json 按鈕的 title tooltip）：
          // 先清掉表單可編輯欄再蓋上收集值，未知欄位原樣跟著走
          var orig = np.buttons[idx] || {};
          ['label', 'label_en', 'icon', 'color', 'confirm', 'action'].forEach(function (k) { delete orig[k]; });
          np.buttons[idx] = Object.assign(orig, nb);
        }
        saveConfig(next, function () { afterSave(ctx); }, function (msg) { ctx.error(msg); });
      },
      onDelete: isNew ? null : function (ctx) {
        var next = clonePages();
        var np = findPage(next, pageId);
        if (!np || !np.buttons) { ctx.error('page not found'); return; }
        np.buttons.splice(idx, 1);
        saveConfig(next, function () { afterSave(ctx); }, function (msg) { ctx.error(msg); });
      }
    });
  }

  function openPageSheet(pageId) {
    if (!window.deckEditor) return;
    var pg = pageById(pageId);
    if (!pg) return;
    var builtin = pg.type !== 'buttons'; // windows/ctrl: name/glyph/hidden only, no delete
    window.deckEditor.showPage({
      page: pg, isNew: false, builtin: builtin,
      onSave: function (patch, ctx) {
        var next = clonePages();
        var np = findPage(next, pageId);
        if (!np) { ctx.error('page not found'); return; }
        np.glyph = patch.glyph;
        np.label = patch.label;
        if (patch.label_en) np.label_en = patch.label_en; else delete np.label_en;
        if (patch.hidden) np.hidden = true; else delete np.hidden;
        saveConfig(next, function () {
          // cfg now holds the server truth; move off the page only if it's hidden.
          if (patch.hidden && pageId === page) { var v = visiblePages()[0]; if (v) page = v.id; }
          afterSave(ctx);
        }, function (msg) { ctx.error(msg); });
      },
      onDelete: builtin ? null : function (ctx) {
        var next = clonePages();
        for (var i = 0; i < next.length; i++) if (next[i].id === pageId) { next.splice(i, 1); break; }
        saveConfig(next, function () {
          if (pageId === page) { var v = visiblePages()[0]; if (v) page = v.id; }
          afterSave(ctx);
        }, function (msg) { ctx.error(msg); });
      }
    });
  }

  function openNewPageSheet() {
    if (!window.deckEditor) return;
    var id = 'page-' + Date.now().toString(36);
    window.deckEditor.showPage({
      page: { id: id, type: 'buttons', glyph: '＋', label: '', label_en: '', hidden: false },
      isNew: true, builtin: false,
      onSave: function (patch, ctx) {
        var np = { id: id, type: 'buttons', glyph: patch.glyph || '·',
          label: patch.label || id, buttons: [] };
        if (patch.label_en) np.label_en = patch.label_en;
        if (patch.hidden) np.hidden = true;
        var next = clonePages();
        next.push(np);
        saveConfig(next, function () { page = np.id; afterSave(ctx); }, function (msg) { ctx.error(msg); });
      }
    });
  }

  function toggleEditMode() {
    editMode = !editMode;
    if (!editMode) { drillWindow = null; drillPanes = null; }
    renderRail();
    forceRetick();
  }

  // ── send helpers (same dispatch semantics as deck.js) ─────────────────────
  function wsOK() {
    if (window.linkSendBlocked && window.linkSendBlocked()) return false; // input follow-lock (spec §3 Slice 2)
    return window.tmuxWs && window.tmuxWs.isConnected() &&
      window.tmuxState && window.tmuxState.focusedPane;
  }
  function sendKey(key, mods) {
    if (!wsOK()) return false;
    var msg = { type: 'key', pane: window.tmuxState.focusedPane, key: key };
    if (mods && mods.length) msg.modifiers = mods;
    window.tmuxWs.send(msg);
    return true;
  }
  function doAction(a) {
    if (!a) return false;
    if (a.type === 'input') {
      if (!wsOK()) return false;
      window.sendSkillOrAction(a.payload);
      return true;
    }
    if (a.type === 'key') return sendKey(a.payload, a.modifiers);
    if (a.type === 'macro') {
      if (!wsOK()) return false;
      window.runMacro(a.steps, a.delays);
      return true;
    }
    return false;
  }
  // slashExec sends "/cmd" + Enter as a macro (deterministic inline form —
  // plain input alone leaves the command sitting unexecuted in the composer).
  function slashExec(cmd) {
    return { type: 'macro', steps: [
      { type: 'input', payload: cmd },
      { type: 'key', payload: 'Enter' }
    ], delays: { inter: 300 } };
  }
  function feedback(el) {
    if (el) {
      el.classList.remove('is-sent');
      void el.offsetWidth;
      el.classList.add('is-sent');
      setTimeout(function () { el.classList.remove('is-sent'); }, 350);
    }
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
  }

  function toast(text, tone) {
    var t = root && root.querySelector('.dka-toast-slot');
    if (!t) return;
    clearTimeout(toastT);
    t.innerHTML = '';
    var d = document.createElement('div');
    d.className = 'dka-toast';
    d.setAttribute('data-tone', tone || 'accent');
    d.textContent = text;
    t.appendChild(d);
    toastT = setTimeout(function () { t.innerHTML = ''; }, 1700);
  }

  // fire routes a key def's action through its confirm gate, with feedback.
  function fire(def, el) {
    if (!wsOK()) { toast(T('未連線', 'not connected'), 'red'); return; }
    var run = function () {
      if (doAction(def.action)) { feedback(el); toast(def.toast || ('→ ' + def.label), def.toastTone || 'accent'); }
      else toast(T('送出失敗', 'send failed'), 'red');
    };
    if (def.confirm === 'slide' && window.deckConfirm) window.deckConfirm.show(def.label, run);
    else if (def.confirm) { if (window.confirm(T('執行「', 'Run "') + (def.label || '') + T('」？', '" ?'))) run(); }
    else run();
  }

  // ── real-state readers ─────────────────────────────────────────────────────
  function S() { return window.tmuxState || {}; }
  function dd() { return window.deckDetect || null; }
  function focusedText() {
    var d = dd();
    return d && d.focusedPaneText ? d.focusedPaneText() : '';
  }
  function currentWindow() {
    var s = S();
    var wins = s.windows || [];
    for (var i = 0; i < wins.length; i++) if (wins[i].index === s.activeWindowIdx) return wins[i];
    return null;
  }
  // focusedMeta returns the focused pane's tmuxctl.Pane meta (window index,
  // window_name, pane index, title, command) — app.js keeps S.paneInfo fed
  // from the WS `panes` frame for the active window, which always contains
  // the focused pane. null before the first frame lands.
  function focusedMeta() {
    var s = S();
    return (s.paneInfo && s.focusedPane && s.paneInfo[s.focusedPane]) || null;
  }
  // routeLabel is the deck's answer to「我到底在控制哪個 pane？」— a window
  // name alone is worthless when five windows are all called "zsh". Format:
  // "1:zsh ⌗2" (window index:name ⌗pane index); falls back to the bare
  // window name until pane meta arrives.
  function routeLabel() {
    var m = focusedMeta();
    if (m) return m.window + ':' + (m.window_name || '') + ' ⌗' + m.pane;
    var w = currentWindow();
    return w ? (w.name || String(w.index)) : (S().currentSession || T('無會話', 'no session'));
  }
  // waitingCount counts PANES blocked on the human (per-pane map when the
  // backend ships it; window-aggregate fallback otherwise).
  // pure helper for tests: count panes blocked on the human. Prefer the
  // per-pane map when the backend ships it; else the window-aggregate map.
  function countWaiting(panePane, paneAgg) {
    var n = 0, k;
    var src = null;
    for (k in panePane) { src = panePane; break; }
    if (!src) src = paneAgg;
    for (k in src) if (src[k] === 'waiting') n++;
    return n;
  }
  function waitingCount() { return countWaiting(panePaneStates, paneStates); }

  // ── I2: attention triage list ──────────────────────────────────────────────
  // The waiting count (「N 等你回覆」) becomes actionable: tap it to see EVERY
  // pane blocked on the human across ALL windows, one tap per row jumps focus
  // there. panePaneStates is the backend's whole-session per-pane truth (paneId
  // "win.pane"), so the list spans windows the deck isn't currently on. Labels
  // join S.paneInfo (active window only) + the S.windows name table; a per-pane
  // TAIL preview is only retained for panes the frontend can see (focused pane's
  // captured text, or an active-window pane's OSC title) — panes in other
  // windows show coordinate + state until a backend per-pane tail field exists
  // (no invented preview text).
  function paneWinIdx(id) { var d = id.indexOf('.'); return d >= 0 ? parseInt(id.slice(0, d), 10) : NaN; }
  function paneLocalIdx(id) { var d = id.indexOf('.'); return d >= 0 ? id.slice(d + 1) : id; }
  function windowNameByIdx(idx) {
    var wins = S().windows || [];
    for (var i = 0; i < wins.length; i++) if (wins[i].index === idx) return wins[i].name || '';
    return '';
  }
  function waitingPanes() {
    var out = [], id;
    var s = S();
    var info0 = s.paneInfo || {};
    for (id in panePaneStates) {
      if (panePaneStates[id] !== 'waiting') continue;
      var win = paneWinIdx(id);
      var info = info0[id] || null;
      var name = info ? (info.window_name || '') : windowNameByIdx(win);
      var paneIdx = info ? info.pane : paneLocalIdx(id);
      // tool chip: retained only for the focused pane (currentTool) and
      // active-window panes (command); left blank elsewhere.
      var tool = (s.focusedPane === id) ? (s.currentTool || '') : (info ? (info.command || '') : '');
      // preview: real retained text only — focused pane's tail, else an
      // active-window pane's OSC title. No fabricated text for other windows.
      var preview = (s.focusedPane === id) ? tailLine(focusedText()) : '';
      if (!preview && info && info.title) preview = info.title;
      out.push({ id: id, window: isNaN(win) ? null : win, paneIdx: paneIdx, name: name, tool: tool, preview: preview });
    }
    out.sort(function (a, b) {
      if ((a.window || 0) !== (b.window || 0)) return (a.window || 0) - (b.window || 0);
      return String(a.paneIdx).localeCompare(String(b.paneIdx), undefined, { numeric: true });
    });
    return out;
  }

  function onWaitKey(e) { if (e.key === 'Escape') closeWaitPanel(); }
  function closeWaitPanel() {
    if (waitPanelEl && waitPanelEl.parentNode) waitPanelEl.parentNode.removeChild(waitPanelEl);
    waitPanelEl = null; waitSig = null;
    document.removeEventListener('keydown', onWaitKey);
  }
  // openWaitPanel toggles the triage overlay (tap the count again to close).
  // Body-level fixed overlay mirroring deck-editor's sheet (Escape / backdrop /
  // ✕ all dismiss); rows are (re)painted by renderWaitList.
  function openWaitPanel() {
    if (waitPanelEl) { closeWaitPanel(); return; }
    var overlay = el('div', 'dka-waitlist');
    var panel = el('div', 'dka-waitlist-panel');
    var head = el('div', 'dka-waitlist-head');
    head.appendChild(el('div', 'dka-waitlist-title', T('等你回覆的 pane', 'Panes waiting on you')));
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'dka-waitlist-close'; x.textContent = '✕';
    x.title = T('關閉', 'close');
    x.addEventListener('click', closeWaitPanel);
    head.appendChild(x);
    panel.appendChild(head);
    panel.appendChild(el('div', 'dka-waitlist-rows'));
    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeWaitPanel(); });
    document.addEventListener('keydown', onWaitKey);
    document.body.appendChild(overlay);
    waitPanelEl = overlay; waitSig = null;
    renderWaitList();
  }
  function renderWaitList() {
    if (!waitPanelEl) return;
    var box = waitPanelEl.querySelector('.dka-waitlist-rows');
    if (!box) return;
    var rows = waitingPanes();
    var sig = rows.map(function (r) {
      return r.id + '|' + r.name + '|' + r.paneIdx + '|' + r.tool + '|' + r.preview;
    }).join('~') + '#' + LANG;
    if (sig === waitSig) return; // unchanged → keep DOM (preserves :active/scroll)
    waitSig = sig;
    box.innerHTML = '';
    if (!rows.length) {
      box.appendChild(el('div', 'dka-waitlist-empty', T('沒有 pane 在等你', 'Nothing waiting')));
      return;
    }
    rows.forEach(function (r) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'dka-waitlist-row';
      row.appendChild(el('span', 'dka-waitlist-dot'));
      var main = el('div', 'dka-waitlist-main');
      var coord = el('div', 'dka-waitlist-coord',
        (r.window == null ? '' : r.window + ':') + (r.name || '') + ' ⌗' + r.paneIdx);
      if (r.tool) coord.appendChild(el('span', 'dka-waitlist-tool', r.tool));
      main.appendChild(coord);
      main.appendChild(el('div', 'dka-waitlist-preview', r.preview || statusText('waiting')));
      row.appendChild(main);
      row.appendChild(el('span', 'dka-waitlist-go', '→'));
      row.addEventListener('click', (function (rr) {
        return function () {
          closeWaitPanel();
          if (window.focusPaneCrossWindow && rr.window != null) window.focusPaneCrossWindow(rr.window, rr.id);
          toast(T('切到 → ', 'jump → ') + (rr.name || rr.window) + ' ⌗' + rr.paneIdx, 'accent');
        };
      })(r));
      box.appendChild(row);
    });
  }

  // focusedState resolves the focused pane's state. The BACKEND per-pane state
  // wins — it alone sees #{pane_title} (the OSC braille/✳ signal) and is
  // debounced. The DOM text classifier is only a first-second fallback, and a
  // plain shell's ❯ prompt never reads as an idle AGENT (no tool → unknown).
  function focusedState(text) {
    var s = S();
    var backend = s.focusedPane && panePaneStates[s.focusedPane];
    if (backend) return backend;
    var d = dd();
    var raw = d && d.detectState ? d.detectState(text) : 'unknown';
    if (raw === 'idle' && !s.currentTool) return 'unknown';
    return raw;
  }
  function ttsOn() { return localStorage.getItem('tmux-tts-enabled') !== '0'; }

  // last meaningful pane line for the touch strip: skip blanks, dividers and
  // status-bar chrome; values are surfaced verbatim (deck.md: copy as read).
  function tailLine(text) {
    var lines = text.split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
      var l = lines[i].trim();
      if (!l) continue;
      if (/^[─╌—_]{3,}$/.test(l)) continue;
      if (/^(🔖|🤖|⏵⏵|⏸|◯|◉|💰|✍)/.test(l)) continue;
      if (/^(shift\s*\+\s*tab|ctrl\s*\+\s*g)/i.test(l)) continue;
      if (/^[│|]?\s*[❯>]\s*$/.test(l)) continue; // empty prompt box
      return l.length > 120 ? l.slice(0, 120) + '…' : l;
    }
    return '';
  }

  // ── key defs per page ──────────────────────────────────────────────────────
  function switchSession(name) {
    var s = S();
    if (name === s.currentSession) return;
    var sel = document.getElementById('sessions');
    if (sel) sel.value = name;
    if (window.tmuxWs) {
      if (window.tmuxWs.isConnected()) window.tmuxWs.disconnect();
      window.tmuxWs.connect(name);
    }
  }

  // ── windows page (type=windows) + pane drill-down ──────────────────────────
  function forceRetick() {
    renderedSig = null; candidate = null; candidateCount = 0; headSig = null;
    tick(); // immediate paint (hysteresis reset, no debounce wait on a user tap)
  }
  function gotoWindowsPage() {
    var id = firstWindowsPageId();
    if (id) page = id;
    drillWindow = null; drillPanes = null;
    renderRail();
    forceRetick();
  }
  function exitDrill() {
    drillWindow = null; drillPanes = null;
    forceRetick();
  }
  // enterDrill: on-demand fetch the whole pane list, keep only the tapped
  // window's panes, then repaint (fetch resolve resets hysteresis so the panes
  // appear at once rather than after the 2-poll debounce).
  function enterDrill(windowIdx) {
    drillWindow = windowIdx;
    drillPanes = null;
    forceRetick();
    var url = basePath() + '/api/panes?session=' + encodeURIComponent(S().currentSession || '');
    fetch(url).then(function (r) { return r.ok ? r.json() : []; }).then(function (arr) {
      if (drillWindow !== windowIdx) return; // user navigated away mid-fetch
      drillPanes = (Array.isArray(arr) ? arr : []).filter(function (p) { return p.window === windowIdx; });
      forceRetick();
    }).catch(function () {
      if (drillWindow !== windowIdx) return;
      drillPanes = [];
      forceRetick();
    });
  }

  // I5: per-key context% badge. U3's poller (deck-rail.pollAgents, shared deck
  // tick) keeps a per-pane burn index from /api/agents; we correlate by the
  // deck's CURRENT session + window/pane. Blank (not "0%") when the pane has no
  // status line — ctxPctStr returns '' for an absent/zero entry, and '<1%' for a
  // real-but-tiny burn so a fresh pane (0<pct<0.5) doesn't misleadingly read '0%'.
  function ctxPctStr(c) {
    if (!c || !(c.pct > 0)) return '';
    return c.pct < 1 ? '<1%' : Math.round(c.pct) + '%';
  }

  // sessionTone maps a session's WORST cross-session agent state (deck-rail's
  // sessionState, from /api/agents) to a grid session-key tone so the deck-agent
  // grid — not just the chrome rail — shows which OTHER session's agent needs you.
  // 'accent' keeps the neutral session look when nothing's up. PURE (unit-tested).
  // pure helper for tests
  function sessionTone(sst) {
    return sst === 'working' ? 'green' : sst === 'waiting' ? 'red' : 'accent';
  }

  // ── I3 per-pane state timeline (pure helpers, unit-tested) ───────────────────
  // splitDurations folds a pane's recent[] transition ring into total seconds per
  // state, the LAST transition open until nowSec (a client clock passed in), so the
  // split ticks live between the 600ms /api/agents polls. Mirrors the Go
  // stateDurations reference; negative spans (clock skew) clamp to 0.
  // pure helper for tests
  function splitDurations(recent, nowSec) {
    var out = { working: 0, waiting: 0, idle: 0 };
    if (!Array.isArray(recent)) return out;
    for (var i = 0; i < recent.length; i++) {
      var e = recent[i];
      if (!e || !e.state) continue;
      var end = (i + 1 < recent.length) ? (+recent[i + 1].atUnix || 0) : nowSec;
      var d = end - (+e.atUnix || 0);
      if (d > 0) out[e.state] = (out[e.state] || 0) + d;
    }
    return out;
  }

  // fmtDuration renders whole seconds as a compact "1h2m" / "4m12s" / "45s" label
  // for the live in-state counter (e.g. "等你回覆 4m12s").
  // pure helper for tests
  function fmtDuration(secs) {
    secs = Math.max(0, Math.floor(+secs || 0));
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    if (h > 0) return h + 'h' + m + 'm';
    if (m > 0) return m + 'm' + (s < 10 ? '0' : '') + s + 's';
    return s + 's';
  }

  // focusedTimeline reads the focused pane's timeline from U3/I5's shared
  // /api/agents poller (deck-rail); null when the pane isn't a tracked agent.
  function focusedTimeline() {
    var r = window.deckRail;
    if (!r || !r.agentTimeline) return null;
    var s = S();
    return r.agentTimeline(s.currentSession, s.focusedPane);
  }

  function winCtxPct(winIdx) {
    var r = window.deckRail;
    return (r && r.agentWindowContext) ? ctxPctStr(r.agentWindowContext(S().currentSession, winIdx)) : '';
  }
  function paneCtxPct(paneID) {
    var r = window.deckRail;
    return (r && r.agentContext) ? ctxPctStr(r.agentContext(S().currentSession, paneID)) : '';
  }

  function windowsKeys() {
    var s = S();
    var defs = [];
    var sessions = s.sessions || [];
    if (sessions.length >= 2) {
      sessions.forEach(function (se) {
        // U3: tint each session key by its worst cross-session agent state so the
        // grid surfaces "another project's agent is waiting" without the chrome rail.
        var sst = (window.deckRail && window.deckRail.sessionState)
          ? window.deckRail.sessionState(se.name) : null;
        defs.push({
          glyph: '⊞', label: se.name, sub: (se.windows || 0) + T(' 窗', 'w'),
          tone: sessionTone(sst),
          led: sst === 'working' || sst === 'waiting',
          ledBlink: true,
          pulse: sst === 'waiting',
          lit: se.name === s.currentSession,
          onPress: function () { switchSession(se.name); toast(T('會話 → ', 'session → ') + se.name, 'accent'); }
        });
      });
    }
    (s.windows || []).forEach(function (w) {
      var st = paneStates[w.index] || 'unknown';
      defs.push({
        glyphTxt: (w.name || String(w.index)).slice(0, 2).toUpperCase(),
        label: w.name || (T('視窗 ', 'win ') + w.index),
        sub: w.panes > 1 ? w.panes + T(' 格', ' panes') : '',
        pct: winCtxPct(w.index),
        tone: st === 'working' ? 'green' : st === 'waiting' ? 'red' : 'neutral',
        led: st === 'working' || st === 'waiting',
        ledBlink: true,
        pulse: st === 'waiting',
        focused: w.index === s.activeWindowIdx,
        onPress: function () {
          // multi-pane window → drill into a pane picker; single pane → route now.
          if (w.panes > 1) { enterDrill(w.index); return; }
          if (w.index === S().activeWindowIdx) return;
          if (window.tmuxWs && window.tmuxWs.isConnected()) {
            window.tmuxWs.send({ type: 'switch_window', window: w.index });
            toast(T('切到 → ', 'routed → ') + (w.name || w.index), 'accent');
          }
        }
      });
    });
    return defs;
  }

  // paneKeys: the drill-down grid — one key per pane in drillWindow + a back key.
  // tone/led follow the backend per-pane state (panePaneStates keyed by "w.p");
  // focused marks the deck's current routing target.
  function paneKeys() {
    var defs = [{ glyph: '←', label: T('返回', 'BACK'), tone: 'neutral', onPress: exitDrill }];
    if (drillPanes == null) {
      defs.push({ glyph: '⋯', label: T('載入中', 'loading…'), tone: 'neutral', onPress: function () {} });
      return defs;
    }
    var s = S();
    drillPanes.forEach(function (p) {
      var st = panePaneStates[p.id] || 'unknown';
      defs.push({
        glyphTxt: String(p.pane),
        label: p.title || p.command || (T('格 ', 'pane ') + p.pane),
        sub: (p.title && p.command) ? p.command : '',
        pct: paneCtxPct(p.id),
        tone: st === 'working' ? 'green' : st === 'waiting' ? 'red' : 'neutral',
        led: st === 'working' || st === 'waiting',
        ledBlink: true,
        pulse: st === 'waiting',
        focused: s.focusedPane === p.id,
        onPress: (function (pane) {
          return function () {
            if (window.focusPaneCrossWindow) window.focusPaneCrossWindow(pane.window, pane.id);
            toast(T('切到 pane → ', 'pane → ') + pane.pane, 'accent');
            exitDrill();
          };
        })(p)
      });
    });
    return defs;
  }

  function ctrlKeys(menu, state, permMode) {
    if (menu) {
      // live CC menu → labeled option keys (V2 core: context responder).
      // Numbers are CC hotkeys; every send passes the slide gate.
      var defs = (menu.options || []).map(function (opt) {
        return {
          menuKey: true, glyphTxt: String(opt.n), label: opt.label,
          tone: 'accent', confirm: 'slide',
          action: { type: 'input', payload: String(opt.n) },
          toast: '✓ ' + opt.n + '. ' + opt.label, toastTone: 'green'
        };
      });
      defs.push({ glyph: '■', label: T('中斷', 'INTERRUPT'), sub: 'esc', tone: 'red',
        action: { type: 'key', payload: 'Escape' }, toast: T('■ 中斷', '■ interrupt'), toastTone: 'red' });
      return defs;
    }
    var noMenu = function () { toast(T('目前沒有待回答的問題', 'no pending question'), 'yellow'); };
    return [
      { glyph: '✓', label: T('核准', 'APPROVE'), sub: 'menu 1', tone: 'green', onPress: noMenu },
      { glyph: '✕', label: T('拒絕', 'DENY'), sub: 'esc', tone: 'red', onPress: noMenu },
      { glyph: '■', label: T('中斷', 'INTERRUPT'), sub: 'esc', tone: 'red', lit: state === 'working',
        action: { type: 'key', payload: 'Escape' }, toast: T('■ 中斷', '■ interrupt'), toastTone: 'red' },
      { glyph: '↺', label: T('回退', 'REWIND'), sub: 'esc esc', tone: 'neutral',
        action: { type: 'macro', steps: [
          { type: 'key', payload: 'Escape' }, { type: 'key', payload: 'Escape' }
        ], delays: { inter: 250 } }, toast: '↺ esc esc' },
      { glyph: '⏵⏵', label: T('模式', 'MODE'), sub: permMode || 'default', tone: 'cyan', lit: !!permMode,
        action: { type: 'key', payload: 'Tab', modifiers: ['S'] },
        toast: T('⇧⇥ 循環權限模式', '⇧⇥ cycle mode'), toastTone: 'accent' },
      { glyph: '↑', label: T('上', 'UP'), tone: 'neutral', action: { type: 'key', payload: 'Up' }, toast: '↑' },
      { glyph: '↓', label: T('下', 'DOWN'), tone: 'neutral', action: { type: 'key', payload: 'Down' }, toast: '↓' },
      { glyph: '⏎', label: T('送出', 'ENTER'), tone: 'neutral', action: { type: 'key', payload: 'Enter' }, toast: '⏎' },
      { glyph: '⌗', label: '/compact', sub: T('壓縮context', 'context'), tone: 'accent',
        action: slashExec('/compact'), toast: '/compact' },
      { glyph: '☰', label: '/resume', sub: T('接續會話', 'session'), tone: 'neutral',
        action: slashExec('/resume'), toast: '/resume' },
      { glyph: '⌫', label: '/clear', sub: T('清空', 'reset'), tone: 'red', confirm: 'slide',
        action: slashExec('/clear'), toast: '/clear', toastTone: 'red' }
    ];
  }

  // buttonsKeys renders a type=buttons page from config (快捷/指令/GIT and any
  // user-authored page). Same tone/confirm/action mapping the PROMPT page used
  // (label=繁中 primary via btnLabel; color→tone; action forwarded verbatim to
  // doAction). SLASH/GIT are no longer hardcoded here — that data lives in
  // default.json's pages (and BUILTIN_PAGES as the dead-fetch fallback).
  var TONE_MAP = { accent: 'accent', warn: 'yellow', danger: 'red' };
  function buttonsKeys(pg) {
    var buttons = (pg && pg.buttons) || [];
    var defs = buttons.map(function (b, i) {
      var isFill = b.action && b.action.type === 'input' &&
        typeof b.action.payload === 'string' && /\s$/.test(b.action.payload);
      var def = {
        glyph: b.icon || '»', label: btnLabel(b),
        sub: isFill ? T('填入', 'fill') : (b.action && b.action.type === 'macro' ? T('巨集', 'macro') : T('送出', 'send')),
        tone: TONE_MAP[b.color] || 'neutral',
        confirm: b.confirm, action: b.action
      };
      if (editMode) {
        def.sub = T('點按編輯', 'tap to edit');
        def.edit = (function (idx) { return function () { openButtonSheet(pg.id, idx); }; })(i);
      }
      return def;
    });
    if (editMode) {
      defs.push({ glyph: '＋', label: T('新增按鈕', 'ADD'), tone: 'accent', isAdd: true,
        edit: function () { openButtonSheet(pg.id, null); } });
    }
    return defs;
  }

  function windowName(idx) {
    var wins = (S().windows) || [];
    for (var i = 0; i < wins.length; i++) if (wins[i].index === idx) return wins[i].name || String(idx);
    return String(idx);
  }

  function pageInfo(menu) {
    var name = routeLabel(); // 1:zsh ⌗2 — pane-precise, not just a window name
    var p = pageById(page);
    if (p && p.type === 'windows') {
      if (drillWindow != null) {
        return [T('選 PANE', 'SELECT PANE') + ' · ' + windowName(drillWindow),
          T('點 pane 把 deck 指過去 · ← 返回', 'tap a pane to route the deck · ← back')];
      }
      return [T('窗口', 'WINDOWS'), T('點視窗切換 deck 的目標', 'tap a window to route the deck')];
    }
    if (p && p.type === 'ctrl') {
      return menu
        ? [T('CLAUDE 在問你', 'CLAUDE IS ASKING'), menu.title || T('選一項 — 滑動送出', 'pick an option — slide to send')]
        : [T('控制', 'CONTROL') + ' · ' + name, T('核准 · 中斷 · 導航', 'approve · interrupt · navigate')];
    }
    if (p && p.type === 'buttons') {
      if (editMode) return [pageLabel(p), T('點鍵編輯 · ＋ 新增按鈕', 'tap a key to edit · ＋ add')];
      return [pageLabel(p), T('一鍵送到 ', 'one tap → ') + name];
    }
    return ['', ''];
  }

  function keysForPage(menu, state, permMode) {
    var p = pageById(page);
    if (!p) return [];
    if (p.type === 'windows') return drillWindow != null ? paneKeys() : windowsKeys();
    if (p.type === 'ctrl') return ctrlKeys(menu, state, permMode);
    if (p.type === 'buttons') return buttonsKeys(p);
    return [];
  }

  // ── DOM builders ───────────────────────────────────────────────────────────
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // I3 timeline widget: a live "<state> <duration>" label + a working/waiting/idle
  // mini split bar. Hidden until updateTimeline() has a focused agent to fill it.
  function timelineEl() {
    var tl = el('div', 'dka-timeline');
    tl.style.display = 'none';
    tl.appendChild(el('span', 'dka-tl-txt', ''));
    var bar = el('span', 'dka-tl-bar');
    bar.appendChild(el('i', 'dka-tl-seg dka-tl-working'));
    bar.appendChild(el('i', 'dka-tl-seg dka-tl-waiting'));
    bar.appendChild(el('i', 'dka-tl-seg dka-tl-idle'));
    tl.appendChild(bar);
    return tl;
  }

  // ── I4 per-pane output replay scrubber (opt-in) ─────────────────────────────
  // A body-level overlay (mirrors openWaitPanel) that RECORDS one agent pane's
  // output and lets you scrub back through the captured frames. Recording is
  // opt-in: opening starts it (POST .../record {on:true}); closing stops AND
  // clears it (POST {on:false}) so no buffer lingers server-side. Frames come
  // from GET .../frames and render through window.ansiToHtml (terminal.js). The
  // draggable axis is a range <input>; while parked at the newest frame the view
  // follows the live edge, otherwise it stays put so you can inspect history.
  // The recordable pane list comes from the shared /api/agents poller
  // (deckRail.agents()), whose entries carry the REAL tmux paneID the API
  // resolves on (pane INDEX collides across windows; paneID does not).
  var replayEl = null;   // overlay root; null = closed
  var replayCtx = null;  // { session, paneID, label, frames[], idx, poll }

  function apiBase() {
    return (typeof location !== 'undefined' && location.pathname
      ? location.pathname.replace(/\/+$/, '') : '') || '';
  }
  function recordPath(session, paneID) {
    return apiBase() + '/api/agents/' + encodeURIComponent(session) + '/' + encodeURIComponent(paneID) + '/record';
  }
  function framesPath(session, paneID) {
    return apiBase() + '/api/agents/' + encodeURIComponent(session) + '/' + encodeURIComponent(paneID) + '/frames';
  }
  function postRecord(session, paneID, on) {
    return fetch(recordPath(session, paneID), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: !!on })
    });
  }

  // clampIdx keeps a scrub index inside [0, n-1]; an empty ring pins to 0.
  // pure helper for tests
  function clampIdx(idx, n) {
    if (n <= 0) return 0;
    if (idx < 0) return 0;
    if (idx > n - 1) return n - 1;
    return idx;
  }
  // replayAgentLabel formats one agent entry as "session · 1:name ⌗2".
  // pure helper for tests
  function replayAgentLabel(a) {
    if (!a) return '';
    return (a.session || '') + ' · ' + (a.window == null ? '' : a.window + ':')
      + (a.windowName || '') + ' ⌗' + (a.pane == null ? '' : a.pane);
  }

  // ── I6 remote-host status federation (read-only) ────────────────────────────
  // Peers merge their agents into /api/agents tagged host=<peer> (local agents
  // carry host "local"; a legacy/absent host also counts as local). A remote
  // agent is STATUS ONLY — the deck shows it with a host badge and an info/
  // preview panel, never focus/input/record (no cross-host control by design).
  // isRemoteAgent gates every read-only path below.
  // pure helper for tests
  function isRemoteAgent(a) { return !!(a && a.host && a.host !== 'local'); }
  // agentHostLabel — the peer host to badge a remote agent with; '' for local.
  // pure helper for tests
  function agentHostLabel(a) { return isRemoteAgent(a) ? a.host : ''; }

  // openRemoteInfo shows a remote agent's read-only status (host · coordinate ·
  // state · tool · last preview line) with an explicit "read-only" note. No
  // record button, no send path — federation is status-only.
  function openRemoteInfo(a) {
    if (!a) return;
    var overlay = el('div', 'dka-replay');
    var panel = el('div', 'dka-replay-panel dka-remote-info');
    var head = el('div', 'dka-replay-head');
    head.appendChild(el('div', 'dka-replay-title',
      T('遠端 · ', 'remote · ') + (a.host || '') + ' · ' + replayAgentLabel(a)));
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'dka-replay-close'; x.textContent = '✕';
    x.title = T('關閉', 'close');
    x.addEventListener('click', function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    head.appendChild(x);
    panel.appendChild(head);
    panel.appendChild(el('div', 'dka-remote-note',
      T('唯讀 — 遠端主機狀態，無法聚焦或輸入', 'read-only — remote host status, no focus/input')));
    var meta = el('div', 'dka-remote-meta');
    meta.appendChild(el('div', 'dka-remote-state st-' + (a.state || 'unknown'),
      statusText(a.state)));
    if (a.tool) meta.appendChild(el('div', 'dka-remote-tool', a.tool));
    if (a.tailPreview) meta.appendChild(el('div', 'dka-remote-preview', a.tailPreview));
    panel.appendChild(meta);
    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    document.body.appendChild(overlay);
  }

  // openAgentView routes one picked agent: a local pane opens the recording
  // replay scrubber; a remote (peer) pane opens the read-only info panel.
  function openAgentView(a) {
    if (isRemoteAgent(a)) openRemoteInfo(a);
    else openReplay(a.session, a.paneID, replayAgentLabel(a));
  }

  function onReplayKey(e) { if (e.key === 'Escape') closeReplay(); }
  function closeReplay() {
    if (!replayEl) return;
    var c = replayCtx;
    if (c && c.poll) { clearInterval(c.poll); c.poll = null; }
    if (c && c.session && c.paneID) postRecord(c.session, c.paneID, false).catch(function () {});
    if (replayEl.parentNode) replayEl.parentNode.removeChild(replayEl);
    document.removeEventListener('keydown', onReplayKey);
    replayEl = null; replayCtx = null;
  }

  function renderReplayFrame() {
    if (!replayEl || !replayCtx) return;
    var c = replayCtx;
    var n = c.frames.length;
    c.idx = clampIdx(c.idx, n);
    var scr = replayEl.querySelector('.dka-replay-screen');
    var meta = replayEl.querySelector('.dka-replay-meta');
    var range = replayEl.querySelector('.dka-replay-range');
    if (range) {
      range.max = String(Math.max(0, n - 1));
      range.value = String(c.idx);
      range.disabled = n <= 1;
    }
    if (!n) {
      if (scr) scr.innerHTML = '';
      if (meta) meta.textContent = T('等待輸出變化…', 'waiting for output…');
      return;
    }
    var f = c.frames[c.idx] || {};
    if (scr) {
      scr.innerHTML = window.ansiToHtml ? window.ansiToHtml(f.content || '')
        : (window.escHtml ? window.escHtml(f.content || '') : (f.content || ''));
    }
    if (meta) {
      var when = f.atUnix ? new Date(f.atUnix * 1000).toLocaleTimeString() : '';
      meta.textContent = T('影格 ', 'frame ') + (c.idx + 1) + '/' + n + (when ? ' · ' + when : '');
    }
  }

  function pollReplayFrames() {
    var c = replayCtx;
    if (!c) return;
    fetch(framesPath(c.session, c.paneID))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!replayCtx || replayCtx !== c) return; // panel closed/switched mid-flight
        var frames = (data && Array.isArray(data.frames)) ? data.frames : [];
        var atEnd = c.idx >= c.frames.length - 1; // parked on the newest → follow live
        var changed = frames.length !== c.frames.length;
        c.frames = frames;
        if (atEnd) c.idx = frames.length - 1;
        if (changed || atEnd) renderReplayFrame();
      })
      .catch(function () { /* transient; next poll retries */ });
  }

  function openReplay(session, paneID, label) {
    if (replayEl) closeReplay();
    if (!session || !paneID) return;
    replayCtx = { session: session, paneID: paneID, label: label || paneID, frames: [], idx: 0, poll: null };

    var overlay = el('div', 'dka-replay');
    var panel = el('div', 'dka-replay-panel');
    var head = el('div', 'dka-replay-head');
    head.appendChild(el('div', 'dka-replay-title', T('回放 · ', 'replay · ') + replayCtx.label));
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'dka-replay-close'; x.textContent = '✕';
    x.title = T('停止並關閉', 'stop & close');
    x.addEventListener('click', closeReplay);
    head.appendChild(x);
    panel.appendChild(head);

    panel.appendChild(el('pre', 'dka-replay-screen'));

    var axis = el('div', 'dka-replay-axis');
    var range = document.createElement('input');
    range.type = 'range'; range.className = 'dka-replay-range';
    range.min = '0'; range.max = '0'; range.value = '0'; range.step = '1'; range.disabled = true;
    range.title = T('拖曳回放時間軸', 'drag the replay axis');
    range.addEventListener('input', function () {
      if (!replayCtx) return;
      replayCtx.idx = clampIdx(parseInt(range.value, 10) || 0, replayCtx.frames.length);
      renderReplayFrame();
    });
    axis.appendChild(range);
    panel.appendChild(axis);

    panel.appendChild(el('div', 'dka-replay-meta', T('錄製中…', 'recording…')));

    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeReplay(); });
    document.addEventListener('keydown', onReplayKey);
    document.body.appendChild(overlay);
    replayEl = overlay;

    postRecord(session, paneID, true)
      .then(function (r) {
        if (!r || !r.ok) { toast(T('無法錄製此 pane', 'cannot record this pane'), 'danger'); closeReplay(); return; }
        if (!replayCtx) return; // closed while awaiting
        pollReplayFrames();
        replayCtx.poll = setInterval(pollReplayFrames, 1000);
      })
      .catch(function () { toast(T('錄製請求失敗', 'record request failed'), 'danger'); closeReplay(); });
  }

  // openReplayPicker lists agent panes; a single agent opens directly. Local
  // panes open the recording replay scrubber; remote (peer, I6) panes are
  // read-only and open the info panel instead (never recorded).
  function openReplayPicker() {
    var r = window.deckRail;
    var agents = (r && r.agents) ? (r.agents() || []) : [];
    if (!agents.length) { toast(T('沒有 agent pane', 'no agent panes'), 'warn'); return; }
    if (agents.length === 1) {
      openAgentView(agents[0]);
      return;
    }
    if (replayEl) closeReplay();
    var overlay = el('div', 'dka-replay');
    var panel = el('div', 'dka-replay-panel dka-replay-picker');
    var head = el('div', 'dka-replay-head');
    head.appendChild(el('div', 'dka-replay-title', T('選 pane（遠端唯讀）', 'pick a pane (remote = read-only)')));
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'dka-replay-close'; x.textContent = '✕';
    x.addEventListener('click', function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    head.appendChild(x);
    panel.appendChild(head);
    var rows = el('div', 'dka-replay-rows');
    agents.forEach(function (a) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'dka-replay-row' + (isRemoteAgent(a) ? ' dka-replay-row-remote' : '');
      row.appendChild(el('span', 'dka-replay-rowmain', replayAgentLabel(a)));
      var host = agentHostLabel(a);
      if (host) row.appendChild(el('span', 'dka-replay-rowhost', '⌂ ' + host));
      row.appendChild(el('span', 'dka-replay-rowstate', statusText(a.state)));
      row.addEventListener('click', function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        openAgentView(a);
      });
      rows.appendChild(row);
    });
    panel.appendChild(rows);
    overlay.appendChild(panel);
    overlay.addEventListener('click', function (e) { if (e.target === overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    document.body.appendChild(overlay);
  }

  function replayBtn() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'dka-x dka-replay-btn';
    b.textContent = '⏺';
    b.title = T('輸出回放（錄製）', 'output replay (record)');
    b.addEventListener('click', function () { openReplayPicker(); });
    return b;
  }

  function makeKey(def) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dka-key' + (def.menuKey ? ' dka-menukey' : '');
    if (def.ghost) { b.classList.add('ghost'); return b; }
    b.setAttribute('data-tone', def.tone || 'neutral');
    if (def.isAdd) b.classList.add('dka-addkey');
    if (def.lit) b.classList.add('lit');
    if (def.focused) b.classList.add('focused');
    if (def.pulse) b.classList.add('pulse');
    if (def.led) {
      var led = el('span', 'dka-led' + (def.ledBlink ? ' blink' : ''));
      b.appendChild(led);
    }
    if (def.glyphTxt != null) b.appendChild(el('span', 'dka-glyph txt', def.glyphTxt));
    else b.appendChild(el('span', 'dka-glyph', def.glyph || ''));
    b.appendChild(el('span', 'dka-lbl', def.label || ''));
    if (def.sub) b.appendChild(el('span', 'dka-sub', def.sub));
    // I5 context% burn badge — additive sub, blank when the pane has no line.
    if (def.pct) b.appendChild(el('span', 'dka-sub dka-keypct', def.pct));
    b.addEventListener('click', function () {
      if (editMode) {
        // edit mode: editable keys open a sheet; computed keys are inert (no fire)
        if (def.edit) { def.edit(); feedback(b); }
        return;
      }
      if (def.onPress) { def.onPress(); feedback(b); }
      else fire(def, b);
    });
    return b;
  }

  function renderGrid(defs) {
    var grid = root.querySelector('.dka-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var real = defs.length;
    defs.forEach(function (d) { grid.appendChild(makeKey(d)); });
    // ghost-pad the tray to a full 5-col row (min 15 cells), menu layout excluded.
    // Compact (auto-fill columns) skips ghosts — the column count is fluid there.
    var hasMenu = defs.some(function (d) { return d.menuKey; });
    if (!hasMenu && !compact) {
      var target = Math.max(15, Math.ceil(real / 5) * 5);
      for (var i = real; i < target; i++) grid.appendChild(makeKey({ ghost: true }));
    }
  }

  function renderRail() {
    var rail = root.querySelector('.dka-rail');
    if (!rail) return;
    rail.innerHTML = '';
    rail.appendChild(el('div', 'dka-rail-title', editMode ? T('編輯', 'EDIT') : T('頁面', 'PROFILE')));
    // edit mode lists ALL pages (incl. hidden, so they can be un-hidden); normal
    // mode skips hidden pages.
    (editMode ? pages() : visiblePages()).forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dka-railbtn' + (p.id === page ? ' active' : '') + (p.hidden ? ' dka-railbtn-hidden' : '');
      b.appendChild(el('span', 'dka-railbtn-glyph', p.glyph || '·'));
      b.appendChild(el('span', 'dka-railbtn-lbl', pageLabel(p)));
      b.addEventListener('click', function () {
        if (editMode) { openPageSheet(p.id); return; } // edit mode: tab tap = edit sheet
        if (page === p.id) return;
        page = p.id;
        drillWindow = null; drillPanes = null; // leaving/entering a page drops any drill-down
        renderRail();
        renderedSig = null; candidate = null; candidateCount = 0; headSig = null;
        tick(); // immediate swap (hysteresis reset, no 1.2s wait on a user tap)
      });
      rail.appendChild(b);
    });
    if (editMode) {
      var addp = document.createElement('button');
      addp.type = 'button';
      addp.className = 'dka-railbtn dka-railbtn-add';
      addp.appendChild(el('span', 'dka-railbtn-glyph', '＋'));
      addp.appendChild(el('span', 'dka-railbtn-lbl', T('新頁', 'NEW')));
      addp.addEventListener('click', function () { openNewPageSheet(); });
      rail.appendChild(addp);
    }
    // ✎ edit-mode toggle (rail tail — present in both layouts)
    var ed = document.createElement('button');
    ed.type = 'button';
    ed.className = 'dka-railbtn dka-railedit' + (editMode ? ' active' : '');
    ed.appendChild(el('span', 'dka-railbtn-glyph', '✎'));
    ed.appendChild(el('span', 'dka-railbtn-lbl', editMode ? T('完成', 'DONE') : T('編輯', 'EDIT')));
    ed.addEventListener('click', function () { toggleEditMode(); });
    rail.appendChild(ed);
  }

  function modeBtn(cls, glyph, title, targetMode) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.title = title;
    b.textContent = glyph;
    b.addEventListener('click', function () { if (window.deckSetMode) window.deckSetMode(targetMode); });
    return b;
  }

  function build() {
    root.classList.add('dka');
    root.classList.toggle('dka-compact', compact);
    root.innerHTML = '';
    if (compact) buildCompact(); else buildFull();
    renderRail();
  }

  // compact = the dock column: tabs · mini strip (+badges) · permission pills ·
  // grid with the scrollback scrub alongside. No dials/foot/pagehead — the
  // terminal is visible, vertical space is the scarce resource.
  function buildCompact() {
    // page tabs + lang toggle + fullscreen/close
    var tabs = el('div', 'dka-tabs');
    tabs.appendChild(el('div', 'dka-rail'));
    tabs.appendChild(replayBtn());
    tabs.appendChild(langBtn());
    tabs.appendChild(modeBtn('dka-x', '⛶', T('Agent Deck（全螢幕）', 'Agent Deck (fullscreen)'), 'deck-mode'));
    tabs.appendChild(modeBtn('dka-x', '✕', T('關閉 deck', 'close deck'), ''));
    root.appendChild(tabs);

    // mini strip: focused pane head + status badges + toast overlay.
    // name = window:name ⌗pane coordinate; title = the pane's OSC title (a
    // Claude task name — the thing that actually tells five "zsh" apart).
    // Tapping the identity jumps to the 窗口 page to re-route.
    var touch = el('div', 'dka-touch');
    var th = el('div', 'dka-touch-head');
    th.appendChild(el('span', 'dka-dot dka-touch-dot'));
    var tnm = el('span', 'dka-touch-name', '');
    tnm.addEventListener('click', function () { gotoWindowsPage(); });
    th.appendChild(tnm);
    th.appendChild(el('span', 'dka-chip dka-touch-tool', ''));
    th.appendChild(el('span', 'dka-touch-title', ''));
    th.appendChild(el('span', 'dka-status', ''));
    th.appendChild(el('div', 'dka-spacer'));
    var wait = document.createElement('button');
    wait.type = 'button';
    wait.className = 'dka-wait';
    wait.style.display = 'none';
    wait.appendChild(el('span', 'dka-wait-dot'));
    wait.appendChild(el('span', 'dka-wait-txt', ''));
    wait.appendChild(el('span', 'dka-wait-caret', '›'));
    wait.title = T('看誰在等你回覆', 'see who is waiting on you');
    wait.addEventListener('click', function () { openWaitPanel(); });
    th.appendChild(wait);
    th.appendChild(el('span', 'dka-pct', ''));
    touch.appendChild(th);
    touch.appendChild(timelineEl());
    touch.appendChild(el('div', 'dka-badges'));
    touch.appendChild(el('div', 'dka-toast-slot'));
    root.appendChild(touch);

    // permission-mode pills — dock soul widget, kept from the legacy chrome
    if (window.deckSlider) {
      var sz = document.createElement('div');
      var d = dd();
      window.deckSlider.render(sz, d && d.detectPermMode ? d.detectPermMode(focusedText()) : null);
      root.appendChild(sz);
    }

    // key grid (scrollback scrub was cut — community verdict "text scroll is a
    // gimmick" + owner confirmed; two-finger scroll on the visible terminal wins)
    var body = el('div', 'dka-body');
    body.appendChild(el('div', 'dka-grid'));
    root.appendChild(body);
  }

  function buildFull() {
    // context strip
    var strip = el('div', 'dka-strip');
    var logo = el('div', 'dka-logo');
    logo.appendChild(el('div', 'dka-logo-mark', '▚'));
    logo.appendChild(el('span', 'dka-logo-name', 'AGENT DECK'));
    logo.appendChild(el('span', 'dka-logo-sub dka-logo-count', ''));
    strip.appendChild(logo);
    strip.appendChild(el('div', 'dka-spacer'));
    // route pill = the deck's identity anchor:「路由 → 1:zsh ⌗2 ⟨claude⟩ 任務標題」.
    // Clickable — jumps to the 窗口 page to re-route.
    var route = el('div', 'dka-route');
    route.appendChild(el('span', 'dka-dot'));
    route.appendChild(el('span', 'dka-route-hint', T('路由 →', 'routing →')));
    route.appendChild(el('span', 'dka-route-name', ''));
    route.appendChild(el('span', 'dka-chip dka-route-tool', ''));
    route.appendChild(el('span', 'dka-route-title', ''));
    route.title = T('點擊切換窗口 / pane', 'tap to re-route');
    route.addEventListener('click', function () { gotoWindowsPage(); });
    strip.appendChild(route);
    var wait = document.createElement('button');
    wait.type = 'button';
    wait.className = 'dka-wait';
    wait.style.display = 'none';
    wait.appendChild(el('span', 'dka-wait-dot'));
    wait.appendChild(el('span', 'dka-wait-txt', ''));
    wait.appendChild(el('span', 'dka-wait-caret', '›'));
    wait.title = T('看誰在等你回覆', 'see who is waiting on you');
    wait.addEventListener('click', function () { openWaitPanel(); });
    strip.appendChild(wait);
    strip.appendChild(el('span', 'dka-clock', ''));
    strip.appendChild(replayBtn());
    strip.appendChild(langBtn());
    strip.appendChild(modeBtn('dka-x', '▣', T('dock 模式', 'dock mode'), 'deck-dock'));
    strip.appendChild(modeBtn('dka-x', '✕', T('關閉 deck', 'close deck'), ''));
    root.appendChild(strip);

    // device: rail + main
    var device = el('div', 'dka-device');
    device.appendChild(el('div', 'dka-rail'));
    var main = el('div', 'dka-main');
    var head = el('div', 'dka-pagehead');
    head.appendChild(el('span', 'dka-pagetitle', ''));
    head.appendChild(el('span', 'dka-pagehint', ''));
    main.appendChild(head);
    main.appendChild(el('div', 'dka-grid'));

    var bottom = el('div', 'dka-bottom');
    var touch = el('div', 'dka-touch');
    var th = el('div', 'dka-touch-head');
    th.appendChild(el('span', 'dka-dot dka-touch-dot'));
    var tnm = el('span', 'dka-touch-name', '');
    tnm.addEventListener('click', function () { gotoWindowsPage(); });
    th.appendChild(tnm);
    th.appendChild(el('span', 'dka-chip dka-touch-tool', ''));
    th.appendChild(el('span', 'dka-touch-title', ''));
    th.appendChild(el('span', 'dka-status', ''));
    th.appendChild(el('div', 'dka-spacer'));
    th.appendChild(el('span', 'dka-pct', ''));
    touch.appendChild(th);
    touch.appendChild(el('div', 'dka-line', ''));
    var bar = el('div', 'dka-bar');
    bar.appendChild(el('div', 'dka-barfill'));
    touch.appendChild(bar);
    touch.appendChild(timelineEl());
    touch.appendChild(el('div', 'dka-toast-slot'));
    bottom.appendChild(touch);

    var dials = el('div', 'dka-dials');
    [
      { id: 'model',  label: T('模型', 'MODEL') },
      { id: 'mode',   label: T('模式', 'MODE') },
      { id: 'notify', label: T('通知', 'NOTIFY') }
    ].forEach(function (d) {
      var wrap = el('div', 'dka-dialwrap');
      wrap.setAttribute('data-dial', d.id);
      wrap.appendChild(el('div', 'dka-dial-lbl', d.label));
      var knob = document.createElement('button');
      knob.type = 'button'; knob.className = 'dka-dial';
      knob.appendChild(el('span', 'dka-tick'));
      knob.addEventListener('click', function () { dialPress(d.id); });
      wrap.appendChild(knob);
      wrap.appendChild(el('div', 'dka-dial-val', '—'));
      dials.appendChild(wrap);
    });
    bottom.appendChild(dials);
    main.appendChild(bottom);
    device.appendChild(main);
    root.appendChild(device);

    var foot = el('div', 'dka-foot');
    foot.appendChild(el('span', null, T('點按鍵 — 直接送到聚焦的 pane ↑', 'tap a key — it fires to the focused pane ↑')));
    foot.appendChild(el('span', null, T('頁面 · 觸控條 · 旋鈕 = 螢幕上的實體 deck', 'profiles · touch strip · dials = your deck, on screen')));
    root.appendChild(foot);
  }

  // ── dials ──────────────────────────────────────────────────────────────────
  function dialPress(id) {
    if (id === 'model') {
      if (!wsOK()) { toast(T('未連線', 'not connected'), 'red'); return; }
      var cur = null;
      var d = dd();
      var st = d && d.detectStatus ? d.detectStatus(focusedText()) : null;
      var curName = (st && st.model || '').toLowerCase();
      for (var i = 0; i < MODELS.length; i++) if (curName.indexOf(MODELS[i]) >= 0) { cur = i; break; }
      var next = MODELS[(cur === null ? 0 : cur + 1) % MODELS.length];
      var run = function () {
        doAction(slashExec('/model ' + next));
        toast(T('模型 → ', 'model → ') + next, 'accent');
      };
      if (window.deckConfirm) window.deckConfirm.show('/model ' + next, run); else run();
    } else if (id === 'mode') {
      if (sendKey('Tab', ['S'])) toast(T('⇧⇥ 循環權限模式', '⇧⇥ cycle mode'), 'accent');
      else toast(T('未連線', 'not connected'), 'red');
    } else if (id === 'notify') {
      if (window.toggleTTS) window.toggleTTS();
      toast('TTS → ' + (ttsOn() ? T('開', 'on') : T('關', 'off')), 'green');
      updateDials(); // immediate re-tick (no WS round-trip involved)
    }
  }

  function setTick(wrap, idx, count) {
    var tick = wrap.querySelector('.dka-tick');
    var val = wrap.querySelector('.dka-dial-val');
    if (!tick) return { val: val };
    if (idx === null || idx < 0) { tick.classList.add('off'); tick.style.transform = 'translateX(-50%)'; }
    else {
      tick.classList.remove('off');
      var deg = -135 + (idx / Math.max(1, count - 1)) * 270;
      tick.style.transform = 'translateX(-50%) rotate(' + deg + 'deg)';
    }
    return { val: val };
  }

  function updateDials() {
    if (compact) return; // no dials in the dock column
    var d = dd();
    var text = focusedText();
    var st = d && d.detectStatus ? d.detectStatus(text) : null;
    var perm = d && d.detectPermMode ? d.detectPermMode(text) : null;
    var model = (st && st.model) || '—';
    var permVal = perm || 'default';
    var tts = ttsOn();
    var sig = model + '|' + permVal + '|' + tts;
    if (sig === dialSig) return;
    dialSig = sig;

    var mw = root.querySelector('[data-dial="model"]');
    if (mw) {
      var mi = null, ml = model.toLowerCase();
      for (var i = 0; i < MODELS.length; i++) if (ml.indexOf(MODELS[i]) >= 0) { mi = i; break; }
      var r = setTick(mw, mi, MODELS.length);
      if (r.val) r.val.textContent = model;
    }
    var pw = root.querySelector('[data-dial="mode"]');
    if (pw) {
      var pi = PERM_MODES.indexOf(permVal);
      var r2 = setTick(pw, pi, PERM_MODES.length);
      if (r2.val) r2.val.textContent = permVal;
    }
    var nw = root.querySelector('[data-dial="notify"]');
    if (nw) {
      var r3 = setTick(nw, tts ? 1 : 0, 2);
      if (r3.val) r3.val.textContent = tts ? T('TTS 開', 'tts on') : T('關', 'off');
    }
  }

  // ── per-tick updates ───────────────────────────────────────────────────────
  function updateStrip(text, state, menu) {
    var d = dd();
    var st = d && d.detectStatus ? d.detectStatus(text) : null;
    var meta = focusedMeta();
    var name = routeLabel();
    var paneTitle = (meta && meta.title) || '';
    var tool = S().currentTool || '';
    var wc = waitingCount();
    var line = menu ? ('⚠ ' + (menu.title || T('等你回答', 'needs your answer'))) : ('● ' + (tailLine(text) || T('無輸出', 'no output')));
    var pct = (st && st.context) || '';
    var connected = window.tmuxWs && window.tmuxWs.isConnected();
    var sessN = (S().sessions || []).length;
    var model = (st && st.model) || '';
    var cost = (st && st.cost) || '';
    var mode = (st && st.mode) || '';

    var sig = [name, paneTitle, tool, state, wc, line, pct, connected, sessN, model, cost, mode].join('|');
    if (sig !== stripSig) {
      stripSig = sig;
      var q = function (sel) { return root.querySelector(sel); };
      var count = q('.dka-logo-count');
      if (count) count.textContent = connected
        ? T('控制台 · ' + sessN + ' 個會話', 'control surface · ' + sessN + ' session' + (sessN === 1 ? '' : 's'))
        : T('未連線', 'disconnected');
      var dots = root.querySelectorAll('.dka-dot');
      for (var i = 0; i < dots.length; i++) {
        dots[i].className = dots[i].className.replace(/\s*st-\S+/g, '') + ' st-' + state;
      }
      var rn = q('.dka-route-name'); if (rn) rn.textContent = name;
      var rt = q('.dka-route-tool');
      if (rt) { rt.textContent = tool; rt.style.display = tool ? '' : 'none'; }
      var rti = q('.dka-route-title');
      if (rti) { rti.textContent = paneTitle; rti.style.display = paneTitle ? '' : 'none'; }
      var tn = q('.dka-touch-name'); if (tn) tn.textContent = name;
      var tt = q('.dka-touch-tool');
      if (tt) { tt.textContent = tool; tt.style.display = tool ? '' : 'none'; }
      var tti = q('.dka-touch-title');
      if (tti) { tti.textContent = paneTitle; tti.style.display = paneTitle ? '' : 'none'; }
      var sx = q('.dka-status');
      if (sx) { sx.textContent = statusText(state); sx.className = 'dka-status st-' + state; }
      var ln = q('.dka-line');
      if (ln) { ln.textContent = line; ln.classList.toggle('warn', !!menu); }
      var pc = q('.dka-pct'); if (pc) pc.textContent = pct;
      var bf = q('.dka-barfill');
      if (bf) {
        var m = pct.match(/(\d+)\/(\d+)/);
        var frac = m ? Math.min(1, parseInt(m[1], 10) / Math.max(1, parseInt(m[2], 10))) :
          (pct.match(/^(\d+)%$/) ? parseInt(pct, 10) / 100 : 0);
        bf.style.width = Math.round(frac * 100) + '%';
      }
      var wb = q('.dka-wait');
      if (wb) {
        wb.style.display = wc > 0 ? '' : 'none';
        var wt = q('.dka-wait-txt'); if (wt) wt.textContent = wc + T(' 個等回覆', ' waiting');
      }
      // compact-only status chips (model / cost / mode) — values verbatim
      var bd = q('.dka-badges');
      if (bd) {
        bd.innerHTML = '';
        if (model) bd.appendChild(el('span', 'dka-badge', '🤖 ' + model));
        if (cost) bd.appendChild(el('span', 'dka-badge', '💰 $' + cost));
        if (mode) {
          var mb = el('span', 'dka-badge dka-badge-mode mode-' + mode, '⏵ ' + mode);
          bd.appendChild(mb);
        }
        bd.style.display = bd.children.length ? '' : 'none';
      }
    }
    var ck = root.querySelector('.dka-clock');
    if (ck) {
      var now = new Date();
      ck.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(function (n) { return String(n).padStart(2, '0'); }).join(':');
    }
    updateTimeline();
  }

  // updateTimeline runs every tick (outside the strip-signature gate) so the live
  // in-state counter and the working/waiting/idle split advance against the client
  // clock without a server round-trip. Reads the focused pane's ring from the
  // shared /api/agents poller.
  function updateTimeline() {
    var host = root.querySelector('.dka-timeline');
    if (!host) return;
    var tl = focusedTimeline();
    if (!tl) { host.style.display = 'none'; return; }
    host.style.display = '';
    var nowSec = Math.floor(Date.now() / 1000);
    var dur = tl.sinceUnix > 0 ? Math.max(0, nowSec - tl.sinceUnix) : 0;
    var txt = host.querySelector('.dka-tl-txt');
    if (txt) txt.textContent = statusText(tl.state) + ' ' + fmtDuration(dur);
    var split = splitDurations(tl.recent, nowSec);
    var total = split.working + split.waiting + split.idle;
    var setW = function (sel, v) {
      var e = host.querySelector(sel);
      if (e) e.style.width = (total > 0 ? (v / total * 100) : 0).toFixed(1) + '%';
    };
    setW('.dka-tl-working', split.working);
    setW('.dka-tl-waiting', split.waiting);
    setW('.dka-tl-idle', split.idle);
  }

  function gridSigFor(menu, state) {
    var p = pageById(page);
    if (p && p.type === 'windows') {
      var s = S();
      if (drillWindow != null) {
        // drill-down grid: re-render on pane list load + any per-pane state /
        // routing-target change (drillPanes==null encodes the loading frame).
        return 'panes:' + drillWindow + '#' + (drillPanes == null ? 'loading' :
          drillPanes.map(function (pn) {
            return pn.id + ',' + (panePaneStates[pn.id] || '') + ',' + pn.active + ',' + (pn.title || pn.command || '') + ',' + paneCtxPct(pn.id);
          }).join('|')) + '#' + (s.focusedPane || '');
      }
      return 'win:' + (s.currentSession || '') + '#' + s.activeWindowIdx + '#' +
        (s.windows || []).map(function (w) {
          return w.index + ',' + w.name + ',' + w.panes + ',' + (paneStates[w.index] || '') + ',' + winCtxPct(w.index);
        }).join('|') + '#' + (s.sessions || []).map(function (x) { return x.name; }).join(',');
    }
    if (p && p.type === 'ctrl') {
      if (menu) return 'menu:' + menu.options.map(function (o) { return o.n + o.label; }).join('|');
      var d = dd();
      var perm = d && d.detectPermMode ? d.detectPermMode(focusedText()) : null;
      return 'ctrl:' + state + ':' + (perm || '');
    }
    return page + (editMode ? ':edit' : ''); // buttons pages are static per page (edit adds the ＋ key)
  }

  function tick() {
    if (!root) return;
    var d = dd();
    var text = focusedText();
    var state = focusedState(text);
    var menu = d && d.detectMenu ? d.detectMenu(text) : null;

    updateStrip(text, state, menu);
    updateDials();
    if (waitPanelEl) renderWaitList(); // I2: keep the open triage list live as pane_states arrive
    // dock keeps the permission pills — feed them the authoritative read-back
    // each tick (the pill component ignores updates mid-tap)
    if (compact && window.deckSlider && d && d.detectPermMode) {
      window.deckSlider.setMode(d.detectPermMode(text));
    }

    var pi = pageInfo(menu);
    var hs = pi[0] + '|' + pi[1];
    if (hs !== headSig) {
      headSig = hs;
      var t = root.querySelector('.dka-pagetitle'); if (t) t.textContent = pi[0];
      var h = root.querySelector('.dka-pagehint'); if (h) h.textContent = pi[1];
    }

    var sig = gridSigFor(menu, state);
    if (sig === renderedSig) { candidate = null; candidateCount = 0; return; }
    if (sig === candidate) {
      candidateCount++;
      if (candidateCount >= 2) {
        candidate = null; candidateCount = 0;
        renderedSig = sig;
        var d2 = dd();
        var perm = d2 && d2.detectPermMode ? d2.detectPermMode(text) : null;
        renderGrid(keysForPage(menu, state, perm));
      }
    } else if (renderedSig === null) {
      // first paint / page switch: render immediately, no hysteresis wait
      renderedSig = sig;
      var d3 = dd();
      var perm3 = d3 && d3.detectPermMode ? d3.detectPermMode(text) : null;
      renderGrid(keysForPage(menu, state, perm3));
    } else {
      candidate = sig;
      candidateCount = 1;
    }
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function start(rootEl, deckCfg, opts) {
    root = rootEl;
    if (!root) return;
    cfg = deckCfg || { panels: [] };
    compact = !!(opts && opts.compact);
    // default to ctrl if it's a visible page, else the first visible page
    page = (pageById('ctrl') && !pageById('ctrl').hidden) ? 'ctrl'
      : (visiblePages()[0] ? visiblePages()[0].id : 'ctrl');
    editMode = false;
    drillWindow = null; drillPanes = null;
    closeWaitPanel();
    renderedSig = null; candidate = null; candidateCount = 0;
    stripSig = null; dialSig = null; headSig = null;
    build();
    tick();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 600);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    clearTimeout(toastT);
    closeWaitPanel(); // body-level overlay must not leak when the deck closes
    if (root) { root.classList.remove('dka', 'dka-compact'); root.innerHTML = ''; }
    root = null;
  }

  function active() { return !!root; }

  function onPaneStates(states, panes) {
    paneStates = states || {};
    panePaneStates = panes || {};
  }

  window.deckAgent = {
    start: start, stop: stop, active: active, onPaneStates: onPaneStates,
    countWaiting: countWaiting,
    // I5 %-badge formatter + U3 grid session-tone (pure, unit-tested).
    ctxPctStr: ctxPctStr, sessionTone: sessionTone,
    // I3 pure helpers (unit-tested): fold a recent[] ring into a live split /
    // duration label.
    splitDurations: splitDurations, fmtDuration: fmtDuration,
    // I4 replay: openReplayPicker is the entry (also on the ⏺ strip button);
    // clampIdx / replayAgentLabel are the pure helpers under unit test.
    openReplay: openReplay, openReplayPicker: openReplayPicker,
    clampIdx: clampIdx, replayAgentLabel: replayAgentLabel,
    // I6 remote-host federation (read-only): isRemoteAgent / agentHostLabel are
    // the pure gates under unit test; openRemoteInfo is the read-only panel a
    // picked remote pane opens (no record/focus/input).
    isRemoteAgent: isRemoteAgent, agentHostLabel: agentHostLabel,
    openRemoteInfo: openRemoteInfo
  };
})();
