package ws

// Agent-state classification for the deck's pane lights.
//
// Clean-room re-derivation of workshop's libs/agent-state manifests, which are
// themselves clean-room ports of the herdr agent multiplexer's detection
// CONCEPTS (herdr is AGPL-3.0; NO source was copied). Every pattern string
// below was authored against Claude Code's / Codex's observed TUI chrome and
// the workshop agent-state manifests, and is validated against the real
// captures in internal/ws/testdata/deck-state-fixtures.json. The herdr TOML
// manifests were consulted only as a BEHAVIOR checklist (which screen should
// resolve to which state, and the priority structure), never copied.
//
// The classifier is an ordered rule table per agent family (claude / codex /
// other), evaluated high-priority-first; the first matching rule wins (the
// tables are authored in descending-priority order, so first-match == the
// highest-priority match, with earlier-in-table breaking ties — same as the
// manifest engine's arbitration). Rules match against a REGION of the screen
// (see regions.go) so that stale scrollback which merely quotes a menu / the
// "esc to interrupt" hint cannot flip a genuinely-idle pane.
//
// Error cost is asymmetric: missing a "waiting" (an agent blocked on the
// human) is the most expensive mistake, so the blocked rules are inclusive and
// the idle rule is heavily NOT-gated — rules discriminate by region/priority,
// not by loosening strings.
//
// State wire strings are "working" | "waiting" | "idle" | "unknown"; the
// manifests' "blocked" maps to "waiting" here.

import (
	"regexp"
	"strings"
)

// detection is one point-in-time classification of a pane screen.
// visible* flags mark states backed by live on-screen/title chrome (stronger
// than plain text); skip marks "do not change state" screens. The three
// visible* flags mirror the agent-state manifests' visible_idle /
// visible_blocker / visible_working (clean-room from claude.toml / codex.toml).
//
// ponytail: only visibleIdle currently feeds a consumer (stateDebouncer's
// immediate-publish path). visibleBlocker / visibleWorking are tracked
// faithfully but not yet consumed — upgrade path = a blocked-heartbeat
// re-publish (herdr re-emits a blocked pane every ~800ms so a late-joining deck
// client learns it's waiting) or any consumer that must distinguish a
// chrome-visible block/work from a text-inferred one.
type detection struct {
	state          string // "working" | "waiting" | "idle" | "unknown"
	visibleIdle    bool
	visibleBlocker bool
	visibleWorking bool
	skip           bool
	rule           string // matched rule id ("" = nothing matched)
}

// paneView is the input to the rule tables: the screen as ANSI-stripped lines
// plus the pane's OSC title.
type paneView struct {
	lines []string
	title string
}

// stateRule is one entry in an ordered rule table. region selects the slice of
// the screen the rule inspects; match is the gate. priority is stored for
// documentation and the ordering invariant (TestRuleTablesOrdered); iteration
// order (descending priority) is what actually decides the winner.
type stateRule struct {
	id         string
	state      string
	priority   int
	visIdle    bool
	visBlocker bool
	visWorking bool
	skip       bool
	region     func(v paneView) []string
	match      func(region []string) bool
}

