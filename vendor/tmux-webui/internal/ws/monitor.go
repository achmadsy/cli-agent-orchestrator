package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// AgentStatus is one agent pane's cross-session status, the unit of the
// Monitor's snapshot and the GET /api/agents payload. Field JSON tags are
// camelCase to match the deck's other agent frames (pane_states is enum-only;
// this is the richer status the triage/rail/push all read).
type AgentStatus struct {
	Host        string `json:"host"`
	Session     string `json:"session"`
	Window      int    `json:"window"`
	WindowName  string `json:"windowName"`
	Pane        int    `json:"pane"`
	PaneID      string `json:"paneID"`
	Tool        string `json:"tool"`  // pane_current_command (claude/codex/…)
	State       string `json:"state"` // working | waiting | idle | unknown
	SinceUnix   int64  `json:"sinceUnix"`
	TailPreview string `json:"tailPreview"`

	// I5 context/token burn, parsed from the pane's status line
	// (`context: 12.3% (32.1k/262.1k)`). All three are 0 when the line is
	// absent/legacy — the deck renders a blank badge, never an error.
	ContextPct float64 `json:"contextPct"`
	TokensUsed int     `json:"tokensUsed"`
	TokensMax  int     `json:"tokensMax"`

	// I3 per-pane state timeline: the pane's recent state transitions (bounded
	// ring, oldest→newest, each = the state entered + the unix second it was
	// entered). Drives the deck's live "waiting 4m12s" + working/waiting/idle mini
	// split. omitempty so a legacy payload / never-classified pane stays lean.
	Recent []StateEvent `json:"recent,omitempty"`
}

// timelineCap bounds each pane's state-transition ring — plenty of history for a
// mini split/sparkline without unbounded growth on a pane that flaps.
const timelineCap = 32

// StateEvent is one entry in a pane's state-transition timeline: the state the
// pane ENTERED and the unix second it entered it. Ships inside AgentStatus.recent[].
type StateEvent struct {
	State  string `json:"state"`
	AtUnix int64  `json:"atUnix"`
}

// stateRing is a bounded FIFO of one pane's state transitions. PURE: push takes
// the timestamp as an argument (never time.Now) so append / eviction / duration
// stay deterministic under test. A repeat of the trailing state is coalesced so a
// segment keeps its original entry time — scan only pushes on a real change, but
// push stays defensive.
type stateRing struct {
	cap    int
	events []StateEvent
}

func newStateRing(capacity int) *stateRing {
	if capacity < 1 {
		capacity = 1
	}
	return &stateRing{cap: capacity}
}

// push records a transition INTO state at atUnix, evicting the oldest once over
// cap. A repeat of the trailing state is a no-op (keeps the first entry time).
func (r *stateRing) push(state string, atUnix int64) {
	if n := len(r.events); n > 0 && r.events[n-1].State == state {
		return
	}
	r.events = append(r.events, StateEvent{State: state, AtUnix: atUnix})
	if over := len(r.events) - r.cap; over > 0 {
		// Compact the tail onto the head of the same backing array (forward copy,
		// dest<src — safe) so the ring never grows past cap.
		r.events = append(r.events[:0], r.events[over:]...)
	}
}

// snapshot copies the retained transitions (oldest→newest) so a caller can ship
// them without racing a later push. nil when empty (folds to omitempty on the wire).
func (r *stateRing) snapshot() []StateEvent {
	if len(r.events) == 0 {
		return nil
	}
	out := make([]StateEvent, len(r.events))
	copy(out, r.events)
	return out
}

// stateDurations folds a transition list into total seconds per state, treating
// the final transition as still-open until now. PURE (now injected). This is the
// verified reference the deck's JS splitDurations mirrors to render the live
// working/waiting/idle split; negative spans (clock skew / out-of-order) clamp
// to 0. Unit-tested as the I3 hard gate.
func stateDurations(events []StateEvent, now int64) map[string]int64 {
	out := map[string]int64{}
	for i, e := range events {
		end := now
		if i+1 < len(events) {
			end = events[i+1].AtUnix
		}
		if d := end - e.AtUnix; d > 0 {
			out[e.State] += d
		}
	}
	return out
}

