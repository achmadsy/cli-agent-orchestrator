package ws

// poller_test.go — P1: the shared per-session poller. Covers the two behaviors
// the refactor turns on and nothing else exercises: (1) Hub owns exactly one
// poller per session, started on the first subscriber and stopped on the last;
// (2) one tick captures the UNION of subscribers' active windows, deduping panes
// shared by same-window tabs, while each subscriber still forwards only its own
// window's output. No live tmux: the lifecycle test races nothing past the
// first (400ms-away) tick, and the capture test drives a recording fake.

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/metrics"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

func isClosed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// TestSessionPollerLifecycle pins "one poller per session, start on first
// subscriber, stop on last". Assertions complete well within the first tick
// (400ms) so the run() goroutine only ever sits in its select — no real tmux
// capture fires.
func TestSessionPollerLifecycle(t *testing.T) {
	h := &Hub{
		cfg:  &config.Config{MetricsInterval: 5, CaptureLines: 150},
		tx:   tmuxctl.New(),
		prov: metrics.NewStub(),
	}
	conn := func(session string) *Conn {
		// ctx set so that if a 400ms tick ever races the assertions, the poller's
		// send() has a real Done() channel to select on instead of panicking.
		return &Conn{session: session, ctx: context.Background(), outChan: make(chan envelope, outChanSize)}
	}

	// Two conns, one session → one shared poller, refs 2.
	c1, c2 := conn("zzAuditS1"), conn("zzAuditS1")
	p1, s1 := h.subscribe(c1)
	p2, s2 := h.subscribe(c2)
	if p1 != p2 {
		t.Fatal("two conns on the same session must share ONE poller")
	}
	h.pollMu.Lock()
	nPollers, refs := len(h.pollers), p1.refs
	h.pollMu.Unlock()
	if nPollers != 1 || refs != 2 {
		t.Fatalf("after 2 subscribes: pollers=%d refs=%d; want 1 and 2", nPollers, refs)
	}
	if got := len(p1.snapshotSubs()); got != 2 {
		t.Fatalf("poller has %d subscribers; want 2", got)
	}

	// A different session gets its own poller.
	c3 := conn("zzAuditS2")
	p3, s3 := h.subscribe(c3)
	if p3 == p1 {
		t.Fatal("a different session must get its OWN poller")
	}
	h.pollMu.Lock()
	nPollers = len(h.pollers)
	h.pollMu.Unlock()
	if nPollers != 2 {
		t.Fatalf("two sessions → %d pollers; want 2", nPollers)
	}

	// Dropping one of session1's two conns keeps the poller alive (refs 1).
	h.unsubscribe(p1, s1)
	h.pollMu.Lock()
	refs = p1.refs
	_, present := h.pollers["zzAuditS1"]
	h.pollMu.Unlock()
	if refs != 1 || !present {
		t.Fatalf("after 1 unsub: refs=%d present=%v; want 1 and true", refs, present)
	}
	if isClosed(p1.stopCh) {
		t.Fatal("poller stopped before its LAST subscriber left")
	}

	// The last conn out removes the poller from the registry and stops it.
	h.unsubscribe(p1, s2)
	h.pollMu.Lock()
	_, present = h.pollers["zzAuditS1"]
	h.pollMu.Unlock()
	if present {
		t.Fatal("poller not removed from registry on last unsubscribe")
	}
	if !isClosed(p1.stopCh) {
		t.Fatal("stopCh not closed on last unsubscribe — goroutine would leak")
	}

	// Re-subscribing the now-dead session mints a fresh poller, not the corpse.
	c4 := conn("zzAuditS1")
	p4, s4 := h.subscribe(c4)
	if p4 == p1 {
		t.Fatal("subscribe after teardown must create a FRESH poller")
	}

	// Clean up the goroutines this test started.
	h.unsubscribe(p4, s4)
	h.unsubscribe(p3, s3)
}

// recordingReader records every CapturePane target so a test can assert the
// union selection and the same-window dedup.
type recordingReader struct {
	panes   []tmuxctl.Pane
	content map[string]string

	mu    sync.Mutex
	calls []string
}

func (r *recordingReader) ListPanes(ctx context.Context, session string) ([]tmuxctl.Pane, error) {
	return r.panes, nil
}
func (r *recordingReader) CapturePane(ctx context.Context, target string, lines int) (string, error) {
	r.mu.Lock()
	r.calls = append(r.calls, target)
	r.mu.Unlock()
	return r.content[target], nil
}
func (r *recordingReader) captureCounts() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	m := make(map[string]int)
	for _, c := range r.calls {
		m[c]++
	}
	return m
}

// outputPanes drains ch and returns the Panes map of the first "output" frame.
func outputPanes(ch chan envelope) map[string]string {
	for {
		select {
		case e := <-ch:
			var m struct {
				Type  string            `json:"type"`
				Panes map[string]string `json:"panes"`
			}
			_ = json.Unmarshal(e, &m)
			if m.Type == "output" {
				return m.Panes
			}
		default:
			return nil
		}
	}
}

// TestPollOnce_UnionOfWindowsCaptureSelection pins the P1 capture rule: one tick
// captures the union of subscribers' active windows (panes outside every
// subscriber's window are skipped), a pane shared by two same-window tabs is
// captured ONCE, and each subscriber still forwards only its own window's output.
func TestPollOnce_UnionOfWindowsCaptureSelection(t *testing.T) {
	panes := []tmuxctl.Pane{
		{ID: "1.0", Window: 1, Command: "zsh"},
		{ID: "2.0", Window: 2, Command: "zsh"},
		{ID: "3.0", Window: 3, Command: "zsh"}, // no subscriber views window 3
	}
	rec := &recordingReader{panes: panes, content: map[string]string{
		"s:1.0": "one", "s:2.0": "two", "s:3.0": "three",
	}}
	p := newTestPoller(rec)

	sub1 := newTestSub()
	sub1.conn.activeWindow.Store(1)
	sub2 := newTestSub()
	sub2.conn.activeWindow.Store(2)
	sub3 := newTestSub()
	sub3.conn.activeWindow.Store(1) // same window as sub1 — must not double-capture

	p.pollOnce(context.Background(), []*subscriber{sub1, sub2, sub3})

	counts := rec.captureCounts()
	if counts["s:1.0"] != 1 {
		t.Errorf("pane 1.0 captured %d×; want 1 (deduped across sub1+sub3)", counts["s:1.0"])
	}
	if counts["s:2.0"] != 1 {
		t.Errorf("pane 2.0 captured %d×; want 1", counts["s:2.0"])
	}
	if counts["s:3.0"] != 0 {
		t.Errorf("pane 3.0 (window 3, no subscriber) captured %d×; want 0 (outside the union)", counts["s:3.0"])
	}

	// Per-conn view semantics: each tab forwards only its own window's output.
	if got := outputPanes(sub1.conn.outChan); len(got) != 1 || got["1.0"] != "one" {
		t.Errorf("sub1 output = %v; want only {1.0:one}", got)
	}
	if got := outputPanes(sub2.conn.outChan); len(got) != 1 || got["2.0"] != "two" {
		t.Errorf("sub2 output = %v; want only {2.0:two}", got)
	}
	if got := outputPanes(sub3.conn.outChan); len(got) != 1 || got["1.0"] != "one" {
		t.Errorf("sub3 (same window as sub1) output = %v; want only {1.0:one}", got)
	}
}
