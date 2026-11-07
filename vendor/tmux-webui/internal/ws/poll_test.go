package ws

import (
	"testing"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// TestClassifyPane pins the backend classifier (agentstate.go) — a Go port of
// libs/agent-state's claude manifest. Priority order under test:
// osc_working(1100) > transcript_freeze(1000) > permission(900) >
// numbered_choice(850) > idle_prompt_box(500) > processing(300) > osc_idle(250).
func TestClassifyPane(t *testing.T) {
	cases := []struct {
		name, text, title string
		want              string
		wantSkip          bool
		wantVisIdle       bool
	}{
		// OSC title — the highest-confidence signal (braille spinner = working).
		{name: "osc braille title working", text: "whatever text", title: "⠹ munching files", want: "working"},
		{name: "osc working beats idle prompt text", text: "──\n ❯ \n──", title: "⠸ thinking", want: "working"},
		{name: "osc idle title", text: "plain output", title: "✳ done thing", want: "idle", wantVisIdle: true},
		// but a live blocked/idle/working TEXT beats the (priority-250) idle title
		{name: "blocked text beats idle title", title: "✳ quiet",
			text: "Do you want to proceed?\n ❯ 1. Yes\n 2. No", want: "waiting"},

		{name: "live working (esc to interrupt)", text: "doing stuff\n  esc to interrupt", want: "working"},
		{name: "spinner glyph working", text: "✻ Cogitating… (2m)", want: "working"},

		// THE 2026-06-20 bug shape: tool-output residue in scrollback must NOT win
		// over the real bottom state.
		{name: "running residue but idle prompt",
			text: "  ⎿ Running echo\n  ⎿ Running ls\n done\n──────\n ❯ \n──────\n  🔖 100 │ 🤖 Opus",
			want: "idle", wantVisIdle: true},

		// blocked: question + numbered yes-line (manifest permission_prompt)
		{name: "edit permission prompt",
			text: "Do you want to make this edit to foo.go?\n ❯ 1. Yes\n   2. No", want: "waiting"},
		{name: "create permission prompt",
			text: "Do you want to create bar.txt?\n 1. Yes\n 2. No", want: "waiting"},
		// ❯ cursor on a numbered option WITHOUT a blocked question: manifest
		// fidelity — no positive numbered-choice rule (a quoted menu or a
		// numbered list typed into the composer must not read waiting; three
		// adversarial refuters each caught the extension false-positive). The
		// ❯N. line still NOT-gates idle, so this classifies unknown and the
		// caller's known-agent default turns it idle — same as the reference.
		{name: "numbered choice without question stays un-waiting",
			text: " ❯ 1. Latency first\n   2. Throughput", want: "unknown"},
		// The composer box's presence alone is the idle signal; its interior is
		// human-typed and never gated (this used to fall to unknown via the
		// reChoiceCursor NOT-gate and only reach idle through the caller's
		// quiet-agent default — now it is direct visible idle).
		{name: "typed numbered list in composer is visible idle, never waiting",
			text: "──────\n ❯ 1. fix ws test 2. rebuild deck\n──────", want: "idle", wantVisIdle: true},

		// idle: live input box, non-empty typed text still idle; NOT-gated
		{name: "empty prompt idle", text: "some output\n──────\n ❯ \n──────\n 🔖 1 │ 🤖 Opus",
			want: "idle", wantVisIdle: true},
		{name: "typed-but-unsent prompt is idle", text: "──────\n ❯ fix the tests please\n──────",
			want: "idle", wantVisIdle: true},
		{name: "prompt box below live question is NOT idle",
			text: "Would you like to proceed?\n ❯ 1. Yes\n ❯ ", want: "waiting"},
		{name: "quoted menu cursor above live box does not poison idle",
			text: "we discussed the menu:\nsomething about ❯ 1. Yes earlier\nmore prose\nlots of prose\nfiller line\nanother line\n──────\n ❯ \n──────",
			want: "idle", wantVisIdle: true},

		// transcript viewer freeze
		{name: "transcript viewer freezes", text: "long history…\nshowing detailed transcript · esc to close",
			want: "unknown", wantSkip: true},

		{name: "plain shell unknown", text: "just some logs\nnothing special here", want: "unknown"},
		{name: "working beats trailing prompt render", text: " esc to interrupt\n ❯ ", want: "working"},
	}
	for _, c := range cases {
		det := classifyPane(c.text, c.title, "claude")
		if det.state != c.want {
			t.Errorf("%s: classifyPane state = %q (rule %q), want %q", c.name, det.state, det.rule, c.want)
		}
		if det.skip != c.wantSkip {
			t.Errorf("%s: skip = %v, want %v", c.name, det.skip, c.wantSkip)
		}
		if c.wantVisIdle && !det.visibleIdle {
			t.Errorf("%s: visibleIdle = false, want true", c.name)
		}
	}
}

// TestRegisterAgentCommands pins the append-only config extension: registered
// commands classify as agents/hosts WITHOUT disturbing the builtin sets. Keys
// are cleaned up so the mutation doesn't leak into sibling tests.
func TestRegisterAgentCommands(t *testing.T) {
	t.Cleanup(func() {
		delete(agentCommandsExtra, "myagent")
		delete(agentHostCommandsExtra, "customruntime")
	})
	RegisterAgentCommands([]string{"myagent", "  ", ""}, []string{"CustomRuntime"})

	if !isAgentCommand("myagent") {
		t.Error("registered agent command must pass the gate")
	}
	// Case-folded + trimmed on the way in, so the host lookup matches lowercase.
	if !isAgentHostCommand("customruntime") {
		t.Error("registered host command must pass the host gate")
	}
	// Blank entries are skipped (an empty command must not match everything).
	if isAgentCommand("") {
		t.Error("blank command must not be registered as an agent")
	}
	// Builtins untouched.
	if !isAgentCommand("claude") || !isAgentHostCommand("node") {
		t.Error("builtin sets must survive an append")
	}
}

// TestAgentGate pins the Layer-1-lite command gate: named agents and Claude's
// bare-version process title pass; generic runtimes are TITLE-ONLY (a vite dev
// server logging "processing…" must never light agent lamps — adversarial
// finding); plain shells classify nothing.
func TestAgentGate(t *testing.T) {
	if !isAgentCommand("claude") || !isAgentCommand("2.1.198") || !isAgentCommand("codex") {
		t.Error("named agents / bare-version cmd must pass the agent gate")
	}
	if isAgentCommand("zsh") || isAgentCommand("node") || isAgentCommand("2.1") || isAgentCommand("v2.1.198") {
		t.Error("shells, generic runtimes and non-bare-version cmds must NOT pass the agent gate")
	}
	if !isAgentHostCommand("node") || !isAgentHostCommand("bun") || isAgentHostCommand("zsh") {
		t.Error("host gate must admit node/bun and reject shells")
	}
	// title-only path: dev-server text can't light lamps, agent titles can
	if got := classifyTitleOnly(""); got.state != "unknown" {
		t.Errorf("empty title → %q, want unknown", got.state)
	}
	if got := classifyTitleOnly("⠹ crunching"); got.state != "working" {
		t.Errorf("braille title → %q, want working", got.state)
	}
	if got := classifyTitleOnly("✳ done"); got.state != "idle" || !got.visibleIdle {
		t.Errorf("✳ title → %q visIdle=%v, want idle/true", got.state, got.visibleIdle)
	}
}

// TestStateDebouncer pins the flicker suppressor: working → PLAIN idle is held
// for 3 confirmations; visible-idle idle and every other transition publish
// immediately; skip-flagged detections never change the published state.
func TestStateDebouncer(t *testing.T) {
	work := detection{state: "working"}
	plainIdle := detection{state: "idle"}
	visIdle := detection{state: "idle", visibleIdle: true}
	blocked := detection{state: "waiting"}
	freeze := detection{state: "unknown", skip: true}

	t.Run("plain idle held for 3 confirmations", func(t *testing.T) {
		d := &stateDebouncer{}
		d.observe(work)
		if got := d.observe(plainIdle); got != "working" {
			t.Fatalf("1st plain idle published %q, want working", got)
		}
		if got := d.observe(plainIdle); got != "working" {
			t.Fatalf("2nd plain idle published %q, want working", got)
		}
		if got := d.observe(plainIdle); got != "idle" {
			t.Fatalf("3rd plain idle published %q, want idle", got)
		}
	})
	t.Run("visible idle publishes immediately", func(t *testing.T) {
		d := &stateDebouncer{}
		d.observe(work)
		if got := d.observe(visIdle); got != "idle" {
			t.Fatalf("visible idle published %q, want idle", got)
		}
	})
	t.Run("working to blocked never held", func(t *testing.T) {
		d := &stateDebouncer{}
		d.observe(work)
		if got := d.observe(blocked); got != "waiting" {
			t.Fatalf("blocked published %q, want waiting", got)
		}
	})
	t.Run("a working sample resets the idle count", func(t *testing.T) {
		d := &stateDebouncer{}
		d.observe(work)
		d.observe(plainIdle)
		d.observe(plainIdle)
		d.observe(work) // flicker over — reset
		d.observe(plainIdle)
		if got := d.observe(plainIdle); got != "working" {
			t.Fatalf("after reset, 2nd plain idle published %q, want working", got)
		}
	})
	t.Run("skip freezes the published state", func(t *testing.T) {
		d := &stateDebouncer{}
		d.observe(work)
		if got := d.observe(freeze); got != "working" {
			t.Fatalf("skip published %q, want frozen working", got)
		}
	})
}

// TestMergeState pins the per-window aggregation: attention-first —
// waiting > working > idle > unknown. A pane blocked on the human must shine
// through even when a sibling pane in the same window is working (the old
// working-first order masked exactly the state that needed attention).
func TestMergeState(t *testing.T) {
	cases := []struct{ name, a, b, want string }{
		{"first pane seeds window", "", "idle", "idle"},
		{"first pane unknown seeds unknown", "", "unknown", "unknown"},
		{"working beats idle", "idle", "working", "working"},
		{"working not downgraded by later idle", "working", "idle", "working"},
		{"waiting beats idle", "idle", "waiting", "waiting"},
		{"waiting beats working (attention-first)", "working", "waiting", "waiting"},
		{"waiting not masked by later working", "waiting", "working", "waiting"},
		{"idle beats unknown", "unknown", "idle", "idle"},
		{"equal keeps first", "waiting", "waiting", "waiting"},
	}
	for _, c := range cases {
		if got := mergeState(c.a, c.b); got != c.want {
			t.Errorf("%s: mergeState(%q,%q) = %q, want %q", c.name, c.a, c.b, got, c.want)
		}
	}
}

// paneListSig must be stable across braille-spinner title rotation (else the
// poll would push a panes frame every tick for any working agent) yet drift
// when command or the title's words change (agent start/exit).
func TestPaneListSigSpinnerStability(t *testing.T) {
	base := []tmuxctl.Pane{{ID: "1.1", Window: 1, WindowName: "zsh", Command: "2.1.199", Title: "⠐ compiling the thing"}}
	spun := []tmuxctl.Pane{{ID: "1.1", Window: 1, WindowName: "zsh", Command: "2.1.199", Title: "⠴ compiling the thing"}}
	if paneListSig(base, 1) != paneListSig(spun, 1) {
		t.Fatal("spinner rotation must not change the pane list signature")
	}
	exited := []tmuxctl.Pane{{ID: "1.1", Window: 1, WindowName: "zsh", Command: "zsh", Title: "⠐ compiling the thing"}}
	if paneListSig(base, 1) == paneListSig(exited, 1) {
		t.Fatal("command change must change the pane list signature")
	}
	retitled := []tmuxctl.Pane{{ID: "1.1", Window: 1, WindowName: "zsh", Command: "2.1.199", Title: "✳ Claude Code"}}
	if paneListSig(base, 1) == paneListSig(retitled, 1) {
		t.Fatal("title word change must change the pane list signature")
	}
}

// TestPoke pins the wake helper. After the P1 refactor the pokeCh lives on the
// shared sessionPoller (not per-Conn); poke() fires from the reader goroutine
// after pushWindowsAndPanes, so it MUST be non-blocking: it delivers one wake on
// the buffered-1 pokeCh, and extra pokes while a wake is already pending coalesce
// into that single wake rather than blocking. The run() select consumes the wake
// to reset its interval to pollMin — an inline assignment inside the loop (needs
// live tmux to run), so this exercises the helper's channel contract, the real
// logic. Also covers Conn.poke forwarding to its poller.
func TestPoke(t *testing.T) {
	p := &sessionPoller{pokeCh: make(chan struct{}, 1)}

	p.poke()
	select {
	case <-p.pokeCh:
	default:
		t.Fatal("poke() did not deliver a wake")
	}

	// Two pokes while the buffer is full must not block and must coalesce
	// into exactly one pending wake.
	p.poke()
	p.poke()
	select {
	case <-p.pokeCh:
	default:
		t.Fatal("poke() left no pending wake")
	}
	select {
	case <-p.pokeCh:
		t.Fatal("poke() over-buffered: more than one pending wake")
	default:
	}

	// Conn.poke forwards to its poller; a conn with no poller is a safe no-op.
	c := &Conn{poller: p}
	c.poke()
	select {
	case <-p.pokeCh:
	default:
		t.Fatal("Conn.poke() did not forward to the session poller")
	}
	(&Conn{}).poke() // nil poller must not panic
}
