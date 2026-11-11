/**
 * app.js — Main application logic for tmux-webui V2
 * Orchestrates WebSocket, pane management, layout, tool profiles, skills
 */

// ========================================================================
// 0. Utilities
// ========================================================================
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// cfgGet reads a dotted path out of the injected window.__UI_CONFIG__ blob
// (index.html sets it from config.json's opaque `ui`; null when unset — see
// internal/pwa). Every miss — null blob, absent segment, a non-object mid-path,
// or an explicit null leaf — yields `fallback`, so a partial or absent config
// keeps the current behavior. Present falsy values (0, false, "") pass through.
function cfgGet(path, fallback) {
  let cur = window.__UI_CONFIG__;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[key];
  }
  return cur == null ? fallback : cur;
}
window.cfgGet = cfgGet; // gestures.js reads ui.theme.fontSize through this

// ========================================================================
// 1. State
// ========================================================================
window.tmuxState = {
  focusedPane: '',
  maximizedPane: '',
  paneEls: {},
  paneInfo: {},
  paneOrder: [],
  paneInputs: {},  // per-pane input buffer
  currentLayout: 'auto',
  customWeights: null,
  currentTool: null,
  currentSession: '',
  activeWindowIdx: null,
  autoRelay: false,
  pendingFocusPane: '', // deck drill-down: focus this pane once its window's metadata arrives
  pendingWinRestore: false, // one-shot: steer back to the saved window on the first windows frame after a fresh connect
};

// ========================================================================
// 2. DOM Refs
// ========================================================================
const container     = document.getElementById('pane-container');
const sessionsEl    = document.getElementById('sessions');
const sessionDD      = document.getElementById('session-dd');
const sessionDDBtn   = document.getElementById('session-dd-btn');
const sessionDDLabel = document.getElementById('session-dd-label');
const sessionDDPanel = document.getElementById('session-dd-panel');
const statusEl      = document.getElementById('status');
const inputEl       = document.getElementById('input');
const sendBtn       = document.getElementById('send-btn');
const uploadBtn     = document.getElementById('upload-btn');
const relayToggle   = document.getElementById('relay-toggle');
const fileInput     = document.getElementById('file-input');
const focusLabel    = document.getElementById('focused-label');
const layoutSelect  = document.getElementById('layout-select');
const layoutDD      = document.getElementById('layout-dd');
const layoutDDBtn   = document.getElementById('layout-dd-btn');
const layoutDDIco   = document.getElementById('layout-dd-ico');
const layoutDDLabel = document.getElementById('layout-dd-label');
const layoutDDPanel = document.getElementById('layout-dd-panel');
const resetLayoutBtn = document.getElementById('reset-layout');
const winTabsEl     = document.getElementById('win-tabs');
const mobilePaneTabs = document.getElementById('mobile-pane-tabs');

const S = window.tmuxState;

// ========================================================================
// 3. Tool Profiles
// ========================================================================
const TOOL_PROFILES = {
  claude: {
    name: 'Claude Code',
    detect: (cmd, title) => /claude/i.test(cmd) || /claude/i.test(title) || /^\d+\.\d+\.\d+$/.test(cmd),
    actions: [
      {l:'/compact',s:'/compact'},{l:'/clear',s:'/clear'},{l:'/cost',s:'/cost'},
      {l:'/model',s:'/model'},{l:'/commit',s:'/commit'},{l:'/review',s:'/review'},
      {l:'/plan',s:'/plan'},{l:'/status',s:'/status'},{l:'/context',s:'/context'},
      {l:'/think',s:'/think'},{l:'/help',s:'/help'},
    ],
  },
  codex: {
    name: 'Codex CLI',
    detect: (cmd, title) => /codex/i.test(cmd) || /codex/i.test(title),
    actions: [
      {l:'/compact',s:'/compact'},{l:'/diff',s:'/diff'},{l:'/model',s:'/model'},
      {l:'/review',s:'/review'},{l:'/status',s:'/status'},{l:'/plan',s:'/plan'},
      {l:'/new',s:'/new'},{l:'/mention',s:'/mention '},
    ],
  },
  gemini: {
    name: 'Gemini CLI',
    detect: (cmd, title) => /gemini/i.test(cmd) || /gemini/i.test(title),
    actions: [
      {l:'/compress',s:'/compress'},{l:'/clear',s:'/clear'},{l:'/stats',s:'/stats'},
      {l:'/copy',s:'/copy'},{l:'/tools',s:'/tools'},{l:'/mcp',s:'/mcp'},
      {l:'/memory',s:'/memory show'},{l:'/help',s:'/help'},
    ],
  },
  aider: {
    name: 'Aider',
    detect: (cmd, title) => /aider/i.test(cmd) || /aider/i.test(title),
    actions: [
      {l:'/add',s:'/add '},{l:'/drop',s:'/drop '},{l:'/diff',s:'/diff'},
      {l:'/undo',s:'/undo'},{l:'/commit',s:'/commit'},{l:'/model',s:'/model '},
      {l:'/tokens',s:'/tokens'},{l:'/ask',s:'/ask '},{l:'/help',s:'/help'},
    ],
  },
  cursor: {
    name: 'Cursor',
    detect: (cmd, title) => /cursor/i.test(cmd) || /cursor/i.test(title),
    actions: [
      {l:'/compress',s:'/compress'},{l:'/model',s:'/model'},
      {l:'/rules',s:'/rules'},{l:'/mcp',s:'/mcp'},
    ],
  },
  agy: {
    name: 'Antigravity',
    detect: (cmd, title) => /^agy$|antigravity/i.test(cmd) || /\bagy\b|antigravity/i.test(title),
    actions: [],
  },
  hermes: {
    name: 'Hermes',
    detect: (cmd, title) => /hermes/i.test(cmd) || /hermes/i.test(title),
    actions: [
      {l:'/clear',s:'/clear'},{l:'/undo',s:'/undo'},{l:'/skills',s:'/skills'},
      {l:'/billing',s:'/billing'},{l:'/help',s:'/help'},
    ],
  },
  kimi: {
    // Kimi Code runs under a shell wrapper (pane_current_command stays "zsh");
    // detection relies on its OSC title ("Kimi Code").
    name: 'Kimi Code',
    detect: (cmd, title) => /kimi/i.test(cmd) || /kimi/i.test(title),
    actions: [
      {l:'/init',s:'/init'},{l:'/clear',s:'/clear'},{l:'/help',s:'/help'},
    ],
  },
  opencode: {
    name: 'OpenCode',
    detect: (cmd, title) => /opencode/i.test(cmd) || /opencode/i.test(title),
    actions: [
      {l:'/new',s:'/new'},{l:'/compact',s:'/compact'},{l:'/models',s:'/models'},
      {l:'/share',s:'/share'},{l:'/help',s:'/help'},
    ],
  },
  copilot: {
    name: 'Copilot CLI',
    detect: (cmd, title) => /copilot/i.test(cmd) || /copilot/i.test(title),
    actions: [
      {l:'/model',s:'/model'},{l:'/mcp',s:'/mcp'},{l:'/clear',s:'/clear'},
      {l:'/help',s:'/help'},
    ],
  },
  qwen: {
    // Gemini CLI fork — same slash surface.
    name: 'Qwen Code',
    detect: (cmd, title) => /qwen/i.test(cmd) || /qwen/i.test(title),
    actions: [
      {l:'/compress',s:'/compress'},{l:'/clear',s:'/clear'},{l:'/stats',s:'/stats'},
      {l:'/tools',s:'/tools'},{l:'/mcp',s:'/mcp'},{l:'/help',s:'/help'},
    ],
  },
  pi: {
    // "pi" is too short for substring matching (would hit "copilot"-adjacent
    // titles, "pip", …) — exact command / leading title word only.
    name: 'Pi',
    detect: (cmd, title) => /^pi$/i.test(cmd.trim()) || /^pi\b/i.test(title.trim()),
    actions: [],
  },
};
// Order matters: first match wins. "pi" (exact-match) stays last; "copilot"
// before "pi" so its panes never reach the shorter pattern.
const PROFILE_ORDER = ['claude','codex','gemini','aider','cursor','agy','hermes','kimi','opencode','copilot','qwen','pi'];

function detectTool(pane) {
  if (!pane) return null;
  for (const key of PROFILE_ORDER) {
    if (TOOL_PROFILES[key].detect(pane.command || '', pane.title || '')) return key;
  }
  return null;
}

// ── Stale-title guard ───────────────────────────────────────────────────
// tmux keeps the last OSC title an agent set: after `kimi` (shell-wrapped,
// pane_current_command stays "zsh") exits, the pane still reports
// title="Kimi Code" forever. So a title-only match on a plain-shell pane is
// trusted only while the pane bottom still shows live TUI chrome (input-box
// borders / braille spinner). Box corners+verticals only — a just-exited
// agent's footer glyphs (⏵) and horizontal rules (─) linger in scrollback
// and would false-positive. Empty content (pane just mounted, no output
// frame yet) stays trusted — it self-corrects within a frame.
const SHELL_CMDS = /^(zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|pwsh)$/i;
const TUI_CHROME = /[╭╮╰╯│┃┌┐└┘]|[⠁-⣿]/;

function paneToolKey(paneId) {
  const info = S.paneInfo[paneId];
  if (!info) return null;
  const key = detectTool(info);
  if (!key) return null;
  const cmdOnlyMatch = TOOL_PROFILES[key].detect(info.command || '', '');
  if (!cmdOnlyMatch && SHELL_CMDS.test((info.command || '').trim())) {
    // Walk .term-line divs bottom-up — container textContent flattens all
    // lines into one string (no \n between divs), which would smear old
    // chrome from anywhere in scrollback into the tail window.
    const lineEls = S.paneEls[paneId]?.terminal?.querySelectorAll('.term-line');
    if (lineEls && lineEls.length) {
      const tail = [];
      for (let i = lineEls.length - 1; i >= 0 && tail.length < 6; i--) {
        const t = lineEls[i].textContent.replace(/\u200b/g, ''); // strip empty-line ZWSP placeholders
        if (t.trim()) tail.push(t);
      }
      if (tail.length && !TUI_CHROME.test(tail.join('\n'))) return null;
    }
  }
  return key;
}

// Re-derive a pane's tool badge from its latest command/title/content and
// swap the header chip when the answer changed. Cheap enough to run on every
// output frame — the DOM is only touched on an actual transition.
function refreshPaneBadge(paneId) {
  const pe = S.paneEls[paneId];
  const info = S.paneInfo[paneId];
  if (!pe || !info) return;
  const key = paneToolKey(paneId);
  const hdr = pe.box.querySelector('.pane-header');
  const cur = hdr.querySelector('.pane-tool');
  const curKey = cur ? (cur.dataset.tool || null) : null;
  if (curKey === key) return;
  if (cur) cur.remove();
  if (key) {
    const chip = document.createElement('span');
    chip.className = `pane-tool pane-tool--${key}`;
    chip.dataset.tool = key;
    chip.textContent = TOOL_PROFILES[key].name;
    hdr.querySelector('.pane-label').after(chip);
  }
  if (paneId === S.focusedPane) {
    focusLabel.textContent = `${info.window_name}:${info.pane}${key ? ` [${TOOL_PROFILES[key].name}]` : ''}`;
    updateToolState(key);
  }
}

// ========================================================================
// 3.5 UI Config consumption (window.__UI_CONFIG__)
// ========================================================================
// Everything here reads through cfgGet, so a null/partial blob is a no-op and
// the server-rendered defaults stand. initUIConfig() runs once at boot (§19).

// config key → CSS custom property. Mostly identity; accentHover maps to the
// existing --accent-h var name.
const THEME_COLOR_VARS = {
  bg: '--bg', surface: '--surface', surface2: '--surface2', border: '--border',
  text: '--text', dim: '--dim', accent: '--accent', accentHover: '--accent-h',
  green: '--green', red: '--red', yellow: '--yellow', cyan: '--cyan',
};

function applyTheme() {
  // The embedded terminal owns its generated theme. Old runtime config must
  // not write inline colors over the terminal stylesheet after a UI update.
  if (window.__CAO_WORKSPACE__) return;
  const root = document.documentElement;
  const colors = cfgGet('theme.colors', null);
  if (colors && typeof colors === 'object') {
    for (const [key, cssVar] of Object.entries(THEME_COLOR_VARS)) {
      if (colors[key] != null) root.style.setProperty(cssVar, String(colors[key]));
    }
  }
  const ff = cfgGet('theme.fontFamily', null);
  if (ff != null) root.style.setProperty('--font-mono', String(ff));
  const radius = cfgGet('theme.radius', null);
  if (radius != null) root.style.setProperty('--radius', String(radius));
  // Font-size precedence: localStorage (user pinched, gestures.js) > config >
  // CSS default. Only seed from config when the user hasn't pinched; gestures.js
  // re-applies the localStorage value after us when present.
  const fs = cfgGet('theme.fontSize', null);
  if (fs != null && localStorage.getItem('tmux-webui-font-size') === null) {
    root.style.setProperty('--font-size', fs + 'px');
  }
}

