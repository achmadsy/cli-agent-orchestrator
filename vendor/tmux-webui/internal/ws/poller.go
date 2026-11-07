package ws

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// paneReader is the narrow slice of *tmuxctl.Client the session poller reads
// through. Kept as an interface so tests can inject a capture-error path and
// assert the never-miss-waiting invariant (B2) without live tmux; production
// uses the real hub.tx (wired in newSessionPoller).
type paneReader interface {
	ListPanes(ctx context.Context, session string) ([]tmuxctl.Pane, error)
	CapturePane(ctx context.Context, target string, lines int) (string, error)
}

// subscriber is one Conn's view onto a shared sessionPoller. The poller owns
// snapshot and lastPaneSig outright (touched only from the poller goroutine, in
// emitOutput) so no mutex guards them; conn.activeWindow / conn.snapshotDirty are
// atomics read across goroutines. Splitting the per-CONN diff state out this way
// is what preserves per-conn activeWindow view semantics — two tabs on different
// windows of one session each keep their own snapshot and see only their window's
// output — while the expensive capture is shared (P1).
type subscriber struct {
	conn *Conn

	// snapshot is this subscriber's per-pane content cache for output diffing.
	// Cleared when conn.snapshotDirty is set (window switch → re-emit all).
	snapshot map[string]string

	// lastPaneSig fingerprints the visible pane list as of the last panes frame
	// pushed to THIS subscriber (its own activeWindow view).
	lastPaneSig string
}

// sessionPoller runs ONE adaptive poll loop per tmux session, shared by every
// Conn subscribed to that session. Started by Hub.subscribe on the first Conn
// for a session, stopped (stopCh closed under Hub.pollMu) when the last Conn
// unsubscribes. The loop mirrors the old per-Conn pollLoop — adaptive interval,
// snapshot diff, pane_states 1s tick, paneListSig drift, poke wake — but does the
// capture ONCE per session and fans typed frames out to each subscriber.
type sessionPoller struct {
	hub     *Hub
	session string
	tx      paneReader

	// ladder is the adaptive interval ladder derived from config.PollInterval
	// (newPollLadder). Fixed for the poller's lifetime.
	ladder pollLadder

	// mu guards subs (membership churns from Conn goroutines via add/del; the
	// loop iterates a snapshot copy taken under mu so a slow tick never blocks
	// subscribe/unsubscribe).
	mu   sync.Mutex
	subs map[*subscriber]struct{}

	// refs counts live subscribers for lifecycle; guarded by Hub.pollMu (NOT mu)
	// so the create/destroy decision stays serialized with the Hub.pollers map.
	refs int

	// pokeCh wakes the loop out of adaptive backoff. Buffered 1: a full channel
	// already carries a pending wake, so poke() drops extras (never blocks the
	// reader goroutine that pokes on a window switch).
	pokeCh chan struct{}

	// stopCh is closed by Hub.unsubscribe when refs hits 0; the loop returns and
	// its deferred cancel aborts any in-flight capture.
	stopCh chan struct{}
}

func newSessionPoller(h *Hub, session string) *sessionPoller {
	return &sessionPoller{
		hub:     h,
		session: session,
		tx:      h.tx,
		ladder:  newPollLadder(h.cfg.PollInterval),
		subs:    make(map[*subscriber]struct{}),
		pokeCh:  make(chan struct{}, 1),
		stopCh:  make(chan struct{}),
	}
}

func (p *sessionPoller) addSub(s *subscriber) {
	p.mu.Lock()
	p.subs[s] = struct{}{}
	p.mu.Unlock()
}

func (p *sessionPoller) delSub(s *subscriber) {
	p.mu.Lock()
	delete(p.subs, s)
	p.mu.Unlock()
}

// snapshotSubs copies the current subscriber set so the loop can iterate without
// holding mu across captures. A subscriber removed mid-tick still gets at most
// one more frame (harmless — conn.send drops once its ctx is cancelled).
func (p *sessionPoller) snapshotSubs() []*subscriber {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]*subscriber, 0, len(p.subs))
	for s := range p.subs {
		out = append(out, s)
	}
	return out
}

// poke wakes the loop immediately, resetting adaptive backoff. Non-blocking.
func (p *sessionPoller) poke() {
	select {
	case p.pokeCh <- struct{}{}:
	default:
	}
}

