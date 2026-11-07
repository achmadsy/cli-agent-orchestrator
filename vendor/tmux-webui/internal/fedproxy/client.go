package fedproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

const (
	// sessionFanoutTimeout bounds the whole /api/sessions fan-out so a dead host
	// never delays the merged list past budget — the local sessions (already in
	// hand) plus whatever hosts answered in time are returned. The session list
	// gates the PWA's boot UX, so this stays tight: a black-hole host already
	// fails at hostDialTimeout (1.2s) and is then negative-cached (~0ms).
	sessionFanoutTimeout = 2 * time.Second
	// forwardTimeout bounds one proxied REST request end-to-end. Generous enough
	// to cover the remote's deepest handler (/api/history caps at 10s) plus slack.
	forwardTimeout = 15 * time.Second
	// forwardBodyCap bounds a proxied request body (create/rename payloads are tiny).
	forwardBodyCap = 8 << 20
	// decodeCap bounds a decoded peer JSON response.
	decodeCap = 8 << 20
)

// Session is the hub's merged session-list entry. It mirrors the local session
// shape and adds host: empty (omitted) for a local session, "<name>" for a
// remote one, so the frontend CAN group by machine without parsing the name.
type Session struct {
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Attached int    `json:"attached"`
	Host     string `json:"host,omitempty"`
}

// remoteSession is the subset of a host's /api/sessions entry the hub reads. A
// transitively-federated host may also send a host field; we ignore it and
// re-tag with the DIRECT host name (provenance collapses to the direct hop —
// fine for a LAN mesh, matching monitor.go's tagPeerAgents).
type remoteSession struct {
	Name     string `json:"name"`
	Windows  int    `json:"windows"`
	Attached int    `json:"attached"`
}

// MergeSessions returns the local sessions (host="") followed by each host's
// sessions (host="<name>", name prefixed "<name>/…"), fanned out concurrently
// under a short shared deadline. A host that errors or times out contributes
// nothing and is logged only on a reachability change — the local list is never
// dropped or delayed past sessionFanoutTimeout.
func (r *Registry) MergeSessions(ctx context.Context, local []tmuxctl.Session) []Session {
	out := make([]Session, 0, len(local)+len(r.order))
	for _, s := range local {
		out = append(out, Session{Name: s.Name, Windows: s.Windows, Attached: s.Attached})
	}
	if len(r.order) == 0 {
		return out
	}

	fctx, cancel := context.WithTimeout(ctx, sessionFanoutTimeout)
	defer cancel()

	// Each goroutine writes only its own index — no shared-slice race — so the
	// merged order stays deterministic (config order) after the join.
	results := make([][]Session, len(r.order))
	var wg sync.WaitGroup
	for i, h := range r.order {
		wg.Add(1)
		go func(i int, h *Host) {
			defer wg.Done()
			remote, err := h.fetchSessions(fctx)
			h.noteReachable(err)
			if err != nil {
				return
			}
			tagged := make([]Session, 0, len(remote))
			for _, s := range remote {
				tagged = append(tagged, Session{
					Name:     h.name + "/" + s.Name,
					Windows:  s.Windows,
					Attached: s.Attached,
					Host:     h.name,
				})
			}
			results[i] = tagged
		}(i, h)
	}
	wg.Wait()

	for _, rs := range results {
		out = append(out, rs...)
	}
	return out
}

// fetchSessions GETs the host's /api/sessions and decodes the list.
func (h *Host) fetchSessions(ctx context.Context) ([]remoteSession, error) {
	resp, err := h.get(ctx, "/api/sessions")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("host %s: /api/sessions HTTP %d", h.name, resp.StatusCode)
	}
	var out []remoteSession
	if err := json.NewDecoder(io.LimitReader(resp.Body, decodeCap)).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// Forward proxies the incoming request r to this host at path (already
// prefix-stripped, query included), piping the response back verbatim: status
// code, Content-Type, and body. The request body is buffered so a fallback
// retry can replay it. A host that cannot be reached becomes 502 Bad Gateway.
func (h *Host) Forward(w http.ResponseWriter, r *http.Request, path string) {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(io.LimitReader(r.Body, forwardBodyCap))
	}
	if len(body) == 0 {
		body = nil
	}
	h.forward(w, r, path, body, r.Header.Get("Content-Type"))
}

// ForwardBody is Forward with an explicit JSON body — for a handler that already
// consumed r.Body and rewrote it (e.g. POST /api/sessions strips the "host"
// field before forwarding the create).
func (h *Host) ForwardBody(w http.ResponseWriter, r *http.Request, path string, body []byte) {
	h.forward(w, r, path, body, "application/json")
}

func (h *Host) forward(w http.ResponseWriter, r *http.Request, path string, body []byte, contentType string) {
	ctx, cancel := context.WithTimeout(r.Context(), forwardTimeout)
	defer cancel()

	resp, err := h.do(ctx, r.Method, path, body, contentType)
	if err != nil {
		http.Error(w, "federation: host "+h.name+" unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// get is a sticky+fallback GET, used for the session fan-out.
func (h *Host) get(ctx context.Context, path string) (*http.Response, error) {
	return h.do(ctx, http.MethodGet, path, nil, "")
}

// do issues method+path against the host, trying baseOrder (sticky, primary,
// fallback) and retrying the next base only on a CONNECTION failure — a
// reachable host's HTTP error status (401/404/500) is returned as-is, never
// retried. The tw_token cookie is attached when configured. On success the
// winning base is remembered (sticky).
func (h *Host) do(ctx context.Context, method, path string, body []byte, contentType string) (*http.Response, error) {
	if h.Down() {
		return nil, fmt.Errorf("host %s: down (negative-cached, retries within %s)", h.name, hostDownWindow)
	}
	var lastErr error
	for _, base := range h.baseOrder() {
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, base+path, rdr)
		if err != nil {
			return nil, err
		}
		if h.token != "" {
			req.AddCookie(&http.Cookie{Name: "tw_token", Value: h.token})
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := h.client.Do(req)
		if err != nil {
			lastErr = err
			continue // connection failure — fall through to the next base once
		}
		h.markUp()
		h.rememberBase(base)
		return resp, nil
	}
	h.markDown()
	return nil, lastErr
}
