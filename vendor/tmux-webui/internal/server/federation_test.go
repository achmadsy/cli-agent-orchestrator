package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/server"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// writeFakeTmux writes a minimal executable tmux stand-in that answers the
// queries a Server issues (list-sessions/windows/panes, show -gv prefix,
// list-keys, capture-pane) with canned output. list-sessions reports one
// session named sessionName; capture-pane echoes its args so a caller can prove
// which target (session:pane) was captured. Reuses the WithBinary pattern the
// history/e2e tests use — no live tmux, so it runs in the normal suite.
func writeFakeTmux(t *testing.T, sessionName string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "faketmux.sh")
	script := "#!/bin/sh\ncase \"$1\" in\n" +
		"list-sessions) printf '%s\\t1\\t0\\t0\\n' '" + sessionName + "' ;;\n" +
		"list-windows) printf '0\\tmain\\t1\\t1\\n' ;;\n" +
		"list-panes) printf '0\\tmain\\t0\\t1\\t80\\t24\\t0\\tbash\\ttitle\\n' ;;\n" +
		"show) echo 'C-b' ;;\n" +
		"list-keys) ;;\n" +
		"capture-pane) echo \"$@\" ;;\n" +
		"*) ;;\n" +
		"esac\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake tmux: %v", err)
	}
	return p
}

// newFedServer spins up a real Server (fake tmux backend) behind an httptest
// server, cleaned up automatically. token != "" makes it token-gated.
func newFedServer(t *testing.T, fakeSession string, hosts []config.HostConfig, token string) *httptest.Server {
	t.Helper()
	cfg := config.Defaults()
	cfg.UploadDir = t.TempDir()
	cfg.Hosts = hosts
	cfg.Token = token
	tx := tmuxctl.New(tmuxctl.WithBinary(writeFakeTmux(t, fakeSession)))
	srv := server.New(&cfg, tx)
	t.Cleanup(srv.Close)
	hs := httptest.NewServer(srv.Mux())
	t.Cleanup(hs.Close)
	return hs
}

// TestFederation_MergedSessionList: the hub's /api/sessions carries its own
// local session (no host field) plus each host's session, name-prefixed
// "<host>/<session>" and tagged host=<name> — the frontend can group by machine
// without parsing names.
func TestFederation_MergedSessionList(t *testing.T) {
	remote := newFedServer(t, "remotework", nil, "")
	hub := newFedServer(t, "localmain", []config.HostConfig{{Name: "rem", URL: remote.URL}}, "")

	resp, err := http.Get(hub.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("GET /api/sessions: %v", err)
	}
	defer resp.Body.Close()

	type sess struct {
		Name string `json:"name"`
		Host string `json:"host"`
	}
	var got []sess
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}

	var local, rem *sess
	for i := range got {
		switch got[i].Name {
		case "localmain":
			local = &got[i]
		case "rem/remotework":
			rem = &got[i]
		}
	}
	if local == nil {
		t.Fatalf("local session 'localmain' missing from %+v", got)
	}
	if local.Host != "" {
		t.Errorf("local session host=%q, want empty", local.Host)
	}
	if rem == nil {
		t.Fatalf("remote session 'rem/remotework' missing from %+v", got)
	}
	if rem.Host != "rem" {
		t.Errorf("remote session host=%q, want rem", rem.Host)
	}
}