// run is the poller goroutine. It owns its own context (cancelled on stop so
// in-flight tmux captures abort), an adaptive output ticker, a FIXED 1s
// pane_states ticker (riding the adaptive one let a quiet screen stretch state
// updates to 2s — live-audit FIX 5), the pane-state debouncers (shared across
// the session's subscribers), and the metrics cadence counter.
func (p *sessionPoller) run() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	interval := p.ladder.min
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	statesTicker := time.NewTicker(1 * time.Second)
	defer statesTicker.Stop()

	debounce := make(map[string]*stateDebouncer)
	tickCount := 0
	metricsEvery := metricsTickEvery(p.hub.cfg.MetricsInterval, p.ladder.min.Seconds())

	for {
		select {
		case <-p.stopCh:
			return
		case <-p.pokeCh:
			// External wake (window switch): drop back to the fast interval and
			// capture now so fresh output doesn't wait for the backed-off tick.
			interval = p.ladder.min
			ticker.Reset(interval)
			p.pollOnce(ctx, p.snapshotSubs())
		case <-statesTicker.C:
			p.pollStates(ctx, p.snapshotSubs(), debounce)
		case <-ticker.C:
			tickCount++
			subs := p.snapshotSubs()
			changed := p.pollOnce(ctx, subs)

			if changed {
				interval = p.ladder.min
			} else {
				interval = p.ladder.stepUp(interval)
			}
			ticker.Reset(interval)

			if tickCount%metricsEvery == 0 {
				// P3: fetch sysmon metrics once per interval at Hub level (cached,
				// shared across every session's poller), fan the snapshot out.
				snap := p.hub.collectMetrics(ctx)
				for _, s := range subs {
					s.conn.send(outMetrics{Type: "metrics", Metrics: snap})
				}
			}
		}
	}
}

// pollOnce captures the UNION of subscribers' active windows ONCE, then diffs the
// captured content per subscriber against that subscriber's own snapshot and
// forwards output/panes frames scoped to each subscriber's active window. Returns
// true if ANY subscriber saw a content change — that drives the shared adaptive
// interval (reset to pollMin on any change), so the shared loop is never slower
// than a per-conn loop would have been.
func (p *sessionPoller) pollOnce(ctx context.Context, subs []*subscriber) bool {
	if len(subs) == 0 {
		return false
	}

	panes, err := p.tx.ListPanes(ctx, p.session)
	if err != nil || len(panes) == 0 {
		return false
	}

	// Union of active windows across subscribers. activeWindow ≤ 0 means "no
	// filter" (matches visiblePanes): such a subscriber wants every pane, so the
	// capture set widens to all panes.
	union := make(map[int]bool)
	captureAll := false
	for _, s := range subs {
		aw := int(s.conn.activeWindow.Load())
		if aw <= 0 {
			captureAll = true
		}
		union[aw] = true
	}

	// Capture each pane in the union ONCE (dedup across subscribers viewing the
	// same window — the whole point of P1).
	captured := make(map[string]string, len(panes))
	for _, pane := range panes {
		if !captureAll && !union[pane.Window] {
			continue
		}
		content, err := p.tx.CapturePane(ctx, p.session+":"+pane.ID, p.hub.cfg.CaptureLines)
		if err != nil {
			// B2: transient flake — omit from captured. The per-subscriber diff
			// below then sees "no update" and keeps the prior snapshot (no blank
			// frame, no dropped waiting lamp). A dead pane maps to ("",nil)
			// upstream, so a real error is a flake worth holding through.
			continue
		}
		captured[pane.ID] = content
	}

	anyChanged := false
	for _, s := range subs {
		if p.emitOutput(s, panes, captured) {
			anyChanged = true
		}
	}
	return anyChanged
}

