//go:build live

package ws

// Live ground-truth harness (opt-in): classifies every pane on the REAL tmux
// server with the production pipeline (capture -e → stripAnsi → classifyPane
// with #{pane_title}) and prints one line per pane, so the output can be
// diffed against libs/agent-state's `python3 -m agent_state scan` — the
// validated reference implementation this classifier was ported from.
//
//	go test ./internal/ws/ -tags live -run TestLiveClassify -v
//
// Read-only: list-panes / capture-pane / display-message only, sends nothing.

import (
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

func tmuxOut(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("tmux", args...).Output()
	if err != nil {
		t.Skipf("tmux unavailable: %v", err)
	}
	return string(out)
}

func TestLiveClassify(t *testing.T) {
	list := tmuxOut(t, "list-panes", "-a", "-F",
		"#{pane_id}\t#{window_index}\t#{pane_current_command}\t#{pane_title}")
	for _, line := range strings.Split(strings.TrimSpace(list), "\n") {
		f := strings.SplitN(line, "\t", 4)
		if len(f) < 4 {
			continue
		}
		id, win, cmd, title := f[0], f[1], f[2], f[3]
		capture := tmuxOut(t, "capture-pane", "-p", "-e", "-S", "-30", "-t", id)
		agent := isAgentCommand(cmd)
		st, rule := "unknown", ""
		if agent {
			det := classifyPane(stripAnsi(capture), title, cmd)
			if det.rule == "" {
				det.state = "idle"
				det.rule = "default_idle"
			}
			st, rule = det.state, det.rule
		}
		fmt.Printf("LIVE %s win=%s cmd=%-8s agent=%-5v state=%-8s rule=%-20s title=%.40q\n",
			id, win, cmd, agent, st, rule, title)
	}
}
