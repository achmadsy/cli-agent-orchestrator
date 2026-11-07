package ws

// Table tests for the region-based agent-state classifier (agentstate.go +
// regions.go). Three layers:
//   1. TestDeckFixtures — drives the FULL pipeline (agent gate → classifyPane →
//      quiet-agent idle default, mirroring collectPaneStates) over the real +
//      synthetic captures in testdata/deck-state-fixtures.json and asserts the
//      ground-truth `expect`. Skip fixtures additionally assert the debouncer
//      freezes the previously-published state.
//   2. TestClaudeRules / TestCodexRules / TestGenericAgentNarrowing — one
//      positive + one negative (poison) case per newly-ported rule.
//   3. TestRegions / TestRuleTablesOrdered — region-algorithm and table-order
//      invariants.

import (
	"encoding/json"
	"os"
	"testing"
)

const ruleLine = "────────────────────────" // U+2500 horizontal rule

type deckFixture struct {
	Name   string `json:"name"`
	Text   string `json:"text"`
	Title  string `json:"title"`
	Cmd    string `json:"cmd"`
	Expect string `json:"expect"`
}

// resolvePipeline reproduces collectPaneStates' decision for a single sample
// (without the debouncer): agent panes run classifyPane and fall back to idle
// when nothing matched; host panes run title-only; everything else is unknown.
func resolvePipeline(f deckFixture) (state string, skip bool, rule string) {
	switch {
	case isAgentCommand(f.Cmd):
		det := classifyPane(stripAnsi(f.Text), f.Title, f.Cmd)
		if det.skip {
			return det.state, true, det.rule
		}
		if det.rule == "" {
			return "idle", false, "default_idle"
		}
		return det.state, false, det.rule
	case isAgentHostCommand(f.Cmd):
		det := classifyTitleOnly(f.Title)
		return det.state, det.skip, det.rule
	default:
		return "unknown", false, ""
	}
}

func TestDeckFixtures(t *testing.T) {
	raw, err := os.ReadFile("testdata/deck-state-fixtures.json")
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var fixtures []deckFixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}
	if len(fixtures) == 0 {
		t.Fatal("no fixtures loaded")
	}
	for _, f := range fixtures {
		state, skip, rule := resolvePipeline(f)
		if f.Expect == "skip" {
			if !skip {
				t.Errorf("%s: want skip, got state=%q rule=%q", f.Name, state, rule)
			}
			// A skip detection must freeze the previously-published state.
			d := &stateDebouncer{published: "working"}
			det := classifyPane(stripAnsi(f.Text), f.Title, f.Cmd)
			if got := d.observe(det); got != "working" {
				t.Errorf("%s: skip fixture did not freeze debouncer, got %q", f.Name, got)
			}
			continue
		}
		if skip {
			t.Errorf("%s: unexpected skip (want %q)", f.Name, f.Expect)
		}
		if state != f.Expect {
			t.Errorf("%s: pipeline state=%q (rule %q), want %q", f.Name, state, rule, f.Expect)
		}
	}
}

