package ws

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/metrics"
	"github.com/operonlab/tmux-webui/internal/prefix"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// Hub manages all active WebSocket connections.
// Safe for concurrent use.
type Hub struct {
	cfg   *config.Config
	tx    *tmuxctl.Client
	pc    *prefix.Cache
	prov  metrics.Provider
	conns sync.Map // map[*Conn]struct{}

	// groups holds link-mode parties, keyed by party code → *linkGroup.
	// Zero value is ready to use; entries are deleted when the last member
	// leaves (see link.go). Never iterated by Hub.Broadcast — party frames are
	// always scoped through broadcastGroup.
	groups sync.Map

	// fitLayouts holds the original tmux window layout captured before the FIRST
	// fit-mode resize of a window, keyed "session:windowIndex", with a refcount
	// of how many Conns currently hold fit enabled on that window. A fit resize
	// mutates the SHARED tmux window, so a per-Conn snapshot let a second
	// client's teardown stomp the first client's still-fit layout (B3); the map
	// lives at Hub scope and the LAST Conn out restores the earliest original.
	// Guarded by fitMu.
	fitMu      sync.Mutex
	fitLayouts map[string]*fitLayout

	// pollers holds one shared sessionPoller per tmux session (P1). Created on
	// the first Conn to subscribe to a session, torn down when the last leaves.
	// pollMu serializes create/destroy with each poller's refcount so the map
	// and the "start on first / stop on last" decision never race.
	pollMu  sync.Mutex
	pollers map[string]*sessionPoller

	// metrics cache (P3): sysmon metrics are machine-global, so every session's
	// poller (and every connect) reads one Hub-level cached Snapshot instead of
	// each fetching independently. Guarded by metricsMu; TTL = MetricsInterval.
	metricsMu   sync.Mutex
	metricsSnap metrics.Snapshot
	metricsAt   time.Time
}

// fitLayout is one shared window's pre-fit state (layout + window size) plus its
// live refcount and every current fitter's desired size. wants drives min-
// aggregation: two clients fitting one window converge to the smaller of their
// requests (smallest-client-wins, matching tmux's shared-window semantics — R3).
type fitLayout struct {
	layout string
	origW  int
	origH  int
	ref    int
	wants  map[*Conn][2]int // conn → [cols, rows]
}

// acquireFit records a fit reference on key (a "session:windowIndex" string for
// the shared tmux window). On the FIRST reference it stores layout AND the
// original window size (origW, origH) as the window's true pre-fit state; later
// references only ++ref and ignore the passed snapshot — the earliest original
// wins so the last-out restore returns the shared window to its pre-fit state.
// Returns true when the caller now holds a reference (and must release it on
// fit_disable/teardown). Returns false ONLY when this was the first reference AND
// valid==false (the snapshot could not be read), so the caller retries the
// snapshot on its next fit message rather than tracking a layout it never
// captured. origW/origH may be 0 even when valid (window-size query failed
// independently of the layout query); the restore skips ResizeWindow in that case.
func (h *Hub) acquireFit(key, layout string, valid bool, origW, origH int) bool {
	h.fitMu.Lock()
	defer h.fitMu.Unlock()
	if h.fitLayouts == nil {
		h.fitLayouts = make(map[string]*fitLayout)
	}
	if e, ok := h.fitLayouts[key]; ok {
		e.ref++
		return true
	}
	if !valid {
		return false
	}
	h.fitLayouts[key] = &fitLayout{
		layout: layout,
		origW:  origW,
		origH:  origH,
		ref:    1,
		wants:  make(map[*Conn][2]int),
	}
	return true
}

// registerWant records conn c's desired (cols, rows) for the window key and
// returns the EFFECTIVE size — the min cols and min rows across every client
// currently fitting that window (R3). Callers apply the returned size to the tmux
// resize so shared-window clients converge downward instead of stomping each
// other last-writer-wins. If the window is untracked (its snapshot could not be
// captured, so no entry exists) the passed size is returned unaggregated, keeping
// the resize working for the degraded single-client path.
func (h *Hub) registerWant(c *Conn, key string, cols, rows int) (int, int) {
	h.fitMu.Lock()
	defer h.fitMu.Unlock()
	e, ok := h.fitLayouts[key]
	if !ok {
		return cols, rows
	}
	e.wants[c] = [2]int{cols, rows}
	return minWants(e.wants)
}

// fitRelease tells restoreLayouts what to re-apply after a conn drops its fit ref.
//   - restore: this was the LAST fitter — reset the window to its pre-fit size
//     (cols=origW, rows=origH) and layout. cols/rows are 0 when capture failed.
//   - remain: other clients still fit — cols/rows carry the recomputed min of the
//     remaining wants so the window grows back to the smallest remaining client
//     (a departing small client must not leave the window stuck small).
type fitRelease struct {
	restore bool
	remain  bool
	cols    int
	rows    int
	layout  string
}

