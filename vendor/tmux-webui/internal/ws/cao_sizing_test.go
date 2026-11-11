package ws

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

func TestCAOSizingClaims(t *testing.T) {
	s := &caoSizing{}
	target := CAOTarget{Socket: "one", WindowID: "@1"}
	a, b := &caoSizingOwner{}, &caoSizingOwner{}
	now := time.Now()
	count := 0
	valid := func() string { return "" }
	resize := func() error { count++; return nil }
	if s.apply(target, a, false, now, valid, resize) != "owned" {
		t.Fatal("initial claim")
	}
	if s.apply(target, b, false, now, valid, resize) != "other_viewer" || count != 1 {
		t.Fatal("competing viewer resized")
	}
	if s.apply(target, b, true, now, valid, resize) != "owned" {
		t.Fatal("explicit takeover failed")
	}
	s.release(target, a) // stale connection may not release new owner's claim
	if s.apply(target, a, false, now, valid, resize) != "other_viewer" {
		t.Fatal("stale release")
	}
	if s.apply(target, a, false, now.Add(caoSizingTTL+time.Second), valid, resize) != "owned" {
		t.Fatal("expired claim")
	}
	if s.apply(target, a, false, now, func() string { return "shared_window" }, resize) != "shared_window" {
		t.Fatal("invalid topology accepted")
	}
	if s.apply(target, b, false, now, valid, resize) != "owned" {
		t.Fatal("invalid owner retained claim")
	}
	other := target
	other.Socket = "two"
	if s.apply(other, a, false, now, valid, resize) != "owned" {
		t.Fatal("cross socket collision")
	}
}

func TestCAOSizingSerializesCompetingOperations(t *testing.T) {
	s := &caoSizing{}
	target := CAOTarget{Socket: "one", WindowID: "@1"}
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.apply(target, &caoSizingOwner{}, false, time.Now(), func() string { return "" }, func() error { calls.Add(1); return nil })
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("competing resizes accepted: %d", calls.Load())
	}
}

func TestCAOSizingChecksRealTopologyAndIdentity(t *testing.T) {
	if os.Getenv("CAO_TMUX_INTEGRATION") != "1" {
		t.Skip("private tmux integration opt-in")
	}
	socket := filepath.Join(t.TempDir(), "tmux.sock")
	run := func(args ...string) string {
		out, err := exec.Command("tmux", append([]string{"-S", socket}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %s", args, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("-f", "/dev/null", "new-session", "-d", "-s", "cao-sizing", "-x", "100", "-y", "30")
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	pane := run("display-message", "-t", "=cao-sizing:0", "-p", "#{pane_id}")
	win := run("display-message", "-t", pane, "-p", "#{window_id}")
	run("set-option", "-w", "-t", win, "@cao_terminal_id", "abc123")
	run("new-session", "-d", "-s", "personal", "-x", "80", "-y", "24")
	target := CAOTarget{Session: "cao-sizing", Terminal: "abc123", WindowID: win, PaneID: pane, Socket: socket, Mode: "window"}
	tx := tmuxctl.New(tmuxctl.WithSocket(socket))
	ctx := context.Background()
	validate := func() string {
		if _, err := caoPanes(ctx, tx, target); err != nil {
			return "target_changed"
		}
		if !caoSinglePane(ctx, tx, target) {
			return "shared_window"
		}
		return ""
	}
	s := &caoSizing{}
	owner := &caoSizingOwner{}
	run("select-pane", "-t", pane, "-T", "") // trailing empty title is a valid field
	if got := s.apply(target, owner, false, time.Now(), validate, func() error { return caoResize(ctx, tx, target, 180, 50) }); got != "owned" {
		t.Fatal(got)
	}
	sibling := run("split-window", "-d", "-t", pane, "-P", "-F", "#{pane_id}")
	run("set-option", "-p", "-t", sibling, "@cao_terminal_id", "foreign")
	// Tabs in program-controlled pane titles must not corrupt topology parsing.
	run("select-pane", "-t", pane, "-T", "title\twith tab")
	panes, err := caoPanes(ctx, tx, target)
	if err != nil || len(panes) != 1 || panes[0].WindowPanes != 2 {
		t.Fatalf("real topology hidden: %+v %v", panes, err)
	}
	called := false
	resize := func() error { called = true; return caoResize(ctx, tx, target, 300, 100) }
	if got := s.apply(target, owner, false, time.Now(), validate, resize); got != "shared_window" || called {
		t.Fatal("shared automatic fit accepted", got)
	}
	run("set-option", "-w", "-t", win, "@cao_terminal_id", "replacement")
	if got := s.apply(target, owner, false, time.Now(), validate, resize); got != "target_changed" || called {
		t.Fatal("replacement resized", got)
	}
	if run("display-message", "-t", "=personal:0", "-p", "#{window_width}x#{window_height}") != "80x24" {
		t.Fatal("personal window changed")
	}
}