var (
	// OSC title signals. Claude sets the pane title to "<braille-spinner> …"
	// while working and "✳ …" while idle; tmux exposes it via #{pane_title}.
	reOscWorking = regexp.MustCompile(`^[\x{2800}-\x{28FF}] `) // braille spinner prefix
	reOscIdle    = regexp.MustCompile(`^✳ `)
	reBraille    = regexp.MustCompile(`[\x{2800}-\x{28FF}]`)

	// idle: the live input box, possibly inside a │…│ border.
	rePromptLine = regexp.MustCompile(`^[\s│]*❯`)
	// a numbered option under the cursor ("❯ 1." …) — NOT-gates the idle box.
	reChoiceCursor = regexp.MustCompile(`❯\s*\d+\.`)
	// a highlighted select-menu option line — a ❯ cursor at line start followed
	// by option text ("❯ Latency", "❯ 1. Yes"). Line-anchored + requires text
	// after the cursor, so an EMPTY composer box (" ❯ ") does NOT match and a
	// "❯ 1." quoted MID-prose ("…something ❯ 1. Yes earlier") does NOT match —
	// only a genuine cursor-highlighted option leading its own line.
	reSelectCursorLine = regexp.MustCompile(`^\s*❯\s+\S`)
	// a numbered yes/no option line (menu present); covers 1./2./3. with or
	// without the ❯ cursor so a capture that starts mid-menu still matches.
	reYesNoOption = regexp.MustCompile(`(?i)^\s*❯?\s*[123]\.\s*(?:yes|no)\b`)
	// an EMPTY ❯ line (input box, nothing typed) — suppresses the catch-all
	// blocker so stale scrollback phrases can't false-fire on an idle pane.
	reEmptyPromptLine = regexp.MustCompile(`^\s*❯\s*$`)
	// working (text fallback): spinner glyph family Claude renders mid-run.
	reSpinnerGlyph = regexp.MustCompile(`[✳✶✸✻✽✴✢✷]`)

	// ANSI stripper: capture-pane -e embeds SGR/CSI (and stray OSC) sequences
	// that break every line-anchored regex — live audit: 11/11 panes read
	// "unknown" purely from escape bytes before the ❯.
	reAnsi = regexp.MustCompile(`\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]`)
)

// Needle sets (all lowercase — the contains helpers lowercase the region).
var (
	// Live permission / confirmation questions (workshop manifest set).
	permissionQuestions = []string{
		"do you want to proceed?",
		"do you want to make this edit",
		"do you want to create",
		"would you like to proceed?",
	}
	// Companion signals that mark the bash-command variant of the prompt.
	bashSignals = []string{
		"bash command", "bash(", "contains expansion",
		"tab to amend", "ctrl+e to explain",
	}
	// AskUserQuestion / arrow-key select-menu chrome. "Enter to select" is the
	// defining footer of Claude's arrow-key select menu; the cancel wording
	// ("Esc to cancel" vs "Esc to go back") and the nav-hint line are
	// version-dependent, so keying on this single string + a live cursor-option
	// line (reSelectCursorLine) is more robust than a 3-way select/cancel/nav
	// conjunction (which a menu missing the nav line, or wording cancel
	// differently, would slip past → read idle). "Enter to confirm" is
	// deliberately excluded so the /model picker (skip rule) is not read as a
	// blocked select menu.
	formSelectSignals = []string{"enter to select"}
	// NOT-gates for the idle box: any live-form / active-question chrome that
	// means the ❯ is part of a prompt, not a free input line. Union of herdr's
	// select/cancel/navigate hints and the workshop's question/interrupt hints.
	idleNotGates = []string{
		"enter to select", "esc to cancel", "tab/arrow keys",
		"arrow keys to navigate", "↑/↓ to navigate",
		"do you want to", "would you like to", "esc to interrupt",
	}
	// Transcript-viewer navigation chrome — one of these must accompany the
	// "showing detailed transcript" phrase before we freeze the state.
	transcriptHints = []string{
		"ctrl+o", "ctrl+e", "↑↓ scroll", "? for shortcuts", "esc to close",
	}
	// pane_current_command values that mark a known coding agent.
	agentCommands = map[string]bool{
		"claude": true, "codex": true, "gemini": true, "aider": true,
		"cursor": true, "cursor-agent": true, "agy": true, "copilot": true,
		"opencode": true, "amp": true, "droid": true, "qwen": true,
		"kimi": true, "hermes": true, "pi": true,
	}
	// Generic runtimes that merely HOST agents (title-only classification).
	agentHostCommands = map[string]bool{
		"node": true, "bun": true, "deno": true,
	}

	// Config-supplied additions, APPENDED to the builtin sets above via
	// RegisterAgentCommands (config.AgentCommandsExtra / AgentHostCommandsExtra).
	// The builtins always stay; these only add. Written once at startup (before
	// any poller/monitor goroutine reads them), nil/empty by default so a stock
	// server classifies exactly as before.
	agentCommandsExtra     = map[string]bool{}
	agentHostCommandsExtra = map[string]bool{}
)