// ── Quick-action bar (footer) ──
// ui.keys.quickBar: ordered [{key,label,icon,title}] REPLACES the default 6
// .qbtn buttons; same classes/attributes so keys wiring (§14) + main.css
// data-key color selectors keep working. buildQuickBar is DOM-pure (createElement
// only) for testing; renderQuickBar swaps them into the live footer.
function buildQuickBar(items) {
  return items.map(it => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qbtn';
    btn.dataset.key = it.key;
    if (it.title) btn.title = it.title;
    btn.textContent = it.label != null ? it.label : it.key;
    if (it.icon) {
      const ico = document.createElement('span');
      ico.className = 'qico';
      ico.textContent = it.icon;
      btn.appendChild(ico);
    }
    return btn;
  });
}

function renderQuickBar(items) {
  const qa = document.querySelector('.quick-actions');
  if (!qa) return;
  // Drop the server-rendered default data-key buttons; keep the arrow pad +
  // ek-toggle (keys.js wires those by id) and slot the custom bar ahead of them.
  qa.querySelectorAll('.qbtn[data-key]').forEach(b => b.remove());
  const anchor = document.getElementById('quick-arrow-pad') || document.getElementById('ek-toggle');
  for (const btn of buildQuickBar(items)) qa.insertBefore(btn, anchor);
}

// ── Extra-keys bar (modifier / ctrl / shell rows) ──
// mod code → display label + title, matching the server-rendered defaults.
const MOD_LABELS = {
  C:     { label: 'Ctrl',  title: 'Ctrl (tap=once, double-tap=lock)' },
  M:     { label: 'Alt',   title: 'Alt/Option' },
  Shift: { label: 'Shift', title: 'Shift' },
  S:     { label: 'Cmd',   title: 'Cmd/Super' },
};

function buildModifierKeys(mods) {
  return mods.map(m => {
    const btn = document.createElement('button');
    btn.className = 'ek mod';
    btn.dataset.mod = m;
    const meta = MOD_LABELS[m];
    btn.title = meta ? meta.title : m;
    btn.textContent = meta ? meta.label : m;
    return btn;
  });
}

function buildCtrlKeys(ctrls) {
  return ctrls.map(c => {
    const btn = document.createElement('button');
    btn.className = 'ek';
    btn.dataset.ctrl = c.ctrl;
    btn.title = c.title != null ? c.title : ('Ctrl+' + String(c.ctrl).toUpperCase());
    btn.textContent = c.label != null ? c.label : ('C-' + c.ctrl);
    if (c.color) btn.style.color = 'var(--' + c.color + ')'; // color = theme color key
    return btn;
  });
}

function buildShellKeys(chars) {
  return chars.map(ch => {
    const btn = document.createElement('button');
    btn.className = 'ek';
    btn.dataset.ek = ch;
    btn.textContent = ch;
    return btn;
  });
}

// The extra-keys bar is a flat flex list partitioned by .ek-sep into rows:
//   [modifiers] sep [ctrl shortcuts] sep [shell chars] sep [arrow pad]
// A configured row swaps its buttons in place (keys.js, loaded after, wires the
// fresh DOM); an unconfigured row is left exactly as the server rendered it.
function renderExtraKeys() {
  const ek = document.getElementById('extra-keys');
  if (!ek) return;
  const rows = [
    ['keys.modifiers', buildModifierKeys],
    ['keys.ctrlShortcuts', buildCtrlKeys],
    ['keys.shellChars', buildShellKeys],
  ];
  const seps = Array.from(ek.children).filter(c => c.classList && c.classList.contains('ek-sep'));
  rows.forEach(([cfgPath, build], i) => {
    const spec = cfgGet(cfgPath, null);
    if (!Array.isArray(spec)) return; // absent → leave the server row untouched
    const endSep = seps[i];
    if (!endSep) return; // structure drifted — leave it rather than corrupt
    // Remove the existing .ek buttons in this segment (from the previous
    // separator, or the start, up to this separator).
    const startSep = i > 0 ? seps[i - 1] : null;
    let node = startSep ? startSep.nextSibling : ek.firstChild;
    while (node && node !== endSep) {
      const next = node.nextSibling;
      if (node.classList && node.classList.contains('ek')) node.remove();
      node = next;
    }
    for (const btn of build(spec)) ek.insertBefore(btn, endSep);
  });
}

// ── Slash-action strip ──
// ui.slashPalette.<toolKey>.actions REPLACES that tool's default actions
// wholesale (per-tool, not deep-merged). The detect regexes and PROFILE_ORDER
// stay hardcoded, so a palette can only retune an EXISTING tool — an unknown
// toolKey is warned and ignored. Pure over its args for testability.
function applySlashPalette(profiles, palette) {
  if (!palette || typeof palette !== 'object') return profiles;
  for (const toolKey of Object.keys(palette)) {
    if (!profiles[toolKey]) {
      console.warn('[ui-config] slashPalette: unknown tool "' + toolKey + '" ignored');
      continue;
    }
    const spec = palette[toolKey];
    if (spec && Array.isArray(spec.actions)) profiles[toolKey].actions = spec.actions;
  }
  return profiles;
}

// ui.layout.defaultPreset seeds the starting layout. Runs before loadLayoutPref
// (§19) so a saved localStorage layout still wins; unknown/absent preset → 'auto'.
function applyLayoutDefault() {
  const preset = cfgGet('layout.defaultPreset', null);
  if (preset && LAYOUT_PRESETS[preset]) {
    S.currentLayout = preset;
    if (layoutSelect) layoutSelect.value = preset;
  }
}

// One-shot boot: apply every configured UI override. Null/partial config → no-op.
function initUIConfig() {
  applyTheme();
  const qb = cfgGet('keys.quickBar', null);
  if (Array.isArray(qb) && qb.length) renderQuickBar(qb);
  renderExtraKeys();
  applySlashPalette(TOOL_PROFILES, cfgGet('slashPalette', null));
  applyLayoutDefault();
}

// ========================================================================
// 4. Layout Presets
// ========================================================================
const LAYOUT_PRESETS = {
  '2x2':  { cols:[1,1], rows:[1,1] },
  '4col': { cols:[1,1,1,1], rows:[1] },
  auto:   { cols:null, rows:null },
  '1+2':  { cols:[2,1], rows:[1,1],
             placement:[{c:'1/2',r:'1/3'},{c:'2/3',r:'1/2'},{c:'2/3',r:'2/3'}] },
  '3col': { cols:[1,1,1], rows:[1] },
  '1x1':  { cols:[1], rows:[1] },
};

// Schematic previews for the layout dropdown — one rect per pane slot,
// mirroring the LAYOUT_PRESETS geometry on a 24x16 canvas.
const LAYOUT_META = {
  '2x2':  { label:'2x2 Grid',  rects:[[0,0,11.2,7.2],[12.8,0,11.2,7.2],[0,8.8,11.2,7.2],[12.8,8.8,11.2,7.2]] },
  '4col': { label:'4 Columns', rects:[[0,0,4.9,16],[6.4,0,4.9,16],[12.7,0,4.9,16],[19.1,0,4.9,16]] },
  auto:   { label:'Auto',      rects:[[3,3,8,4.5],[13,3,8,4.5],[3,9.5,18,4.5]], adaptive:true },
  '1+2':  { label:'1 + 2',     rects:[[0,0,15,16],[16.5,0,7.5,7.2],[16.5,8.8,7.5,7.2]] },
  '3col': { label:'3 Columns', rects:[[0,0,7,16],[8.5,0,7,16],[17,0,7,16]] },
  '1x1':  { label:'Single',    rects:[[0,0,24,16]] },
};

function layoutIcon(key) {
  const m = LAYOUT_META[key];
  if (!m) return '';
  let body = m.rects.map(r => `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" rx="1.5"/>`).join('');
  // Auto gets a dashed frame around shrunken cells — "the grid adapts".
  if (m.adaptive) body = `<rect x="0.5" y="0.5" width="23" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-dasharray="3 2" opacity=".6"/>` + body;
  return `<svg viewBox="0 0 24 16" aria-hidden="true">${body}</svg>`;
}

// Pure slot/overflow selection lifted out of applyLayout (§8 Layout Engine):
// which of `order` (pane ids in drag order) stays visible in `slots` cells,
// always keeping the focused pane (its index `focusIdx` in order, -1 = none)
// on-screen even when it sorts past the cut.
// pure helper for tests
function selectVisible(order, slots, focusIdx) {
  if (order.length <= slots) return order.slice();
  const visible = order.slice(0, slots);
  if (focusIdx >= 0 && focusIdx < order.length && !visible.includes(order[focusIdx])) {
    visible[visible.length - 1] = order[focusIdx];
  }
  return visible;
}

// Exposed for node --test (pure, DOM-free) — mirrors window.linkParsePartyCode.
window.__layoutTest = { LAYOUT_PRESETS, LAYOUT_META, layoutIcon, selectVisible };
// histAnchor is declared next to lineDiffUpdate (§11.5) — function declarations
// hoist, and the export must sit up here: the test harness's tolerant load dies
// on fake-DOM gaps further down, so late window.* exports never execute.
window.__histTest = { histAnchor };
// posToCell is declared near histAnchor (§11.5); same hoist-and-export-early
// reason so the tolerant test load sees it.
window.__mouseTest = { posToCell, isTapGesture };
// cfgGet + the UI-config pure builders (§3.5) — same hoist-and-export-early
// rationale so the tolerant test load captures them before app.js dereferences
// real DOM refs further down.
window.__cfgTest = { cfgGet, buildQuickBar, applySlashPalette };

// ========================================================================
// 6. Helpers
// ========================================================================

function focusMessageInput() {
  // Async ACK/timeout/selection handlers must not steal focus into a hidden
  // composer while Direct keys owns typing. Draft/ACK state stays mounted.
  if (window.__CAO_WORKSPACE__ && document.getElementById('app')?.classList.contains('cao-direct-active')) return;
  inputEl.focus();
}

window.sendSkillOrAction = function(cmdStr) {
  if (!window.tmuxWs || !window.tmuxWs.isConnected() || !S.focusedPane) return;
  if (window.linkSendBlocked && window.linkSendBlocked()) return; // input follow-lock (spec §3 Slice 2)
  if (cmdStr.endsWith(' ')) {
    inputEl.value = cmdStr;
    focusMessageInput();
  } else {
    window.tmuxWs.send({ type:'input', pane:S.focusedPane, text:cmdStr });
    if (S.paneEls[S.focusedPane]) S.paneEls[S.focusedPane].resetScroll();
  }
};

window.flashInputError = function(msg) {
  inputEl.classList.add('input-error');
  inputEl.placeholder = msg || 'Send failed';
  setTimeout(() => {
    inputEl.classList.remove('input-error');
    inputEl.placeholder = 'Type a message...';
  }, 1500);
};

window._inputPending = null; // { nonce, text, pane, timer }
function _setInputSending(on) { inputEl.disabled = on; sendBtn.disabled = on; sendBtn.classList.toggle('sending', on); }
window.handleInputAck = function(nonce, ok, message) {
  const p = window._inputPending;
  if (!p || (nonce && p.nonce !== nonce)) { if (!ok) window.flashInputError(message); return; }
  clearTimeout(p.timer);
  window._inputPending = null;
  _setInputSending(false);
  if (ok) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    S.paneInputs[p.pane] = '';
    if (S.paneEls[p.pane]) S.paneEls[p.pane].resetScroll();
  } else {
    window.flashInputError(message);
  }
  focusMessageInput();
};

window.sendInput = function() {
  let text = inputEl.value;
  if (!text) return;
  if (window._inputPending) return;
  if (!window.tmuxWs || !window.tmuxWs.isConnected()) { window.flashInputError('Not connected'); return; }
  if (!S.focusedPane) { window.flashInputError('No pane selected'); return; }
  if (window.linkSendBlocked && window.linkSendBlocked()) { window.flashInputError('following…'); return; } // input follow-lock (spec §3 Slice 2)

  // Auto-relay prefix: prepend /tmux-relay for Claude Code panes (toggle-controlled).
  // The /tmux-relay guard stays literal — it's the "already a relay command"
  // sentinel; only the prefix text is configurable.
  if (S.autoRelay && S.currentTool === 'claude' && !text.startsWith('/tmux-relay')) {
    text = cfgGet('relay.autoPrefixText', '/tmux-relay async dispatch to a free pane: ') + text;
  }

  const nonce = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  const pane = S.focusedPane;
  _setInputSending(true);
  const timer = setTimeout(() => {
    if (window._inputPending && window._inputPending.nonce === nonce) {
      window._inputPending = null; _setInputSending(false);
      window.flashInputError('Send timed out'); focusMessageInput();
    }
  }, cfgGet('input.sendAckTimeoutMs', 5000));
  window._inputPending = { nonce, text, pane, timer };
  window.tmuxWs.send({ type:'input', pane, text, nonce });
};

// ── Send / Long-Press Clear ──
(function() {
  let mode = 'send', transTimer = null, clearTimer = null;
  function reset() {
    clearTimeout(transTimer); clearTimeout(clearTimer);
    mode = 'send';
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('clear-transition', 'clear-ready');
  }
  function doClear() {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    reset();
  }
  sendBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    reset();
    // At 1s: start color transition + text change
    transTimer = setTimeout(() => {
      mode = 'clear';
      sendBtn.textContent = 'Clear';
      sendBtn.classList.add('clear-transition');
      // At 2s: fully ready
      setTimeout(() => sendBtn.classList.add('clear-ready'), 1000);
    }, 1000);
    // At 3s: auto-clear
    clearTimer = setTimeout(doClear, 3000);
  });
  sendBtn.addEventListener('pointerup', () => {
    if (mode === 'clear') { doClear(); return; }
    reset();
    window.acClose?.();
    window.sendInput();
  });
  sendBtn.addEventListener('pointerleave', reset);
  sendBtn.addEventListener('pointercancel', reset);
})();