// releaseFit drops conn c's want and one reference to key. When references
// remain it returns {remain, recomputed-min}. When the LAST reference goes it
// deletes the entry and returns {restore, origW, origH, earliest-original-
// layout}. A key with no entry returns a zero fitRelease — releasing an untracked
// window is a no-op.
func (h *Hub) releaseFit(c *Conn, key string) fitRelease {
	h.fitMu.Lock()
	defer h.fitMu.Unlock()
	e, ok := h.fitLayouts[key]
	if !ok {
		return fitRelease{}
	}
	delete(e.wants, c)
	e.ref--
	if e.ref > 0 {
		cols, rows := minWants(e.wants)
		return fitRelease{remain: true, cols: cols, rows: rows}
	}
	delete(h.fitLayouts, key)
	return fitRelease{restore: true, cols: e.origW, rows: e.origH, layout: e.layout}
}

// minWants returns the min cols and min rows across all wants. Zero-valued
// components are ignored as "no constraint" so an empty map yields (0, 0), which
// callers treat as "nothing to apply".
func minWants(wants map[*Conn][2]int) (int, int) {
	minC, minR := 0, 0
	for _, w := range wants {
		if w[0] > 0 && (minC == 0 || w[0] < minC) {
			minC = w[0]
		}
		if w[1] > 0 && (minR == 0 || w[1] < minR) {
			minR = w[1]
		}
	}
	return minC, minR
}

// NewHub constructs a Hub. cfg, tx, pc, and prov must not be nil.
// Pass metrics.NewStub() for prov when metrics are disabled.
func NewHub(cfg *config.Config, tx *tmuxctl.Client, pc *prefix.Cache, prov metrics.Provider) *Hub {
	return &Hub{cfg: cfg, tx: tx, pc: pc, prov: prov}
}

// subscribe attaches c to its session's shared poller, creating and starting the
// poller goroutine if c is the first subscriber for that session. Returns the
// poller (for poke/teardown) and the per-conn subscriber view. Call unsubscribe
// on teardown.
func (h *Hub) subscribe(c *Conn) (*sessionPoller, *subscriber) {
	h.pollMu.Lock()
	p := h.pollers[c.session]
	if p == nil {
		if h.pollers == nil {
			h.pollers = make(map[string]*sessionPoller)
		}
		p = newSessionPoller(h, c.session)
		h.pollers[c.session] = p
		go p.run()
	}
	p.refs++
	h.pollMu.Unlock()

	sub := &subscriber{conn: c, snapshot: make(map[string]string)}
	p.addSub(sub)
	return p, sub
}

// unsubscribe detaches sub from its poller. When the last subscriber leaves, the
// poller is removed from the registry and its stopCh closed so the goroutine
// exits. The map delete + stopCh close happen together under pollMu so a
// concurrent subscribe for the same session either reuses this live poller (ref
// still held) or, if we already tore it down, creates a fresh one — never a lost
// registration against a dying poller.
func (h *Hub) unsubscribe(p *sessionPoller, sub *subscriber) {
	p.delSub(sub)

	h.pollMu.Lock()
	p.refs--
	if p.refs == 0 {
		if h.pollers[p.session] == p {
			delete(h.pollers, p.session)
		}
		close(p.stopCh)
	}
	h.pollMu.Unlock()
}

// collectMetrics returns the Hub-cached sysmon Snapshot (P3), fetching a fresh
// one via the provider only when the cache is older than MetricsInterval. Two
// pollers racing a cold miss may both fetch — a rare, harmless duplicate; the TTL
// dedups the steady state, which is the point.
func (h *Hub) collectMetrics(ctx context.Context) metrics.Snapshot {
	ttl := time.Duration(h.cfg.MetricsInterval * float64(time.Second))

	h.metricsMu.Lock()
	if !h.metricsAt.IsZero() && time.Since(h.metricsAt) < ttl {
		snap := h.metricsSnap
		h.metricsMu.Unlock()
		return snap
	}
	h.metricsMu.Unlock()

	// Fetch outside the lock — Collect may block up to the provider's HTTP
	// timeout (3s) and must not stall other pollers reading the cache.
	snap := h.prov.Collect(ctx)

	h.metricsMu.Lock()
	h.metricsSnap = snap
	h.metricsAt = time.Now()
	h.metricsMu.Unlock()
	return snap
}

// add registers a connection.
func (h *Hub) add(c *Conn) { h.conns.Store(c, struct{}{}) }

// Remove unregisters a connection.
func (h *Hub) Remove(c *Conn) { h.conns.Delete(c) }

// Broadcast marshals msg as JSON and sends it to every registered connection.
// Slow or closed connections are dropped non-blocking (mirroring Conn.send).
func (h *Hub) Broadcast(msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.conns.Range(func(key, _ any) bool {
		c := key.(*Conn)
		select {
		case c.outChan <- envelope(b):
		default:
			// drop on overflow; connection will eventually close itself
		}
		return true
	})
}

// BroadcastTTS is a convenience wrapper for Hub.Broadcast with a TTS payload.
func (h *Hub) BroadcastTTS(id, text string) {
	h.Broadcast(outTTS{Type: "tts", ID: id, Text: text})
}