// Monitor is the cross-session agent watcher: a server-lifetime goroutine that
// scans every session on an interval, classifies each agent pane, and both
// (a) maintains a live all-sessions status snapshot for the UI (GET /api/agents)
// and (b) POSTs a push payload when a pane transitions INTO the "waiting on you"
// state.
//
// It generalizes the former Notifier — one scanner backs the push AND the UI,
// so a lamp the deck shows as "waiting" is the exact signal that fires a push:
// no second, drifting definition. The snapshot is ALWAYS maintained (the deck
// needs it regardless); only the push side is gated on cfg.WebhookURL, so a
// stock server keeps a live snapshot but never POSTs.
//
// It reuses the poller's classification verbatim (isAgentCommand + classifyPane
// + stateDebouncer), so the states here are the same as the deck's pane lamps.
type Monitor struct {
	cfg    config.NotifyConfig
	tx     monitorReader
	client *http.Client
	host   string // host label stamped on every AgentStatus (Phase 7 federates)

	// rec holds the I4 opt-in per-pane replay recordings. Always present (empty
	// until a pane is recorded); the scan feeds it, the record/frames handlers
	// drive it.
	rec *recorder

	// fetchPeer polls one I6 peer's /api/agents. Injected so mergePeers is
	// unit-testable without a live network; defaults to httpFetchPeer.
	fetchPeer peerFetcher

	// pidAlive reports whether an external-registry entry's pid is still a live
	// process. Injected so mergeExternal's liveness gate is unit-testable without
	// spawning real processes; defaults to pidAliveSyscall (kill-0).
	pidAlive func(pid int) bool

	// Presence overlay (the fourth agent source, presence.go) — a best-effort ps
	// sweep for AI CLIs whose hooks aren't wired. Both are inert no-ops by default
	// so the fake-reader unit tests never see the overlay; NewMonitor upgrades
	// them to the live scan ONLY when tx is a real *tmuxctl.Client (production).
	// Injected directly in the presence unit tests.
	psScan   func() (string, bool)                     // `ps -axo pid=,tt=,args=` stdout; false on failure
	paneTTYs func(ctx context.Context) map[string]bool // normalized tmux pane tty set (exclusion)

	// presenceSeen records first-seen unix time per pid for the presence overlay's
	// SinceUnix. Touched ONLY by the scan goroutine (same discipline as Run's
	// debounce/prev/since locals) so it needs no lock; it lives on the struct
	// rather than as another scan() parameter purely to keep that signature from
	// growing. Bounded + self-cleaning: mergePresence deletes a pid the moment it
	// leaves the ps table.
	presenceSeen map[int]int64

	// mu guards snapshot/genAt, read by the /api/agents handler goroutine and
	// written by the single scan goroutine.
	mu       sync.RWMutex
	snapshot []AgentStatus
	genAt    time.Time
}

// monitorReader is the narrow slice of *tmuxctl.Client the Monitor reads
// through — the poller's paneReader (ListPanes+CapturePane) plus ListSessions,
// which the Monitor needs because it scans every session (not one). Kept as an
// interface so the snapshot/transition logic is unit-testable without live tmux.
type monitorReader interface {
	paneReader
	ListSessions(ctx context.Context) ([]tmuxctl.Session, error)
}

func NewMonitor(cfg config.NotifyConfig, tx monitorReader) *Monitor {
	m := &Monitor{
		cfg:          cfg,
		tx:           tx,
		client:       &http.Client{Timeout: 8 * time.Second},
		host:         "local",
		rec:          newRecorder(cfg.RecordMaxFrames, cfg.RecordMaxBytes),
		presenceSeen: map[int]int64{},
	}
	m.fetchPeer = m.httpFetchPeer
	m.pidAlive = pidAliveSyscall
	// Presence overlay defaults to inert no-ops — this keeps it out of the
	// fake-reader unit tests (which assert exact agent counts). A real tmux client
	// upgrades it to the live ps sweep + pane-tty exclusion.
	m.psScan = func() (string, bool) { return "", false }
	m.paneTTYs = func(context.Context) map[string]bool { return nil }
	if lister, ok := tx.(paneTTYLister); ok {
		m.psScan = psScanExec
		m.paneTTYs = func(ctx context.Context) map[string]bool {
			return normalizeTTYSet(lister.PaneTTYs(ctx))
		}
	}
	return m
}

func (m *Monitor) interval() time.Duration {
	if m.cfg.Interval > 0 {
		return time.Duration(m.cfg.Interval * float64(time.Second))
	}
	return 3 * time.Second
}