// ── Auto-Relay Toggle ──
relayToggle.addEventListener('click', () => {
  S.autoRelay = !S.autoRelay;
  relayToggle.classList.toggle('active', S.autoRelay);
  relayToggle.title = S.autoRelay ? 'Auto-Relay: ON' : 'Auto-Relay: OFF';
});

// ── File Upload ──

uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  if (!files.length) return;

  uploadBtn.classList.add('uploading');
  uploadBtn.disabled = true;

  const basePath = location.pathname.replace(/\/+$/, '') || '';
  const paths = [];
  const errors = [];

  for (const file of files) {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(basePath + '/api/upload', { method: 'POST', body: form });

      if (!res.ok) {
        if (res.status === 401 || res.status === 302 || res.redirected) {
          throw new Error('Session expired — please re-login');
        }
        const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }

      const { path } = await res.json();
      paths.push(path);
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  if (paths.length) {
    const insert = ' ' + paths.map(p => `@${p}`).join(' ') + ' ';
    const start = inputEl.selectionStart || inputEl.value.length;
    const end = inputEl.selectionEnd || start;
    inputEl.value = inputEl.value.slice(0, start) + insert + inputEl.value.slice(end);
    inputEl.selectionStart = inputEl.selectionEnd = start + insert.length;
    focusMessageInput();
  }
  if (errors.length) {
    window.flashInputError(errors.join('; '));
  }

  uploadBtn.classList.remove('uploading');
  uploadBtn.disabled = false;
  fileInput.value = '';
});

// ========================================================================
// 7. Tool Detection
// ========================================================================

function updateToolState(toolKey) {
  S.currentTool = toolKey;
}

// ========================================================================
// 8. Layout Engine
// ========================================================================

function applyLayout() {
  syncLayoutLabel(); // every layout change funnels through here
  const ordered = S.paneOrder.length ? S.paneOrder.filter(id => S.paneEls[id]) : Object.keys(S.paneEls);
  const count = ordered.length;
  if (count === 0) return;
  container.style.display = 'grid';

  ordered.forEach(id => {
    if (S.paneEls[id]) {
      S.paneEls[id].box.style.gridColumn = '';
      S.paneEls[id].box.style.gridRow = '';
      S.paneEls[id].box.style.display = '';
    }
  });
  container.querySelectorAll('.hidden-indicator').forEach(el => el.remove());

  if (S.currentLayout === 'auto') {
    if (count <= 1) { container.style.gridTemplateColumns = '1fr'; container.style.gridTemplateRows = '1fr'; }
    else if (count === 2) { container.style.gridTemplateColumns = '1fr 1fr'; container.style.gridTemplateRows = '1fr'; }
    else if (count <= 4) { container.style.gridTemplateColumns = '1fr 1fr'; container.style.gridTemplateRows = '1fr 1fr'; }
    else if (count <= 6) { container.style.gridTemplateColumns = '1fr 1fr 1fr'; container.style.gridTemplateRows = '1fr 1fr'; }
    else { container.style.gridTemplateColumns = '1fr 1fr 1fr'; container.style.gridTemplateRows = `repeat(${Math.ceil(count/3)}, 1fr)`; }
  } else {
    const preset = LAYOUT_PRESETS[S.currentLayout];
    if (!preset || !preset.cols) return;
    const cols = S.customWeights ? S.customWeights.cols : preset.cols;
    const rows = S.customWeights ? S.customWeights.rows : preset.rows;
    // Placement presets seat exactly placement.length panes — an unseated pane
    // would auto-flow into an implicit grid row sized by its content, starving
    // the fr rows and visually collapsing the whole template.
    const slots = preset.placement ? preset.placement.length : cols.length * rows.length;
    container.style.gridTemplateColumns = cols.map(v => v + 'fr').join(' ');
    container.style.gridTemplateRows = rows.map(v => v + 'fr').join(' ');

    let visible = ordered;
    if (count > slots) {
      // Keep the focused pane on-screen: Single means "the pane I'm working
      // in", not "first in drag order".
      const focusIdx = S.focusedPane ? ordered.indexOf(S.focusedPane) : -1;
      visible = selectVisible(ordered, slots, focusIdx);
      ordered.forEach(id => {
        if (!visible.includes(id) && S.paneEls[id]) S.paneEls[id].box.style.display = 'none';
      });
      const badge = document.createElement('div');
      badge.className = 'hidden-indicator';
      badge.textContent = `+${count - slots} hidden`;
      badge.addEventListener('click', () => { layoutSelect.value = 'auto'; S.currentLayout = 'auto'; S.customWeights = null; applyLayout(); saveLayoutPref(); });
      container.appendChild(badge);
    }
    if (preset.placement) {
      visible.forEach((id, i) => {
        const p = preset.placement[i];
        if (p && S.paneEls[id]) { S.paneEls[id].box.style.gridColumn = p.c; S.paneEls[id].box.style.gridRow = p.r; }
      });
    }
  }

  rebuildResizeHandles();
  updateMobilePaneTabs();
  if (window._fitAllPanes) window._fitAllPanes();
}

// ── Resize handles (identical logic to V1) ──

function getCurrentFr() {
  if (S.currentLayout === 'auto') return null;
  const preset = LAYOUT_PRESETS[S.currentLayout];
  if (!preset || !preset.cols) return null;
  return {
    cols: S.customWeights ? [...S.customWeights.cols] : [...preset.cols],
    rows: S.customWeights ? [...S.customWeights.rows] : [...preset.rows],
  };
}

function rebuildResizeHandles() {
  container.querySelectorAll('.resize-handle').forEach(h => h.remove());
  if (S.maximizedPane || S.currentLayout === 'auto') return;
  const fr = getCurrentFr();
  if (!fr) return;
  if (fr.cols.length > 1) {
    const total = fr.cols.reduce((s,v) => s+v, 0);
    let acc = 0;
    for (let i = 0; i < fr.cols.length - 1; i++) {
      acc += fr.cols[i];
      const h = document.createElement('div');
      h.className = 'resize-handle resize-handle-col';
      h.style.left = ((acc/total)*100) + '%';
      container.appendChild(h);
      initColResize(h, i);
    }
  }
  if (fr.rows.length > 1) {
    const total = fr.rows.reduce((s,v) => s+v, 0);
    let acc = 0;
    for (let i = 0; i < fr.rows.length - 1; i++) {
      acc += fr.rows[i];
      const h = document.createElement('div');
      h.className = 'resize-handle resize-handle-row';
      h.style.top = ((acc/total)*100) + '%';
      container.appendChild(h);
      initRowResize(h, i);
    }
  }
}

function ensureCustomWeights() {
  if (S.customWeights) return;
  const preset = LAYOUT_PRESETS[S.currentLayout];
  if (!preset || !preset.cols) return;
  S.customWeights = { cols:[...preset.cols], rows:[...preset.rows] };
}

function repositionHandles() {
  const fr = getCurrentFr();
  if (!fr) return;
  let ci = 0;
  const colHandles = container.querySelectorAll('.resize-handle-col');
  if (fr.cols.length > 1) {
    const total = fr.cols.reduce((s,v) => s+v, 0);
    let acc = 0;
    for (let i = 0; i < fr.cols.length - 1; i++) { acc += fr.cols[i]; if (colHandles[ci]) colHandles[ci].style.left = ((acc/total)*100)+'%'; ci++; }
  }
  let ri = 0;
  const rowHandles = container.querySelectorAll('.resize-handle-row');
  if (fr.rows.length > 1) {
    const total = fr.rows.reduce((s,v) => s+v, 0);
    let acc = 0;
    for (let i = 0; i < fr.rows.length - 1; i++) { acc += fr.rows[i]; if (rowHandles[ri]) rowHandles[ri].style.top = ((acc/total)*100)+'%'; ri++; }
  }
}

function initColResize(handle, idx) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.classList.add('active');
    ensureCustomWeights();
    const startX = e.clientX, cw = S.customWeights.cols;
    const totalFr = cw.reduce((s,v) => s+v, 0), frToPx = container.clientWidth / totalFr;
    const startL = cw[idx], startR = cw[idx+1];
    function onMove(ev) { const dx = ev.clientX - startX, dFr = dx/frToPx; cw[idx] = Math.max(0.15, startL+dFr); cw[idx+1] = Math.max(0.15, startR-dFr); container.style.gridTemplateColumns = cw.map(v => v+'fr').join(' '); repositionHandles(); }
    function onUp() { handle.classList.remove('active'); handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); saveLayoutPref(); }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('dblclick', () => { ensureCustomWeights(); S.customWeights.cols = S.customWeights.cols.map(() => 1); container.style.gridTemplateColumns = S.customWeights.cols.map(v => v+'fr').join(' '); repositionHandles(); saveLayoutPref(); });
}

function initRowResize(handle, idx) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.classList.add('active');
    ensureCustomWeights();
    const startY = e.clientY, rw = S.customWeights.rows;
    const totalFr = rw.reduce((s,v) => s+v, 0), frToPx = container.clientHeight / totalFr;
    const startT = rw[idx], startB = rw[idx+1];
    function onMove(ev) { const dy = ev.clientY - startY, dFr = dy/frToPx; rw[idx] = Math.max(0.15, startT+dFr); rw[idx+1] = Math.max(0.15, startB-dFr); container.style.gridTemplateRows = rw.map(v => v+'fr').join(' '); repositionHandles(); }
    function onUp() { handle.classList.remove('active'); handle.removeEventListener('pointermove', onMove); handle.removeEventListener('pointerup', onUp); saveLayoutPref(); }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('dblclick', () => { ensureCustomWeights(); S.customWeights.rows = S.customWeights.rows.map(() => 1); container.style.gridTemplateRows = S.customWeights.rows.map(v => v+'fr').join(' '); repositionHandles(); saveLayoutPref(); });
}

// ── Persistence ──

function saveLayoutPref() {
  try { localStorage.setItem('tmux-webui-layout', JSON.stringify({ layout: S.currentLayout, weights: S.customWeights })); } catch(e) {}
}
function loadLayoutPref() {
  try {
    const s = localStorage.getItem('tmux-webui-layout');
    if (s) { const o = JSON.parse(s); if (o.layout && LAYOUT_PRESETS[o.layout]) { S.currentLayout = o.layout; layoutSelect.value = S.currentLayout; } if (o.weights) S.customWeights = o.weights; }
  } catch(e) {}
}
function savePaneOrder() {
  if (S.currentSession) { try { localStorage.setItem('tmux-webui-order-'+S.currentSession, JSON.stringify(S.paneOrder)); } catch(e) {} }
}
function loadPaneOrder() {
  try { const s = localStorage.getItem('tmux-webui-order-'+S.currentSession); if (s) S.paneOrder = JSON.parse(s); else S.paneOrder = []; } catch(e) { S.paneOrder = []; }
}
function saveFocusedPane() {
  if (S.currentSession && S.focusedPane) { try { localStorage.setItem('tmux-webui-focus-'+S.currentSession, S.focusedPane); } catch(e) {} }
}
function loadFocusedPane() {
  // URL query param takes priority over localStorage
  const urlPane = new URLSearchParams(location.search).get('pane');
  if (urlPane) return urlPane;
  try { return localStorage.getItem('tmux-webui-focus-'+S.currentSession) || ''; } catch(e) { return ''; }
}
function saveLastSession(session) {
  try { localStorage.setItem('tmux-webui-last-session', session); } catch(e) {}
}
function loadLastSession() {
  try { return localStorage.getItem('tmux-webui-last-session') || ''; } catch(e) { return ''; }
}
function saveActiveWindow() {
  if (S.currentSession && S.activeWindowIdx !== null) {
    try { localStorage.setItem('tmux-webui-win-'+S.currentSession, String(S.activeWindowIdx)); } catch(e) {}
  }
}
function loadSavedWindow() {
  try {
    const v = localStorage.getItem('tmux-webui-win-'+S.currentSession);
    if (v === null) return null;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  } catch(e) { return null; }
}

// One-shot per fresh connect: steer tmux back to the window (and its saved
// pane) the user last had selected here. Must run BEFORE renderWindowTabs
// persists the incoming frame — the frame's active window would overwrite
// the very value being restored. Defers to: reconnects (state already live),
// party mode (link.js has its own deferred apply), ?pane= deep links (a
// push-notification tap should land where the URL points, not where the
// user last browsed), and a saved window that no longer exists.
function maybeRestoreWindow(windows, activeWin) {
  if (!S.pendingWinRestore) return;
  S.pendingWinRestore = false;
  if (S.linkApplying) return;
  if (new URLSearchParams(location.search).get('pane')) return;
  const saved = loadSavedWindow();
  if (saved === null || saved === activeWin) return;
  if (!(windows || []).some(w => w.index === saved)) return;
  const pane = loadFocusedPane();
  if (pane) window.focusPaneCrossWindow(saved, pane);
  else window.tmuxWs?.send({ type: 'switch_window', window: saved });
}

