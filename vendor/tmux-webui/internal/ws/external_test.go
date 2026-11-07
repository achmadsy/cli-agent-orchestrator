package ws

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
)

// TestMapExternalState is the pure state-mapping gate: the registry's coarse
// vocabulary folds onto the deck's lamp states, and anything unknown/garbage
// folds to "unknown" (never a spurious working/waiting/idle).
func TestMapExternalState(t *testing.T) {
	cases := []struct{ in, want string }{
		{"busy", "working"},
		{"blocked", "waiting"},
		{"idle", "idle"},
		{"unknown", "unknown"},
		{"", "unknown"},
		{"BUSY", "unknown"}, // case-sensitive by design (writer emits lowercase)
		{"garbage", "unknown"},
	}
	for _, c := range cases {
		if got := mapExternalState(c.in); got != c.want {
			t.Fatalf("mapExternalState(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// writeRegistryFile drops one raw JSON body at <dir>/<name>.json (name without
// the extension), so a test can seed both well-formed and garbage records.
func writeRegistryFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name+".json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write fixture %s: %v", name, err)
	}
}

// TestMergeExternal is the reader's hard gate. With AI_AGENTS_DIR pointed at a
// temp dir and an injected pid-liveness stub, it exercises: a normal record's
// full field mapping, the tmux_pane-non-empty dedup skip, the dead-pid skip, and
// the garbage-JSON skip — all best-effort, never dropping the local agents.
func TestMergeExternal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AI_AGENTS_DIR", dir)

	const alivePID = 4242 // dead pid in the fixtures below is 999999999

	// Normal, live, no tmux_pane → maps to a full AgentStatus.
	writeRegistryFile(t, dir, "claude-abc12345",
		`{"v":1,"cli":"claude","state":"busy","pid":4242,"tmux_pane":"","session_id":"abc12345-x","host":"mini","ts":1700000000}`)
	// Has a tmux_pane → the pane scan already owns it → skipped.
	writeRegistryFile(t, dir, "codex-deadbeef",
		`{"v":1,"cli":"codex","state":"blocked","pid":4242,"tmux_pane":"%7","session_id":"deadbeef","host":"mini","ts":1700000001}`)
	// Dead pid → skipped.
	writeRegistryFile(t, dir, "agy-pid999",
		`{"v":1,"cli":"agy","state":"idle","pid":999999999,"tmux_pane":"","session_id":"","host":"mini","ts":1700000002}`)
	// Garbage JSON → skipped, never breaks the scan.
	writeRegistryFile(t, dir, "broken", `{not valid json`)
	// A non-.json sibling (e.g. the writer's in-flight ".tmp-*") must be ignored
	// by the *.json glob.
	if err := os.WriteFile(filepath.Join(dir, ".tmp-inflight"), []byte(`{"cli":"x"}`), 0o644); err != nil {
		t.Fatalf("write tmp sibling: %v", err)
	}

	local := []AgentStatus{{Host: "local", Session: "projX", PaneID: "1.0", State: "working"}}

	m := NewMonitor(config.NotifyConfig{}, nil)
	m.pidAlive = func(pid int) bool { return pid == alivePID } // deadPID → not alive

	regPIDs := map[int]bool{}
	merged := m.mergeExternal(local, regPIDs)

	// local (1) + one live, no-pane external → 2. dead/pane/garbage/tmp contribute nothing.
	if len(merged) != 2 {
		t.Fatalf("merged has %d agents, want 2: %+v", len(merged), merged)
	}
	// regPIDs collects EVERY parsed record's pid (before the tmux_pane/liveness
	// skips) so the presence overlay can exclude a hook-tracked process. The two
	// well-formed records (the alive one and the pane-attached one) both carry pid
	// 4242; the dead record carries 999999999; garbage/tmp contribute none.
	if !regPIDs[4242] || !regPIDs[999999999] {
		t.Fatalf("regPIDs must collect parsed pids (4242, 999999999), got %v", regPIDs)
	}
	// Local agent must be first and untouched (external is appended AFTER).
	if merged[0].Host != "local" || merged[0].Session != "projX" || merged[0].PaneID != "1.0" {
		t.Fatalf("local agent altered: %+v", merged[0])
	}
	// Full field mapping of the one surviving external record.
	ext := merged[1]
	want := AgentStatus{
		Host:       "local", // m.host default; a peer's tagPeerAgents re-stamps this
		Session:    "ext",
		Window:     0,
		WindowName: "claude",
		Pane:       0,
		PaneID:     "ext/claude-abc12345",
		Tool:       "claude",
		State:      "working",
		SinceUnix:  1700000000,
	}
	if !reflect.DeepEqual(ext, want) {
		t.Fatalf("external agent = %+v, want %+v", ext, want)
	}

	// Input slice must not be mutated by the merge.
	if len(local) != 1 || local[0].PaneID != "1.0" {
		t.Fatalf("input local slice mutated: %+v", local)
	}
}

// TestMergeExternalMissingDir: a non-existent AI_AGENTS_DIR (no registry at all)
// returns the local list unchanged — the common case on a host with no external
// agents must be a cheap no-op, never an error.
func TestMergeExternalMissingDir(t *testing.T) {
	t.Setenv("AI_AGENTS_DIR", filepath.Join(t.TempDir(), "does-not-exist"))
	local := []AgentStatus{{Host: "local", Session: "s", PaneID: "0.0", State: "idle"}}
	m := NewMonitor(config.NotifyConfig{}, nil)
	got := m.mergeExternal(local, map[int]bool{})
	if len(got) != 1 || got[0].PaneID != "0.0" {
		t.Fatalf("mergeExternal(missing dir) = %+v, want the local list unchanged", got)
	}
}

// TestAIAgentsDir: the override wins when set (trimmed), else the default path.
func TestAIAgentsDir(t *testing.T) {
	t.Setenv("AI_AGENTS_DIR", "  /custom/reg  ")
	if got := aiAgentsDir(); got != "/custom/reg" {
		t.Fatalf("aiAgentsDir() with override = %q, want /custom/reg", got)
	}
	t.Setenv("AI_AGENTS_DIR", "")
	if got := aiAgentsDir(); got != "/tmp/ai-agents" {
		t.Fatalf("aiAgentsDir() default = %q, want /tmp/ai-agents", got)
	}
}
