package tmuxctl

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// TestSendTextBoundarySelectsPath pins SendTextWithBuf's 512-char split
// decision: text AT the limit still goes through send-keys -l, text ONE byte
// over switches to the load-buffer + paste-buffer path. Drives the real
// method through a fake tmux binary (mirrors capture_test.go's
// TestCapturePaneErrorPropagation) that logs which subcommand it was invoked
// with, so the assertion is on tmux-webui's own branch selection, not on tmux
// itself.
func TestSendTextBoundarySelectsPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake-binary test uses a POSIX shell script")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "faketmux")
	logPath := filepath.Join(dir, "calls.log")
	script := `#!/bin/sh
echo "$1" >> "` + logPath + `"
case "$1" in
  load-buffer) cat >/dev/null ;;
esac
exit 0
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	c := New(WithBinary(fake))
	ctx := context.Background()

	cases := []struct {
		name      string
		n         int
		wantCalls []string
	}{
		{"exactly at the 512 limit uses send-keys", sendKeysLimit, []string{"send-keys"}},
		{"one over the limit uses load-buffer+paste-buffer", sendKeysLimit + 1, []string{"load-buffer", "paste-buffer"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_ = os.Remove(logPath)
			text := strings.Repeat("a", tc.n)
			if err := c.SendTextWithBuf(ctx, "s:0.0", text, "_test_buf"); err != nil {
				t.Fatalf("SendTextWithBuf(len=%d): %v", tc.n, err)
			}
			raw, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatalf("reading call log: %v", err)
			}
			got := strings.Fields(string(raw))
			if !reflect.DeepEqual(got, tc.wantCalls) {
				t.Errorf("tmux calls = %v; want %v", got, tc.wantCalls)
			}
		})
	}
}