// ========================================================================
// 9. Pane Management
// ========================================================================

function ensurePaneOrder(ids) {
  const idSet = new Set(ids);
  const kept = S.paneOrder.filter(id => idSet.has(id));
  for (const id of ids) { if (!kept.includes(id)) kept.push(id); }
  S.paneOrder = kept;
}

function reorderDOM() {
  const handles = [...container.querySelectorAll('.resize-handle')];
  for (const id of S.paneOrder) { if (S.paneEls[id]) container.appendChild(S.paneEls[id].box); }
  handles.forEach(h => container.appendChild(h));
}

function toggleMaximize(paneId) {
  const appEl = document.getElementById('app');
  if (S.maximizedPane === paneId) {
    S.maximizedPane = '';
    container.classList.remove('has-maximized');
    appEl.classList.remove('fullscreen-mode');
    Object.values(S.paneEls).forEach(pe => { pe.box.classList.remove('maximized'); pe.box.querySelector('.pane-header').draggable = true; });
    rebuildResizeHandles();
  } else {
    S.maximizedPane = paneId;
    container.classList.add('has-maximized');
    appEl.classList.add('fullscreen-mode');
    Object.values(S.paneEls).forEach(pe => { pe.box.classList.remove('maximized'); pe.box.querySelector('.pane-header').draggable = false; });
    if (S.paneEls[paneId]) S.paneEls[paneId].box.classList.add('maximized');
    setFocus(paneId);
    container.querySelectorAll('.resize-handle').forEach(h => h.remove());
  }
  // Refit after layout change (double RAF ensures CSS is applied)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { if (window._fitAllPanes) window._fitAllPanes(); });
  });
}

function buildPaneEl(p) {
  const box = document.createElement('div');
  box.className = 'pane-box';
  box.dataset.paneId = p.id;

  const toolKey = detectTool(p);
  const toolBadge = toolKey ? `<span class="pane-tool pane-tool--${toolKey}" data-tool="${toolKey}">${TOOL_PROFILES[toolKey].name}</span>` : '';

  const hdr = document.createElement('div');
  hdr.className = 'pane-header';
  hdr.innerHTML = `<span class="pane-label">${esc(p.window_name)}:${esc(String(p.pane))}</span>${toolBadge}`
    + `<span class="pane-cmd">${esc(p.command)}</span>`
    + `<button class="pane-split" title="Split pane (new)">&#xFF0B;</button>`
    + `<button class="pane-close" title="Close pane">&#x00D7;</button>`
    + `<button class="pane-maximize" title="Maximize / Restore">&#x26F6;</button>`;
  box.appendChild(hdr);

  hdr.querySelector('.pane-maximize').addEventListener('click', (e) => { e.stopPropagation(); toggleMaximize(p.id); });
  hdr.querySelector('.pane-split').addEventListener('click', (e) => { e.stopPropagation(); window.tmuxWs?.send({ type:'split_pane', pane:p.id, direction:'h' }); });
  hdr.querySelector('.pane-close').addEventListener('click', (e) => { e.stopPropagation(); if (!confirm(`Close pane ${p.window_name}:${p.pane}?`)) return; window.tmuxWs?.send({ type:'close_pane', pane:p.id }); });
  hdr.addEventListener('dblclick', (e) => { e.stopPropagation(); toggleMaximize(p.id); });

  // Drag to reorder
  hdr.draggable = true;
  hdr.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; requestAnimationFrame(() => box.classList.add('dragging')); });
  hdr.addEventListener('dragend', () => { box.classList.remove('dragging'); container.querySelectorAll('.pane-box.drag-over').forEach(el => el.classList.remove('drag-over')); });
  box.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!box.classList.contains('dragging')) box.classList.add('drag-over'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault(); box.classList.remove('drag-over');
    const srcId = e.dataTransfer.getData('text/plain');
    if (srcId === p.id) return;
    const si = S.paneOrder.indexOf(srcId), ti = S.paneOrder.indexOf(p.id);
    if (si === -1 || ti === -1) return;
    S.paneOrder.splice(si, 1); S.paneOrder.splice(ti, 0, srcId);
    reorderDOM(); applyLayout(); savePaneOrder();
  });

  const term = document.createElement('div');
  term.className = 'pane-terminal';
  box.appendChild(term);

  let scrolledByUser = false; // >60px off bottom — stop auto-following
  let histLocked = false;     // deep in scrollback — freeze DOM updates

  // H1 on-demand scrollback. The live WS frame is a sliding ~capture_lines
  // window recaptured every poll tick, so (a) anything older never reaches the
  // browser and (b) in-place line rewrites slide content under a reader. Two
  // rules fix both:
  //   • DEEP in scrollback (past max(half viewport, 500px)) ⇒ FREEZE DOM
  //     updates (ws.onmessage stashes the newest frame via histStash; the
  //     scroll listener applies it on return-to-bottom) — scroll-lock, like a
  //     real terminal emulator. Lightly scrolled (above 60px but under the
  //     lock) stays LIVE: frames keep applying and content drifts up like a
  //     plain terminal — only the auto-follow snap stops;
  //   • at the top ⇒ fetch history PAGED: HIST_CHUNK lines per fetch, keep
  //     fetching older chunks while the user keeps hitting the top, until tmux
  //     runs out (a short/≤1-line chunk = exhausted). Total depth is unbounded
  //     by design. Chunk 1 replaces the live window (histAnchor keeps the text
  //     being read in place); later chunks PREPEND (same anchor formula: the
  //     old content is the suffix of the new).
  const HIST_CHUNK = cfgGet('history.chunkLines', 5000);
  const followGatePx = cfgGet('scroll.followGatePx', 60);
  const freezeGateMinPx = cfgGet('scroll.freezeGateMinPx', 500);
  const freezeGateRatio = cfgGet('scroll.freezeGateRatio', 0.5);
  const topTriggerPx = cfgGet('history.topTriggerPx', 80);
  const fetchCooldownMs = cfgGet('history.fetchCooldownMs', 1000);
  const hist = { loaded: false, loading: false, exhausted: false, offset: 0, pending: null, lastFetch: 0 };

  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'hist-jump';
  jump.textContent = '⬇'; // ⬇ back to live
  jump.title = 'back to live';
  jump.hidden = true;
  const screenController = window.__CAO_WORKSPACE__ && window.createCaoScreen?.(term, p.id, jump);
  function jumpToLive() {
    if (screenController) { screenController.live(); return; }
    scrolledByUser = false;
    setTerminalScroll(term, term.scrollHeight);
    // Also leave history mode when already at the bottom (no native event).
    term.dispatchEvent(new Event('scroll'));
  }
  jump.addEventListener('click', (e) => {
    e.stopPropagation();
    jumpToLive();
  });
  box.appendChild(jump);

  async function loadHistory() {
    // lastFetch cooldown: rubber-banding at the top fires scroll events in a
    // burst — don't refetch the next chunk more than once a second.
    if (hist.loading || hist.exhausted || Date.now() - hist.lastFetch < fetchCooldownMs) return;
    hist.loading = true; hist.lastFetch = Date.now();
    try {
      const basePath = location.pathname.replace(/\/+$/, '') || '';
      const r = await fetch(`${basePath}/api/history?session=${encodeURIComponent(S.currentSession)}&pane=${encodeURIComponent(p.id)}&lines=${HIST_CHUNK}&offset=${hist.offset}`);
      if (!r.ok) return;
      const d = await r.json();
      if (!d || typeof d.content !== 'string') return;
      const newLines = d.content ? d.content.replace(/\n$/, '').split('\n') : [];
      if (hist.offset === 0) {
        if (!newLines.length) return;
        // First chunk: replace the live window with history+screen, anchored.
        const oldTop = term.scrollTop, oldH = term.scrollHeight;
        lineDiffUpdate(term, d.content);
        setTerminalScroll(term, histAnchor(oldTop, oldH, term.scrollHeight));
        hist.loaded = true;
      } else {
        // Older chunk: tmux clamps a fully-consumed range to a ≤1-line
        // duplicate — don't prepend that, just mark exhausted.
        if (newLines.length <= 1) { hist.exhausted = true; return; }
        const frag = document.createDocumentFragment();
        const html = ansiToHtml(newLines.join('\n')).split('\n');
        for (let i = 0; i < html.length; i++) {
          const div = document.createElement('div');
          div.className = 'term-line';
          div.innerHTML = html[i] || '\u200b';
          frag.appendChild(div);
        }
        const oldTop = term.scrollTop, oldH = term.scrollHeight;
        term.insertBefore(frag, term.firstChild);
        setTerminalScroll(term, histAnchor(oldTop, oldH, term.scrollHeight));
      }
      // Offsets accumulate by REQUESTED size — tmux coordinates are absolute,
      // so the next chunk abuts this one regardless of what was returned.
      hist.offset += HIST_CHUNK;
      if (newLines.length < HIST_CHUNK) hist.exhausted = true; // short chunk = history start reached
    } catch (e) { /* history unavailable — stay on what we have */ }
    finally { hist.loading = false; }
  }

  term.addEventListener('scroll', () => {
    if (screenController) return; // v2 distinguishes gesture intent from layout clamps
    const dist = term.scrollHeight - term.scrollTop - term.clientHeight;
    // A scroll WE caused (follow snap, history anchor, rebuild anchor) must not
    // re-evaluate the reader flag: after a content-shrinking repaint the clamp
    // would read as "at bottom" and re-arm auto-follow against the reader.
    const expectedTop = term.dataset.caoScrollProg;
    const programmatic = expectedTop !== undefined && Math.abs(term.scrollTop - Number(expectedTop)) < 1;
    delete term.dataset.caoScrollProg;
    if (!programmatic) scrolledByUser = dist > followGatePx;
    histLocked = dist > Math.max(term.clientHeight * freezeGateRatio, freezeGateMinPx);
    const frozen = histLocked || hist.loading || hist.loaded;
    jump.hidden = !frozen;
    if (scrolledByUser && term.scrollTop < topTriggerPx) loadHistory();
    if (!frozen && hist.pending != null) {
      // Dropped back under the lock threshold without having entered history
      // view: resume live in place with the frame stashed while locked.
      lineDiffUpdate(term, hist.pending); hist.pending = null;
      // Applying a newer frame can add rows after we reached the old bottom.
      // Keep explicit return-to-live at the NEW bottom, not one frame behind.
      requestAnimationFrame(() => {
        if (!scrolledByUser) setTerminalScroll(term, term.scrollHeight);
      });
    }
    if (!scrolledByUser && hist.loaded) {
      // Back at the bottom: leave history view (reset paging — history may
      // have grown; re-entry refetches from scratch), apply the stashed frame.
      hist.loaded = false; hist.exhausted = false; hist.offset = 0;
      if (hist.pending != null) { lineDiffUpdate(term, hist.pending); hist.pending = null; }
      requestAnimationFrame(() => {
        if (!scrolledByUser) setTerminalScroll(term, term.scrollHeight);
      });
    }
  });

  // TUI wheel passthrough (slice 1): on a mouse-mode pane (yazi/lazygit/less…)
  // the wheel scrolls the PROGRAM, not the browser's scrollback. mouse_mode
  // comes from the panes frame (#{mouse_any_flag}); a plain shell pane falls
  // through to the native scroll (history). passive:false so preventDefault can
  // suppress the DOM scroll when we inject.
  term.addEventListener('wheel', (e) => {
    const info = S.paneInfo[p.id];
    if (!info || !info.mouse_mode) return; // plain pane → history scroll
    e.preventDefault();
    const { col, row } = eventCell(term, info, e.clientX, e.clientY);
    window.tmuxWs?.send({
      type: 'mouse', pane: p.id,
      mbutton: e.deltaY < 0 ? 'wheelup' : 'wheeldown',
      mphase: 'press', mx: col, my: row,
    });
  }, { passive: false });

  // TUI click passthrough (slice 2): a TAP on a mouse-mode pane injects a left
  // press+release at that cell (yazi select, lazygit panel, htop row). Pointer
  // events fire reliably on iOS; a tap is short + still (drag/scroll is left for
  // slice 3). The same qualified user tap can reopen the Direct keys keyboard
  // on plain shells too; never synthesize terminal input just to focus it.
  let downXY = null, downT = 0, typingTap = 0;
  term.addEventListener('pointerdown', (e) => {
    typingTap = 0;
    if (e.isPrimary === false || e.button !== 0) { downXY = null; return; }
    downXY = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }; downT = e.timeStamp;
  });
  term.addEventListener('pointermove', (e) => {
    if (downXY && !isTapGesture(e.clientX - downXY.x, e.clientY - downXY.y, e.timeStamp - downT)) downXY = null;
  });
  term.addEventListener('pointercancel', () => { downXY = null; typingTap = 0; });
  term.addEventListener('pointerup', (e) => {
    const down = downXY; downXY = null;
    if (!down || e.pointerId !== down.pointerId || e.button !== 0 || e.isPrimary === false) return;
    if (!isTapGesture(e.clientX - down.x, e.clientY - down.y, e.timeStamp - downT)) return;
    if (window.getSelection()?.toString()) return; // preserve native text selection
    const control = e.target instanceof Element && e.target.closest('button, a, input, textarea, [contenteditable="true"]');
    if (control) return;
    typingTap = e.timeStamp + 750;
    const info = S.paneInfo[p.id];
    if (!info?.mouse_mode) return;
    const { col, row } = eventCell(term, info, e.clientX, e.clientY);
    window.tmuxWs?.send({ type: 'mouse', pane: p.id, mbutton: 'left', mphase: 'press', mx: col, my: row });
    window.tmuxWs?.send({ type: 'mouse', pane: p.id, mbutton: 'left', mphase: 'release', mx: col, my: row });
  });

  term.addEventListener('click', (e) => {
    const expires = typingTap; typingTap = 0;
    if (!expires || e.timeStamp > expires || window.getSelection()?.toString()) return;
    // Focus on the compatibility click, after pointerup's default focus changes.
    // Still a synchronous user gesture (required by native phone keyboards).
    setFocus(p.id);
    window.caoDirectTapToType?.(p.id);
  });

  // TUI touch-swipe → wheel: on a phone the `wheel` event never fires; a finger
  // drag would scroll the DOM. On a mouse-mode pane we instead emit one wheel per
  // rendered row of drag so yazi/less/lazygit scroll their OWN view. Natural
  // direction: finger up (reveal later content) → wheeldown. touch-action:none +
  // passive:false preventDefault own the gesture so the page doesn't scroll.
  let swipeY = null;
  term.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) downXY = null;
    const info = S.paneInfo[p.id];
    const tui = !!(info && info.mouse_mode) && e.touches.length === 1;
    term.style.touchAction = tui ? 'none' : '';
    swipeY = tui ? e.touches[0].clientY : null;
  }, { passive: true });
  term.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) { downXY = null; swipeY = null; return; }
    if (swipeY == null) return; // not a TUI-pane swipe → leave native scroll
    const info = S.paneInfo[p.id];
    if (!info || !info.mouse_mode) { swipeY = null; return; }
    e.preventDefault();
    const t = e.touches[0];
    const { col, row } = eventCell(term, info, t.clientX, t.clientY);
    const rowH = measureCell(term).h; // NOT scrollHeight/height — scrollback poisons it (see measureCell)
    const step = Math.max(12, rowH);
    let dy = t.clientY - swipeY;
    while (Math.abs(dy) >= step) {
      const down = dy < 0; // finger up → wheeldown (later content)
      window.tmuxWs?.send({ type: 'mouse', pane: p.id, mbutton: down ? 'wheeldown' : 'wheelup', mphase: 'press', mx: col, my: row });
      swipeY += down ? -step : step;
      dy = t.clientY - swipeY;
    }
  }, { passive: false });
  term.addEventListener('touchend', () => { swipeY = null; term.style.touchAction = ''; }, { passive: true });

  box.addEventListener('click', () => setFocus(p.id));

  S.paneEls[p.id] = {
    box, terminal: term, screenController, destroy: () => screenController?.destroy(),
    scrolledByUser: () => screenController ? screenController.reading : scrolledByUser, jumpToLive,
    resetScroll: () => { if (screenController) { screenController.live(); return; } scrolledByUser = false; histLocked = false; delete term.dataset.caoScrollProg; },
    // H1 scroll-lock hooks for ws.onmessage 'output'
    histFrozen: () => histLocked || hist.loading || hist.loaded,
    histStash: (c) => { hist.pending = c; },
  };
  S.paneInfo[p.id] = p;
  return box;
}

