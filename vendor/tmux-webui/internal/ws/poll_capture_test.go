package ws

// poll_capture_test.go — B2: the poll loop must never turn a transient capture
// flake into a blank frame / a dropped waiting lamp. After the P1 refactor the
// capture/diff lives on sessionPoller (pollOnce → emitOutput) and the state pass
// on collectPaneStates(debounce) — these tests were adapted from the old per-Conn
// methods to drive the poller directly (still no live tmux). Both CapturePane
// callers are exercised through a fake paneReader:
//   - pollOnce/emitOutput: on capture error → keep the subscriber's snapshot, emit no output.
//   - collectPaneStates:    on capture error → hold the previously published state.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// fakePaneReader injects a scripted ListPanes / CapturePane so tests can drive
// the capture-error path the never-miss-waiting invariant hinges on.
type fakePaneReader struct {
	panes   []tmuxctl.Pane
	capture func(target string) (string, error)
}

func (f fakePaneReader) ListPanes(ctx context.Context, session string) ([]tmuxctl.Pane, error) {
	return f.panes, nil
}
func (f fakePaneReader) CapturePane(ctx context.Context, target string, lines int) (string, error) {
	return f.capture(target)
}

// drainFrameTypes pops every buffered frame off outChan and returns its "type".
func drainFrameTypes(ch chan envelope) []string {
	var types []string
	for {
		select {
		case e := <-ch:
			var m struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(e, &m)
			types = append(types, m.Type)
		default:
			return types
		}
	}
}

// newTestPoller builds a sessionPoller wired to a fake pane source (no live tmux;
// the fake ignores CaptureLines). session "s" so capture targets read
// "s:<paneID>". A minimal Hub carries the cfg the poll path reads.
func newTestPoller(tx paneReader) *sessionPoller {
	return &sessionPoller{
		hub:     &Hub{cfg: &config.Config{}},
		session: "s",
		tx:      tx,
		subs:    make(map[*subscriber]struct{}),
		pokeCh:  make(chan struct{}, 1),
		stopCh:  make(chan struct{}),
	}
}

// newTestSub builds a subscriber whose conn only needs an outChan (activeWindow
// defaults to 0 = no window filter, matching the old per-conn tests).
func newTestSub() *subscriber {
	return &subscriber{
		conn:     &Conn{ctx: context.Background(), outChan: make(chan envelope, outChanSize)},
		snapshot: make(map[string]string),
	}
}

func TestPollPanes_CaptureErrorKeepsSnapshotNoFrame(t *testing.T) {
	panes := []tmuxctl.Pane{{ID: "1.0", Window: 1, WindowName: "zsh", Command: "claude", Title: "⠹ working"}}
	tx := fakePaneReader{panes: panes, capture: func(string) (string, error) {
		return "", errors.New("capture flake")
	}}
	p := newTestPoller(tx)
	sub := newTestSub()
	sub.lastPaneSig = paneListSig(panes, 0) // pre-seed so no panes frame fires
	sub.snapshot = map[string]string{"1.0": "PREVIOUS CONTENT"}

	changed := p.pollOnce(context.Background(), []*subscriber{sub})

	if changed {
		t.Error("pollOnce reported a change on a capture flake; want false")
	}
	if sub.snapshot["1.0"] != "PREVIOUS CONTENT" {
		t.Errorf("snapshot blanked on flake: got %q, want %q", sub.snapshot["1.0"], "PREVIOUS CONTENT")
	}
	if types := drainFrameTypes(sub.conn.outChan); len(types) != 0 {
		t.Errorf("capture flake emitted frames %v; want none", types)
	}
}

func TestPollPanes_CaptureSuccessEmitsOutput(t *testing.T) {
	panes := []tmuxctl.Pane{{ID: "1.0", Window: 1, WindowName: "zsh", Command: "claude", Title: "⠹ working"}}
	tx := fakePaneReader{panes: panes, capture: func(string) (string, error) {
		return "FRESH OUTPUT", nil
	}}
	p := newTestPoller(tx)
	sub := newTestSub()
	sub.lastPaneSig = paneListSig(panes, 0)
	sub.snapshot = map[string]string{"1.0": "OLD"}

	if !p.pollOnce(context.Background(), []*subscriber{sub}) {
		t.Fatal("pollOnce reported no change on new content; want true")
	}
	if sub.snapshot["1.0"] != "FRESH OUTPUT" {
		t.Errorf("snapshot not updated: got %q", sub.snapshot["1.0"])
	}
	types := drainFrameTypes(sub.conn.outChan)
	if len(types) != 1 || types[0] != "output" {
		t.Errorf("frames = %v; want exactly one output frame", types)
	}
}

func TestCollectPaneStates_CaptureErrorHoldsPublishedState(t *testing.T) {
	// A blocked (waiting) pane whose next capture flakes must NOT drop to idle:
	// its stale ✳ title would otherwise hit osc_title_idle on the blank text.
	panes := []tmuxctl.Pane{{ID: "1.0", Window: 1, Command: "claude", Title: "✳ quiet"}}
	tx := fakePaneReader{panes: panes, capture: func(string) (string, error) {
		return "", errors.New("capture flake")
	}}
	p := newTestPoller(tx)
	debounce := map[string]*stateDebouncer{"1.0": {published: "waiting"}}

	win, perPane := p.collectPaneStates(context.Background(), debounce)
	if perPane["1.0"] != "waiting" {
		t.Errorf("perPane[1.0] = %q on flake; want held waiting", perPane["1.0"])
	}
	if win["1"] != "waiting" {
		t.Errorf("win[1] = %q on flake; want held waiting", win["1"])
	}
}

func TestCollectPaneStates_CaptureErrorNoPriorStaysUnknown(t *testing.T) {
	panes := []tmuxctl.Pane{{ID: "1.0", Window: 1, Command: "claude", Title: "✳ quiet"}}
	tx := fakePaneReader{panes: panes, capture: func(string) (string, error) {
		return "", errors.New("capture flake")
	}}
	p := newTestPoller(tx)

	_, perPane := p.collectPaneStates(context.Background(), map[string]*stateDebouncer{})
	if perPane["1.0"] != "unknown" {
		t.Errorf("perPane[1.0] = %q with no prior state; want unknown", perPane["1.0"])
	}
}

func TestCollectPaneStates_CaptureSuccessObserves(t *testing.T) {
	// Contrast: a healthy capture runs the classifier + debouncer as before.
	panes := []tmuxctl.Pane{{ID: "1.0", Window: 1, Command: "claude", Title: "✳ quiet"}}
	tx := fakePaneReader{panes: panes, capture: func(string) (string, error) {
		return "Do you want to proceed?\n ❯ 1. Yes\n   2. No", nil
	}}
	p := newTestPoller(tx)

	_, perPane := p.collectPaneStates(context.Background(), map[string]*stateDebouncer{})
	if perPane["1.0"] != "waiting" {
		t.Errorf("perPane[1.0] = %q; want waiting from live permission prompt", perPane["1.0"])
	}
}