func TestClaudeRules(t *testing.T) {
	cases := []struct {
		name, text, title string
		want              string
		wantRule          string // "" = don't assert
		wantSkip          bool
	}{
		// transcript_viewer (1000): phrase + nav chrome freezes; phrase alone does NOT.
		{name: "transcript freeze with nav chrome",
			text: "history\nShowing detailed transcript · ctrl+o to expand · esc to close",
			want: "unknown", wantRule: "transcript_viewer", wantSkip: true},
		{name: "transcript phrase alone does not freeze",
			text: "someone said 'showing detailed transcript' once", want: "unknown"},

		// live_blocked_form (980): select+cancel+nav → waiting; quoted above a live box → idle.
		{name: "askuserquestion form is waiting",
			text: " Pick one\n ❯ A\n   B\n ↑/↓ to navigate · Enter to select · Esc to cancel",
			want: "waiting", wantRule: "live_blocked_form"},
		{name: "form chrome quoted above a live idle box does not block",
			text: "earlier: Enter to select · Esc to cancel · ↑/↓ to navigate\nmore prose\n" +
				ruleLine + "\n ❯ \n" + ruleLine + "\n status", want: "idle", wantRule: "live_prompt_box"},

		// dynamic_workflow_prompt (980): exact phrase → waiting; the bg-workflow phrase does NOT.
		{name: "run a dynamic workflow prompt is waiting",
			text: "Run a dynamic workflow?\n ❯ 1. Yes\n press esc to cancel", want: "waiting",
			wantRule: "dynamic_workflow_prompt"},
		{name: "bg dynamic workflow status is not a prompt",
			text: "✻ Waiting for 1 dynamic workflow to finish\n" + ruleLine + "\n ❯ \n" + ruleLine,
			want: "idle", wantRule: "live_prompt_box"},

		// model_picker_menu (900): select model + esc to cancel → skip; plain idle box does not.
		{name: "model picker freezes",
			text: " Select model\n ❯ 1. Default\n   2. Opus\n Enter to confirm · Esc to cancel",
			want: "unknown", wantRule: "model_picker_menu", wantSkip: true},
		{name: "idle box is not a model picker",
			text: ruleLine + "\n ❯ \n" + ruleLine, want: "idle", wantRule: "live_prompt_box"},

		// bash_permission_prompt (850): bash signal present → attributed to bash rule.
		{name: "bash permission attributed to bash rule",
			text: "│ Bash command │\n pytest -q\nDo you want to proceed?\n ❯ 1. Yes\n 2. No",
			want: "waiting", wantRule: "bash_permission_prompt"},
		// generic_permission_prompt (840): proceed w/o bash signal → generic rule.
		{name: "generic proceed permission attributed to generic rule",
			text: "Do you want to proceed?\n ❯ 1. Yes\n 2. No", want: "waiting",
			wantRule: "generic_permission_prompt"},

		// legacy_no_prompt_blocker (300): MCP/plan phrases → waiting; empty ❯ line suppresses.
		{name: "waiting for permission is a blocker",
			text: "MCP server foo\nWaiting for permission to use tool", want: "waiting",
			wantRule: "legacy_no_prompt_blocker"},
		{name: "plan review is a blocker",
			text: "Review your answers before continuing", want: "waiting",
			wantRule: "legacy_no_prompt_blocker"},
		{name: "empty prompt line vetoes stale blocker phrase",
			text: "scrollback: do you want to proceed? yes earlier\n" + ruleLine + "\n ❯ \n" + ruleLine,
			want: "idle", wantRule: "live_prompt_box"},

		// processing (290): interrupt hint / spinner → working.
		{name: "processing spinner is working",
			text: "output\n✻ Distilling…", want: "working", wantRule: "processing"},

		// Ground truth (live captures 2026-07-02, CC v2.1.198): a live menu and a
		// composer box are mutually exclusive — every real blocked screen
		// (AskUserQuestion / bash permission / ExitPlanMode) renders WITHOUT a
		// box below it. A menu-shaped tail above a detected box is therefore
		// stale scrollback and must stay idle; the old prompt_above_composer_box
		// rule that assumed the hybrid screen was real is gone (it false-fired on
		// shell-prompt examples and numbered lists flush above the box, and
		// false-bailed on wrapped menu options).
		{name: "real askuserquestion menu (internal ─ rule, stale ✳ title) is waiting",
			text: " ☐ 顏色偏好\n少爺偏好哪個顏色？\n ❯ 1. Red\n      紅色\n   2. Blue\n      藍色\n   3. Green\n      綠色\n   4. Type something.\n" +
				ruleLine + "\n   5. Chat about this\n Enter to select · ↑/↓ to navigate · Esc to cancel",
			title: "✳ Ask user color preference",
			want:  "waiting", wantRule: "live_blocked_form"},
		{name: "perm menu quoted then pushed above composer box stays idle",
			text: "earlier: Do you want to proceed?\n ❯ 1. Yes\nline\nline\nline\nline\nline\nline\n" +
				ruleLine + "\n ❯ \n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
		{name: "quoted bash perm prompt flush above composer box stays idle",
			text: "⏺ I asked: Bash command · tab to amend\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n" +
				ruleLine + "\n ❯ \n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
		{name: "shell-prompt example flush above composer box stays idle",
			text: "Run it yourself:\n ❯ go test ./internal/ws/\n" + ruleLine + "\n ❯ \n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
		{name: "numbered next-steps list flush above composer box stays idle",
			text: "the footer said Enter to select earlier\nNext steps:\n 1. fix ws test\n 2. rebuild deck\n" +
				ruleLine + "\n ❯ \n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},

		// live_blocked_form (980, findings 2 & 3): relaxed to key on 'enter to
		// select' + a live cursor-option line, over a bottom-12 window.
		{name: "select menu without nav hint is waiting",
			text: "Pick one\n ❯ A\n   B\n Enter to select · Esc to cancel",
			want: "waiting", wantRule: "live_blocked_form"},
		{name: "select menu with esc-to-go-back wording is waiting",
			text: "Pick one\n ❯ A\n   B\n ↑/↓ to navigate · Enter to select · Esc to go back",
			want: "waiting", wantRule: "live_blocked_form"},
		{name: "select menu above a trailing status-bar rule is waiting",
			text: "Pick one\n ❯ A\n   B\n ↑/↓ to navigate · Enter to select · Esc to cancel\n" +
				ruleLine + "\n 🔖 status\n 🤖 model",
			want: "waiting", wantRule: "live_blocked_form"},

		// Permission wording OUTSIDE the 4-phrase whitelist (real shape: menu
		// owns the bottom, no composer box) must still block — via the broad
		// legacy blocker, not a phrase-per-rule whitelist.
		{name: "delete-permission (non-whitelisted question, no box) is waiting",
			text: "Do you want to delete src/old.py?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)",
			want: "waiting", wantRule: "legacy_no_prompt_blocker"},
		{name: "mcp-tool approval (non-whitelisted question, no box) is waiting",
			text: "Do you want to allow this MCP tool?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)",
			want: "waiting", wantRule: "legacy_no_prompt_blocker"},
		// Wrapped last option (narrow deck pane): the option's continuation tail
		// is the bottom-most line — wording-based blockers must still fire.
		{name: "wrapped permission option continuation is waiting",
			text: "Do you want to make this edit to agentstate.go?\n ❯ 1. Yes\n   2. No, and tell Claude what to do\n" +
				"      differently (esc)",
			want: "waiting", wantRule: "generic_permission_prompt"},

		// finding 2: the highlighted ❯ cursor scrolled out of the fixed windows.
		{name: "long boxless select list with cursor scrolled out is waiting",
			text: "Resume:\n ❯ 1. a\n   2. b\n   3. c\n   4. d\n   5. e\n   6. f\n   7. g\n   8. h\n   9. i\n   10. j\n" +
				" ↑/↓ to navigate · Enter to select · Esc to cancel",
			want: "waiting", wantRule: "live_blocked_form"},

		// Human-typed composer content must NEVER poison the state (adversarial
		// findings, round 3): the box's presence alone is the idle signal; its
		// interior is the human's text, not agent chrome.
		{name: "pasted npm y/n prompt inside composer stays visible idle",
			text: "some output\n" + ruleLine + "\n ❯ from npm: ? Do you want to continue? (Y/n)\n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
		{name: "typed do-you-want-to question inside composer stays visible idle",
			text: ruleLine + "\n ❯ Do you want to keep the old debouncer, or should I remove it?\n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
		{name: "typed would-you-like-to inside composer stays visible idle",
			text: ruleLine + "\n ❯ Would you like to see the diff before I commit?\n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
		{name: "typed esc-to-interrupt question inside composer stays visible idle",
			text: ruleLine + "\n ❯ how do I use esc to interrupt while it is thinking?\n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
		{name: "typed quoted choice cursor inside composer stays visible idle",
			text: ruleLine + "\n ❯ explain what ❯ 1. Yes means\n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},

		// Fabricated-box vector: streamed output quoting box chrome (a ❯ line
		// between two ─ separators) on a WORKING pane must not read visible-idle.
		{name: "fake box from streamed rules on working pane is working",
			text: "⏺ cat testdata/deck-state-fixtures.json\n" + ruleLine + "\n ❯ go test ./...\n" + ruleLine + "\n" +
				"✳ Synthesizing… (esc to interrupt · 12s)",
			want: "working", wantRule: "processing"},
		{name: "fake box from shell example between rules is working",
			text: "docs say:\n" + ruleLine + "\n ❯ make install\n" + ruleLine + "\n✻ Baking… (esc to interrupt)",
			want: "working", wantRule: "processing"},

		// finding 3: a blocker phrase in the scrollback of a working pane (live
		// 'esc to interrupt' spinner at the bottom, no box) must NOT flip to waiting.
		{name: "working spinner with do-you-want-to-yes in scrollback is working",
			text: "⏺ When Claude asks 'do you want to proceed?' you answer yes. Earlier: ❯ 1. Yes.\n" +
				"  Now streaming the result.\n\n✻ Simmering… (esc to interrupt · 8s · ↑ 2.1k tokens)",
			want: "working", wantRule: "processing"},
		{name: "working spinner with answered bash perm in scrollback is working",
			text: "⏺ Bash(pytest -q)\n  ⎿ 42 passed\nDo you want to proceed?\n ❯ 1. Yes\n   2. No\n" +
				"  (already approved)\n\n✻ Cogitating… (esc to interrupt · 3s)",
			want: "working", wantRule: "processing"},
		{name: "working spinner with quoted select-menu chrome in scrollback is working",
			text: "⏺ The picker showed ❯ 1. Latency and a footer 'Enter to select · Esc to cancel'.\n" +
				"  You already chose; now streaming.\n\n✻ Churning… (esc to interrupt · 5s)",
			want: "working", wantRule: "processing"},

		// finding 4 (poison): a quoted menu within 6 lines above a live box, but
		// with prose flush against the box → stays idle (contiguity guard).
		{name: "quoted menu with prose flush above the box stays idle",
			text: "⏺ Done. Earlier you approved when I asked:\n Do you want to proceed?\n ❯ 1. Yes\n" +
				" All tests passed. Nothing pending.\n" + ruleLine + "\n ❯ \n" + ruleLine + "\n 🔖 status",
			want: "idle", wantRule: "live_prompt_box"},
	}
	for _, c := range cases {
		det := classifyPane(c.text, c.title, "claude")
		if det.state != c.want {
			t.Errorf("%s: state=%q (rule %q), want %q", c.name, det.state, det.rule, c.want)
		}
		if c.wantRule != "" && det.rule != c.wantRule {
			t.Errorf("%s: rule=%q, want %q", c.name, det.rule, c.wantRule)
		}
		if det.skip != c.wantSkip {
			t.Errorf("%s: skip=%v, want %v", c.name, det.skip, c.wantSkip)
		}
	}
}

func TestCodexRules(t *testing.T) {
	cases := []struct {
		name, text, title string
		want              string
		wantRule          string
	}{
		{name: "codex action-required title is waiting", title: "Action Required: approve command",
			want: "waiting", wantRule: "osc_title_action_required"},
		{name: "codex braille title is working", title: "⠹ running", text: "whatever",
			want: "working", wantRule: "osc_title_working"},
		{name: "codex allow-command approval is waiting",
			text: "$ rm -rf build\nAllow command?", want: "waiting", wantRule: "approval_prompt"},
		{name: "codex y/n weak blocker is waiting",
			text: "Overwrite file? [y/n]", want: "waiting", wantRule: "weak_blocker"},
		{name: "codex esc-to-interrupt is working",
			text: "thinking\n esc to interrupt", want: "working", wantRule: "interrupt_working"},
		// weak_blocker must not outrank codex's own live-working chrome: a y/n
		// phrase in scrollback while the bottom shows a braille spinner + the
		// interrupt hint is stale (adversarial finding, round 3).
		{name: "codex working with y/n phrase in scrollback stays working",
			text: "docs: when codex asks do you want to proceed you answer yes\nmore output\n⠋ running tests · esc to interrupt",
			want: "working", wantRule: "interrupt_working"},
		// negative: a quiet codex screen matches nothing → caller default idle.
		{name: "codex quiet screen matches nothing", text: "just some output\nnothing pending",
			want: "unknown", wantRule: ""},
	}
	for _, c := range cases {
		det := classifyPane(c.text, c.title, "codex")
		if det.state != c.want {
			t.Errorf("%s: state=%q (rule %q), want %q", c.name, det.state, det.rule, c.want)
		}
		if det.rule != c.wantRule {
			t.Errorf("%s: rule=%q, want %q", c.name, det.rule, c.wantRule)
		}
	}
}

// TestGenericAgentNarrowing pins the deliberate narrowing: other known agents
// (gemini/aider/…) get OSC-title rules ONLY — Claude's body-text rules must not
// run, because a different TUI's chrome would misclassify. A claude-style
// permission body under cmd=gemini must NOT read waiting (it stays unknown and
// the caller's quiet-agent default turns it idle); only OSC titles classify.
func TestGenericAgentNarrowing(t *testing.T) {
	blockedBody := "Do you want to proceed?\n ❯ 1. Yes\n 2. No"
	if det := classifyPane(blockedBody, "", "gemini"); det.state != "unknown" || det.rule != "" {
		t.Errorf("gemini body text must not classify: state=%q rule=%q, want unknown/\"\"", det.state, det.rule)
	}
	if det := classifyPane("whatever", "⠹ crunching", "aider"); det.state != "working" {
		t.Errorf("gemini/aider braille title should be working, got %q", det.state)
	}
	if det := classifyPane("whatever", "✳ done", "aider"); det.state != "idle" || !det.visibleIdle {
		t.Errorf("known-agent ✳ title should be idle/visible, got %q vis=%v", det.state, det.visibleIdle)
	}
	// contrast: the SAME body under claude DOES read waiting.
	if det := classifyPane(blockedBody, "", "claude"); det.state != "waiting" {
		t.Errorf("claude body text should be waiting, got %q", det.state)
	}
}

// TestVisibleFlags pins the visible_idle / visible_blocker / visible_working
// flags (finding 4): the Go detection must carry all three, populated from the
// rule table to mirror the agent-state manifests (claude.toml / codex.toml).
// Before the fix only visibleIdle existed, so a chrome-visible block/work could
// not be distinguished from a text-inferred one.
func TestVisibleFlags(t *testing.T) {
	cases := []struct {
		name, text, title, cmd string
		wantRule               string
		wantIdle               bool
		wantBlocker            bool
		wantWorking            bool
	}{
		{name: "claude osc working → visible_working", title: "⠹ munching", cmd: "claude",
			wantRule: "osc_title_working", wantWorking: true},
		{name: "claude osc idle → visible_idle", text: "plain", title: "✳ done", cmd: "claude",
			wantRule: "osc_title_idle", wantIdle: true},
		{name: "claude permission prompt → visible_blocker",
			text: "Do you want to proceed?\n ❯ 1. Yes\n 2. No", cmd: "claude",
			wantRule: "generic_permission_prompt", wantBlocker: true},
		{name: "claude select menu → visible_blocker",
			text: "Pick one\n ❯ A\n ↑/↓ to navigate · Enter to select · Esc to cancel", cmd: "claude",
			wantRule: "live_blocked_form", wantBlocker: true},
		{name: "claude dynamic-workflow prompt → visible_blocker",
			text: "Run a dynamic workflow?\n ❯ 1. Yes\n press esc to cancel", cmd: "claude",
			wantRule: "dynamic_workflow_prompt", wantBlocker: true},
		{name: "claude live idle box → visible_idle only",
			text: ruleLine + "\n ❯ \n" + ruleLine, cmd: "claude",
			wantRule: "live_prompt_box", wantIdle: true},
		{name: "claude processing → visible_working",
			text: "out\n✻ Distilling…", cmd: "claude", wantRule: "processing", wantWorking: true},
		{name: "codex action-required title → visible_blocker", title: "Action Required: approve", cmd: "codex",
			wantRule: "osc_title_action_required", wantBlocker: true},
		{name: "codex approval prompt → visible_blocker", text: "Allow command?", cmd: "codex",
			wantRule: "approval_prompt", wantBlocker: true},
		{name: "codex interrupt → visible_working", text: "x\n esc to interrupt", cmd: "codex",
			wantRule: "interrupt_working", wantWorking: true},
	}
	for _, c := range cases {
		det := classifyPane(stripAnsi(c.text), c.title, c.cmd)
		if det.rule != c.wantRule {
			t.Errorf("%s: rule=%q, want %q", c.name, det.rule, c.wantRule)
		}
		if det.visibleIdle != c.wantIdle || det.visibleBlocker != c.wantBlocker || det.visibleWorking != c.wantWorking {
			t.Errorf("%s: visible idle/blocker/working = %v/%v/%v, want %v/%v/%v", c.name,
				det.visibleIdle, det.visibleBlocker, det.visibleWorking,
				c.wantIdle, c.wantBlocker, c.wantWorking)
		}
	}
	// title-only path (node/bun host): braille title carries visible_working.
	if det := classifyTitleOnly("⠹ crunching"); !det.visibleWorking {
		t.Error("classifyTitleOnly braille → visible_working must be true")
	}
}

func equalLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRegions(t *testing.T) {
	t.Run("isHorizontalRule", func(t *testing.T) {
		checks := []struct {
			line string
			want bool
		}{
			{ruleLine, true},
			{"─", true},                    // lone dash
			{"─── Title", true},            // 3+ dashes with trailing text
			{"── Title", false},            // only 2 dashes with text
			{"╌╌╌╌╌╌", false},              // U+254C light-double-dash, not U+2500
			{"╭────────╮", false},          // corner-led (U+256D) box line
			{"", false},                    // blank
			{"  " + ruleLine + "  ", true}, // padded rule
		}
		for _, c := range checks {
			if got := isHorizontalRule(c.line); got != c.want {
				t.Errorf("isHorizontalRule(%q) = %v, want %v", c.line, got, c.want)
			}
		}
	})
	t.Run("afterLastHorizontalRule", func(t *testing.T) {
		lines := []string{"a", ruleLine, "b", ruleLine, "c", "d"}
		if got := afterLastHorizontalRule(lines); !equalLines(got, []string{"c", "d"}) {
			t.Errorf("after last rule = %v, want [c d]", got)
		}
		noRule := []string{"x", "y"}
		if got := afterLastHorizontalRule(noRule); !equalLines(got, noRule) {
			t.Errorf("no rule should return whole content, got %v", got)
		}
	})
	t.Run("promptBoxBody", func(t *testing.T) {
		lines := []string{"top", ruleLine, " ❯ fix tests", "  wrapped input", ruleLine, "status"}
		body, ok := promptBoxBody(lines)
		if !ok || !equalLines(body, []string{" ❯ fix tests", "  wrapped input"}) {
			t.Errorf("body = %v ok=%v, want the ❯-led interior, true", body, ok)
		}
		if _, ok := promptBoxBody([]string{"a", ruleLine, "b"}); ok {
			t.Error("a single rule line is not a box")
		}
		if _, ok := promptBoxBody([]string{"╭──╮", "❯", "╰──╯"}); ok {
			t.Error("corner-bordered box has no U+2500 rule lines → no box")
		}
		// shape: interior must START with the ❯ input line — an AskUserQuestion
		// menu's internal rule pair ("☐ …" header first) is not a box.
		if _, ok := promptBoxBody([]string{ruleLine, " ☐ header", " ❯ 1. Red", ruleLine, " 5. Chat", " footer"}); ok {
			t.Error("menu interior (not ❯-led) must not read as a composer box")
		}
		// position: a rule pair deep in scrollback (>4 non-empty lines below the
		// bottom border) is streamed content, not the composer box.
		if _, ok := promptBoxBody([]string{ruleLine, " ❯ example", ruleLine, "a", "b", "c", "d", "e"}); ok {
			t.Error("rule pair with >4 trailing non-empty lines must not read as a box")
		}
		if _, ok := promptBoxBody([]string{"x", ruleLine, ruleLine, "status"}); ok {
			t.Error("adjacent rules (empty interior) are not an input box")
		}
	})
	t.Run("bottomNonEmptyLines", func(t *testing.T) {
		lines := []string{"a", "", "b", "", "c", ""}
		if got := bottomNonEmptyLines(lines, 2); !equalLines(got, []string{"b", "", "c", ""}) {
			t.Errorf("bottom 2 non-empty = %v, want [b  c ]", got)
		}
		if got := bottomNonEmptyLines(lines, 10); !equalLines(got, lines) {
			t.Errorf("n beyond count should return from top-most non-empty, got %v", got)
		}
		if bottomNonEmptyLines(lines, 0) != nil {
			t.Error("n=0 → nil")
		}
		if bottomNonEmptyLines([]string{"", "  ", ""}, 3) != nil {
			t.Error("all-blank screen → nil")
		}
	})
}

// TestRuleTablesOrdered guards the first-match-wins invariant: each table must
// be authored in non-increasing priority order, so iterating top-to-bottom and
// returning the first match yields the highest-priority match.
func TestRuleTablesOrdered(t *testing.T) {
	tables := map[string][]stateRule{
		"claude": claudeRules, "codex": codexRules, "generic": genericOscRules,
	}
	for name, rules := range tables {
		for i := 1; i < len(rules); i++ {
			if rules[i].priority > rules[i-1].priority {
				t.Errorf("%s table not descending: rule %q (%d) after %q (%d)",
					name, rules[i].id, rules[i].priority, rules[i-1].id, rules[i-1].priority)
			}
		}
	}
}