func (m *Monitor) cooldown() time.Duration {
	if m.cfg.Cooldown > 0 {
		return time.Duration(m.cfg.Cooldown * float64(time.Second))
	}
	return 60 * time.Second
}

// Snapshot returns a copy of the current agent status list and the time it was
// generated. Safe to call from any goroutine.
func (m *Monitor) Snapshot() ([]AgentStatus, time.Time) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]AgentStatus, len(m.snapshot))
	copy(out, m.snapshot)
	return out, m.genAt
}

// ResolveAgentPane maps a (session, pane) request — where pane is either the
// tmux pane id ("%5") or the pane index ("2") — to the pane's canonical PaneID,
// but ONLY if it currently appears in the snapshot (which holds agent panes
// only). This is the I4 gate: a non-agent / unknown pane returns ok=false, so
// the record/frames handlers reject it. Matching PaneID first keeps it
// unambiguous when the caller passes the id from /api/agents; the index match is
// a convenience for the first pane of that index.
func (m *Monitor) ResolveAgentPane(session, pane string) (paneID string, ok bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, a := range m.snapshot {
		if a.Session != session {
			continue
		}
		if a.PaneID == pane || strconv.Itoa(a.Pane) == pane {
			return a.PaneID, true
		}
	}
	return "", false
}

// StartRecording / StopRecording / IsRecording / Frames are the I4 handler
// surface, keyed by the same session-namespaced pane key the scan uses.
func (m *Monitor) StartRecording(session, paneID string) { m.rec.start(notifyKey(session, paneID)) }
func (m *Monitor) StopRecording(session, paneID string)  { m.rec.stop(notifyKey(session, paneID)) }
func (m *Monitor) IsRecording(session, paneID string) bool {
	return m.rec.isRecording(notifyKey(session, paneID))
}
func (m *Monitor) Frames(session, paneID string) ([]Frame, bool) {
	return m.rec.frames(notifyKey(session, paneID))
}

// Run blocks until ctx is cancelled; start it in a goroutine at server startup.
// Unlike the old Notifier it does NOT early-return on a missing WebhookURL — it
// always maintains the snapshot; the push is gated per-pane inside scan.
func (m *Monitor) Run(ctx context.Context) {
	slog.Info("agent monitor started", "interval", m.interval().String(), "push", m.cfg.WebhookURL != "")

	// All maps are touched only from this single goroutine — no locking.
	debounce := map[string]*stateDebouncer{} // key -> flicker suppressor
	prev := map[string]string{}              // key -> last published state
	since := map[string]int64{}              // key -> unix when it entered prev state
	lastPush := map[string]time.Time{}       // key -> last webhook fire (cooldown)
	rings := map[string]*stateRing{}         // key -> per-pane state-transition ring (I3)

	// Prime the snapshot immediately so /api/agents isn't empty for the first
	// interval after startup.
	m.scan(ctx, time.Now(), debounce, prev, since, lastPush, rings)

	ticker := time.NewTicker(m.interval())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.scan(ctx, time.Now(), debounce, prev, since, lastPush, rings)
		}
	}
}

// notifyKey namespaces a pane by session so the same pane id in two sessions
// never collides. NUL can't appear in a session name or pane id.
func notifyKey(session, paneID string) string { return session + "\x00" + paneID }

// shouldNotify decides whether a pane's state change warrants a push: only on
// the edge INTO waiting (prev was something else), and not within the per-pane
// cooldown of the last push. Pure so the edge/throttle logic is unit-testable
// without a live tmux.
func shouldNotify(prev, cur string, lastPush, now time.Time, cooldown time.Duration) bool {
	if cur != "waiting" || prev == "waiting" {
		return false
	}
	return now.Sub(lastPush) >= cooldown
}