// RegisterAgentCommands appends config-provided agent commands to the builtin
// classifier sets (never replaces them). Call once at startup, before serving,
// so the one-time write happens-before any poller/monitor read.
func RegisterAgentCommands(extra, hostExtra []string) {
	for _, c := range extra {
		if c = strings.ToLower(strings.TrimSpace(c)); c != "" {
			agentCommandsExtra[c] = true
		}
	}
	for _, c := range hostExtra {
		if c = strings.ToLower(strings.TrimSpace(c)); c != "" {
			agentHostCommandsExtra[c] = true
		}
	}
}

// ── region selectors ────────────────────────────────────────────────────────

func rgnWhole(v paneView) []string    { return wholeRecent(v.lines) }
func rgnOscTitle(v paneView) []string { return []string{v.title} }
func rgnAfterRule(v paneView) []string {
	return afterLastHorizontalRule(v.lines)
}
func rgnBottomNonEmpty(n int) func(paneView) []string {
	return func(v paneView) []string { return bottomNonEmptyLines(v.lines, n) }
}

// ── Claude rule table (descending priority) ─────────────────────────────────

var claudeRules = []stateRule{
	{
		id: "osc_title_working", state: "working", priority: 1100, visWorking: true, region: rgnOscTitle,
		match: func(r []string) bool { return reOscWorking.MatchString(strings.Join(r, "\n")) },
	},
	{
		// User scrolling the transcript viewer → freeze state (skip_state_update).
		// Requires the phrase AND actual viewer nav chrome (safety margin so a
		// mere quote of the phrase in scrollback doesn't freeze a live pane).
		id: "transcript_viewer", state: "unknown", priority: 1000, skip: true,
		region: rgnBottomNonEmpty(3),
		match: func(r []string) bool {
			return regionContainsAll(r, []string{"showing detailed transcript"}) &&
				regionContainsAny(r, transcriptHints)
		},
	},
	{
		// AskUserQuestion / arrow-key select menu live on screen with NO composer
		// box → blocked. Discrimination is by LAYOUT, not window position, so a
		// long list whose highlighted ❯ option is scrolled far above the bottom
		// zone still detects (finding 2: a 12-item list with the cursor on option
		// 1 pushed the cursor out of the old fixed bottom-12 window → read idle):
		//   - No composer box (promptBoxBody absent). A live select menu and a
		//     live input box are mutually-exclusive UIs (verified on live
		//     captures, CC v2.1.198: AskUserQuestion / bash permission /
		//     ExitPlanMode all render WITHOUT a composer box), so a footer+cursor
		//     merely quoted in scrollback above an idle box (which HAS a box)
		//     cannot reach this rule. AskUserQuestion menus carry an INTERNAL ─
		//     rule ("N. Chat about this" separator) — promptBoxBody's shape match
		//     (interior must start with the ❯ input line) keeps that internal
		//     rule pair from reading as a box and short-circuiting this rule.
		//   - The "Enter to select" footer sits in the bottom zone (the menu owns
		//     the bottom, allowing only a trailing status-bar rule below it) — a
		//     footer quoted high in scrollback is excluded.
		//   - A live cursor-highlighted option line (reSelectCursorLine) exists
		//     anywhere in the menu; an empty composer ❯ or a mid-prose "❯ 1." quote
		//     does not satisfy the cursor gate.
		id: "live_blocked_form", state: "waiting", priority: 980, visBlocker: true, region: rgnWhole,
		match: func(r []string) bool {
			if _, hasBox := promptBoxBody(r); hasBox {
				return false
			}
			// whole-screen cursor search (finding 2) reintroduces a scrollback
			// vector, so keep the finding-3 bottom-anchor: a working pane whose
			// streamed prose merely quotes select-menu chrome is not blocked.
			if bottomZoneLiveWorking(r) {
				return false
			}
			return regionContainsAny(bottomNonEmptyLines(r, 12), formSelectSignals) &&
				regionLineMatch(r, reSelectCursorLine)
		},
	},
	{
		// "Run a dynamic workflow?" confirmation → blocked.
		id: "dynamic_workflow_prompt", state: "waiting", priority: 980, visBlocker: true, region: rgnWhole,
		match: func(r []string) bool {
			return regionContainsAll(r, []string{"run a dynamic workflow?", "esc to cancel"})
		},
	},
	{
		// The live input box is showing and no active prompt/form → visible idle.
		//
		// The zone is the composer box interior when a real box is on screen
		// (promptBoxBody's shape match — see regions.go), else the bottom-6
		// window (boxless / ╭─╮-bordered prompts). A real blocked screen NEVER
		// renders a composer box below its menu (verified on live captures of
		// AskUserQuestion, bash permission and ExitPlanMode, CC v2.1.198), so a
		// menu/question above a detected box is by definition stale scrollback —
		// the box's presence alone is the idle signal, and quoted menus above it
		// cannot poison the NOT-gates (they only see the box interior).
		//
		// When a box IS present, its presence ALONE is the idle signal — the
		// interior is HUMAN-TYPED text and must not be gated at all (adversarial
		// findings: typing/pasting "do you want to …", "esc to interrupt" or a
		// quoted "❯ 1. Yes" into the composer must not knock the pane off idle;
		// the NOT-gates exist for the boxless fallback zone where question text
		// sits NEXT TO the ❯, not inside it). The only box-mode veto is a live
		// "esc to interrupt" hint OUTSIDE the box — streamed fake-box chrome
		// below it, or the streaming spinner line directly above it. Deliberately
		// esc-only: spinner glyphs would false-veto a real idle screen whose
		// "✻ Crunched for Ns" completion residue sits above the box.
		id: "live_prompt_box", state: "idle", priority: 950, visIdle: true, region: rgnWhole,
		match: func(r []string) bool {
			if top, bottom, ok := promptBoxSpan(r); ok {
				return !liveInterruptOutsideBox(r, top, bottom)
			}
			zone := bottomNonEmptyLines(r, 6)
			return regionLineMatch(zone, rePromptLine) &&
				!regionContainsAny(zone, idleNotGates) &&
				!regionLineMatch(zone, reChoiceCursor)
		},
	},
	{
		// /model picker open → freeze (don't read the pane as idle/available
		// mid-selection). Real picker chrome (live capture 2026-07-02, CC
		// v2.1.198): "Select model" header + "Enter to set as default · s to use
		// this session only · Esc to cancel" footer — no "enter to select", so
		// the live_blocked_form rule above cannot claim it first.
		id: "model_picker_menu", state: "unknown", priority: 900, skip: true, region: rgnWhole,
		match: func(r []string) bool {
			return regionContainsAll(r, []string{"select model", "esc to cancel"}) &&
				!regionContainsAny(r, []string{"do you want to proceed?", "enter to select"})
		},
	},
	{
		// Bash-command permission prompt (higher-confidence: bash companion
		// signal present) → blocked.
		id: "bash_permission_prompt", state: "waiting", priority: 850, visBlocker: true, region: rgnWhole,
		match: func(r []string) bool {
			return !bottomZoneLiveWorking(r) &&
				regionContainsAll(r, []string{"do you want to proceed?"}) &&
				regionContainsAny(r, bashSignals) &&
				regionLineMatch(r, reYesNoOption)
		},
	},
	{
		// Generic permission / confirmation prompt (any workshop question + a
		// numbered yes/no option) → blocked. region falls back to whole content
		// when there is no horizontal rule, so boxless prompts still match.
		id: "generic_permission_prompt", state: "waiting", priority: 840, visBlocker: true, region: rgnAfterRule,
		match: func(r []string) bool {
			return !bottomZoneLiveWorking(r) &&
				regionContainsAny(r, permissionQuestions) && regionLineMatch(r, reYesNoOption)
		},
	},
	{
		// Catch-all blocker for prompts with no numbered menu (MCP permission
		// wait, network connection prompt, Plan-Mode review/skip). NOT-gated by
		// an empty ❯ line so stale scrollback phrases can't false-fire on an
		// idle pane.
		id: "legacy_no_prompt_blocker", state: "waiting", priority: 300, region: rgnWhole,
		match: matchLegacyBlocker,
	},
	{
		// Working from bottom-zone text. Workshop extension: herdr detects
		// working from PTY byte activity, which tmux polling can't observe.
		// ponytail: text heuristic (interrupt hint / spinner glyph / verbs);
		// upgrade path = a content-diff activity signal from the poll loop.
		id: "processing", state: "working", priority: 290, visWorking: true, region: rgnBottomNonEmpty(5),
		match: func(r []string) bool {
			lower := strings.ToLower(regionText(r))
			return strings.Contains(lower, "esc to interrupt") ||
				strings.Contains(lower, "thinking") ||
				strings.Contains(lower, "processing") ||
				reSpinnerGlyph.MatchString(regionText(r))
		},
	},
	{
		// NOTE: the manifests' companion osc_progress_idle rule (OSC 9;4 progress
		// "4;0" → idle) is intentionally NOT ported — tmux exposes no format
		// variable for OSC 9 progress (only #{pane_title} for OSC 0/2), and the
		// rule is redundant with this title signal in every case tmux can see.
		// A blocked pane's STALE ✳ title (live capture: title stays "✳ …" while
		// an AskUserQuestion / permission menu is up) is out-ranked by every
		// text blocker above, so this rule only fires on genuinely quiet screens.
		id: "osc_title_idle", state: "idle", priority: 250, visIdle: true, region: rgnOscTitle,
		match: func(r []string) bool { return reOscIdle.MatchString(strings.Join(r, "\n")) },
	},
}

