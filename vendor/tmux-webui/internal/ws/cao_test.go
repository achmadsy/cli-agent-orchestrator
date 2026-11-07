package ws

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

func TestCAOKeyNormalization(t *testing.T) {
	for _, tt := range []struct {
		key  string
		mods []string
		want string
	}{
		{"p", []string{"C"}, "C-p"}, {"p", []string{"Shift"}, "P"},
		{"P", []string{"C", "Shift"}, "C-P"}, {"Tab", []string{"Shift"}, "BTab"},
		{"[", []string{"C"}, "C-["}, {"p", []string{"M"}, "M-p"},
		{"F2", []string{"Shift"}, "S-F2"}, {"1", []string{"Shift"}, "!"},
		{"Up", nil, "Up"}, {"Down", nil, "Down"},
	} {
		got, ok := caoKeySpec(tt.key, tt.mods)
		if !ok || got != tt.want {
			t.Fatalf("%q %v: %q %v", tt.key, tt.mods, got, ok)
		}
	}
	for _, key := range []string{"F99", "-t", "kill-pane", "x;kill-server", "\\n", "\\x7f"} {
		if _, ok := caoKeySpec(key, nil); ok {
			t.Fatalf("accepted %q", key)
		}
	}
	if _, ok := caoKeySpec("p", []string{"Super"}); ok {
		t.Fatal("unknown modifier")
	}
}

func TestCAOResizeBounds(t *testing.T) {
	for _, tt := range [][2]int{{10, 40}, {500, 40}, {100, 3}, {100, 300}} {
		if err := caoResize(context.Background(), nil, CAOTarget{}, tt[0], tt[1]); err == nil {
			t.Fatalf("accepted out-of-range resize %v", tt)
		}
	}
}

// Opt-in private-socket test: an explicit viewer resize changes ONLY the
// terminal's own window; the personal session keeps its size.
func TestCAOResizeOwnWindowOnly(t *testing.T) {
	if os.Getenv("CAO_TMUX_INTEGRATION") != "1" {
		t.Skip("set CAO_TMUX_INTEGRATION=1 for private-socket tmux test")
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}
	socket := filepath.Join(t.TempDir(), "tmux.sock")
	run := func(args ...string) string {
		all := append([]string{"-S", socket}, args...)
		out, err := exec.Command("tmux", all...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %s", args, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("-f", "/dev/null", "new-session", "-d", "-s", "cao-test", "-n", "agent", "-x", "100", "-y", "30")
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	run("set-option", "-w", "-t", "=cao-test:agent", "@cao_terminal_id", "abc123")
	run("new-session", "-d", "-s", "personal", "-x", "80", "-y", "24")
	win := run("display-message", "-t", "=cao-test:agent", "-p", "#{window_id}")
	tx := tmuxctl.New(tmuxctl.WithSocket(socket))
	target := CAOTarget{Session: "cao-test", Terminal: "abc123", WindowID: win,
		PaneID: run("display-message", "-t", "=cao-test:agent", "-p", "#{pane_id}"),
		Mode:   "window", Socket: socket}
	if err := caoResize(context.Background(), tx, target, 200, 60); err != nil {
		t.Fatal(err)
	}
	if w := run("display-message", "-t", "=cao-test:agent", "-p", "#{window_width}"); w != "200" {
		t.Fatalf("own window width = %s", w)
	}
	if h := run("display-message", "-t", "=cao-test:agent", "-p", "#{window_height}"); h != "60" {
		t.Fatalf("own window height = %s", h)
	}
	if w := run("display-message", "-t", "=personal:0", "-p", "#{window_width}"); w != "80" {
		t.Fatalf("personal window resized: %s", w)
	}
}

func TestCAORejectsInvalidTarget(t *testing.T) {
	for _, q := range []string{"session=personal", "session=cao-test&terminal=abc&window_id=%401&pane_id=%252&mode=all"} {
		_, err := CAOTargetFromRequest(httptest.NewRequest("GET", "/ws?"+q, nil))
		if err == nil {
			t.Fatal("invalid target accepted")
		}
	}
}

// This test is opt-in and uses a private socket. It never touches the user's
// default tmux server; cleanup kills only that exact private test socket.
func TestCAOIsolatedOwnership(t *testing.T) {
	if os.Getenv("CAO_TMUX_INTEGRATION") != "1" {
		t.Skip("set CAO_TMUX_INTEGRATION=1 for private-socket tmux test")
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}
	socket := filepath.Join(t.TempDir(), "tmux.sock")
	run := func(args ...string) string {
		all := append([]string{"-S", socket}, args...)
		out, err := exec.Command("tmux", all...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %s", args, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("-f", "/dev/null", "new-session", "-d", "-s", "cao-test", "-n", "agent")
	defer exec.Command("tmux", "-S", socket, "kill-server").Run()
	anchor := run("display-message", "-t", "=cao-test:agent", "-p", "#{pane_id}")
	win := run("display-message", "-t", anchor, "-p", "#{window_id}")
	run("set-option", "-w", "-t", win, "@cao_terminal_id", "abc123")
	run("new-session", "-d", "-s", "personal")
	sibling := run("split-window", "-d", "-t", anchor, "-P", "-F", "#{pane_id}")
	run("set-option", "-p", "-t", sibling, "@cao_terminal_id", "other456")
	tx := tmuxctl.New(tmuxctl.WithSocket(socket))
	target := CAOTarget{Session: "cao-test", Terminal: "abc123", WindowID: win, PaneID: anchor, Mode: "window", Socket: socket}
	panes, err := caoPanes(context.Background(), tx, target)
	if err != nil {
		t.Fatal(err)
	}
	if len(panes) != 1 || panes[0].ID != anchor {
		t.Fatalf("sibling leaked: %#v", panes)
	}
	target.Terminal = "other456"
	target.Mode = "pane"
	target.PaneID = sibling
	panes, err = caoPanes(context.Background(), tx, target)
	if err != nil || len(panes) != 1 || panes[0].ID != sibling {
		t.Fatalf("pane ownership: %v %#v", err, panes)
	}
	target.Terminal = "abc123"
	if _, err = caoPanes(context.Background(), tx, target); err == nil {
		t.Fatal("foreign owner authorized")
	}
	run("has-session", "-t", "=personal")
}
