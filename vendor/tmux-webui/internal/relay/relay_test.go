// relay_test.go — unit tests for Check()'s path handling (traversal
// attempts) and Dispatch()'s argv construction. Never executes real
// pane_pool.sh/relay.sh scripts: argv tests assert the pure builder
// functions directly; Check tests only touch os.Stat on paths inside a
// t.TempDir(), no subprocess involved.
package relay

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestCheckPathHandling(t *testing.T) {
	signalDir := t.TempDir()
	outsideDir := t.TempDir()
	d := &Dispatcher{signalDir: signalDir}

	// A real, present signal file directly inside signalDir.
	present := filepath.Join(signalDir, "relay-webui-present.done")
	if err := os.WriteFile(present, []byte("done"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name       string
		signalFile string
		wantStatus string
		wantErr    bool
	}{
		{
			name:       "present file in signal dir reports completed",
			signalFile: present,
			wantStatus: "completed",
		},
		{
			name:       "absent file in signal dir reports running",
			signalFile: filepath.Join(signalDir, "relay-webui-absent.done"),
			wantStatus: "running",
		},
		{
			name:       "wrong prefix rejected",
			signalFile: filepath.Join(signalDir, "not-a-relay-file.done"),
			wantErr:    true,
		},
		{
			name:       "traversal via .. escapes signal dir",
			signalFile: filepath.Join(signalDir, "..", "relay-webui-escaped.done"),
			wantErr:    true,
		},
		{
			name:       "absolute path outside root rejected",
			signalFile: filepath.Join(outsideDir, "relay-webui-elsewhere.done"),
			wantErr:    true,
		},
		{
			name:       "nested subdirectory rejected (must be direct child)",
			signalFile: filepath.Join(signalDir, "sub", "relay-webui-nested.done"),
			wantErr:    true,
		},
		{
			name:       "bare relative filename resolves against cwd, not signal dir",
			signalFile: "relay-webui-relative.done",
			wantErr:    true,
		},
		{
			name:       "redundant separators still resolve inside signal dir",
			signalFile: signalDir + string(filepath.Separator) + "." + string(filepath.Separator) + "relay-webui-dotslash.done",
			wantStatus: "running",
		},
		{
			name:       "traversal-looking substring inside the filename itself is not real traversal",
			signalFile: filepath.Join(signalDir, "relay-webui-..-fake.done"),
			wantStatus: "running",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, err := d.Check(tc.signalFile)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Check(%q) = (%q, nil), want error", tc.signalFile, status)
				}
				return
			}
			if err != nil {
				t.Fatalf("Check(%q) unexpected error: %v", tc.signalFile, err)
			}
			if status != tc.wantStatus {
				t.Errorf("Check(%q) = %q, want %q", tc.signalFile, status, tc.wantStatus)
			}
		})
	}
}

func TestPaneAcquireArgv(t *testing.T) {
	got := paneAcquireArgv("/opt/tmux-relay/pane_pool.sh")
	want := []string{"bash", "/opt/tmux-relay/pane_pool.sh", "acquire", "1"}
	assertArgvEqual(t, got, want)
}

func TestRelayDispatchArgv(t *testing.T) {
	got := relayDispatchArgv("/opt/tmux-relay/relay.sh", "%3", "echo hi", "/tmp/relay-webui-1-2.done", 120)
	want := []string{
		"bash", "/opt/tmux-relay/relay.sh", "%3", "", "echo hi",
		"--no-forward", "--signal", "/tmp/relay-webui-1-2.done", "--timeout", "120",
	}
	assertArgvEqual(t, got, want)
}

func TestNormalizeTimeout(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{0, 600},
		{-5, 600},
		{1800, 1800},
		{1801, 600},
		{300, 300},
	}
	for _, tc := range cases {
		if got := normalizeTimeout(tc.in); got != tc.want {
			t.Errorf("normalizeTimeout(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func assertArgvEqual(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("argv length = %d, want %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("argv[%d] = %q, want %q\n%s", i, got[i], want[i], fmt.Sprintf("full got: %v", got))
		}
	}
}