function setFocus(paneId) {
  const isSwitch = S.focusedPane !== paneId;
  if (isSwitch) window.dispatchEvent(new Event('cao:terminal-reset'));
  // Save current pane's input buffer before switching
  if (S.focusedPane && isSwitch) {
    S.paneInputs[S.focusedPane] = inputEl.value;
  }
  S.focusedPane = paneId;
  Object.values(S.paneEls).forEach(pe => pe.box.classList.remove('focused'));
  if (S.paneEls[paneId]) {
    S.paneEls[paneId].box.classList.add('focused');
    // A focused pane hidden by a slot-limited preset (Single / 1+2 overflow)
    // gets swapped into view — applyLayout keeps S.focusedPane visible.
    if (S.paneEls[paneId].box.style.display === 'none') applyLayout();
    const info = S.paneInfo[paneId];
    const toolKey = paneToolKey(paneId);
    const toolName = toolKey ? ` [${TOOL_PROFILES[toolKey].name}]` : '';
    focusLabel.textContent = info ? `${info.window_name}:${info.pane}${toolName}` : paneId;
    updateToolState(toolKey);
    if (isSwitch) {
      // Only on actual pane switch: restore input, sync tmux, focus
      inputEl.value = S.paneInputs[paneId] || '';
      inputEl.style.height = 'auto';
      window.tmuxWs?.send({ type: 'focus', pane: paneId });
      // Initial pane selection is also a switch; don't open a phone keyboard.
      if (!window.matchMedia('(pointer: coarse)').matches) focusMessageInput();
      // Emit pane follow only for real user switches — never re-broadcast a
      // link-driven focus (S.linkApplying), which would echo-loop the party.
      if (!S.linkApplying) window.linkBroadcast?.({ pane: paneId });
    }
    // Auto-resize tmux pane to match browser display cols/rows
    setTimeout(() => { if (window._fitPane) window._fitPane(paneId); }, 50);
  }
  saveFocusedPane();
  updateMobilePaneTabs();
}

// Cross-window pane focus for the deck window drill-down. There is no single WS
// message that switches window AND selects a pane (see internal/ws recon), so:
// if the pane is already in the rendered (active) window, focus it directly;
// otherwise switch to its window and latch the target — renderPanes() focuses it
// once that window's pane metadata lands. The latch self-clears after 3s so a
// closed/stale id can't misfire on a later unrelated renderPanes.
window.focusPaneCrossWindow = function (windowIdx, paneId) {
  if (S.paneEls[paneId]) { setFocus(paneId); return; }
  S.pendingFocusPane = paneId;
  window.updateFollowLock?.(); // latch armed → input follow-lock on (spec §3 Slice 2)
  window.tmuxWs?.send({ type: 'switch_window', window: windowIdx });
  clearTimeout(S._pendingFocusT);
  S._pendingFocusT = setTimeout(() => { S.pendingFocusPane = ''; window.updateFollowLock?.(); }, 3000);
};

function renderPanes(panes) {
  const oldFocus = S.focusedPane;
  const existingIds = new Set(Object.keys(S.paneEls));
  const newIds = new Set(panes.map(p => p.id));

  // Skeleton/welcome placeholders linger in DOM and render as ghost panes — clear before mounting real panes
  container.querySelectorAll('.skeleton-loading, .welcome').forEach(el => el.remove());

  for (const gone of existingIds) {
    if (!newIds.has(gone)) { S.paneEls[gone].destroy?.(); S.paneEls[gone].box.remove(); delete S.paneEls[gone]; delete S.paneInfo[gone]; delete S.paneInputs[gone]; }
  }
  for (const p of panes) {
    if (!S.paneEls[p.id]) {
      container.appendChild(buildPaneEl(p));
    } else {
      S.paneInfo[p.id] = p;
      const hdr = S.paneEls[p.id].box.querySelector('.pane-header');
      const lbl = hdr.querySelector('.pane-label');
      const cmd = hdr.querySelector('.pane-cmd');
      if (lbl) lbl.textContent = `${p.window_name}:${p.pane}`;
      if (cmd) cmd.textContent = p.command;
      refreshPaneBadge(p.id); // command/title may have changed (agent started/exited)
    }
  }

  ensurePaneOrder(panes.map(p => p.id));
  reorderDOM();
  applyLayout();

  if (S.pendingFocusPane && newIds.has(S.pendingFocusPane)) {
    const target = S.pendingFocusPane;
    S.pendingFocusPane = '';
    clearTimeout(S._pendingFocusT);
    window.updateFollowLock?.(); // latch resolved → release the input follow-lock
    setFocus(target);
  } else if (newIds.has(oldFocus)) setFocus(oldFocus);
  else {
    const saved = loadFocusedPane();
    if (saved && newIds.has(saved)) setFocus(saved);
    else if (panes.length > 0) setFocus(panes[0].id);
  }

  if (S.maximizedPane && newIds.has(S.maximizedPane)) {
    container.classList.add('has-maximized');
    Object.values(S.paneEls).forEach(pe => pe.box.classList.remove('maximized'));
    S.paneEls[S.maximizedPane].box.classList.add('maximized');
  } else if (S.maximizedPane && !newIds.has(S.maximizedPane)) {
    S.maximizedPane = '';
    container.classList.remove('has-maximized');
  }

  window.linkOnPanesFrame?.(); // clears S.linkApplying once a link-driven switch_window lands
  if (window.__CAO_WORKSPACE__) {
    document.getElementById('app').classList.toggle('cao-single-pane', panes.length === 1);
    window.dispatchEvent(new Event('cao:panes'));
  }
}

// ========================================================================
// 10. Mobile Pane Tab Bar
// ========================================================================

function updateMobilePaneTabs() {
  if (!mobilePaneTabs) return;
  const isMobile = window.matchMedia('(max-width:600px)').matches;
  const panes = S.paneOrder.filter(id => S.paneEls[id]);

  if (!isMobile) {
    mobilePaneTabs.classList.remove('visible');
    panes.forEach(id => S.paneEls[id].box.classList.remove('mobile-active'));
    return;
  }

  if (panes.length <= 1) {
    mobilePaneTabs.classList.remove('visible');
    // Single pane — still needs mobile-active to be visible on mobile
    panes.forEach(id => S.paneEls[id].box.classList.add('mobile-active'));
    return;
  }

  mobilePaneTabs.classList.add('visible');
  mobilePaneTabs.innerHTML = '';

  panes.forEach(id => {
    const info = S.paneInfo[id];
    const tab = document.createElement('button');
    tab.className = 'mobile-pane-tab' + (id === S.focusedPane ? ' active' : '');
    const cmdShort = (info?.command || '').slice(0, 8);
    tab.innerHTML = `${esc(info?.window_name || '')}:${esc(String(info?.pane || ''))}<span class="tab-cmd">${esc(cmdShort)}</span>`;
    tab.addEventListener('click', () => {
      setFocus(id);
      // Show only this pane
      panes.forEach(pid => S.paneEls[pid].box.classList.toggle('mobile-active', pid === id));
      updateMobilePaneTabs();
    });
    mobilePaneTabs.appendChild(tab);

    // Show/hide pane boxes
    S.paneEls[id].box.classList.toggle('mobile-active', id === S.focusedPane);
  });
}

window.switchMobilePane = function(direction) {
  const panes = S.paneOrder.filter(id => S.paneEls[id]);
  if (panes.length <= 1) return;
  const idx = panes.indexOf(S.focusedPane);
  const next = (idx + direction + panes.length) % panes.length;
  setFocus(panes[next]);
  panes.forEach(pid => S.paneEls[pid].box.classList.toggle('mobile-active', pid === panes[next]));
  updateMobilePaneTabs();
};

// ========================================================================
// 11. Window Tabs
// ========================================================================