// liveInterruptOutsideBox reports whether a live "esc to interrupt" hint sits
// OUTSIDE the composer box interior: anywhere below the bottom border (streamed
// fake-box chrome), or on the 2 non-empty lines directly above the top border
// (Claude's streaming spinner line renders flush above the box). Text INSIDE
// the box is human-typed and never counts.
func liveInterruptOutsideBox(lines []string, top, bottom int) bool {
	if regionContainsAny(lines[bottom+1:], []string{"esc to interrupt"}) {
		return true
	}
	seen := 0
	for i := top - 1; i >= 0 && seen < 2; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		seen++
		if strings.Contains(strings.ToLower(lines[i]), "esc to interrupt") {
			return true
		}
	}
	return false
}

// matchLegacyBlocker mirrors the manifest's broad any-of catch-all with the
// empty-❯-line veto. Additionally NOT-gated by:
//   - a present composer box (ground truth: no real blocked screen renders
//     one, and the box interior is human-typed text — pasting "do you want to
//     continue? (y/n)" into the composer must not flip an idle pane), and
//   - an actively-working bottom zone (finding 3): a blocker phrase in the
//     SCROLLBACK of a pane whose bottom is a live spinner (a just-answered
//     permission, or Claude quoting a menu mid-turn) is stale and must not
//     flip a genuinely-working pane to waiting.
func matchLegacyBlocker(r []string) bool {
	if _, ok := promptBoxBody(r); ok {
		return false
	}
	if bottomZoneLiveWorking(r) {
		return false
	}
	lower := strings.ToLower(regionText(r))
	hasYesOrCursor := strings.Contains(lower, "yes") || strings.Contains(lower, "❯")
	hit := (strings.Contains(lower, "do you want to") && hasYesOrCursor) ||
		(strings.Contains(lower, "would you like to") && hasYesOrCursor) ||
		strings.Contains(lower, "waiting for permission") ||
		strings.Contains(lower, "do you want to allow this connection?") ||
		strings.Contains(lower, "tab to amend") ||
		strings.Contains(lower, "ctrl+e to explain") ||
		(strings.Contains(lower, "do you want to proceed?") && strings.Contains(lower, "esc to cancel")) ||
		strings.Contains(lower, "review your answers") ||
		strings.Contains(lower, "skip interview and plan immediately")
	if !hit {
		return false
	}
	return !regionLineMatch(r, reEmptyPromptLine)
}

