package ws

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// external.go — the Monitor's THIRD agent source, alongside the local pane scan
// and I6 peer federation: a global external-AI-agent registry under
// ${AI_AGENTS_DIR:-/tmp/ai-agents}, one JSON file per agent, written by the
// hook-observatory agent_registry handler on each CLI's hook events. It lets the
// deck surface agents that aren't tmux panes we scan (headless children, other
// CLIs) without walking their processes.

// aiAgentsDir is the external-agent registry directory. AI_AGENTS_DIR overrides
// the default so tests can point at a t.TempDir and deployments can relocate it,
// decoupling the reader from the hard-coded path.
func aiAgentsDir() string {
	if d := strings.TrimSpace(os.Getenv("AI_AGENTS_DIR")); d != "" {
		return d
	}
	return "/tmp/ai-agents"
}

// externalAgent is one registry file's record. Field tags mirror the writer
// (hook-observatory/internal/handlers/agent_registry.go): snake_case, distinct
// from AgentStatus's camelCase wire shape, so the two never share a struct.
type externalAgent struct {
	V         int    `json:"v"`
	CLI       string `json:"cli"`
	State     string `json:"state"`
	PID       int    `json:"pid"`
	TmuxPane  string `json:"tmux_pane"`
	SessionID string `json:"session_id"`
	Host      string `json:"host"`
	TS        int64  `json:"ts"`
}

// mapExternalState maps the registry's coarse state vocabulary onto the deck's
// working|waiting|idle|unknown lamp states. Anything unrecognized (or a stale
// file with a missing/garbage state) folds to unknown — never a spurious lamp.
func mapExternalState(state string) string {
	switch state {
	case "busy":
		return "working"
	case "blocked":
		return "waiting"
	case "idle":
		return "idle"
	default:
		return "unknown"
	}
}

// pidAliveSyscall reports whether pid is a live process, kill-0 semantics: a
// running process either accepts signal 0 (nil) or returns EPERM when we lack
// permission to signal it; ESRCH means it's gone. Injected onto the Monitor
// (m.pidAlive) so mergeExternal's liveness gate is unit-testable without
// spawning real processes.
func pidAliveSyscall(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// mergeExternal appends the external-agent registry onto the local agent list.
// Best-effort like mergePeers: a missing dir, an unreadable/garbage file, or a
// duplicate/dead entry is silently skipped — an external source can never stall
// or break the scan.
//
// Two built-in de-dups keep it from double-counting panes the scan already saw:
//   - an entry with a non-empty tmux_pane is skipped (the pane scan owns it —
//     the writer only records a TMUX_PANE for panes we're already walking);
//   - an entry whose pid is no longer alive is skipped (kill-0 liveness).
//
// A dead entry is only SKIPPED, never deleted: reaping stale files belongs to
// the registry side (the writer's SessionEnd delete + the ai-agents-count.sh
// GC). A second GC here would race that one on the same dir (double-remove /
// ENOENT thrash), so the reader stays strictly read-only.
//
// regPIDs (when non-nil) collects every parsed record's pid — BEFORE the
// tmux_pane / liveness skips, so a pane-attached or just-died registered agent
// still suppresses a double-count by the presence overlay (presence.go), which
// excludes any hook-tracked pid.
func (m *Monitor) mergeExternal(local []AgentStatus, regPIDs map[int]bool) []AgentStatus {
	files, err := filepath.Glob(filepath.Join(aiAgentsDir(), "*.json"))
	if err != nil || len(files) == 0 {
		return local // bad pattern / empty dir / no dir → nothing to add
	}
	merged := local
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue // unreadable (vanished mid-scan, is a dir, perms) → skip
		}
		var ext externalAgent
		if err := json.Unmarshal(raw, &ext); err != nil {
			continue // garbage / partial JSON → skip
		}
		if regPIDs != nil && ext.PID > 0 {
			regPIDs[ext.PID] = true // hook-tracked pid → presence overlay excludes it
		}
		if strings.TrimSpace(ext.TmuxPane) != "" {
			continue // pane scan already covers this one (dedup)
		}
		if !m.pidAlive(ext.PID) {
			continue // process gone → skip (file GC is the writer's job, not ours)
		}
		name := strings.TrimSuffix(filepath.Base(path), ".json")
		merged = append(merged, AgentStatus{
			Host:       m.host,
			Session:    "ext",
			Window:     0,
			WindowName: ext.CLI,
			Pane:       0,
			PaneID:     "ext/" + name,
			Tool:       ext.CLI,
			State:      mapExternalState(ext.State),
			SinceUnix:  ext.TS,
		})
	}
	return merged
}
