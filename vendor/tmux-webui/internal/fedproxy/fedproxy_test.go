package fedproxy

import (
	"sync"
	"time"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// TestSplitTarget: naive first-"/" split; no "/" → empty host (local).
func TestSplitTarget(t *testing.T) {
	cases := []struct{ in, host, sess string }{
		{"main", "", "main"},
		{"mbp/main", "mbp", "main"},
		{"mbp/a/b", "mbp", "a/b"}, // splits on FIRST slash only
		{"/leading", "", "leading"},
	}
	for _, c := range cases {
		h, s := SplitTarget(c.in)
		if h != c.host || s != c.sess {
			t.Errorf("SplitTarget(%q) = (%q,%q), want (%q,%q)", c.in, h, s, c.host, c.sess)
		}
	}
}

// TestResolve: remote ONLY when the prefix is a configured host; a "/"-bearing
// name whose prefix is NOT a host stays local (tmux permits "/" in a session name).
func TestResolve(t *testing.T) {
	r := NewRegistry([]config.HostConfig{
		{Name: "mbp", URL: "http://mbp:9527"},
		{Name: "studio", URL: "http://studio:9527"},
	})
	cases := []struct {
		target     string
		wantRemote bool
		wantHost   string
		wantSess   string
	}{
		{"plain", false, "", "plain"},           // no slash → local
		{"mbp/main", true, "mbp", "main"},       // configured host → remote
		{"studio/work", true, "studio", "work"}, // configured host → remote
		{"foo/bar", false, "", "foo/bar"},       // unknown prefix → local, name intact
		{"mbp", false, "", "mbp"},               // host name w/o session → local
	}
	for _, c := range cases {
		h, sess, remote := r.Resolve(c.target)
		if remote != c.wantRemote {
			t.Errorf("Resolve(%q) remote=%v, want %v", c.target, remote, c.wantRemote)
			continue
		}
		if !remote {
			if sess != c.wantSess {
				t.Errorf("Resolve(%q) local session=%q, want %q", c.target, sess, c.wantSess)
			}
			continue
		}
		if h.Name() != c.wantHost || sess != c.wantSess {
			t.Errorf("Resolve(%q) = host %q sess %q, want %q/%q", c.target, h.Name(), sess, c.wantHost, c.wantSess)
		}
	}
}

// TestResolveEmptyRegistry: an unfederated (empty/nil) registry never routes remote.
func TestResolveEmptyRegistry(t *testing.T) {
	for _, r := range []*Registry{NewRegistry(nil), nil} {
		if !r.Empty() {
			t.Fatalf("registry should be Empty")
		}
		if _, sess, remote := r.Resolve("mbp/main"); remote || sess != "mbp/main" {
			t.Errorf("empty registry Resolve = (sess=%q remote=%v), want (mbp/main,false)", sess, remote)
		}
	}
}

func TestToWSScheme(t *testing.T) {
	cases := map[string]string{
		"http://mbp:9527":  "ws://mbp:9527",
		"https://mbp:9527": "wss://mbp:9527",
		"mbp:9527":         "mbp:9527", // no scheme → unchanged
		"http://a/b":       "ws://a/b",
	}
	for in, want := range cases {
		if got := toWSScheme(in); got != want {
			t.Errorf("toWSScheme(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestBaseOrder: sticky base first, then primary, then fallback, deduped.
func TestBaseOrder(t *testing.T) {
	h := &Host{primary: "http://p", fallback: "http://f"}
	if got := h.baseOrder(); !eqStr(got, []string{"http://p", "http://f"}) {
		t.Fatalf("cold order = %v, want [p f]", got)
	}
	h.rememberBase("http://f") // fallback last won
	if got := h.baseOrder(); !eqStr(got, []string{"http://f", "http://p"}) {
		t.Fatalf("sticky=fallback order = %v, want [f p]", got)
	}
	// No fallback configured → single base.
	h2 := &Host{primary: "http://p"}
	if got := h2.baseOrder(); !eqStr(got, []string{"http://p"}) {
		t.Fatalf("no-fallback order = %v, want [p]", got)
	}
}

// TestForward proxies method/path/body/cookie to the host and pipes the
// response (status + Content-Type + body) back verbatim.
func TestForward(t *testing.T) {
	var gotMethod, gotPath, gotQuery, gotCookie, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotQuery = r.Method, r.URL.Path, r.URL.RawQuery
		if c, err := r.Cookie("tw_token"); err == nil {
			gotCookie = c.Value
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTeapot) // distinctive status to prove pass-through
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	h := &Host{name: "mbp", primary: srv.URL, token: "tok-xyz", client: &http.Client{}}

	req := httptest.NewRequest(http.MethodPatch, "/api/sessions/mbp%2Fmain", strings.NewReader(`{"name":"renamed"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Forward(rec, req, "/api/sessions/main?foo=bar")

	if gotMethod != http.MethodPatch {
		t.Errorf("method=%q, want PATCH", gotMethod)
	}
	if gotPath != "/api/sessions/main" || gotQuery != "foo=bar" {
		t.Errorf("path=%q query=%q, want /api/sessions/main foo=bar", gotPath, gotQuery)
	}
	if gotCookie != "tok-xyz" {
		t.Errorf("tw_token cookie=%q, want tok-xyz", gotCookie)
	}
	if gotBody != `{"name":"renamed"}` {
		t.Errorf("forwarded body=%q", gotBody)
	}
	if rec.Code != http.StatusTeapot {
		t.Errorf("piped status=%d, want 418", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("piped Content-Type=%q, want application/json", ct)
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Errorf("piped body=%q", rec.Body.String())
	}
}

// TestDoFallback: a dead primary base fails the connection and the fallback is
// tried once; on success the fallback becomes sticky so the next call tries it
// first.
func TestDoFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("from-fallback"))
	}))
	defer srv.Close()

	h := &Host{
		name:     "mbp",
		primary:  "http://127.0.0.1:1", // reserved, connection refused
		fallback: srv.URL,
		client:   &http.Client{},
	}
	resp, err := h.get(context.Background(), "/api/sessions")
	if err != nil {
		t.Fatalf("get with dead primary + live fallback: %v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "from-fallback" {
		t.Errorf("body=%q, want from-fallback", string(b))
	}
	// Fallback is now sticky.
	if p := h.sticky.Load(); p == nil || *p != srv.URL {
		t.Errorf("sticky=%v, want %q", p, srv.URL)
	}
}

// TestDoNoFallbackRetryOnHTTPError: a reachable host returning a non-2xx status
// is NOT retried against the fallback — the status is surfaced as-is.
func TestDoNoFallbackRetryOnHTTPError(t *testing.T) {
	var primaryHits, fallbackHits int
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		primaryHits++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer primary.Close()
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fallbackHits++
	}))
	defer fallback.Close()

	h := &Host{name: "mbp", primary: primary.URL, fallback: fallback.URL, client: &http.Client{}}
	resp, err := h.get(context.Background(), "/api/sessions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status=%d, want 401 (surfaced, not retried)", resp.StatusCode)
	}
	if primaryHits != 1 || fallbackHits != 0 {
		t.Errorf("primary=%d fallback=%d, want 1/0 (HTTP error is not a connection failure)", primaryHits, fallbackHits)
	}
}

// TestMergeSessions: local sessions come first (host=""), then a live host's
// sessions prefixed + host-tagged; a dead host contributes nothing but does not
// drop the local list.
func TestMergeSessions(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/sessions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`[{"name":"work","windows":2,"attached":1},{"name":"scratch","windows":1,"attached":0}]`))
	}))
	defer host.Close()

	r := NewRegistry([]config.HostConfig{
		{Name: "mbp", URL: host.URL},
		{Name: "dead", URL: "http://127.0.0.1:1"},
	})
	local := []tmuxctl.Session{{Name: "main", Windows: 3, Attached: 1}}

	merged := r.MergeSessions(context.Background(), local)

	// local(1) + mbp(2) + dead(0) = 3
	if len(merged) != 3 {
		t.Fatalf("merged len=%d, want 3: %+v", len(merged), merged)
	}
	if merged[0].Name != "main" || merged[0].Host != "" {
		t.Errorf("local[0]=%+v, want name=main host=''", merged[0])
	}
	if merged[1].Name != "mbp/work" || merged[1].Host != "mbp" || merged[1].Windows != 2 {
		t.Errorf("remote[0]=%+v, want mbp/work host=mbp windows=2", merged[1])
	}
	if merged[2].Name != "mbp/scratch" || merged[2].Host != "mbp" {
		t.Errorf("remote[1]=%+v, want mbp/scratch host=mbp", merged[2])
	}
}

// TestMergeSessionsEmpty: no hosts → local list mapped through unchanged (host
// omitted), never nil.
func TestMergeSessionsEmpty(t *testing.T) {
	r := NewRegistry(nil)
	got := r.MergeSessions(context.Background(), []tmuxctl.Session{{Name: "s", Windows: 1}})
	if len(got) != 1 || got[0].Name != "s" || got[0].Host != "" {
		t.Fatalf("got %+v, want single local session s", got)
	}
	if got := r.MergeSessions(context.Background(), nil); got == nil || len(got) != 0 {
		t.Fatalf("nil local → %+v, want empty non-nil slice", got)
	}
}

func eqStr(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// blockingDialTransport hangs every dial until the request context dies, and
// counts attempts — a deterministic stand-in for a sleeping Mac (SYN black
// hole, no RST).
type blockingDialTransport struct {
	mu       sync.Mutex
	attempts int
}

func (t *blockingDialTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.attempts++
	t.mu.Unlock()
	<-req.Context().Done()
	return nil, req.Context().Err()
}

func (t *blockingDialTransport) count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.attempts
}

// TestMergeSessionsBlackholeBudgetAndDownCache is the 2026-07-06 regression:
// a sleeping host made every /api/sessions ride the full fan-out deadline, so
// the phone PWA opened into a multi-second stall on every list. The merged
// list must (a) come back well under the old 4s budget on FIRST contact with a
// black hole, and (b) come back near-instantly on the next call because the
// host is negative-cached as down.
func TestMergeSessionsBlackholeBudgetAndDownCache(t *testing.T) {
	r := NewRegistry([]config.HostConfig{{Name: "mbp", URL: "http://198.51.100.1:9527"}})
	h, _ := r.Host("mbp")
	bt := &blockingDialTransport{}
	h.client = &http.Client{Transport: bt}

	local := []tmuxctl.Session{{Name: "mini", Windows: 1}}

	start := time.Now()
	out := r.MergeSessions(context.Background(), local)
	firstElapsed := time.Since(start)
	if len(out) != 1 || out[0].Name != "mini" {
		t.Fatalf("merged list should hold the local session, got %+v", out)
	}
	if firstElapsed > 3*time.Second {
		t.Fatalf("first contact with a black hole took %v; want under 3s (budget regression)", firstElapsed)
	}
	if !h.Down() {
		t.Fatal("host should be negative-cached down after a connection failure")
	}

	attemptsAfterFirst := bt.count()
	start = time.Now()
	out = r.MergeSessions(context.Background(), local)
	secondElapsed := time.Since(start)
	if len(out) != 1 {
		t.Fatalf("second merge should still hold the local session, got %+v", out)
	}
	if secondElapsed > 100*time.Millisecond {
		t.Fatalf("cached-down host still cost %v on the second merge; want <100ms", secondElapsed)
	}
	if bt.count() != attemptsAfterFirst {
		t.Fatalf("cached-down host was re-dialed (%d → %d attempts)", attemptsAfterFirst, bt.count())
	}
}

// TestDoRecoversAfterDownWindow: a down host must not be down forever — markUp
// on the next success clears the cache (the window itself expiring is plain
// time.Now math, exercised via markDown/markUp directly to stay clock-free).
func TestDoRecoversAfterDownWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	r := NewRegistry([]config.HostConfig{{Name: "air", URL: srv.URL}})
	h, _ := r.Host("air")

	h.markDown()
	if _, err := h.get(context.Background(), "/api/sessions"); err == nil {
		t.Fatal("down-cached host should fail fast, not dial")
	}
	h.markUp()
	resp, err := h.get(context.Background(), "/api/sessions")
	if err != nil {
		t.Fatalf("recovered host should serve again: %v", err)
	}
	resp.Body.Close()
	if h.Down() {
		t.Fatal("successful request must clear the down cache")
	}
}