// bottomZoneLiveWorking reports whether a region's bottom non-empty zone shows
// UNAMBIGUOUS live-working chrome — the "esc to interrupt" interrupt hint or a
// spinner glyph. It NOT-gates the whole-screen text blockers (finding 3) so a
// blocker phrase sitting in the scrollback of a genuinely-working pane cannot
// flip it to waiting. Deliberately NARROWER than the processing rule (no
// "thinking"/"processing" verbs): those are ordinary English words that could
// appear in a real permission question, and NOT-gating a genuine block to
// working is the most expensive error — so the gate keys only on chrome that
// cannot occur in a static prompt.
func bottomZoneLiveWorking(region []string) bool {
	tail := regionText(bottomNonEmptyLines(region, 5))
	return strings.Contains(strings.ToLower(tail), "esc to interrupt") ||
		reSpinnerGlyph.MatchString(tail)
}

// ── Codex rule table (port of libs/agent-state codex.toml) ──────────────────

var codexRules = []stateRule{
	{
		id: "osc_title_action_required", state: "waiting", priority: 1100, visBlocker: true, region: rgnOscTitle,
		match: func(r []string) bool { return regionContainsAll(r, []string{"action required"}) },
	},
	{
		id: "osc_title_working", state: "working", priority: 1050, visWorking: true, region: rgnOscTitle,
		match: func(r []string) bool { return reOscWorking.MatchString(strings.Join(r, "\n")) },
	},
	{
		id: "approval_prompt", state: "waiting", priority: 300, visBlocker: true, region: rgnWhole,
		match: func(r []string) bool {
			return regionContainsAny(r, []string{
				"press enter to confirm or esc to cancel",
				"allow command?", "enter to submit answer", "enter to submit all",
			})
		},
	},
	{
		// Guarded by codex's own live-working signals (the same ones
		// interrupt_working keys on, which this rule outranks): a y/n phrase in
		// the SCROLLBACK of a pane whose bottom shows a braille spinner or the
		// interrupt hint is stale and must not flip a working pane to waiting.
		id: "weak_blocker", state: "waiting", priority: 200, region: rgnWhole,
		match: func(r []string) bool {
			tail := bottomNonEmptyLines(r, 6)
			if regionContainsAny(tail, []string{"esc to interrupt"}) || reBraille.MatchString(regionText(tail)) {
				return false
			}
			lower := strings.ToLower(regionText(r))
			return strings.Contains(lower, "[y/n]") || strings.Contains(lower, "yes (y)") ||
				(strings.Contains(lower, "do you want to") &&
					(strings.Contains(lower, "yes") || strings.Contains(lower, "❯")))
		},
	},
	{
		id: "interrupt_working", state: "working", priority: 100, visWorking: true, region: rgnBottomNonEmpty(6),
		match: func(r []string) bool {
			return regionContainsAny(r, []string{"esc to interrupt"}) || reBraille.MatchString(regionText(r))
		},
	},
}

