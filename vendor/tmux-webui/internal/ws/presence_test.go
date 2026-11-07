package ws

import (
	"context"
	"reflect"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
)

// TestParsePresenceLine covers the `ps -axo pid=,tt=,args=` row splitter: the
// right-padded pid column, the tt token ("??" when no controlling terminal),
// args with interior spacing preserved, and the header/blank/malformed rows that
// must yield ok=false.
func TestParsePresenceLine(t *testing.T) {
	cases := []struct {
		name     string
		line     string
		wantPID  int
		wantTT   string
		wantArgs string
		wantOK   bool
	}{
		{"padded pid + tty", "  888  s000 claude --resume", 888, "s000", "claude --resume", true},
		{"no tty marker", "  501   ??  python /x/run_agent.py --port 9000", 501, "??", "python /x/run_agent.py --port 9000", true},
		{"args keep interior spaces", "12 s001 grep  claude   foo.log", 12, "s001", "grep  claude   foo.log", true},
		{"blank line", "   ", 0, "", "", false},
		{"empty line", "", 0, "", "", false},
		{"no leading pid (header)", "PID  TT  ARGS", 0, "", "", false},
		{"pid but no args column", "  42  s000", 0, "", "", false},
		{"pid zero rejected", "0 ?? launchd", 0, "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pid, tt, args, ok := parsePresenceLine(c.line)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v (pid=%d tt=%q args=%q)", ok, c.wantOK, pid, tt, args)
			}
			if !ok {
				return
			}
			if pid != c.wantPID || tt != c.wantTT || args != c.wantArgs {
				t.Fatalf("got (%d, %q, %q), want (%d, %q, %q)", pid, tt, args, c.wantPID, c.wantTT, c.wantArgs)
			}
		})
	}
}

// TestMatchPresenceCLI is the feature-table gate. It nails the two false-positive
// vectors the design must never trip: a bare short name ("pi") and a CLI name
// that appears only as a grep ARGUMENT (argv[0]=grep). It also covers every
// exact-basename entry and every full-path signal.
func TestMatchPresenceCLI(t *testing.T) {
	cases := []struct {
		name    string
		args    string
		wantCLI string
		wantOK  bool
	}{
		// argv[0]-basename exact matches (absolute path + bare name).
		{"claude app path", "/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg", "claude", true},
		{"codex bare", "codex", "codex", true},
		{"agy bare", "/opt/homebrew/bin/agy chat", "agy", true},
		{"antigravity bare", "antigravity --serve", "antigravity", true},
		{"opencode path", "/usr/local/bin/opencode run", "opencode", true},
		{"hermes bare", "hermes", "hermes", true},
		{"kimi bare", "/Users/x/.bun/bin/kimi", "kimi", true},
		{"qwen bare", "qwen chat", "qwen", true},
		{"copilot bare", "copilot --stdio", "copilot", true},
		// full-path signals (interpreter / versioned argv[0]).
		{"codex versioned binary", "/Users/x/.codex/bin/codex-aarch64-apple-darwin --model o1", "codex", true},
		{"pi via node interpreter", "node /Users/x/pi-coding-agent/dist/cli.js --port 8080", "pi", true},
		{"kimi via full path", "/Users/x/kimi-code/bin/kimi serve", "kimi", true},
		{"hermes via python", "python3 /Users/x/hermes/run_agent.py --daemon", "hermes", true},
		// false positives that MUST NOT match.
		{"bare pi rejected", "pi --serve", "", false},
		{"pi-something else rejected", "pip install foo", "", false},
		{"grep claude (argv0=grep)", "grep claude /var/log/app.log", "", false},
		{"grep codex", "grep -r codex src/", "", false},
		// infrastructure daemons that would otherwise pin phantom cards
		// (real argv observed 2026-07-07).
		{"infra: claude bg-pty-host", "/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon", "", false},
		{"infra: claude daemon run", "/Users/x/.local/bin/claude daemon run --json-path /Users/x/.claude/daemon.json --log x", "", false},
		{"infra: codex app-server", "/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled", "", false},
		{"grep hermes", "grep hermes", "", false},
		{"tail a claude log", "tail -f claude.log", "", false},
		{"shell exporting CODEX env", "/bin/zsh -c export CODEX_COMPANION_SESSION_ID=abc && claude", "", false},
		{"plain shell", "-zsh", "", false},
		{"empty args", "", "", false},
		{"the ps probe itself", "ps -axo pid=,tt=,args=", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cli, ok := matchPresenceCLI(c.args)
			if ok != c.wantOK || cli != c.wantCLI {
				t.Fatalf("matchPresenceCLI(%q) = (%q, %v), want (%q, %v)", c.args, cli, ok, c.wantCLI, c.wantOK)
			}
		})
	}
}