function renderWindowTabs(windows, activeWin) {
  S.activeWindowIdx = activeWin;
  S.windows = windows || []; // expose to deck mode (deck-rail.js reads this for the session rail)
  saveActiveWindow(); // last-seen window per session — restored by maybeRestoreWindow on the next visit
  winTabsEl.innerHTML = '';
  if (!windows || windows.length === 0) { winTabsEl.style.display = 'none'; return; }
  winTabsEl.style.display = '';
  const scroll = document.createElement('div');
  scroll.className = 'win-tabs-scroll';
  let activeTabEl = null;
  const maxLen = cfgGet('layout.windowTabNameChars', 8);
  windows.forEach(w => {
    const tab = document.createElement('button');
    tab.className = 'win-tab' + (w.index === activeWin ? ' active' : '');
    const shortName = w.name.length > maxLen ? w.name.slice(0, maxLen) + '\u2026' : w.name;
    tab.textContent = `${w.index}:${shortName}`;
    if (w.panes > 1) tab.textContent += ` (${w.panes})`;
    tab.title = `${w.index}: ${w.name} (${w.panes} panes)`;
    tab.addEventListener('click', () => {
      if (w.index === S.activeWindowIdx) return;
      window.tmuxWs?.send({ type:'switch_window', window:w.index });
      window.linkBroadcast?.({ window: w.index });
    });
    tab.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const raw = prompt(`Rename window ${w.index} to:`, w.name);
      if (raw === null) return; // cancelled
      const name = raw.trim().slice(0, 50);
      if (!name || name === w.name) return;
      window.tmuxWs?.send({ type:'rename_window', window:w.index, name });
    });
    if (windows.length > 1) {
      const x = document.createElement('span');
      x.className = 'win-tab-x';
      x.textContent = '\u00d7';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Close window ${w.index}:${w.name}?`)) return;
        window.tmuxWs?.send({ type:'close_window', window:w.index });
      });
      tab.appendChild(x);
    }
    if (w.index === activeWin) activeTabEl = tab;
    scroll.appendChild(tab);
  });
  winTabsEl.appendChild(scroll);
  const addBtn = document.createElement('button');
  addBtn.className = 'win-tab win-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New window';
  addBtn.addEventListener('click', () => window.tmuxWs?.send({ type:'new_window' }));
  winTabsEl.appendChild(addBtn);
  if (activeTabEl) requestAnimationFrame(() => activeTabEl.scrollIntoView({ inline:'nearest', block:'nearest' }));
}

// ========================================================================
// 11.5 Line-Level Diff Renderer
// ========================================================================

// H1: after swapping the live window for the deep-history capture, keep the
// viewport on what the user was reading. The old (live-window) content is the
// suffix of the new capture, so distance-from-bottom is the invariant:
// newTop = newHeight - (oldHeight - oldTop), floored at 0.
// pure helper for tests
function histAnchor(oldTop, oldHeight, newHeight) {
  return Math.max(0, newHeight - (oldHeight - oldTop));
}

// Tag only real movement, using the browser's clamped destination. scrollHeight
// itself is unreachable: the last viewport starts at scrollHeight-clientHeight.
// A destination token also lets a reader scroll win if it precedes our async event.
function setTerminalScroll(terminal, top) {
  const target = Math.max(0, Math.min(top, terminal.scrollHeight - terminal.clientHeight));
  if (Math.abs(terminal.scrollTop - target) < 1) return;
  terminal.scrollTop = target;
  terminal.dataset.caoScrollProg = String(terminal.scrollTop);
}

// posToCell maps a pixel offset inside a terminal to a 1-based (col,row) — the
// coordinate a TUI's SGR mouse report uses. floor+1: pixel 0 is column 1. cellW/
// cellH come from measureCell (the rendered monospace glyph box). Pure/tested.
// pure helper for tests
function posToCell(offsetX, offsetY, cellW, cellH) {
  return {
    col: Math.max(1, Math.floor(offsetX / (cellW || 1)) + 1),
    row: Math.max(1, Math.floor(offsetY / (cellH || 1)) + 1),
  };
}

// isTapGesture distinguishes a tap (inject a click) from a drag/scroll/long-press
// (leave for slice 3) — small movement AND short duration. Pure/tested.
// pure helper for tests
function isTapGesture(dx, dy, dt) {
  return Math.abs(dx) <= 8 && Math.abs(dy) <= 8 && dt <= 700;
}

// measureCell measures ONE monospace cell with a single strategy: a plain-ASCII
// probe (20×'X') for the WIDTH, and a real .term-line's rect for the HEIGHT.
// Two data sources are BANNED here, both learned the hard way:
//   1. Line-derived WIDTH (boundingWidth / textContent.length) — yazi/lazygit
//      lines carry nerd-font icons and box-drawing whose visual advance ≠ their
//      JS string length, which skewed the cell to ~1/3 and landed clicks columns
//      away. A plain-ASCII probe in the terminal's OWN font gives the true
//      monospace advance.
//   2. Content geometry (scrollWidth / scrollHeight) — the terminal DOM always
//      holds ~300 lines of scrollback, INCLUDING lines painted at an OLD width,
//      so feeding it into a size computation makes it spiral (this is what shrank
//      a real tmux window to 38x1). A single line's rect height is uniform per
//      row regardless of content width, so it never carries that history.
// Probe width + line-rect height is the only clean pair. Cached per element
// (font is fixed per session) ONLY when both came from real measurements.
function measureCell(term) {
  if (window.caoCell) return window.caoCell.measure(term);
  if (term.__cell) return term.__cell;
  const cs = getComputedStyle(term);
  const probe = document.createElement('span');
  probe.style.cssText = 'visibility:hidden;position:absolute;left:-9999px;top:-9999px;white-space:pre;';
  probe.style.fontFamily = cs.fontFamily;
  probe.style.fontSize = cs.fontSize;
  probe.style.letterSpacing = cs.letterSpacing;
  probe.textContent = 'XXXXXXXXXXXXXXXXXXXX'; // 20×ASCII
  term.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  const line = term.querySelector('.term-line');
  const h = line ? line.getBoundingClientRect().height : (parseFloat(cs.lineHeight) || 18);
  const cell = { w: w || 8, h: h || 18 };
  if (w > 0 && line) term.__cell = cell; // cache only when width probed AND height from a real term-line
  return cell;
}

// eventCell resolves a pointer's clientX/Y to a 1-based terminal (col,row).
// Cell size ALWAYS comes from measureCell (probe width + line-rect height). The
// old fast-path derived it from content geometry (scrollWidth / info.width),
// which the ~300-line scrollback poisons the same way it poisoned fit — see
// measureCell. `info` is now unused but kept in the signature so the wheel/tap/
// touch call sites don't change. Viewport-relative (SGR coords are on-screen).
function eventCell(term, info, clientX, clientY) {
  const rect = term.getBoundingClientRect();
  const cs = getComputedStyle(term);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const { w: cw, h: ch } = measureCell(term);
  return posToCell(clientX - rect.left - padL, clientY - rect.top - padT, cw, ch);
}

// Line-level diff update — only touch changed lines
function lineDiffUpdate(terminal, newContent) {
  // tmux captures the whole screen, including unused rows below the prompt.
  // A tall pane cleared from a shorter browser otherwise follows that blank
  // tail and hides the prompt. Keep internal/ANSI-painted rows untouched.
  if (window.__CAO_WORKSPACE__ && terminal.dataset.caoFullGrid !== 'true') newContent = newContent.replace(/(?:\n[ \t]*)+$/, '');
  const newHtml = ansiToHtml(newContent);
  const newLines = newHtml.split('\n');
  const children = terminal.children;

  // Structure check: children must be div.term-line for safe diffing.
  // After innerHTML full-replace, children are <span> from ANSI rendering,
  // NOT <div class="term-line"> — diffing against those corrupts the DOM.
  const isStructured = children.length > 0
    && children[0]?.tagName === 'DIV'
    && children[0]?.classList?.contains('term-line');

  const oldTop = terminal.scrollTop, oldH = terminal.scrollHeight;
  function preserveReadingPosition() {
    // Both small diffs and full rebuilds can shrink/clamp the viewport. Keep
    // distance-from-bottom and do not mistake that clamp for a reader gesture.
    setTerminalScroll(terminal, histAnchor(oldTop, oldH, terminal.scrollHeight));
    if (Math.abs(oldTop - terminal.scrollTop) >= 1) {
      terminal.dataset.caoScrollProg = String(terminal.scrollTop);
    }
  }
  if (!isStructured || children.length === 0 || Math.abs(children.length - newLines.length) > 20) {
    // Full rebuild: wrap each line in a div for correct structure.
    terminal.innerHTML = newLines
      .map(l => '<div class="term-line">' + (l || '\u200b') + '</div>')
      .join('');
    preserveReadingPosition();
    return;
  }

  // Safe diff — children are guaranteed to be div.term-line
  while (children.length > newLines.length) terminal.lastChild.remove();
  while (children.length < newLines.length) {
    const div = document.createElement('div');
    div.className = 'term-line';
    terminal.appendChild(div);
  }

  for (let i = 0; i < newLines.length; i++) {
    const lineHtml = newLines[i] || '\u200b';
    if (children[i].innerHTML !== lineHtml) {
      children[i].innerHTML = lineHtml;
    }
  }
  preserveReadingPosition();
}

window.caoLineDiffUpdate = lineDiffUpdate;

// ========================================================================
// 12. WebSocket with Exponential Backoff Reconnection
// ========================================================================

window.tmuxWs = (function() {
  let ws = null, connectionGeneration = 0;
  const INITIAL_DELAY = cfgGet('reconnect.initialDelayMs', 1000);
  const MAX_DELAY = cfgGet('reconnect.maxDelayMs', 30000);
  let reconnectDelay = INITIAL_DELAY;
  // Zombie watchdog state: the server pings every 15s, so a healthy socket is
  // never silent for WS_SILENT_LIMIT. iOS Safari often never fires onclose
  // when the network drops under a PWA (WebKit 247943) — without this the UI
  // sits "connected" on a dead socket forever.
  const WS_SILENT_LIMIT = cfgGet('reconnect.silentLimitMs', 45000);
  let lastMsgAt = Date.now();

  function isConnected() { return ws && ws.readyState === WebSocket.OPEN; }

  function send(data) {
    if (window.__CAO_WORKSPACE__) {
      const permitted = new Set(['input','paste','key','mouse','focus','fit','resize','fit_enable','fit_disable','switch_window','refresh_panes','autocomplete','pong']);
      if (!permitted.has(data.type)) { window.flashInputError?.('Manage agents from CAO'); return; }
      if (['fit','fit_enable','fit_disable'].includes(data.type)) return; // layouts are shared
    }
    if (isConnected()) ws.send(JSON.stringify(data));
  }

  function setStatus(state, text) {
    statusEl.className = state;
    if (window.__CAO_WORKSPACE__) window.dispatchEvent(new CustomEvent('cao:connection', { detail: state }));
    if (state === 'connected') {
      statusEl.innerHTML = `<span class="dot"></span> ${window.__CAO_WORKSPACE__ ? 'Connected' : text}`;
      // Keep the custom dropdown label in sync — deck-rail/deck-agent switch
      // sessions by writing the hidden <select> and reconnecting, ending here.
      syncSessionLabel();
      inputEl.disabled = false;
      sendBtn.disabled = false;
      uploadBtn.disabled = false;
      // Do not summon the phone keyboard on initial connect/reconnect.
      if (!window.matchMedia('(pointer: coarse)').matches) focusMessageInput();
      reconnectDelay = INITIAL_DELAY;
      // Remove reconnect overlay if present
      const overlay = document.getElementById('reconnect-overlay');
      if (overlay) overlay.remove();
    } else if (state === 'reconnecting') {
      if (window._inputPending) { clearTimeout(window._inputPending.timer); window._inputPending = null; }
      statusEl.innerHTML = `<span class="dot"></span> reconnecting (${Math.round(reconnectDelay/1000)}s)...`;
      // Add overlay instead of clearing DOM
      if (!document.getElementById('reconnect-overlay')) {
        // basePath-relative like every other endpoint — the webui may sit
        // behind a stripping reverse proxy (/apps/tmux/ -> /).
        const rescueBase = location.pathname.replace(/\/+$/, '') || '';
        const overlay = document.createElement('div');
        overlay.id = 'reconnect-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;background:var(--overlay-bg);display:flex;align-items:center;justify-content:center;z-index:100;pointer-events:none;';
        overlay.innerHTML = '<div style="color:var(--overlay-fg);font-size:14px;background:var(--overlay-box-bg);padding:8px 16px;border-radius:6px;">Reconnecting...' +
          `<a id="rescue-link" href="${rescueBase}/rescue" style="display:none;margin-left:12px;color:var(--overlay-link);pointer-events:auto;">tmux not responding? Rescue console &rarr;</a></div>`;
        container.style.position = 'relative';
        container.appendChild(overlay);
      }
      // After repeated failures: if the webui itself still answers /health,
      // the wedge is tmux-side — surface the out-of-band rescue console.
      if (!window.__CAO_WORKSPACE__ && reconnectDelay >= 4000) {
        const link = document.getElementById('rescue-link');
        if (link && link.style.display === 'none') {
          const basePath = location.pathname.replace(/\/+$/, '') || '';
          fetch(basePath + '/health').then(r => { if (r.ok) link.style.display = 'inline'; }).catch(() => {});
        }
      }
    } else {
      if (window._inputPending) { clearTimeout(window._inputPending.timer); window._inputPending = null; }
      statusEl.innerHTML = '<span class="dot"></span> disconnected';
      inputEl.disabled = true;
      sendBtn.disabled = true;
      uploadBtn.disabled = true;
      focusLabel.textContent = 'no pane';
      winTabsEl.innerHTML = '';
      winTabsEl.style.display = 'none';
      document.getElementById('tmux-status').innerHTML = '';
      document.getElementById('tmux-status').style.display = 'none';
      if (mobilePaneTabs) mobilePaneTabs.classList.remove('visible');
    }
  }

  function connect(session) {
    // Preserve input text across reconnects
    const savedInputs = S.currentSession === session ? { ...S.paneInputs } : {};
    const savedText = inputEl.value;
    const isReconnect = (S.currentSession === session);

    if (ws) { ws.close(); ws = null; }
    connectionGeneration++;
    S.currentSession = session;
    S.paneInputs = savedInputs;
    S.currentTool = null;
    S.pendingWinRestore = !isReconnect;
    saveLastSession(session);

    if (!isReconnect) {
      // Fresh connection: full reset
      S.focusedPane = '';
      Object.values(S.paneEls).forEach(pe => pe.destroy?.());
      S.paneEls = {};
      S.paneInfo = {};
      S.paneOrder = [];
      container.innerHTML = '<div class="skeleton-loading" style="display:flex;gap:8px;padding:8px;height:100%;">' +
        '<div style="flex:1;background:var(--surface2);border-radius:6px;animation:pulse 1.5s infinite;"></div>' +
        '<div style="flex:1;background:var(--surface2);border-radius:6px;animation:pulse 1.5s infinite;animation-delay:0.3s;"></div>' +
        '</div>';
    }
    // Reconnect: keep existing DOM, paneEls, paneInfo, paneOrder intact

    // Restore input text after reconnect
    if (savedText) inputEl.value = savedText;

    loadPaneOrder();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const basePath = location.pathname.replace(/\/+$/, '') || '';
    ws = new WebSocket(`${proto}://${location.host}${basePath}/ws?session=${encodeURIComponent(session)}`);
    const thisWs = ws;

    ws.onopen = () => { lastMsgAt = Date.now(); setStatus('connected', session); if (window._fitOnConnect) window._fitOnConnect(); window.linkOnOpen?.(); };

    ws.onmessage = (e) => {
      lastMsgAt = Date.now();
      const data = JSON.parse(e.data);
      if (data.type === 'panes') {
        renderPanes(data.panes);
      } else if (data.type === 'screens' && window.__CAO_WORKSPACE__ && data.version === 2) {
        for (const [paneId, snapshot] of Object.entries(data.panes)) {
          const pe = S.paneEls[paneId];
          if (!pe) continue;
          pe.screenController?.apply(snapshot);
          refreshPaneBadge(paneId);
        }
      } else if (data.type === 'output') {
        for (const [paneId, content] of Object.entries(data.panes)) {
          const pe = S.paneEls[paneId];
          if (!pe) continue;
          // H1 scroll-lock: while the user reads scrollback (or a history fetch
          // is in flight) don't touch the DOM — stash the newest frame; the
          // pane's scroll listener applies it on return-to-bottom.
          if (pe.histFrozen?.()) { pe.histStash?.(content); continue; }
          // Skip update if user is selecting text in this terminal
          const sel = window.getSelection();
          if (sel && sel.toString() && pe.terminal.contains(sel.anchorNode)) continue;
          lineDiffUpdate(pe.terminal, content);
          refreshPaneBadge(paneId); // stale-title guard reads pane content — re-check per frame
          if (!pe.scrolledByUser()) {
            const t = pe.terminal;
            requestAnimationFrame(() => { requestAnimationFrame(() => {
              if (!pe.scrolledByUser()) setTerminalScroll(t, t.scrollHeight);
            }); });
          }
        }
      } else if (data.type === 'windows') {
        maybeRestoreWindow(data.windows, data.active); // must precede the save inside renderWindowTabs
        renderWindowTabs(data.windows, data.active);
      } else if (data.type === 'metrics') {
        window.renderMetrics?.(data.metrics);
      } else if (data.type === 'sizing' && window.__CAO_WORKSPACE__) {
        window.dispatchEvent(new CustomEvent('cao:sizing', { detail: data }));
      } else if (data.type === 'input_ok') {
        window.dispatchEvent(new CustomEvent('cao:input-ack', {detail:{nonce:data.nonce,ok:true}}));
        window.handleInputAck?.(data.nonce, true);
      } else if (data.type === 'input_error') {
        window.dispatchEvent(new CustomEvent('cao:input-ack', {detail:{nonce:data.nonce,ok:false,message:data.message}}));
        window.handleInputAck?.(data.nonce, false, data.message);
      } else if (data.type === 'autocomplete') {
        window.handleAutocomplete?.(data.results);
      } else if (data.type === 'tts') {
        window.playTTS?.(data.id, data.text);
      } else if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: data.ts }));
      } else if (data.type === 'pane_states') {
        window.__deckPaneStates?.(data.states, data.panes); // S4 deck status lights (no-op when deck off)
      } else if (data.type === 'link_state') {
        if (data.origin !== S.clientId) window.applyLinkState?.(data); // skip self-originated echo
        S.linkMembers = data.members || [];
        S.linkLeader = data.leader || '';
        S.linkLeaderOnly = !!data.leader_only;
        window.updateLinkUI?.();
      } else if (data.type === 'error') {
        container.innerHTML = `<div class="welcome" style="color:var(--red)">${esc(data.message)}</div>`;
      }
    };

    ws.onclose = (event) => {
      if (ws !== thisWs) return; // stale instance's close must not touch shared UI state
      window.dispatchEvent(new Event('cao:terminal-reset'));
      if (window.__CAO_WORKSPACE__ && [4401,4403].includes(event.code)) {
        setStatus('', '');
        statusEl.textContent = 'Viewer expired — reopen from CAO';
        parent.postMessage({ type: 'cao:terminal-expired' }, location.origin);
        return;
      }
      if (S.currentSession === session) {
        setStatus('reconnecting', '');
        const savedMaximized = S.maximizedPane;
        setTimeout(() => {
          if (S.currentSession === session && (!ws || ws.readyState === WebSocket.CLOSED)) {
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
            connect(session);
            if (savedMaximized) {
              const check = setInterval(() => {
                if (S.paneEls[savedMaximized]) { clearInterval(check); toggleMaximize(savedMaximized); }
              }, 300);
              setTimeout(() => clearInterval(check), 5000);
            }
          }
        }, reconnectDelay);
      } else {
        setStatus('', '');
      }
    };

    ws.onerror = (ev) => {
      if (ws !== thisWs) return; // stale instance's error must not touch shared UI state
      console.warn('tmux-webui WS error:', ev);
    };
  }

  function disconnect() {
    if (window._inputPending) { clearTimeout(window._inputPending.timer); window._inputPending = null; }
    S.currentSession = '';
    S.maximizedPane = '';
    S.currentTool = null;
    if (ws) { ws.close(); ws = null; }
    setStatus('', '');
    container.classList.remove('has-maximized');
    document.getElementById('app').classList.remove('fullscreen-mode');
    container.innerHTML = '<div class="welcome">select a tmux session to connect</div>';
    Object.values(S.paneEls).forEach(pe => pe.destroy?.());
    S.paneEls = {};
    S.paneInfo = {};
    S.paneOrder = [];
    S.paneInputs = {};
  }

  // Force a dead-but-"OPEN" socket into the normal onclose → reconnect path.
  // Only fires while a session is supposed to be live; closing a healthy
  // socket is impossible here because any server ping resets lastMsgAt.
  function zombieCheck() {
    if (ws && ws.readyState === WebSocket.OPEN && S.currentSession &&
        Date.now() - lastMsgAt > WS_SILENT_LIMIT) {
      console.warn('tmux-webui: WS silent ' + (Date.now() - lastMsgAt) + 'ms — forcing reconnect');
      ws.close();
    }
  }
  setInterval(zombieCheck, 10000);
  // PWA foregrounding is the moment zombies bite (timers were suspended in the
  // background): check immediately, and once more after the socket has had a
  // fair window to speak (a live one pings within 15s).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    zombieCheck();
    setTimeout(zombieCheck, 20000);
  });

  return { connect, disconnect, send, isConnected, connectionId: () => connectionGeneration };
})();