// scan runs one pass over every session: classifies each agent pane, rebuilds
// the snapshot, updates the per-pane state-entry timestamps, and fires the push
// on any into-waiting edge (when a webhook is configured). now is injected so
// the timestamp/cooldown logic stays deterministic under test.
func (m *Monitor) scan(ctx context.Context, now time.Time, debounce map[string]*stateDebouncer, prev map[string]string, since map[string]int64, lastPush map[string]time.Time, rings map[string]*stateRing) {
	sessions, err := m.tx.ListSessions(ctx)
	if err != nil {
		return // tmux gone / transient — keep the last snapshot, try again next tick
	}
	live := make(map[string]bool)
	var agents []AgentStatus
	for _, s := range sessions {
		panes, err := m.tx.ListPanes(ctx, s.Name)
		if err != nil {
			continue
		}
		for _, p := range panes {
			key := notifyKey(s.Name, p.ID)
			live[key] = true
			st, tail := m.classify(ctx, s.Name, p, debounce, key)
			if st == "" {
				continue // not an agent pane, or a held capture flake
			}
			ring := rings[key]
			if ring == nil {
				ring = newStateRing(timelineCap)
				rings[key] = ring
			}
			// sinceUnix = when the pane ENTERED its current state. Only reset on a
			// real state change; a pane sitting in "waiting" keeps its original
			// entry time so the deck can render "waiting 4m". The same edge appends
			// the transition to the per-pane timeline ring (I3).
			if prev[key] != st {
				since[key] = now.Unix()
				ring.push(st, now.Unix())
			}
			preview := lastNonEmptyLine(tail)
			cpct, cused, cmax, _ := parseContextLine(tail)
			agents = append(agents, AgentStatus{
				Host:        m.host,
				Session:     s.Name,
				Window:      p.Window,
				WindowName:  p.WindowName,
				Pane:        p.Pane,
				PaneID:      p.ID,
				Tool:        p.Command,
				State:       st,
				SinceUnix:   since[key],
				TailPreview: preview,
				ContextPct:  cpct,
				TokensUsed:  cused,
				TokensMax:   cmax,
				Recent:      ring.snapshot(),
			})
			// I4: if this pane is being recorded, capture its ANSI-preserved
			// content and hand it to the recorder (which retains a frame only on a
			// real change). Opt-in, so no capture cost for panes that aren't
			// recording. Errors are swallowed — a transient capture flake just
			// skips a frame, never breaks the scan.
			if m.rec.isRecording(key) {
				if raw, cerr := m.tx.CapturePane(ctx, s.Name+":"+p.ID, recordCaptureLines); cerr == nil {
					m.rec.record(key, raw, now.Unix())
				}
			}
			// Fire only on the edge INTO waiting, throttled per pane so a pane that
			// sits in waiting doesn't re-alert every tick. Gated on a webhook.
			if m.cfg.WebhookURL != "" && shouldNotify(prev[key], st, lastPush[key], now, m.cooldown()) {
				m.fire(ctx, s.Name, p, preview)
				lastPush[key] = now
			}
			prev[key] = st
		}
	}
	// Reap state for panes that vanished so the maps don't grow unbounded.
	for k := range debounce {
		if !live[k] {
			delete(debounce, k)
			delete(prev, k)
			delete(since, k)
			delete(lastPush, k)
			delete(rings, k)
		}
	}
	// Free replay buffers for panes that vanished (I4). Kept separate from the
	// debounce-keyed reap above because a recording can outlive its debounce
	// entry only briefly; reap is idempotent.
	m.rec.reap(live)

	// Third source: the external-agent registry (headless children / other CLIs
	// that aren't tmux panes we scanned). Appended AFTER the local scan and
	// BEFORE mergePeers, so a peer polling our /api/agents federates these too
	// (its tagPeerAgents re-stamps Host + prefixes PaneID — no collision). It also
	// collects every registry pid so the presence overlay below can exclude a
	// process the hook already tracks.
	regPIDs := map[int]bool{}
	agents = m.mergeExternal(agents, regPIDs)

	// Fourth source: the process-presence overlay (presence.go) — a best-effort ps
	// sweep for AI CLIs whose hooks aren't wired (hermes especially). On/Off only
	// (state "unknown"); excludes anything a tmux pane already owns (tty match) or
	// the registry already tracks (pid match). Ordered after mergeExternal so both
	// dedup inputs are ready, and before mergePeers so peers federate it too.
	agents = m.mergePresence(ctx, agents, regPIDs, now.Unix())

	// I6: federate STATUS ONLY from configured peers. Local classification is
	// already done above, so a dead/slow peer only delays publishing (bounded by
	// the per-peer timeout) — it never affects the local agents. Remote agents
	// are host-tagged and pane-id-prefixed inside mergePeers.
	agents = m.mergePeers(ctx, agents)

	m.mu.Lock()
	m.snapshot = agents
	m.genAt = now
	m.mu.Unlock()
}