// ── Generic known-agent table: OSC-title signals only ───────────────────────
// Other known agents (gemini/aider/…) get OSC-title rules only — their body
// TUI chrome differs from Claude's and would misclassify under the claude text
// rules. An unmatched screen falls through to the caller's known-agent quiet
// idle default.
var genericOscRules = []stateRule{
	{
		id: "osc_title_working", state: "working", priority: 1100, visWorking: true, region: rgnOscTitle,
		match: func(r []string) bool { return reOscWorking.MatchString(strings.Join(r, "\n")) },
	},
	{
		id: "osc_title_idle", state: "idle", priority: 250, visIdle: true, region: rgnOscTitle,
		match: func(r []string) bool { return reOscIdle.MatchString(strings.Join(r, "\n")) },
	},
}

// stripAnsi removes escape sequences so line-anchored rules see the glyphs a
// human sees. Applied once per capture on the classification path only —
// output frames keep their colors.
func stripAnsi(s string) string {
	if !strings.ContainsRune(s, '\x1b') {
		return s
	}
	return reAnsi.ReplaceAllString(s, "")
}

// reVersionCmd: Claude Code sets its process title to its bare version string
// ("2.1.198"), so that's what #{pane_current_command} reports for a live
// Claude pane.
var reVersionCmd = regexp.MustCompile(`^\d+\.\d+\.\d+`)

