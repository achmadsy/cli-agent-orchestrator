package ws

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// presence.go — the Monitor's FOURTH agent source, a best-effort `ps` sweep that
// surfaces AI CLIs whose hook wiring is absent or broken (hermes above all).
// Where external.go reads the hook-written registry (rich state) and the pane
// scan classifies tmux panes (rich state), this layer is a pure MEMORY overlay:
// On/Off only (state "unknown"), never written to disk, never touching
// ${AI_AGENTS_DIR} — that file layer belongs to the hook event side and the two
// stay unmixed. It only fills the gap the other two miss: a process no tmux pane
// owns and no registry file tracks.
//
// Matching is deliberately conservative (see presenceExactCommands): a raw ps
// line carries no tmux/agent context to disambiguate, so a bare short name would
// false-fire on unrelated processes — the whole matcher is authored so that
// `grep claude` (argv[0]=grep) can never register as an agent.

// presenceExactCommands is the argv[0]-basename allowlist: a process matches only
// if the basename of its executable EXACTLY equals one of these. It is a narrow
// subset of agentstate.go's agentCommands: the short/ambiguous names that set
// carries for pane classification — "pi" especially, but also gemini/aider/
// cursor — are omitted here because presence has no context to keep them from
// false-firing on unrelated processes. A CLI those names would catch is already
// covered when it runs in a tmux pane (pane scan) or has a hook (registry).
var presenceExactCommands = map[string]bool{
	"claude":      true,
	"codex":       true,
	"agy":         true,
	"antigravity": true,
	"opencode":    true,
	"hermes":      true,
	"kimi":        true,
	"qwen":        true,
	"copilot":     true,
}

// presencePathSignals catch AI CLIs whose argv[0] is an interpreter (node/python)
// or a versioned/renamed binary, so the basename rule can't see them. Full-path
// fragments ONLY — never a bare short name, so a process merely mentioning a CLI
// name in an argument (`grep claude`, a shell exporting CODEX_*) is not matched.
var presencePathSignals = []struct{ needle, cli string }{
	{"codex-aarch64-", "codex"},
	{"pi-coding-agent/dist/cli.js", "pi"},
	{"kimi-code/bin/kimi", "kimi"},
	{"run_agent.py", "hermes"},
}

// presenceInfraFragments rejects an otherwise-matched process that is known
// infrastructure rather than a working agent — without this the overlay pins
// permanent phantom "unknown" cards for daemons that are always running
// (observed 2026-07-07: claude --bg-pty-host, claude daemon run, Codex.app's
// resident app-server). Fragments carry a leading space so they only match as
// an argument boundary, never inside a path segment.
var presenceInfraFragments = []string{
	" --bg-pty-host",  // claude --bg-pty-host: Claude Code background PTY host
	" daemon run",     // claude daemon run: Claude Code background service
	" app-server",     // codex app-server: Codex.app resident GUI server
}

// paneTTYLister is the presence overlay's extra tmux need — the set of pane
// ttys — kept as a local optional interface so the monitorReader interface (and
// its test fakes) stay untouched. The production *tmuxctl.Client satisfies it; a
// fake reader does not, which is exactly why presence stays inert under the
// snapshot unit tests (NewMonitor only wires the live scan when tx satisfies it).
type paneTTYLister interface {
	PaneTTYs(ctx context.Context) []string
}

// psScanExec is the production ps source: `ps -axo pid=,tt=,args=` on macOS (the
// `=` header-suppression form). Best-effort — a spawn/exec failure or timeout
// yields ("", false) so the overlay simply adds nothing.
func psScanExec() (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,tt=,args=").Output()
	if err != nil {
		return "", false
	}
	return string(out), true
}

// parsePresenceLine splits one `ps -axo pid=,tt=,args=` row into its pid, tt
// (controlling terminal, "??" when none) and the full args string. The pid
// column is right-padded, so leading spaces are trimmed first; args keeps its
// interior spacing. Returns ok=false for a header/blank/malformed row so the
// caller skips it.
func parsePresenceLine(line string) (pid int, tt, args string, ok bool) {
	line = strings.TrimLeft(line, " \t")
	if line == "" {
		return 0, "", "", false
	}
	// pid: the leading digit run.
	i := 0
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i == 0 {
		return 0, "", "", false // no leading pid (header / junk)
	}
	pid, err := strconv.Atoi(line[:i])
	if err != nil || pid <= 0 {
		return 0, "", "", false
	}
	rest := strings.TrimLeft(line[i:], " \t")
	// tt: the next whitespace-delimited token.
	j := strings.IndexAny(rest, " \t")
	if j < 0 {
		return 0, "", "", false // no args column
	}
	tt = rest[:j]
	args = strings.TrimLeft(rest[j:], " \t")
	if args == "" {
		return 0, "", "", false
	}
	return pid, tt, args, true
}

