package fedproxy

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/operonlab/tmux-webui/internal/config"
)

const (
	// hostDialTimeout bounds TCP connection establishment to a host. A sleeping
	// Mac is a packet BLACK HOLE (drops SYNs, no RST), so without a dial-level
	// cap every touch of a dead host rides the caller's full context deadline —
	// the 2026-07-06 incident: each phone /api/sessions stalled the whole 4s
	// fan-out budget, and the primary ate it all so the fallback base was never
	// even tried. 1.2s is generous for LAN/Tailscale handshakes and leaves
	// budget for the fallback.
	hostDialTimeout = 1200 * time.Millisecond
	// hostDownWindow is the negative-cache TTL after a connection failure:
	// while it lasts the host is skipped outright (session fan-out) or failed
	// fast (forward/WS) instead of re-dialing a known black hole per request.
	hostDownWindow = 30 * time.Second
)

// newHostClient is the per-host HTTP client: dial-bounded (see hostDialTimeout)
// and proxy-free — bases are internal LAN/Tailscale URLs, an env proxy must
// never intercept them. Response streaming stays bounded per call via context.
func newHostClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext:         (&net.Dialer{Timeout: hostDialTimeout}).DialContext,
		TLSHandshakeTimeout: 3 * time.Second,
	}}
}

// Host is the hub's client for ONE remote tmux-webui instance. It owns the
// primary + fallback base URLs, the shared tw_token, and a sticky record of
// which base last worked so a healthy request path is reused without re-probing.
// Never copy a Host — the mutex and atomic pointer must stay put; always *Host.
type Host struct {
	name     string
	primary  string // base URL, trailing slash trimmed (e.g. "http://mbp:9527")
	fallback string // optional secondary base, tried once on a connection failure
	token    string // carried as the tw_token cookie on every forwarded request
	client   *http.Client

	// sticky remembers the base that most recently succeeded (primary or
	// fallback) so baseOrder tries it first. Atomic — read/written across the
	// concurrent session fan-out and per-request forwards.
	sticky atomic.Pointer[string]

	// reach* drives once-per-transition reachability logging (fail-soft: a dead
	// host is skipped silently every scan, but a state FLIP is logged once).
	reachMu    sync.Mutex
	reachKnown bool
	reachable  bool

	// down* is the negative cache (see hostDownWindow): set on a connection
	// failure, cleared on any success. Checked before every dial so a black
	// hole costs at most one hostDialTimeout per window, not one per request.
	downMu    sync.Mutex
	downUntil time.Time
}

// Registry holds the hub's hosts, keyed by name for O(1) resolve and ordered by
// config position for a deterministic session fan-out.
type Registry struct {
	order []*Host
	hosts map[string]*Host
}

// NewRegistry builds a Registry from validated host configs (config.Load has
// already enforced non-empty/unique/no-slash/not-"local" names). A nil/empty
// list yields an empty Registry whose Empty() is true — the caller then keeps
// every path byte-identical to a standalone server.
func NewRegistry(hosts []config.HostConfig) *Registry {
	r := &Registry{hosts: make(map[string]*Host, len(hosts))}
	for _, hc := range hosts {
		h := &Host{
			name:     hc.Name,
			primary:  strings.TrimRight(strings.TrimSpace(hc.URL), "/"),
			fallback: strings.TrimRight(strings.TrimSpace(hc.FallbackURL), "/"),
			token:    hc.Token,
			client:   newHostClient(), // no Client.Timeout — bounded per call via context
		}
		r.order = append(r.order, h)
		r.hosts[h.name] = h
	}
	return r
}

// Empty reports whether any hosts are configured. When true, callers take the
// unfederated fast path (no fan-out, no proxy checks).
func (r *Registry) Empty() bool { return r == nil || len(r.order) == 0 }

// Host returns the configured host by name.
func (r *Registry) Host(name string) (*Host, bool) {
	if r == nil {
		return nil, false
	}
	h, ok := r.hosts[name]
	return h, ok
}

// Name returns the host's configured name (its session prefix).
func (h *Host) Name() string { return h.name }

// SplitTarget splits a federated target "<host>/<session>" on the FIRST "/".
// A target with no "/" has an empty host (a plain local session name). This is
// the naive split; use Registry.Resolve for authoritative routing, which also
// requires the prefix to be a CONFIGURED host — tmux permits "/" inside a local
// session name, so the "/" alone is not proof of a remote target.
func SplitTarget(s string) (host, session string) {
	if i := strings.IndexByte(s, '/'); i >= 0 {
		return s[:i], s[i+1:]
	}
	return "", s
}

// Resolve maps a wire target to its owning host. remote is true ONLY when the
// target is "<host>/<session>" AND <host> is a configured host name; otherwise
// remote is false and the caller serves it locally (target may be a local
// session whose own name contains "/", which is returned intact as session).
func (r *Registry) Resolve(target string) (h *Host, session string, remote bool) {
	if r == nil {
		return nil, target, false
	}
	host, sess := SplitTarget(target)
	if host == "" {
		return nil, target, false
	}
	hh, ok := r.hosts[host]
	if !ok {
		return nil, target, false
	}
	return hh, sess, true
}

// baseOrder is the sequence of base URLs a request tries: the sticky (last-good)
// base first, then the primary, then the fallback, deduplicated. This collapses
// to [primary, fallback] normally, or [fallback, primary] after the fallback
// last won — so a connection failure retries the OTHER base exactly once.
func (h *Host) baseOrder() []string {
	var order []string
	seen := map[string]bool{}
	add := func(b string) {
		if b != "" && !seen[b] {
			seen[b] = true
			order = append(order, b)
		}
	}
	if p := h.sticky.Load(); p != nil {
		add(*p)
	}
	add(h.primary)
	add(h.fallback)
	return order
}

// rememberBase records which base URL just succeeded so baseOrder prefers it.
func (h *Host) rememberBase(base string) {
	b := base
	h.sticky.Store(&b)
}

// markDown starts (or refreshes) the negative-cache window after a connection
// failure. HTTP status errors never mark down — a host that answered is up.
func (h *Host) markDown() {
	h.downMu.Lock()
	h.downUntil = time.Now().Add(hostDownWindow)
	h.downMu.Unlock()
}

// markUp clears the negative cache on any successful contact.
func (h *Host) markUp() {
	h.downMu.Lock()
	h.downUntil = time.Time{}
	h.downMu.Unlock()
}

// Down reports whether the host is inside its negative-cache window.
func (h *Host) Down() bool {
	h.downMu.Lock()
	defer h.downMu.Unlock()
	return time.Now().Before(h.downUntil)
}

// noteReachable logs a host's reachability only on a STATE CHANGE (fail-soft):
// a first-time-reachable host is silent, an unreachable host warns once (and
// again only if it flaps), and a recovery logs once. err==nil means reachable.
func (h *Host) noteReachable(err error) {
	ok := err == nil
	h.reachMu.Lock()
	defer h.reachMu.Unlock()
	if h.reachKnown && h.reachable == ok {
		return
	}
	firstObs := !h.reachKnown
	h.reachKnown = true
	h.reachable = ok
	switch {
	case !ok:
		slog.Warn("federation host unreachable (skipped)", "host", h.name, "err", err)
	case !firstObs:
		slog.Info("federation host recovered", "host", h.name)
	}
}