// rulesetFor selects the rule table for a pane's foreground command. codex →
// codex table; claude / bare-version → claude table; any other known agent →
// OSC-title-only table.
func rulesetFor(cmd string) []stateRule {
	c := strings.ToLower(strings.TrimSpace(cmd))
	switch {
	case c == "codex":
		return codexRules
	case c == "claude" || c == "claude-code" || reVersionCmd.MatchString(c):
		return claudeRules
	default:
		return genericOscRules
	}
}

// classifyPane classifies one pane snapshot. text must already be ANSI-stripped
// (see stripAnsi). cmd selects the agent rule table (see rulesetFor). Rules are
// evaluated high-priority-first; the first match wins, else "unknown".
func classifyPane(text, title, cmd string) detection {
	v := paneView{lines: splitLines(text), title: title}
	for _, r := range rulesetFor(cmd) {
		if r.match(r.region(v)) {
			return detection{
				state:          r.state,
				visibleIdle:    r.visIdle,
				visibleBlocker: r.visBlocker,
				visibleWorking: r.visWorking,
				skip:           r.skip,
				rule:           r.id,
			}
		}
	}
	return detection{state: "unknown"}
}

// isAgentCommand reports whether a pane's foreground command names a known
// coding agent (or Claude's bare-version process title).
func isAgentCommand(cmd string) bool {
	cmd = strings.ToLower(strings.TrimSpace(cmd))
	return agentCommands[cmd] || agentCommandsExtra[cmd] || reVersionCmd.MatchString(cmd)
}

// isAgentHostCommand reports whether the command is a generic runtime that may
// be hosting an agent — trusted for TITLE-ONLY classification.
func isAgentHostCommand(cmd string) bool {
	cmd = strings.ToLower(strings.TrimSpace(cmd))
	return agentHostCommands[cmd] || agentHostCommandsExtra[cmd]
}

// classifyTitleOnly classifies a pane by its OSC title alone — used for generic
// runtimes (node/bun/deno) where screen text is untrusted (a dev server's logs
// must not light agent lamps) but an agent-set braille/✳ title is still
// authoritative. No default-idle: an unmatched title stays unknown.
func classifyTitleOnly(title string) detection {
	if reOscWorking.MatchString(title) {
		return detection{state: "working", visibleWorking: true, rule: "osc_title_working"}
	}
	if reOscIdle.MatchString(title) {
		return detection{state: "idle", visibleIdle: true, rule: "osc_title_idle"}
	}
	return detection{state: "unknown"}
}

// stateDebouncer suppresses point-in-time flicker per pane. Only the
// working → PLAIN idle transition is held (the flicker-prone one: a blank
// mid-render frame reads idle for a sample); a visible-idle idle, or any other
// transition, publishes immediately. skip-flagged detections never change the
// published state. Confirmations are counted, not timed — deterministic.
type stateDebouncer struct {
	published    string
	idleConfirms int
}

const idleConfirmationsRequired = 3

func (d *stateDebouncer) observe(det detection) string {
	if det.skip {
		if d.published == "" {
			d.published = "unknown"
		}
		return d.published
	}
	held := d.published == "working" && det.state == "idle" && !det.visibleIdle
	if !held {
		d.idleConfirms = 0
		d.published = det.state
		return d.published
	}
	d.idleConfirms++
	if d.idleConfirms >= idleConfirmationsRequired {
		d.idleConfirms = 0
		d.published = "idle"
	}
	return d.published
}