// ========================================================================
// 13. Sessions
// ========================================================================

async function loadSessions(autoConnect = false) {
  try {
    const basePath = location.pathname.replace(/\/+$/, '') || '';
    const res = await fetch(basePath + '/api/sessions');
    const list = await res.json();
    S.sessions = list || []; // expose to deck mode (deck-rail.js reads this for the session rail)
    // Hidden select mirrors the real sessions only; the "+ new session…"
    // affordance lives in the custom panel now.
    sessionsEl.innerHTML = '<option value="">-- select session --</option>';
    list.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      sessionsEl.appendChild(opt);
    });
    if (S.currentSession) sessionsEl.value = S.currentSession;

    // First run: tmux has no sessions yet (creating one also boots the tmux
    // server) — a newcomer must not be left staring at an empty dropdown.
    if (list.length === 0 && !S.currentSession) {
      container.innerHTML = '<div class="welcome"><p>No tmux sessions yet.</p></div>';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.id = 'first-run-create';
      btn.textContent = 'Create your first session';
      btn.addEventListener('click', () => createSession());
      container.querySelector('.welcome').appendChild(btn);
    }

    // Auto-connect: last session the user picked here, then "default",
    // then first available (saved name may be gone — a deleted session
    // must not strand the UI on "-- select session --").
    if (autoConnect && list.length > 0) {
      if (!S.currentSession) {
        const last = loadLastSession();
        const target = list.find(s => s.name === last) || list.find(s => s.name === 'default') || list[0];
        sessionsEl.value = target.name;
        window.tmuxWs.connect(target.name);
      } else if (!S.currentSession.includes('/') && !list.some(s => s.name === S.currentSession)) {
        // The optimistic boot connect raced a session that no longer exists —
        // fall back like a stale saved name. Host-prefixed sessions are exempt:
        // absence may just mean their host is asleep, not that they're gone.
        const target = list.find(s => s.name === 'default') || list[0];
        sessionsEl.value = target.name;
        window.tmuxWs.connect(target.name);
      }
    }
  } catch(e) {
    S.sessions = [];
    sessionsEl.innerHTML = '<option value="">tmux not available</option>';
  }
  renderSessionPanel();
  syncSessionLabel();
}

// ── Custom session dropdown ─────────────────────────────────────────────
// Replaces the native <select> UI: each row carries its own rename/delete
// actions so no select-first dance is needed. The hidden <select> keeps
// carrying the selection state for deck-rail.js / deck-agent.js.

function syncSessionLabel() {
  const v = sessionsEl.value || S.currentSession;
  sessionDDLabel.textContent = v || '-- session --';
  sessionDD.classList.toggle('has-session', !!v);
}

// Link session-follow (spec §3 Slice 2): mirror the session-dropdown row click
// path so a party member reconnects onto the driver's session. Deferred
// window/pane apply happens in link.js on the new session's first panes frame.
window.linkFollowSession = function (session) {
  sessionsEl.value = session;
  syncSessionLabel();
  if (S.currentSession) window.tmuxWs.disconnect();
  window.tmuxWs.connect(session);
};

function renderSessionPanel() {
  sessionDDPanel.innerHTML = '';
  (S.sessions || []).forEach(s => {
    const row = document.createElement('div');
    row.className = 'session-dd-row' + (s.name === S.currentSession ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'session-dd-name';
    name.textContent = s.name;
    name.title = s.name;
    const meta = document.createElement('span');
    meta.className = 'session-dd-meta';
    meta.textContent = `${s.windows}w${s.attached ? ' ·att' : ''}`;
    const ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'session-dd-act';
    ren.innerHTML = '&#x270E;';
    ren.title = `Rename "${s.name}"`;
    ren.addEventListener('click', (e) => { e.stopPropagation(); closeSessionPanel(); renameSession(s.name); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'session-dd-act session-dd-act-del';
    del.innerHTML = '&#x1F5D1;';
    del.title = `Delete "${s.name}"`;
    del.addEventListener('click', (e) => { e.stopPropagation(); closeSessionPanel(); deleteSession(s.name); });
    // Federated session (from a remote host): tag the origin as a small dim
    // chip. The name is already prefixed "<host>/<session>" server-side — this
    // is just the provenance marker, not a re-render of the name.
    if (s.host) {
      const host = document.createElement('span');
      host.className = 'session-dd-host';
      host.textContent = s.host;
      host.title = `host: ${s.host}`;
      row.append(name, host, meta, ren, del);
    } else {
      row.append(name, meta, ren, del);
    }
    row.addEventListener('click', () => {
      closeSessionPanel();
      if (s.name === S.currentSession) return;
      sessionsEl.value = s.name;
      syncSessionLabel();
      if (S.currentSession) window.tmuxWs.disconnect();
      window.tmuxWs.connect(s.name);
    });
    sessionDDPanel.appendChild(row);
  });
  const add = document.createElement('div');
  add.className = 'session-dd-row session-dd-new';
  add.textContent = '＋ new session…';
  add.addEventListener('click', () => { closeSessionPanel(); createSession(); });
  sessionDDPanel.appendChild(add);
}

function openSessionPanel() {
  // position:fixed keeps the panel out of the header's overflow-x clipping
  // on narrow screens; anchor it under the trigger at open time.
  const r = sessionDDBtn.getBoundingClientRect();
  sessionDDPanel.style.top = (r.bottom + 4) + 'px';
  sessionDDPanel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 248)) + 'px';
  sessionDDPanel.hidden = false;
  sessionDD.classList.add('open');
  loadSessions(); // refresh list on open — sessions created in a terminal show up
}

function closeSessionPanel() {
  sessionDDPanel.hidden = true;
  sessionDD.classList.remove('open');
}

sessionDDBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (sessionDDPanel.hidden) openSessionPanel(); else closeSessionPanel();
});
// pointerdown in capture phase, not click: iOS Safari never dispatches a
// click for taps on non-interactive elements, so a document click listener
// can't see "tapped outside" on touch devices (panels became unclosable on
// iPad). Pointer events fire for every tap regardless of target, and the
// capture phase is immune to stopPropagation in widget handlers.
document.addEventListener('pointerdown', (e) => {
  if (!sessionDDPanel.hidden && !sessionDDPanel.contains(e.target) && !sessionDDBtn.contains(e.target)) closeSessionPanel();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sessionDDPanel.hidden) closeSessionPanel();
});
window.addEventListener('resize', closeSessionPanel);