// classify mirrors sessionPoller.collectPaneStates for one pane (same rules,
// same debounce) and additionally returns the ANSI-stripped capture tail so the
// caller can derive tailPreview without a second capture. Returns ("","") for a
// non-agent pane, or (held previous state, "") on a transient capture flake
// (never a spurious idle — B2 invariant).
func (m *Monitor) classify(ctx context.Context, session string, p tmuxctl.Pane, debounce map[string]*stateDebouncer, key string) (string, string) {
	var det detection
	var tail string
	classified := false
	if isAgentCommand(p.Command) {
		raw, err := m.tx.CapturePane(ctx, session+":"+p.ID, 30)
		if err != nil {
			if d := debounce[key]; d != nil {
				return d.published, "" // hold through the flake, no preview
			}
			return "", ""
		}
		tail = stripAnsi(raw)
		det = classifyPane(tail, p.Title, p.Command)
		if det.rule == "" {
			det.state = "idle"
		}
		classified = true
	} else if isAgentHostCommand(p.Command) {
		det = classifyTitleOnly(p.Title)
		classified = true
	}
	if !classified {
		return "", ""
	}
	d := debounce[key]
	if d == nil {
		d = &stateDebouncer{}
		debounce[key] = d
	}
	return d.observe(det), tail
}

// fire builds a push payload shaped like the workshop notification module's
// PushPayload (title/body/url/tag/category/severity) and POSTs it. preview is
// the pane's last non-empty line (already computed by scan) so fire doesn't
// re-capture. The tag keys off session:window:pane so a re-fire dedups against
// the backend's own tag TTL as a second line of defense.
func (m *Monitor) fire(ctx context.Context, session string, p tmuxctl.Pane, preview string) {
	title := "⏳ " + session + ":" + p.WindowName + " 在等你" // ⏳ …在等你
	body := "點開回覆"                                        // 點開回覆
	if !m.cfg.NoPreview && preview != "" {
		body = preview
	}
	base := m.cfg.URLBase
	if base == "" {
		base = "/"
	}
	payload := map[string]any{
		"title":    title,
		"body":     body,
		"url":      base,
		"tag":      "tmux-waiting:" + session + ":" + strconv.Itoa(p.Window) + ":" + p.ID,
		"category": "agent", // must be a core PushPayload category enum value
		"severity": "high",
	}
	m.post(ctx, payload)
}

func (m *Monitor) post(ctx context.Context, payload map[string]any) {
	b, err := json.Marshal(payload)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.cfg.WebhookURL, bytes.NewReader(b))
	if err != nil {
		slog.Warn("notify build request failed", "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range m.cfg.WebhookHeaders {
		req.Header.Set(k, v)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		slog.Warn("notify webhook post failed", "err", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		slog.Warn("notify webhook non-2xx", "status", resp.StatusCode)
	}
}

// ctxTokRe matches a `used/max` token pair with optional k/M scale suffixes,
// ctxPctRe a bare percentage. Both are deliberately loose so a legacy status
// line (percentage only, or tokens only) still yields something usable.
var (
	ctxTokRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*([kKmM]?)\s*/\s*(\d+(?:\.\d+)?)\s*([kKmM]?)`)
	ctxPctRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*%`)
)

// scaleToken parses a token count with an optional k/M suffix into an int
// (`32.1k` → 32100, `2M` → 2000000). A malformed number yields 0.
func scaleToken(num, suffix string) int {
	v, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	switch suffix {
	case "k", "K":
		v *= 1000
	case "m", "M":
		v *= 1_000_000
	}
	return int(v)
}

// parseContextLine extracts the agent's context %/token burn from the pane's
// (ANSI-stripped) capture tail. It scans for a line mentioning "context" and,
// from that word onward, reads a percentage and/or a `used/max` token pair
// (k/M suffixes honoured). When only tokens are present the percentage is
// derived; when only a percentage is present tokens stay 0. PURE and tolerant:
// a missing/legacy/junk line returns (0,0,0,false) and never panics — the hard
// gate is TestParseContextLine.
func parseContextLine(tail string) (pct float64, used, max int, ok bool) {
	for _, ln := range strings.Split(tail, "\n") {
		i := strings.Index(strings.ToLower(ln), "context")
		if i < 0 {
			continue
		}
		// Slice from "context" onward so an unrelated % earlier in the line
		// (e.g. a progress bar) can't be mistaken for the context figure.
		seg := ln[i:]
		var p float64
		var u, mx int
		if m := ctxTokRe.FindStringSubmatch(seg); m != nil {
			u = scaleToken(m[1], m[2])
			mx = scaleToken(m[3], m[4])
		}
		if m := ctxPctRe.FindStringSubmatch(seg); m != nil {
			if v, err := strconv.ParseFloat(m[1], 64); err == nil {
				p = v
			}
		}
		if p == 0 && mx > 0 {
			p = float64(u) / float64(mx) * 100
		}
		if p != 0 || mx > 0 {
			return p, u, mx, true
		}
	}
	return 0, 0, 0, false
}

