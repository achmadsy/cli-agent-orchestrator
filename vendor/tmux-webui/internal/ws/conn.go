package ws

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/sync/errgroup"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

const outChanSize = 64

// envelope is a pre-marshalled JSON frame ready to write on the wire.
type envelope []byte

// Conn is the per-WebSocket-connection state. It must be created via
// Hub.UpgradeHandler; never construct directly.
type Conn struct {
	hub     *Hub
	ws      *websocket.Conn
	session string

	ctx    context.Context
	cancel context.CancelFunc

	outChan chan envelope

	// poller is the shared per-session poll loop this conn subscribes to; sub is
	// this conn's view onto it (per-conn snapshot + activeWindow filter). Both set
	// by Hub.subscribe in Run, released by Hub.unsubscribe on teardown. The poll
	// loop no longer runs per-conn — the capture is shared across the session (P1).
	poller *sessionPoller
	sub    *subscriber

	// fit-mode state (see fit.go). fitWindows is the SET of window indices this
	// conn currently holds a fit reference on — the original layouts themselves
	// live at Hub scope (hub.fitLayouts), keyed "session:windowIndex" with a
	// refcount, because a fit resize mutates the SHARED tmux window (B3).
	fitMode    bool
	fitWindows map[int]bool

	// prefix FSM state (see prefix_fsm.go)
	prefixWaiting bool

	// link-mode party membership (see link.go). Set by the link_join handler,
	// read by teardown (leaveLink) to depart the party. Empty when link is off.
	clientID string
	group    string

	// activeWindow tracks the currently-displayed tmux window index.
	// Updated by reader goroutine (handleSwitchWindow / handleNewWindow /
	// handleCloseWindow) and read by the session poller. Atomic for
	// cross-goroutine safety — the poller reads it to scope this conn's output.
	activeWindow atomic.Int32

	// snapshotDirty asks the session poller to clear THIS conn's content cache on
	// the next tick. Set after window switches so all panes' output gets re-sent
	// to the frontend (matches Python's last_contents.clear() behaviour).
	snapshotDirty atomic.Bool

	// lastRecv is the Unix-ms time of the last inbound frame (any type — the
	// client pongs every server ping, so a healthy conn is never silent for a
	// full ping interval). Stamped by the reader, enforced by heartbeat's
	// LivenessTimeout to tear down zombie conns.
	lastRecv atomic.Int64
}

// newConn allocates a Conn. ctx should be the request context or a derived ctx.
func newConn(parent context.Context, h *Hub, ws *websocket.Conn, session string) *Conn {
	ctx, cancel := context.WithCancel(parent)
	c := &Conn{
		hub:        h,
		ws:         ws,
		session:    session,
		ctx:        ctx,
		cancel:     cancel,
		outChan:    make(chan envelope, outChanSize),
		fitWindows: make(map[int]bool),
	}
	c.lastRecv.Store(epochMs()) // connect counts as liveness — grace before the first pong
	return c
}

// poke wakes this conn's session poller, resetting its adaptive backoff.
// Non-blocking (the poller drops extras when a wake is already pending), so
// callers (e.g. pushWindowsAndPanes from the reader goroutine) never stall.
// A nil poller (before subscribe) is a no-op.
func (c *Conn) poke() {
	if c.poller != nil {
		c.poller.poke()
	}
}

// send marshals msg as JSON and enqueues it for the writer goroutine.
// Non-blocking: drops the message on overflow rather than blocking the caller.
func (c *Conn) send(msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case c.outChan <- envelope(b):
	case <-c.ctx.Done():
	default:
		// drop on overflow — a slow client must not stall the poll loop
	}
}

// sendInitial pushes the opening windows + panes + metrics frames.
func (c *Conn) sendInitial(ctx context.Context) {
	windows, _ := c.hub.tx.ListWindows(ctx, c.session)
	if windows == nil {
		windows = []tmuxctl.Window{}
	}
	active := 0
	for _, w := range windows {
		if w.Active == 1 {
			active = w.Index
			break
		}
	}
	c.activeWindow.Store(int32(active))
	c.send(outWindows{Type: "windows", Windows: windows, Active: active})

	panes, _ := c.hub.tx.ListPanes(ctx, c.session)
	if panes == nil {
		panes = []tmuxctl.Pane{}
	}
	c.send(outPanes{Type: "panes", Panes: visiblePanes(panes, active)})

	// P3: read the Hub-cached sysmon snapshot rather than firing a fresh fetch on
	// every connect — a party of N phones connecting no longer means N sysmon hits.
	c.send(outMetrics{Type: "metrics", Metrics: c.hub.collectMetrics(ctx)})
}

// visiblePanes filters panes to those in the given active window.
// activeWin == 0 (default tmux pane-base-index is 1) means "no filter" —
// matches the Python `active_window is None` early-return branch.
func visiblePanes(panes []tmuxctl.Pane, activeWin int) []tmuxctl.Pane {
	if activeWin <= 0 {
		return panes
	}
	out := make([]tmuxctl.Pane, 0, len(panes))
	for _, p := range panes {
		if p.Window == activeWin {
			out = append(out, p)
		}
	}
	return out
}

// Run starts the four goroutines and blocks until all exit (errgroup).
// On return the connection is fully torn down (layout restore + hub remove + ws close).
func (c *Conn) Run() {
	defer func() {
		c.cancel()
		if c.poller != nil {
			c.hub.unsubscribe(c.poller, c.sub)
		}
		c.restoreLayouts()
		c.leaveLink()
		c.hub.Remove(c)
		c.ws.Close(websocket.StatusNormalClosure, "bye")
	}()

	// Send initial state synchronously BEFORE subscribing so the client's first
	// frames are this snapshot, not a poll diff racing in. Subscribing after keeps
	// the on-the-wire ordering (windows → panes → metrics → poll output) identical
	// to the old per-conn pollLoop, which also started after sendInitial.
	c.sendInitial(c.ctx)
	c.poller, c.sub = c.hub.subscribe(c)

	eg, ctx := errgroup.WithContext(c.ctx)
	_ = ctx // used by individual goroutines via c.ctx (already derived)

	eg.Go(func() error { return c.heartbeat() })
	eg.Go(func() error { return c.reader() })
	eg.Go(func() error { c.writer(); return nil })

	// Wait for any goroutine to return, then cancel the rest via deferred cancel.
	_ = eg.Wait()
}

// epochMs returns current Unix time in milliseconds.
func epochMs() int64 { return time.Now().UnixMilli() }
