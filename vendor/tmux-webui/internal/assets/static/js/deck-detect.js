// deck-detect.js — Deck Mode context detection (Slice 2a, LOW-RISK states only).
//
// Read-only: inspects the focused pane's visible text and classifies it as
// 'working' | 'idle' | 'unknown'. It NEVER sends anything, so the worst failure
// mode is showing the wrong panel (recoverable), never a wrong keystroke.
//
// NOTE (herdr-cannibalize): detectState is now a first-second FALLBACK only —
// the backend classifier (internal/ws/agentstate.go, ported from
// libs/agent-state's claude manifest) is authoritative for pane states: it
// alone sees #{pane_title} (Claude's braille-spinner/✳ OSC signal, which
// catches thinking/background phases that carry NO 'esc to interrupt' hint)
// and debounces per pane. Frontends consume it via pane_states frames
// (states=per-window aggregate, panes=per-pane). detectMenu / detectStatus /
// detectPermMode remain frontend-owned (they parse text the backend doesn't
// need).
//
// Regexes are calibrated against the REAL Claude Code TUI (see SLICE2-RECON.md),
// not assumptions. High-risk states (permission / plan / numbered choice) are
// deliberately NOT classified here — that is Slice 2b and needs per-state
// real-capture tuning plus a false-positive matrix before any auto-send.
(function () {
  'use strict';

  function focusedPaneText() {
    var S = window.tmuxState;
    if (!S || !S.focusedPane || !S.paneEls) return '';
    var pe = S.paneEls[S.focusedPane];
    if (!pe || !pe.terminal) return '';
    // Rebuild line breaks: the terminal is a stack of div.term-line; textContent
    // alone would concatenate lines with no separator.
    var lines = pe.terminal.querySelectorAll ? pe.terminal.querySelectorAll('.term-line') : null;
    if (lines && lines.length) {
      var out = [];
      for (var i = 0; i < lines.length; i++) out.push(lines[i].textContent);
      return out.join('\n');
    }
    return pe.terminal.textContent || '';
  }

  // working = the LIVE "esc to interrupt" interrupt hint. Calibrated to the
  // agent-deck idle-BT study (outputs/idle-bt-gate/is_idle_bt.py): this is the
  // GT-level signal, shown ONLY while Claude is running. The old '⎿ Running' /
  // '↓ <n>k tokens' signals were REMOVED — those are tool-output lines that LINGER
  // in scrollback, so an idle pane whose history still contained them was
  // misclassified 'working' (2026-06-20 bug: idle pane showed working). A captured
  // idle pane really did carry 4× '⎿ Running' + 1× '↓ tokens' residue.
  // tailNonEmpty returns the last n non-blank lines — the BOTTOM interaction zone.
  // All live-state signals are matched only within this window, NOT the whole pane:
  // scanning everything would match scrollback that merely QUOTES a marker (a real
  // 2026-06-20 case: this very pane's transcript discussed "esc to interrupt" and
  // was misclassified working). Dropping blanks first keeps padding from eating it.
  function tailNonEmpty(text, n) {
    var ne = text.split('\n').filter(function (l) { return l.trim(); });
    return ne.slice(-n);
  }

  function isWorking(text) {
    return /esc to interrupt/i.test(tailNonEmpty(text, 10).join('\n'));
  }

  // waiting = Claude is blocked on a choice (ExitPlanMode / proceed prompt /
  // numbered choice) at the bottom. Distinct from idle so the S4 lights flag
  // "needs you". Bottom-only (15 lines covers a title + options + footer).
  function isWaiting(text) {
    var tail = tailNonEmpty(text, 15).join('\n');
    return /(would you like to proceed|do you want to proceed|ready to code)/i.test(tail)
      || /❯\s*\d+\.\s/.test(tail);
  }

  // idle needs a POSITIVE signal — an empty ❯ input box near the bottom — not the
  // mere ABSENCE of working (which the scrollback residue defeated). Empty = ❯ with
  // nothing after it (a '❯ 1.' choice is NOT empty → handled by isWaiting above).
  function hasEmptyPrompt(text) {
    var tail = tailNonEmpty(text, 7);
    for (var i = 0; i < tail.length; i++) {
      if (/^[│|]?\s*[❯>]\s*$/.test(tail[i].trim())) return true;
    }
    return false;
  }

  function detectState(text) {
    if (!text) return 'unknown';
    if (isWorking(text)) return 'working';
    if (isWaiting(text)) return 'waiting';
    if (hasEmptyPrompt(text)) return 'idle';
    return 'unknown';
  }

  // detectMenu parses a Claude Code numbered-choice menu (ExitPlanMode / proceed
  // prompts) into { title, options:[{n,label}] }, calibrated to the REAL TUI
  // (REAL-MENU-SAMPLES.md: "❯ 1. Yes, and use auto mode" etc).
  //
  // STRICT — six anchors must ALL hold, so an assistant message that merely
  // DISCUSSES a menu (a numbered list + the words "ready to code", with ❯ only
  // in the input prompt) is NOT misread as a live menu. Real bug 2026-06-19:
  // deck quoted its own conversation back as a menu because the old ❯ check was
  // "anywhere in the pane" (the input prompt has ❯ too).
  //   (A) position: option block must be in the last ~18 lines
  //   (B) contiguous: the numbered option lines must be adjacent
  //   (C) cursor-on-option: the ❯ cursor must be ON an option line of the block
  //       — a plain numbered list typed in a message has no ❯ on its lines
  //   (D) consecutive numbering 1,2,3…
  //   (E) title adjacency: a proceed/ready anchor in the 1-4 lines directly above
  //       the block — scattered anchors elsewhere in the transcript don't count
  //   (F) bottom-adjacency + live-chrome: below the block there must be (1) no
  //       transcript prose AND (2) at least one live-chrome line (the menu's own
  //       shift+tab/ctrl+g footer or the 🔖/🤖/⏵⏵ status bar). A real menu always
  //       carries that chrome; a menu QUOTED at the very bottom of the pane has
  //       nothing below it → rejected. (A) alone missed quotes with prose under
  //       them; the "no prose" half alone missed quotes sitting at the pane bottom.
  // Even so, the actual send still passes through slide-to-confirm downstream.
  function detectMenu(text) {
    if (!text) return null;
    var lines = text.split('\n');
    var n = lines.length;
    var lo = Math.max(0, n - 18); // (A) position anchor

    // find the lowest contiguous block of >=2 numbered option lines within the tail.
    // No footer-skip here: real footer hints (shift+tab / ctrl+g) are UNNUMBERED so
    // they never match and naturally terminate the block; skipping on the label
    // instead wrongly dropped genuine options containing those words.
    var opts = null, blockTop = -1, blockEnd = -1, cursorOnBlock = false;
    for (var i = n - 1; i >= lo; i--) {
      if (!/^\s*❯?\s*\d+\.\s+\S/.test(lines[i])) continue;
      var collected = [], cur = false, j = i, expect = null;
      while (j >= lo) { // (B) contiguous AND strictly descending-by-1 going up
        var mm = lines[j].match(/^\s*(❯)?\s*(\d+)\.\s+(\S.*?)\s*$/);
        if (!mm) break;
        var num = parseInt(mm[2], 10);
        // a quoted numbered list sitting directly above the real block (no blank
        // line between) would otherwise merge into [1,2,1,2] and fail (D); stop the
        // upward walk the moment the numbering stops descending by exactly 1.
        if (expect !== null && num !== expect) break;
        if (mm[1]) cur = true;
        collected.unshift({ n: num, label: mm[3] });
        expect = num - 1;
        j--;
      }
      if (collected.length >= 2) { opts = collected; blockTop = j + 1; blockEnd = i; cursorOnBlock = cur; break; }
      i = j;
    }
    if (!opts) return null;
    if (!cursorOnBlock) return null; // (C) ❯ must be on an option line, not just in the pane
    for (var k = 0; k < opts.length; k++) { // (D) consecutive from 1
      if (opts[k].n !== k + 1) return null;
    }
    // (E) title adjacency: a proceed/ready anchor — END-ANCHORED so it matches the
    // actual prompt line ("…Would you like to proceed?") and NOT a mid-sentence
    // occurrence ("do you want to proceed to checkout?").
    var title = null, anchored = false;
    for (var t = Math.max(0, blockTop - 4); t < blockTop; t++) {
      if (/(would you like to proceed|do you want to proceed|ready to code)\s*\??\s*$/i.test(lines[t])) {
        anchored = true;
        title = lines[t].trim();
        break;
      }
    }
    if (!anchored) return null;

    // (F) bottom-adjacency + live-chrome: a LIVE menu is ALWAYS trailed by Claude
    // Code chrome — its own "shift+tab to approve" / "ctrl+g to edit" footer plus the
    // persistent 🔖/🤖/⏵⏵ status bar (REAL-MENU-SAMPLES.md golden ExitPlanMode sample).
    // Below the option block we therefore require BOTH: (1) no transcript prose, and
    // (2) at least one live-chrome line. A menu QUOTED in a transcript that ends at the
    // very bottom of the pane has NOTHING below it, so it is rejected — that was the
    // residual 2026-06-19 self-render bug shape (quote sitting at pane bottom). Markers
    // are anchored at line start / matched by leading phrase, never loose substrings.
    // Bias is deliberate: a missed live menu only shows the wrong panel (recoverable),
    // while a quote mistaken for a menu would send a real keystroke — so we err strict.
    var sawLiveChrome = false;
    for (var b = blockEnd + 1; b < n; b++) {
      var s = lines[b].trim();
      if (s === '') continue;                                                            // blank padding
      if (/^[─╌—_]{3,}$/.test(s)) continue;                                              // divider: neutral (allowed, not proof)
      if (/^(shift\s*\+\s*tab to|ctrl\s*\+\s*g to)/i.test(s)) { sawLiveChrome = true; continue; } // menu footer hint
      if (/^(🔖|🤖|⏵⏵|⏸|◯|◉)/.test(s)) { sawLiveChrome = true; continue; }              // status-bar line
      return null; // anything else below the block → quoted/discussed menu, not live
    }
    if (!sawLiveChrome) return null; // no live footer/status below the block → a quote at the pane bottom

    return { title: title, options: opts };
  }

  // detectStatus pulls the Claude Code status-bar values out of the focused pane
  // so the deck can surface them as badges (token/cost/context/mode) without the
  // user looking at the Mac. Calibrated to the REAL status bar (REAL-MENU-SAMPLES.md):
  //   🔖 3094 │ 📁 tmux-webui │ ⎇ -
  //   🤖 Opus 4.8 │ 💰 $311.56 │ ✍️  9/80%
  //   ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
  // Read-only. Values are surfaced VERBATIM (we don't reinterpret what 🔖/✍️ mean,
  // just relay the marker's value) so a status-bar format change degrades to a
  // missing badge, never a wrong number. Returns null if nothing parses.
  function detectStatus(text) {
    if (!text) return null;
    var out = { model: null, cost: null, context: null, tokens: null, mode: null };
    var m;
    if ((m = text.match(/🤖\s*([^│\n]+?)\s*(?:│|$)/m))) out.model = m[1].trim();
    if ((m = text.match(/💰\s*\$?\s*([\d.,]+)/))) out.cost = m[1];
    if ((m = text.match(/✍️️?\s*(\d+\/\d+%|\d+%)/))) out.context = m[1];
    if ((m = text.match(/🔖\s*(\d+)/))) out.tokens = m[1];
    if (/⏸\s*plan mode on/i.test(text)) out.mode = 'plan';
    else if (/⏵⏵\s*accept edits on/i.test(text)) out.mode = 'accept';
    else if (/⏵⏵\s*auto mode on/i.test(text)) out.mode = 'auto';
    else if (/bypass permissions/i.test(text)) out.mode = 'bypass';
    if (!out.model && !out.cost && !out.context && !out.tokens && !out.mode) return null;
    return out;
  }

  // detectPermMode reads ONLY the permission-mode marker (for the S2 slider's
  // authoritative read-back). Same markers as detectStatus.mode but standalone so
  // the slider can call it cheaply each tick. null = default (no marker shown).
  // Cycle order (shift+tab): default → accept → plan → auto → (loop). Calibrated to
  // REAL-MENU-SAMPLES.md §4, CC v2.1.183.
  function detectPermMode(text) {
    if (!text) return null;
    if (/⏸\s*plan mode on/i.test(text)) return 'plan';
    if (/⏵⏵\s*accept edits on/i.test(text)) return 'accept';
    if (/⏵⏵\s*auto mode on/i.test(text)) return 'auto';
    if (/bypass permissions/i.test(text)) return 'bypass';
    return null;
  }

  window.deckDetect = {
    focusedPaneText: focusedPaneText,
    detectState: detectState,
    detectMenu: detectMenu,
    detectStatus: detectStatus,
    detectPermMode: detectPermMode,
    currentState: function () { return detectState(focusedPaneText()); }
  };
})();
