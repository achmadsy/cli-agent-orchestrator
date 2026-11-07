package tmuxctl

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestIsDeadTarget pins the pure classifier that decides whether a tmux capture
// error is a legitimately-gone target (→ empty+nil) or a transient flake to be
// propagated (B2). Only the "can't find pane/session/window" family is dead.
func TestIsDeadTarget(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil is not dead", nil, false},
		{"cant find pane", errors.New("tmux capture-pane: exit status 1 (stderr: can't find pane: 3)"), true},
		{"cant find session", errors.New("can't find session: nope"), true},
		{"cant find window", errors.New("can't find window: 9"), true},
		{"transient flake propagates", errors.New("tmux capture-pane: signal: killed"), false},
		{"server not running propagates", errors.New("error connecting to /tmp/tmux-501/default (No such file or directory)"), false},
	}
	for _, tc := range cases {
		if got := isDeadTarget(tc.err); got != tc.want {
			t.Errorf("%s: isDeadTarget(%v) = %v; want %v", tc.name, tc.err, got, tc.want)
		}
	}
}

// TestCapturePaneErrorPropagation drives the real CapturePane through a fake
// tmux binary: a dead target maps to empty+nil, a transient failure propagates
// the error (the never-miss-waiting invariant relies on callers seeing it), and
// success returns the output.
func TestCapturePaneErrorPropagation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake-binary test uses a POSIX shell script")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "faketmux")
	script := `#!/bin/sh
case "$*" in
  *dead*)  echo "can't find pane: dead" >&2; exit 1 ;;
  *flake*) echo "connection reset" >&2; exit 1 ;;
  *)       printf 'hello\n' ;;
esac
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	c := New(WithBinary(fake))
	ctx := context.Background()

	if out, err := c.CapturePane(ctx, "s:dead", 0); err != nil || out != "" {
		t.Errorf("dead target = (%q,%v); want (\"\",nil)", out, err)
	}
	if _, err := c.CapturePane(ctx, "s:flake", 0); err == nil {
		t.Error("transient flake must propagate an error, got nil")
	}
	if out, err := c.CapturePane(ctx, "s:ok", 0); err != nil || out != "hello\n" {
		t.Errorf("healthy capture = (%q,%v); want (\"hello\\n\",nil)", out, err)
	}
}