// TestNormalizeTTY: ps's abbreviated tt ("s000") and tmux's pane_tty
// ("/dev/ttys000") must fold to the same key so the exclusion set compares
// equal; the no-tty marker ("??") folds to itself (never a real pane tty).
func TestNormalizeTTY(t *testing.T) {
	if a, b := normalizeTTY("s000"), normalizeTTY("/dev/ttys000"); a != b {
		t.Fatalf("normalizeTTY mismatch: ps %q vs pane %q", a, b)
	}
	if got := normalizeTTY("/dev/ttys000"); got != "s000" {
		t.Fatalf("normalizeTTY(/dev/ttys000) = %q, want s000", got)
	}
	if got := normalizeTTY("??"); got != "??" {
		t.Fatalf("normalizeTTY(??) = %q, want ??", got)
	}
	// The exclusion set drops the empty / no-tty markers so a headless process is
	// never wrongly excluded.
	set := normalizeTTYSet([]string{"/dev/ttys000", "/dev/ttys008", "??", "  "})
	if !set["s000"] || !set["s008"] {
		t.Fatalf("normalizeTTYSet missing real ttys: %v", set)
	}
	if set["??"] || set[""] {
		t.Fatalf("normalizeTTYSet must not carry ??/empty markers: %v", set)
	}
}

// presenceFixturePS is a realistic ps table (right-padded pid, tt, args) spanning
// every branch: two headless CLIs to include (hermes via python, codex via a
// versioned binary), one pane-owned claude (tty s000), one hook-tracked codex
// (pid in regPIDs), and three non-matches (grep claude / bare pi / plain shell).
const presenceFixturePS = `  501   ??  python3 /Users/x/hermes/run_agent.py --daemon
  777   ??  /Users/x/.codex/bin/codex-aarch64-apple-darwin --model o1
  888  s000 claude --resume
  999   ??  codex
 1234  s001 grep claude /var/log/app.log
 1500   ??  pi --serve
 1600  s002 -zsh`

// newPresenceMonitor builds a Monitor with injected ps + pane-tty sources so
// mergePresence is exercised without spawning ps or touching tmux.
func newPresenceMonitor(psOut string, psOK bool, paneTTYs map[string]bool) *Monitor {
	m := NewMonitor(config.NotifyConfig{}, nil)
	m.psScan = func() (string, bool) { return psOut, psOK }
	m.paneTTYs = func(context.Context) map[string]bool { return paneTTYs }
	return m
}

// TestMergePresence is the overlay's hard gate: it maps a matched headless CLI to
// a full AgentStatus, excludes a pane-owned process by tty (s000 vs /dev/ttys000
// normalization), excludes a hook-tracked process by pid, and drops every
// non-match — all appended AFTER the local list, never mutating it.
func TestMergePresence(t *testing.T) {
	local := []AgentStatus{{Host: "local", Session: "projX", PaneID: "1.0", State: "working"}}
	paneTTYs := normalizeTTYSet([]string{"/dev/ttys000"}) // owns pid 888 (claude)
	regPIDs := map[int]bool{999: true}                    // hook already tracks pid 999 (codex)

	m := newPresenceMonitor(presenceFixturePS, true, paneTTYs)
	merged := m.mergePresence(context.Background(), local, regPIDs, 1700000000)

	// local (1) + hermes-501 + codex-777 = 3. pane-owned / hook-tracked / grep /
	// bare-pi / shell contribute nothing.
	if len(merged) != 3 {
		t.Fatalf("merged has %d agents, want 3: %+v", len(merged), merged)
	}
	if merged[0].Host != "local" || merged[0].PaneID != "1.0" {
		t.Fatalf("local agent altered / reordered: %+v", merged[0])
	}
	// Full field mapping of the two surviving presence agents (order = ps order).
	wantHermes := AgentStatus{
		Host: "local", Session: "ext", Window: 0, WindowName: "hermes", Pane: 0,
		PaneID: "ps/hermes-501", Tool: "hermes", State: "unknown", SinceUnix: 1700000000,
	}
	wantCodex := AgentStatus{
		Host: "local", Session: "ext", Window: 0, WindowName: "codex", Pane: 0,
		PaneID: "ps/codex-777", Tool: "codex", State: "unknown", SinceUnix: 1700000000,
	}
	if !reflect.DeepEqual(merged[1], wantHermes) {
		t.Fatalf("presence agent 1 = %+v, want %+v", merged[1], wantHermes)
	}
	if !reflect.DeepEqual(merged[2], wantCodex) {
		t.Fatalf("presence agent 2 = %+v, want %+v", merged[2], wantCodex)
	}
	// Input slice must not be mutated.
	if len(local) != 1 || local[0].PaneID != "1.0" {
		t.Fatalf("input local slice mutated: %+v", local)
	}
}