async function createSession() {
  const raw = prompt('New session name (blank = auto):', '');
  if (raw === null) return; // cancelled
  // Mirror the server allowlist so the user sees the corrected name, not a 400.
  const name = raw.trim().replace(/[^A-Za-z0-9_@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  try {
    const basePath = location.pathname.replace(/\/+$/, '') || '';
    const res = await fetch(basePath + '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    if (!res.ok) { alert(body.error || 'Create session failed'); return; }
    await loadSessions();
    sessionsEl.value = body.name;
    syncSessionLabel();
    if (S.currentSession) window.tmuxWs.disconnect();
    window.tmuxWs.connect(body.name);
  } catch (e) {
    alert('Create session failed: ' + e);
  }
}

async function renameSession(target) {
  if (!target) return;
  const raw = prompt(`Rename session "${target}" to:`, target);
  if (raw === null) return; // cancelled
  // Mirror the server allowlist so the user sees the corrected name, not a 400.
  const name = raw.trim().replace(/[^A-Za-z0-9_@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (!name) { alert('Session name cannot be empty'); return; }
  if (name === target) return;
  try {
    const basePath = location.pathname.replace(/\/+$/, '') || '';
    const res = await fetch(basePath + '/api/sessions/' + encodeURIComponent(target), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json();
    if (!res.ok) { alert(body.error || 'Rename session failed'); return; }
    const wasCurrent = S.currentSession === target;
    await loadSessions();
    sessionsEl.value = body.name;
    syncSessionLabel();
    // The old ws is bound to the old name; reconnect so the stream follows.
    if (wasCurrent) { window.tmuxWs.disconnect(); window.tmuxWs.connect(body.name); }
  } catch (e) {
    alert('Rename session failed: ' + e);
  }
}

async function deleteSession(target) {
  if (!target) return;
  if (!confirm(`Delete session "${target}"? This kills the tmux session and all its windows.`)) return;
  try {
    const basePath = location.pathname.replace(/\/+$/, '') || '';
    const res = await fetch(basePath + '/api/sessions/' + encodeURIComponent(target), { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { alert(body.error || 'Delete session failed'); return; }
    if (S.currentSession === target) window.tmuxWs.disconnect();
    await loadSessions();
  } catch (e) {
    alert('Delete session failed: ' + e);
  }
}

// ========================================================================
// 14. Quick-Action Buttons
// ========================================================================

document.querySelectorAll('.qbtn[data-key]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const key = btn.dataset.key;
    if (!window.tmuxWs.isConnected() || !S.focusedPane) return;
    if (window.linkSendBlocked && window.linkSendBlocked()) return; // input follow-lock (spec §3 Slice 2)
    if (window.sendEk) window.sendEk(key, [], key.startsWith('C-') || key === 'BTab');
    else window.tmuxWs.send({ type:'key', pane:S.focusedPane, key });
    if (S.paneEls[S.focusedPane]) S.paneEls[S.focusedPane].resetScroll();
  });
});

// ========================================================================
// 15. Keyboard Shortcuts
// ========================================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.activeElement === inputEl && inputEl.value) {
      inputEl.value = '';
      inputEl.style.height = 'auto';
      return;
    }
    if (S.maximizedPane) toggleMaximize(S.maximizedPane);
  }
});

// Exit fullscreen button
const exitFsBtn = document.getElementById('exit-fullscreen');
if (exitFsBtn) {
  exitFsBtn.addEventListener('click', () => {
    if (S.maximizedPane) toggleMaximize(S.maximizedPane);
  });
}

// ========================================================================
// 16. Layout Controls
// ========================================================================

layoutSelect.addEventListener('change', () => { S.currentLayout = layoutSelect.value; S.customWeights = null; applyLayout(); saveLayoutPref(); });

// ── Custom layout dropdown ──────────────────────────────────────────────
// Wraps the hidden <select id=layout-select>: rows carry SVG schematics of
// each preset so the arrangement is visible before picking it.

function syncLayoutLabel() {
  const key = LAYOUT_META[layoutSelect.value] ? layoutSelect.value : 'auto';
  layoutDDIco.innerHTML = layoutIcon(key);
  layoutDDLabel.textContent = LAYOUT_META[key].label;
}

function renderLayoutPanel() {
  layoutDDPanel.innerHTML = '';
  const current = LAYOUT_META[layoutSelect.value] ? layoutSelect.value : 'auto';
  Object.keys(LAYOUT_META).forEach(key => {
    const row = document.createElement('div');
    row.className = 'layout-dd-row' + (key === current ? ' active' : '');
    const ico = document.createElement('span');
    ico.className = 'layout-dd-row-ico';
    ico.innerHTML = layoutIcon(key);
    const name = document.createElement('span');
    name.textContent = LAYOUT_META[key].label;
    row.append(ico, name);
    row.addEventListener('click', () => {
      closeLayoutPanel();
      if (key === layoutSelect.value) return;
      layoutSelect.value = key;
      // Reuse the change listener so the apply/persist path stays single.
      layoutSelect.dispatchEvent(new Event('change'));
      syncLayoutLabel();
    });
    layoutDDPanel.appendChild(row);
  });
}

function openLayoutPanel() {
  renderLayoutPanel();
  const r = layoutDDBtn.getBoundingClientRect();
  layoutDDPanel.style.top = (r.bottom + 4) + 'px';
  layoutDDPanel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 178)) + 'px';
  layoutDDPanel.hidden = false;
  layoutDD.classList.add('open');
}

function closeLayoutPanel() {
  layoutDDPanel.hidden = true;
  layoutDD.classList.remove('open');
}

layoutDDBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (layoutDDPanel.hidden) openLayoutPanel(); else closeLayoutPanel();
});
// Capture-phase pointerdown — same iOS outside-tap rationale as the session panel.
document.addEventListener('pointerdown', (e) => {
  if (!layoutDDPanel.hidden && !layoutDDPanel.contains(e.target) && !layoutDDBtn.contains(e.target)) closeLayoutPanel();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !layoutDDPanel.hidden) closeLayoutPanel();
});
window.addEventListener('resize', closeLayoutPanel);

syncLayoutLabel(); // initial paint (pref restore may have set the value already)
resetLayoutBtn.addEventListener('click', () => { S.customWeights = null; applyLayout(); saveLayoutPref(); });
window.addEventListener('resize', () => { if (!S.maximizedPane && S.currentLayout !== 'auto') rebuildResizeHandles(); updateMobilePaneTabs(); });

// ========================================================================
// 17. Terminal Fit (sync WebUI size → tmux pane size)
// ========================================================================

(function() {
  const FIT_KEY = 'tmux-fit-enabled';
  const fitToggle = document.getElementById('fit-toggle');
  // Default fit ON for phones. An unfit pane renders at its full tmux width
  // (e.g. 100 cols ≈ 1200px); a ~390px phone clips ~2/3 off-screen, so a TUI
  // (yazi/lazygit) is unusable and taps land on off-screen columns. On a narrow
  // viewport, enable unless the user has EXPLICITLY turned it off ('0').
  const FIT_PREF = localStorage.getItem(FIT_KEY);
  let fitEnabled = FIT_PREF === '1'
    || (FIT_PREF === null && window.matchMedia('(max-width:600px)').matches);

  function fitPane(paneId) {
    if (!fitEnabled) return;
    const pe = S.paneEls[paneId];
    const info = S.paneInfo[paneId];
    if (!pe || !info || !info.width || !info.height) return;
    const term = pe.terminal;
    // Box size ÷ measured cell. NEVER scrollWidth/scrollHeight: the terminal
    // holds ~300 lines of scrollback (incl. lines painted at the OLD width), so
    // the content box feeds its own history back into the size and spirals down
    // — that's how a real window collapsed to 38x1. clientWidth/clientHeight are
    // the stable viewport box (padding included), so subtract the padding to get
    // the text area, then divide by the probe-measured cell.
    const cell = measureCell(term);
    const cs = getComputedStyle(term);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const availW = term.clientWidth - padX, availH = term.clientHeight - padY;
    if (availW < 1 || availH < 1 || cell.w < 1 || cell.h < 1) return;
    const cols = Math.max(1, Math.floor(availW / cell.w));
    const rows = Math.max(1, Math.floor(availH / cell.h));
    // Only send on a real change (±1 deadband) — avoids a resize/reflow loop
    // when it's already converged.
    if (Math.abs(cols - info.width) > 1 || Math.abs(rows - info.height) > 1) {
      window.tmuxWs?.send({ type: 'fit', pane: paneId, cols, rows });
    }
  }

  function fitAllPanes() {
    if (!fitEnabled) return;
    const panes = S.paneOrder.length ? S.paneOrder.filter(id => S.paneEls[id]) : Object.keys(S.paneEls);
    for (const id of panes) {
      const pe = S.paneEls[id];
      if (pe && pe.box.style.display !== 'none' && !pe.box.classList.contains('dragging')) fitPane(id);
    }
  }

  function updateToggleUI() {
    fitToggle.classList.toggle('active', fitEnabled);
    fitToggle.title = fitEnabled
      ? 'Fit mode ON — terminal synced to browser viewport (click to disable)'
      : 'Sync terminal size to browser viewport';
  }

  function enableFit() {
    fitEnabled = true;
    localStorage.setItem(FIT_KEY, '1');
    updateToggleUI();
    window.tmuxWs?.send({ type: 'fit_enable' });
    fitAllPanes();
  }

  function disableFit() {
    fitEnabled = false;
    localStorage.setItem(FIT_KEY, '0');
    updateToggleUI();
    window.tmuxWs?.send({ type: 'fit_disable' });
  }

  fitToggle.addEventListener('click', () => {
    if (fitEnabled) disableFit(); else enableFit();
  });

  // On WS connect, re-send fit_enable if toggle is on
  window._fitOnConnect = function() {
    updateToggleUI();
    if (fitEnabled) {
      window.tmuxWs?.send({ type: 'fit_enable' });
      setTimeout(fitAllPanes, 200);
    }
  };

  let fitTimer = null;
  function debouncedFit() { clearTimeout(fitTimer); fitTimer = setTimeout(fitAllPanes, 300); }
  window._fitAllPanes = debouncedFit;
  window._fitPane = function(paneId) { fitPane(paneId); };
  window.addEventListener('resize', debouncedFit);

  updateToggleUI();
})();

// ========================================================================
// 18. TTS Playback
// ========================================================================

(function() {
  const TTS_KEY = 'tmux-tts-enabled';
  // Explicit localStorage toggle always wins; config sets only the default for
  // a first-time visitor (no stored preference yet).
  const ttsStored = localStorage.getItem(TTS_KEY);
  let ttsEnabled = ttsStored !== null ? ttsStored !== '0' : cfgGet('notify.ttsDefaultEnabled', true);

  function getBasePath() { return location.pathname.replace(/\/+$/, '') || ''; }

  // Show TTS toast — tap to play (bypasses autoplay policy)
  function showTTSToast(id, text) {
    const ind = document.getElementById('tts-indicator');
    if (!ind) return;
    ind.innerHTML = '<span class="tts-play-icon">\u25B6</span> ' + esc(text || 'TTS');
    ind.classList.add('active');
    ind.style.pointerEvents = 'auto';
    ind.onclick = function() {
      const audio = new Audio(`${getBasePath()}/api/tts/${id}`);
      audio.play().catch(() => {});
      ind.classList.remove('active');
      ind.onclick = null;
      ind.style.pointerEvents = '';
    };
    // Auto-dismiss after 8s if not tapped
    clearTimeout(ind._timer);
    ind._timer = setTimeout(() => {
      ind.classList.remove('active');
      ind.onclick = null;
      ind.style.pointerEvents = '';
    }, 8000);
  }

  window.playTTS = function(id, text) {
    if (!ttsEnabled) return;
    // Try autoplay first; if blocked, show tap-to-play toast
    const audio = new Audio(`${getBasePath()}/api/tts/${id}`);
    const p = audio.play();
    if (p && p.catch) {
      p.catch(() => showTTSToast(id, text));
    }
    // Always show text indicator briefly
    const ind = document.getElementById('tts-indicator');
    if (ind && !ind.classList.contains('active')) {
      ind.textContent = text || '';
      ind.classList.add('active');
      clearTimeout(ind._timer);
      ind._timer = setTimeout(() => ind.classList.remove('active'), 3000);
    }
  };

  function updateTTSBtn(btn, on) {
    btn.textContent = on ? '\uD83D\uDD0A' : '\uD83D\uDD07';
    btn.classList.toggle('active', on);
    btn.title = on ? 'TTS: ON' : 'TTS: OFF';
  }

  window.toggleTTS = function() {
    ttsEnabled = !ttsEnabled;
    localStorage.setItem(TTS_KEY, ttsEnabled ? '1' : '0');
    const btn = document.getElementById('tts-toggle');
    if (btn) updateTTSBtn(btn, ttsEnabled);
  };

  // Init button state
  requestAnimationFrame(() => {
    const btn = document.getElementById('tts-toggle');
    if (btn) updateTTSBtn(btn, ttsEnabled);
  });
})();

// ========================================================================
// 19. Init
// ========================================================================

initUIConfig(); // apply window.__UI_CONFIG__ overrides before pref restore (localStorage still wins)
loadLayoutPref();
const _readOnly = new URLSearchParams(location.search).has('readonly');
// Boot: connect to the last-used session IMMEDIATELY — /api/sessions can be
// slow while federated hosts sleep (fan-out), and the local WS must never wait
// on remote machines (2026-07-06 "PWA opens into a multi-second stall"
// incident). loadSessions still refreshes the dropdown and falls back when the
// remembered session no longer exists.
if (!_readOnly) {
  const _bootLast = loadLastSession();
  if (_bootLast) window.tmuxWs.connect(_bootLast);
}
loadSessions(!_readOnly); // skip auto-connect in readonly mode (e.g. sentinel health check)
