package ws

// reader_dispatch_test.go pins reader.go's dispatch() routing table: every
// inbound type the switch declares must be recognized (never fall through to
// the "unknown message type" default), and an unrecognized type must be
// reported via a client-visible error frame rather than surfacing as a Go
// error. Side-effecting handlers run against a fake tmux binary (mirrors
// tmuxctl's TestCapturePaneErrorPropagation) so this never touches a live
// tmux server or session.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/metrics"
	"github.com/operonlab/tmux-webui/internal/prefix"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// newDispatchTestConn builds a Conn wired to a fake tmux binary: enough
// canned output for list-windows / list-panes / show-prefix that every
// handler in the dispatch switch completes without error, everything else is
// a silent success (exit 0). No real tmux process or session involved.
func newDispatchTestConn(t *testing.T) *Conn {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake-binary test uses a POSIX shell script")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "faketmux")
	script := `#!/bin/sh
case "$1" in
  list-windows) printf '0\tzsh\t1\t1\n' ;;
  list-panes)   printf '0\tzsh\t0\t1\t80\t24\tzsh\t\n' ;;
  show)         printf 'C-b\n' ;;
esac
exit 0
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	tx := tmuxctl.New(tmuxctl.WithBinary(fake))
	h := &Hub{
		cfg:  &config.Config{MetricsInterval: 5, CaptureLines: 150},
		tx:   tx,
		pc:   prefix.New(tx),
		prov: metrics.NewStub(),
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &Conn{
		hub:        h,
		session:    "zzFeatDispatchTest",
		ctx:        ctx,
		cancel:     cancel,
		outChan:    make(chan envelope, outChanSize),
		fitWindows: make(map[int]bool),
	}
}

// drainOutbound non-blockingly collects the "type" field of every frame
// currently queued on c.outChan.
func drainOutbound(c *Conn) []string {
	var types []string
	for {
		select {
		case env := <-c.outChan:
			var probe struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(env, &probe)
			types = append(types, probe.Type)
		default:
			return types
		}
	}
}

func containsType(types []string, want string) bool {
	for _, ty := range types {
		if ty == want {
			return true
		}
	}
	return false
}

// TestDispatchKnownTypesRecognized drives dispatch() with every inbound type
// declared in reader.go's switch and asserts none of them fall through to the
// "unknown message type" default branch. fitMode defaults false so "fit"
// exercises its pure early-return without touching tmux; the link_* cases use
// empty/self-contained payloads so they exercise their own early-returns or
// pure Hub.groups state without needing a live tmux session either.
func TestDispatchKnownTypesRecognized(t *testing.T) {
	cases := []struct {
		name string
		msg  InboundMsg
	}{
		{"focus", InboundMsg{Type: "focus", Pane: "0.0"}},
		{"input", InboundMsg{Type: "input", Pane: "0.0", Text: "echo hi"}},
		{"key", InboundMsg{Type: "key", Pane: "0.0", Key: "a"}},
		{"switch_window", InboundMsg{Type: "switch_window", Window: 0}},
		{"new_window", InboundMsg{Type: "new_window"}},
		{"close_window", InboundMsg{Type: "close_window", Window: 0}},
		{"rename_window", InboundMsg{Type: "rename_window", Window: 0, Name: "zzRenamed"}},
		{"split_pane", InboundMsg{Type: "split_pane", Pane: "0.0", Direction: "h"}},
		{"close_pane", InboundMsg{Type: "close_pane", Pane: "0.0"}},
		{"fit", InboundMsg{Type: "fit", Pane: "0.0", Cols: 80, Rows: 24}},
		{"fit_enable", InboundMsg{Type: "fit_enable"}},
		{"fit_disable", InboundMsg{Type: "fit_disable"}},
		{"select_pane_direction", InboundMsg{Type: "select_pane_direction", Pane: "0.0", Direction: "left"}},
		{"autocomplete", InboundMsg{Type: "autocomplete", Query: "ls"}},
		{"refresh_panes", InboundMsg{Type: "refresh_panes"}},
		{"link_join", InboundMsg{Type: "link_join", Group: "g1", ClientID: "c1"}},
		{"link_leave", InboundMsg{Type: "link_leave"}},
		{"link_update", InboundMsg{Type: "link_update"}},
		{"link_config", InboundMsg{Type: "link_config"}},
		{"pong", InboundMsg{Type: "pong", Ts: 1}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := newDispatchTestConn(t)
			msg := tc.msg
			if err := c.dispatch(&msg); err != nil {
				// dispatch() itself never returns a non-nil error for a type it
				// recognizes — reader() turns that into an "input_error" frame,
				// which is the wrong signal for a routing problem. A non-nil
				// error here means this type isn't cleanly routed.
				t.Fatalf("dispatch(%s) returned error: %v", tc.name, err)
			}
			if got := drainOutbound(c); containsType(got, "error") {
				t.Errorf("dispatch(%s) produced an \"error\" frame (unrecognized type?): %v", tc.name, got)
			}
		})
	}
}

// TestDispatchUnknownType pins the default branch: an unrecognized type must
// not error out of dispatch — it sends exactly one client-visible "error"
// frame naming the offending type and returns nil.
func TestDispatchUnknownType(t *testing.T) {
	c := newDispatchTestConn(t)
	msg := InboundMsg{Type: "bogus_type"}
	if err := c.dispatch(&msg); err != nil {
		t.Fatalf("dispatch(unknown) returned error %v; want nil (reported via frame, not error)", err)
	}
	got := drainOutbound(c)
	if len(got) != 1 || got[0] != "error" {
		t.Fatalf("dispatch(unknown) frames = %v; want exactly one \"error\" frame", got)
	}
}