// TestMergePresencePSFailure: a ps failure adds nothing AND leaves presenceSeen
// untouched, so a transient failure can never reset a live agent's first-seen.
func TestMergePresencePSFailure(t *testing.T) {
	m := newPresenceMonitor("", false, nil)
	m.presenceSeen[42] = 100 // a previously-seen agent
	local := []AgentStatus{{Host: "local", Session: "s", PaneID: "0.0", State: "idle"}}

	got := m.mergePresence(context.Background(), local, map[int]bool{}, 5000)
	if !reflect.DeepEqual(got, local) {
		t.Fatalf("ps failure must return local unchanged, got %+v", got)
	}
	if m.presenceSeen[42] != 100 {
		t.Fatalf("ps failure must not touch presenceSeen, got %v", m.presenceSeen)
	}
}

// TestMergePresenceFirstSeen drives the pid→first-seen lifecycle across ticks:
// first-seen is stamped once and PRESERVED while the pid stays in ps; when the
// pid leaves ps its map entry is reaped; a reappearance gets a FRESH first-seen.
func TestMergePresenceFirstSeen(t *testing.T) {
	const bothPS = `  501   ??  python3 /x/hermes/run_agent.py
  777   ??  codex`
	const onlyCodexPS = `  777   ??  codex`

	m := newPresenceMonitor(bothPS, true, nil)
	ctx := context.Background()
	noReg := map[int]bool{}

	// Tick 1 (now=1000): both first seen at 1000.
	m.psScan = func() (string, bool) { return bothPS, true }
	got := m.mergePresence(ctx, nil, noReg, 1000)
	if len(got) != 2 || got[0].SinceUnix != 1000 || got[1].SinceUnix != 1000 {
		t.Fatalf("tick1: want both SinceUnix=1000, got %+v", got)
	}

	// Tick 2 (now=2000): same pids → first-seen PRESERVED at 1000.
	got = m.mergePresence(ctx, nil, noReg, 2000)
	if len(got) != 2 || got[0].SinceUnix != 1000 || got[1].SinceUnix != 1000 {
		t.Fatalf("tick2: first-seen must be preserved at 1000, got %+v", got)
	}

	// Tick 3 (now=3000): hermes (501) gone → dropped, and its map entry reaped.
	m.psScan = func() (string, bool) { return onlyCodexPS, true }
	got = m.mergePresence(ctx, nil, noReg, 3000)
	if len(got) != 1 || got[0].PaneID != "ps/codex-777" || got[0].SinceUnix != 1000 {
		t.Fatalf("tick3: want only codex-777 SinceUnix=1000, got %+v", got)
	}
	if _, ok := m.presenceSeen[501]; ok {
		t.Fatalf("tick3: vanished pid 501 must be reaped from presenceSeen: %v", m.presenceSeen)
	}

	// Tick 4 (now=4000): hermes reappears → FRESH first-seen at 4000; codex kept.
	m.psScan = func() (string, bool) { return bothPS, true }
	got = m.mergePresence(ctx, nil, noReg, 4000)
	if len(got) != 2 {
		t.Fatalf("tick4: want 2 agents, got %+v", got)
	}
	var hermes, codex AgentStatus
	for _, a := range got {
		switch a.PaneID {
		case "ps/hermes-501":
			hermes = a
		case "ps/codex-777":
			codex = a
		}
	}
	if hermes.SinceUnix != 4000 {
		t.Fatalf("tick4: reappeared hermes must get fresh SinceUnix=4000, got %d", hermes.SinceUnix)
	}
	if codex.SinceUnix != 1000 {
		t.Fatalf("tick4: continuously-present codex must keep SinceUnix=1000, got %d", codex.SinceUnix)
	}
}