// TestFederation_HistoryProxyStripAndCookie: /api/history for a remote session
// hits the host with the prefix stripped from ?session= AND the host token
// carried as the tw_token cookie. Proven through a REAL token-GATED remote: a
// wrong/absent cookie would 401 at the gate, so a 200 with the stripped target
// in the captured content proves both.
func TestFederation_HistoryProxyStripAndCookie(t *testing.T) {
	remote := newFedServer(t, "ignored", nil, "sekret") // token-gated
	hub := newFedServer(t, "localmain", []config.HostConfig{
		{Name: "mbp", URL: remote.URL, Token: "sekret"},    // correct token
		{Name: "bad", URL: remote.URL, Token: "wrong-tok"}, // wrong token
	}, "")

	// Correct token → 200, content is the capture of the STRIPPED target "x:%1".
	q := url.Values{"session": {"mbp/x"}, "pane": {"%1"}, "lines": {"500"}}
	resp, err := http.Get(hub.URL + "/api/history?" + q.Encode())
	if err != nil {
		t.Fatalf("GET /api/history: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("history status=%d, want 200", resp.StatusCode)
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	// fake capture-pane echoes its args: prefix must be stripped (x:, not mbp/x:).
	if !strings.Contains(body.Content, "-t x:%1") {
		t.Errorf("captured target missing stripped session: %q", body.Content)
	}
	if strings.Contains(body.Content, "mbp") {
		t.Errorf("host prefix leaked into forwarded target: %q", body.Content)
	}

	// Wrong token → the gated remote rejects it (401), piped back verbatim.
	q2 := url.Values{"session": {"bad/x"}, "pane": {"%1"}}
	resp2, err := http.Get(hub.URL + "/api/history?" + q2.Encode())
	if err != nil {
		t.Fatalf("GET /api/history (bad token): %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Errorf("bad-token history status=%d, want 401 (proves the cookie is what admits it)", resp2.StatusCode)
	}
}

// TestFederation_WSProxyPipesFrame: dialing the hub's /ws for a remote session
// proxies to the host's /ws and pipes the host's first output frame back to the
// browser end verbatim — asserted by receiving the remote's "windows" frame.
func TestFederation_WSProxyPipesFrame(t *testing.T) {
	remote := newFedServer(t, "remotework", nil, "")
	hub := newFedServer(t, "localmain", []config.HostConfig{{Name: "rem", URL: remote.URL}}, "")

	wsURL, _ := url.Parse(hub.URL)
	wsURL.Scheme = "ws"
	wsURL.Path = "/ws"
	wsURL.RawQuery = "session=" + url.QueryEscape("rem/remotework")

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	c, _, err := websocket.Dial(dialCtx, wsURL.String(), nil)
	if err != nil {
		t.Fatalf("dial hub /ws for remote session: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "test done")

	seen := map[string]bool{}
	deadline := time.Now().Add(4 * time.Second)
	for i := 0; i < 8 && time.Now().Before(deadline); i++ {
		readCtx, readCancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, raw, err := c.Read(readCtx)
		readCancel()
		if err != nil {
			break
		}
		var env map[string]any
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		if typ, ok := env["type"].(string); ok {
			seen[typ] = true
		}
	}
	if !seen["windows"] {
		t.Errorf("did not receive a piped 'windows' frame from the remote; saw %v", seen)
	}
}

// TestFederation_DeadHostStillReturnsLocal: a host that accepts the connection
// but never responds must not stall /api/sessions — the merge returns the local
// list within the fan-out budget, dropping only the dead host's entries.
func TestFederation_DeadHostStillReturnsLocal(t *testing.T) {
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done() // block until the hub cancels (fan-out deadline)
	}))
	defer hang.Close()

	hub := newFedServer(t, "localmain", []config.HostConfig{{Name: "slow", URL: hang.URL}}, "")

	start := time.Now()
	resp, err := http.Get(hub.URL + "/api/sessions")
	if err != nil {
		t.Fatalf("GET /api/sessions: %v", err)
	}
	elapsed := time.Since(start)
	defer resp.Body.Close()

	var got []struct {
		Name string `json:"name"`
		Host string `json:"host"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if elapsed > 7*time.Second {
		t.Errorf("merged list took %s; a dead host must not exceed the fan-out budget", elapsed)
	}
	foundLocal := false
	for _, s := range got {
		if s.Name == "localmain" {
			foundLocal = true
		}
		if s.Host == "slow" {
			t.Errorf("dead host contributed a session: %+v", s)
		}
	}
	if !foundLocal {
		t.Errorf("local session dropped when a host was dead: %+v", got)
	}
}