// matchPresenceCLI classifies a ps args string against the feature table, in two
// passes: (1) the basename of argv[0] EXACTLY equals a presenceExactCommands
// entry; (2) the args string CONTAINS a presencePathSignals fragment. Returns
// the canonical CLI name and ok=true on a hit, ("", false) otherwise. Basename
// exactness plus full-path-only signals is what keeps `grep claude` from ever
// matching.
func matchPresenceCLI(args string) (cli string, ok bool) {
	fields := strings.Fields(args)
	if len(fields) == 0 {
		return "", false
	}
	for _, frag := range presenceInfraFragments {
		if strings.Contains(args, frag) {
			return "", false
		}
	}
	if base := filepath.Base(fields[0]); presenceExactCommands[base] {
		return base, true
	}
	for _, sig := range presencePathSignals {
		if strings.Contains(args, sig.needle) {
			return sig.cli, true
		}
	}
	return "", false
}

// normalizeTTY folds a controlling-terminal string to a common key so ps's `tt`
// abbreviation ("s000") and tmux's pane_tty ("/dev/ttys000") compare equal. A
// no-tty marker ("??") folds to itself and never matches a real pane tty — which
// is what keeps headless processes (the overlay's whole point) from being
// excluded.
func normalizeTTY(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "/dev/")
	s = strings.TrimPrefix(s, "tty")
	return s
}

// normalizeTTYSet builds the exclusion set from tmux's raw pane_tty list,
// normalized and with the empty / no-tty markers dropped (they must never
// exclude a headless process).
func normalizeTTYSet(ttys []string) map[string]bool {
	out := make(map[string]bool, len(ttys))
	for _, t := range ttys {
		if n := normalizeTTY(t); n != "" && n != "??" {
			out[n] = true
		}
	}
	return out
}

// mergePresence appends the process-presence overlay onto the agent list. Like
// mergeExternal/mergePeers it is strictly best-effort: a ps failure adds nothing
// (and leaves presenceSeen untouched so a transient failure never resets a live
// agent's first-seen time). Each matched process is excluded when a tmux pane
// already owns it (tty match — the pane scan covers it) or the registry already
// tracks its pid (regPIDs — hook-managed), so the overlay only ever adds the
// agents the other three sources miss. now is injected (scan passes now.Unix())
// so first-seen assignment stays deterministic under test.
func (m *Monitor) mergePresence(ctx context.Context, local []AgentStatus, regPIDs map[int]bool, now int64) []AgentStatus {
	out, ok := m.psScan()
	if !ok {
		return local // ps unavailable this tick — add nothing, keep first-seen map
	}
	paneTTYs := m.paneTTYs(ctx)
	live := map[int]bool{}
	merged := local
	for _, line := range strings.Split(out, "\n") {
		pid, tt, args, lineOK := parsePresenceLine(line)
		if !lineOK {
			continue
		}
		cli, matched := matchPresenceCLI(args)
		if !matched {
			continue
		}
		if paneTTYs[normalizeTTY(tt)] {
			continue // a tmux pane already owns this process (pane scan covers it)
		}
		if regPIDs[pid] {
			continue // the registry/hook already tracks this pid
		}
		live[pid] = true
		first, seen := m.presenceSeen[pid]
		if !seen {
			first = now
			m.presenceSeen[pid] = now
		}
		merged = append(merged, AgentStatus{
			Host:       m.host,
			Session:    "ext",
			Window:     0,
			WindowName: cli,
			Pane:       0,
			PaneID:     "ps/" + cli + "-" + strconv.Itoa(pid),
			Tool:       cli,
			State:      "unknown",
			SinceUnix:  first,
		})
	}
	// Reap first-seen entries whose pid left the ps table (bounded, self-cleaning).
	// Only on a SUCCESSFUL read, so a transient ps failure can't reset live times.
	for pid := range m.presenceSeen {
		if !live[pid] {
			delete(m.presenceSeen, pid)
		}
	}
	return merged
}
