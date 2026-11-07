package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
)

// TestPeerHostLabel: a peer base URL folds to a short host label; a garbage /
// hostless string falls back to the trimmed raw so the label is never empty.
func TestPeerHostLabel(t *testing.T) {
	cases := []struct{ in, want string }{
		{"http://host-b:10105", "host-b"},
		{"http://192.168.1.9:9527/", "192.168.1.9"},
		{"https://mac-studio.tail-scale.ts.net", "mac-studio.tail-scale.ts.net"},
		{"  http://host-d/  ", "host-d"}, // surrounding whitespace trimmed before parse
	}
	for _, c := range cases {
		if got := peerHostLabel(c.in); got != c.want {
			t.Fatalf("peerHostLabel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestTagPeerAgents is a purity gate: each remote agent is stamped host=<label>
// and its PaneID host-prefixed; the input slice is not mutated; empty → nil.
func TestTagPeerAgents(t *testing.T) {
	if got := tagPeerAgents("host-b", nil); got != nil {
		t.Fatalf("tagPeerAgents(empty) = %+v, want nil", got)
	}
	in := []AgentStatus{
		{Host: "local", Session: "projX", PaneID: "1.0", State: "waiting"},
		{Host: "local", Session: "projY", PaneID: "%7", State: "working"},
	}
	got := tagPeerAgents("host-b", in)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Host != "host-b" || got[0].PaneID != "host-b/1.0" {
		t.Fatalf("agent0 = %+v, want host=host-b paneID=host-b/1.0", got[0])
	}
	if got[1].Host != "host-b" || got[1].PaneID != "host-b/%7" {
		t.Fatalf("agent1 = %+v, want host=host-b paneID=host-b/%%7", got[1])
	}
	// Session/State carried through untouched.
	if got[0].Session != "projX" || got[0].State != "waiting" {
		t.Fatalf("agent0 non-host fields altered: %+v", got[0])
	}
	// Input slice must be untouched (pure).
	if in[0].Host != "local" || in[0].PaneID != "1.0" {
		t.Fatalf("input mutated: %+v", in[0])
	}
}

// TestMergePeers is the I6 hard gate: with an INJECTED fetch (no network), the
// merge appends a live peer's agents (host-tagged, pane-id-prefixed) onto the
// local list, keeps the local agents' host="local" untouched, and SKIPS a dead
// peer without dropping anything.
func TestMergePeers(t *testing.T) {
	local := []AgentStatus{
		{Host: "local", Session: "localS", PaneID: "2.0", State: "working"},
	}

	var calls []string
	m := NewMonitor(config.NotifyConfig{
		Peers: []string{"http://good:9527", "http://dead:9527", "  ", "http://empty:9527"},
	}, nil)
	m.fetchPeer = func(ctx context.Context, base string) ([]AgentStatus, error) {
		calls = append(calls, base)
		switch base {
		case "http://good:9527":
			return []AgentStatus{
				{Host: "local", Session: "remoteS", PaneID: "1.0", State: "waiting"},
			}, nil
		case "http://dead:9527":
			return nil, errors.New("connection refused")
		case "http://empty:9527":
			return nil, nil // reachable but no agents
		}
		return nil, errors.New("unexpected peer " + base)
	}

	merged := m.mergePeers(context.Background(), local)

	// Blank peer entry is skipped before any fetch; the other three are polled.
	wantCalls := []string{"http://good:9527", "http://dead:9527", "http://empty:9527"}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("fetch calls = %v, want %v", calls, wantCalls)
	}

	// local (1) + good peer (1); dead + empty contribute nothing.
	if len(merged) != 2 {
		t.Fatalf("merged has %d agents, want 2: %+v", len(merged), merged)
	}
	if merged[0].Host != "local" || merged[0].PaneID != "2.0" {
		t.Fatalf("local agent altered: %+v", merged[0])
	}
	remote := merged[1]
	if remote.Host != "good" || remote.PaneID != "good/1.0" || remote.Session != "remoteS" || remote.State != "waiting" {
		t.Fatalf("remote agent = %+v, want host=good paneID=good/1.0 session=remoteS state=waiting", remote)
	}

	// The original local slice must not have been mutated by the merge.
	if len(local) != 1 || local[0].PaneID != "2.0" || local[0].Host != "local" {
		t.Fatalf("input local slice mutated: %+v", local)
	}
}

// TestMergePeersNoPeers: with no peers configured the local list is returned
// unchanged (the default fetchPeer is never invoked).
func TestMergePeersNoPeers(t *testing.T) {
	local := []AgentStatus{{Host: "local", Session: "s", PaneID: "0.0", State: "idle"}}
	m := NewMonitor(config.NotifyConfig{}, nil)
	m.fetchPeer = func(ctx context.Context, base string) ([]AgentStatus, error) {
		t.Fatalf("fetchPeer must not be called with no peers configured (base=%q)", base)
		return nil, nil
	}
	got := m.mergePeers(context.Background(), local)
	if !reflect.DeepEqual(got, local) {
		t.Fatalf("mergePeers(no peers) = %+v, want %+v", got, local)
	}
}

// TestHttpFetchPeer exercises the real HTTP path against a stub peer: it hits
// /api/agents, carries the configured PeerToken as the tw_token cookie, and
// decodes the {agents:[...]} envelope. A non-200 is surfaced as an error so
// mergePeers skips it.
func TestHttpFetchPeer(t *testing.T) {
	var gotPath, gotCookie string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if c, err := r.Cookie("tw_token"); err == nil {
			gotCookie = c.Value
		}
		_, _ = w.Write([]byte(`{"agents":[{"session":"s","paneID":"1.0","state":"waiting","host":"local"}],"generated_at":1}`))
	}))
	defer srv.Close()

	m := NewMonitor(config.NotifyConfig{PeerToken: "tok-abc"}, nil)
	agents, err := m.httpFetchPeer(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("httpFetchPeer error: %v", err)
	}
	if gotPath != "/api/agents" {
		t.Fatalf("peer path = %q, want /api/agents", gotPath)
	}
	if gotCookie != "tok-abc" {
		t.Fatalf("tw_token cookie = %q, want tok-abc", gotCookie)
	}
	if len(agents) != 1 || agents[0].Session != "s" || agents[0].State != "waiting" {
		t.Fatalf("decoded agents = %+v, want one waiting agent for session s", agents)
	}

	// A non-200 peer surfaces an error (mergePeers logs + skips it).
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer bad.Close()
	if _, err := m.httpFetchPeer(context.Background(), bad.URL); err == nil {
		t.Fatalf("non-200 peer must return an error")
	}
}