// emitOutput does the per-subscriber diff/forward using pre-captured content.
// Mirrors the old per-Conn pollPanes exactly for a single subscriber (union ==
// its one window, captured == its panes), keeping single-connection behavior
// byte-identical on the wire.
func (p *sessionPoller) emitOutput(s *subscriber, panes []tmuxctl.Pane, captured map[string]string) bool {
	if s.conn.snapshotDirty.CompareAndSwap(true, false) {
		for k := range s.snapshot {
			delete(s.snapshot, k)
		}
	}
	activeWin := int(s.conn.activeWindow.Load())

	// Reader actions (window switch, split, kill) push panes frames, but
	// command/title mutations happen without any client action — an agent
	// starting or exiting flips #{pane_current_command}/#{pane_title} while the
	// pane list stays structurally identical. Push a fresh frame on any drift.
	if sig := paneListSig(panes, activeWin); sig != s.lastPaneSig {
		s.lastPaneSig = sig
		s.conn.send(outPanes{Type: "panes", Panes: visiblePanes(panes, activeWin)})
	}

	changed := make(map[string]string)
	for _, pane := range panes {
		if activeWin > 0 && pane.Window != activeWin {
			continue
		}
		content, ok := captured[pane.ID]
		if !ok {
			// Not captured this tick (capture flake, or a pane outside this
			// subscriber's window that the union still skipped): keep the prior
			// snapshot, emit no diff for it (B2 invariant).
			continue
		}
		if prev, ok := s.snapshot[pane.ID]; !ok || prev != content {
			changed[pane.ID] = content
			s.snapshot[pane.ID] = content
		}
	}

	if len(changed) == 0 {
		return false
	}
	s.conn.send(outOutput{Type: "output", Panes: changed})
	return true
}

// pollStates runs the shared pane_states pass once and fans the identical frame
// to every subscriber (pane state is window-independent — the same lamp map for
// every tab on the session). Always sends, even on an empty result, to match the
// old per-conn tick that sent unconditionally.
func (p *sessionPoller) pollStates(ctx context.Context, subs []*subscriber, debounce map[string]*stateDebouncer) {
	if len(subs) == 0 {
		return
	}
	win, perPane := p.collectPaneStates(ctx, debounce)
	frame := outPaneStates{Type: "pane_states", States: win, Panes: perPane}
	for _, s := range subs {
		s.conn.send(frame)
	}
}

// collectPaneStates does a lightweight all-windows pass: captures only the last
// 30 lines of every agent pane, strips ANSI, classifies each agent pane
// (classifyPane: OSC title + bottom-zone text rules), and debounces per pane
// through the SHARED debounce map (one flicker suppressor per pane per session,
// not per conn). Returns the per-WINDOW aggregate (attention-first max) AND the
// per-pane map for the wire frame. Non-agent panes stay "unknown" without running
// rules. Intentionally separate from pollOnce (which tracks content diffs) so we
// never push full text here — only short enum strings.
func (p *sessionPoller) collectPaneStates(ctx context.Context, debounce map[string]*stateDebouncer) (map[string]string, map[string]string) {
	panes, err := p.tx.ListPanes(ctx, p.session)
	if err != nil || len(panes) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool, len(panes))
	win := make(map[string]string)
	perPane := make(map[string]string, len(panes))
	for _, pane := range panes {
		seen[pane.ID] = true
		st := "unknown"
		var det detection
		classified := false
		captureFailed := false
		if isAgentCommand(pane.Command) {
			tail, err := p.tx.CapturePane(ctx, p.session+":"+pane.ID, 30)
			if err != nil {
				// Transient capture flake: SKIP observe() and hold the last
				// published state below. Classifying the blank text a flake yields
				// would let a blocked pane's stale ✳ title hit osc_title_idle and
				// drop its waiting lamp (B2 invariant). A dead pane maps to ("",nil)
				// upstream, so a real error is a flake worth holding through.
				captureFailed = true
			} else {
				det = classifyPane(stripAnsi(tail), pane.Title, pane.Command)
				// Known agent with a quiet screen defaults to idle
				// (agent-state semantics: "agent is up but quiet").
				if det.rule == "" {
					det.state = "idle"
				}
				classified = true
			}
		} else if isAgentHostCommand(pane.Command) {
			// generic runtime (node/bun/deno): screen text untrusted, the
			// agent-set OSC title alone may classify (no capture needed)
			det = classifyTitleOnly(pane.Title)
			classified = true
		}
		if classified {
			d := debounce[pane.ID]
			if d == nil {
				d = &stateDebouncer{}
				debounce[pane.ID] = d
			}
			st = d.observe(det)
		} else if captureFailed {
			// Hold the previously published state for this pane; "unknown" only
			// if it was never classified (no debouncer yet).
			if d := debounce[pane.ID]; d != nil && d.published != "" {
				st = d.published
			}
		}
		perPane[pane.ID] = st
		key := strconv.Itoa(pane.Window)
		win[key] = mergeState(win[key], st)
	}
	// drop debouncers for panes that no longer exist
	for id := range debounce {
		if !seen[id] {
			delete(debounce, id)
		}
	}
	return win, perPane
}