// peerFetcher polls one I6 peer's /api/agents and returns its agent list.
// Injected into the Monitor so mergePeers stays testable without a live network.
type peerFetcher func(ctx context.Context, base string) ([]AgentStatus, error)

// peerTimeout bounds each peer poll so a dead/slow peer never stalls the scan.
// Deliberately short — status federation is best-effort, not a hard dependency.
const peerTimeout = 2 * time.Second

// mergePeers appends each configured peer's agents (host-tagged, pane-id
// prefixed) onto the local list. Best-effort: a peer that errors is logged and
// skipped, never dropping the local agents. Peers are polled sequentially; each
// is bounded by peerTimeout inside httpFetchPeer.
// ponytail: sequential polls; parallelize with a bounded errgroup if a
// deployment ever federates many peers and the added latency matters.
func (m *Monitor) mergePeers(ctx context.Context, local []AgentStatus) []AgentStatus {
	merged := local
	for _, peer := range m.cfg.Peers {
		peer = strings.TrimSpace(peer)
		if peer == "" {
			continue
		}
		remote, err := m.fetchPeer(ctx, peer)
		if err != nil {
			slog.Warn("peer agents fetch failed (skipped)", "peer", peer, "err", err)
			continue
		}
		merged = append(merged, tagPeerAgents(peerHostLabel(peer), remote)...)
	}
	return merged
}

// peerHostLabel derives a short host label from a peer base URL
// ("http://host-b:10105" → "host-b"). Falls back to the trimmed raw string when
// the URL has no parseable host, so the label is never empty.
func peerHostLabel(base string) string {
	base = strings.TrimSpace(base)
	if u, err := url.Parse(base); err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	return strings.TrimRight(base, "/")
}

// tagPeerAgents stamps a peer's agents with host=<label> and host-prefixes each
// PaneID ("<label>/<paneID>") so ids from different hosts never collide in the
// merged snapshot. PURE (no network, no clock, input untouched) — the I6 hard
// gate exercises the merge through an injected fetch. The peer reports its own
// agents as host "local"; we overwrite that with the direct-peer label
// (transitive federation collapses provenance to the direct peer — fine for LAN
// status).
func tagPeerAgents(host string, agents []AgentStatus) []AgentStatus {
	if len(agents) == 0 {
		return nil
	}
	out := make([]AgentStatus, 0, len(agents))
	for _, a := range agents {
		a.Host = host
		a.PaneID = host + "/" + a.PaneID
		out = append(out, a)
	}
	return out
}

// httpFetchPeer GETs base+"/api/agents" and decodes the agent list, carrying the
// configured peer token as the tw_token cookie (peers are trusted LAN). A SHORT
// per-request timeout (peerTimeout) keeps a dead peer from blocking the scan.
func (m *Monitor) httpFetchPeer(ctx context.Context, base string) ([]AgentStatus, error) {
	rctx, cancel := context.WithTimeout(ctx, peerTimeout)
	defer cancel()
	endpoint := strings.TrimRight(strings.TrimSpace(base), "/") + "/api/agents"
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if m.cfg.PeerToken != "" {
		req.AddCookie(&http.Cookie{Name: "tw_token", Value: m.cfg.PeerToken})
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("peer %s: HTTP %d", base, resp.StatusCode)
	}
	var payload struct {
		Agents []AgentStatus `json:"agents"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Agents, nil
}

// lastNonEmptyLine returns the last non-blank line, trimmed and capped so a
// runaway pane can't stuff the push body / tailPreview. Rune-safe cap (~120
// runes).
func lastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		t := strings.TrimSpace(lines[i])
		if t == "" {
			continue
		}
		r := []rune(t)
		if len(r) > 120 {
			t = string(r[:120]) + "…"
		}
		return t
	}
	return ""
}
