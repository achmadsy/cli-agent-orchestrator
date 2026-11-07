//go:build tmux_integration

package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/server"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// TestE2E_WsReceivesInitialFrames connects a real WebSocket against a real
// tmux server and verifies the first frames the client gets after upgrade.
//
// Skipped automatically when no tmux session is reachable.
//
// Run with:  go test -tags=tmux_integration ./internal/server -v -run TestE2E
func TestE2E_WsReceivesInitialFrames(t *testing.T) {
	cfg := config.Defaults()
	cfg.PollInterval = 0.4
	cfg.MetricsInterval = 5.0
	cfg.CaptureLines = 50

	tx := tmuxctl.New()
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer probeCancel()
	sessions, err := tx.ListSessions(probeCtx)
	if err != nil || len(sessions) == 0 {
		t.Skip("no tmux session; skipping e2e test")
	}
	sessionName := sessions[0].Name

	srv := server.New(&cfg, tx)
	defer srv.Close()

	httpSrv := httptest.NewServer(srv.Mux())
	defer httpSrv.Close()

	wsURL, _ := url.Parse(httpSrv.URL)
	wsURL.Scheme = "ws"
	wsURL.Path = "/ws"
	wsURL.RawQuery = "session=" + sessionName

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	c, _, err := websocket.Dial(dialCtx, wsURL.String(), nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "test done")

	// Read up to 6 frames within 4 seconds; expect to see windows + panes at minimum.
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

	for _, want := range []string{"windows", "panes"} {
		if !seen[want] {
			t.Errorf("expected to receive %q frame; saw %v", want, seen)
		}
	}
	t.Logf("ws frame types seen: %v", seen)
}

// TestE2E_AllMajorRoutes spot-checks every public HTTP route against a live
// server backed by a real tmux server.
func TestE2E_AllMajorRoutes(t *testing.T) {
	cfg := config.Defaults()
	tx := tmuxctl.New()
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer probeCancel()
	if _, err := tx.ListSessions(probeCtx); err != nil {
		t.Skip("no tmux server; skipping")
	}

	srv := server.New(&cfg, tx)
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Mux())
	defer httpSrv.Close()

	cases := []struct {
		method string
		path   string
		want   int
	}{
		{"GET", "/", http.StatusOK},
		{"GET", "/sw.js", http.StatusOK},
		{"GET", "/manifest.json", http.StatusOK},
		{"GET", "/icon-192.png", http.StatusOK},
		{"GET", "/static/css/main.css", http.StatusOK},
		{"GET", "/api/version", http.StatusOK},
		{"GET", "/api/sessions", http.StatusOK},
		{"GET", "/api/panes", http.StatusOK},
		{"GET", "/api/deck", http.StatusOK},
		{"GET", "/api/metrics", http.StatusOK},
		{"GET", "/api/autocomplete?q=test", http.StatusOK},
		{"GET", "/api/link/qr?text=http://example.com/?party=ABCD", http.StatusOK},
		{"GET", "/api/link/qr", http.StatusBadRequest}, // missing text
		{"POST", "/api/relay", http.StatusNotImplemented}, // disabled by default
		{"GET", "/api/tts/nonexistent", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.method+"_"+tc.path, func(t *testing.T) {
			req, _ := http.NewRequest(tc.method, httpSrv.URL+tc.path, strings.NewReader(""))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("%s %s: %v", tc.method, tc.path, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Errorf("%s %s: status %d; want %d", tc.method, tc.path, resp.StatusCode, tc.want)
			}
		})
	}
}

// TestE2E_VersionEndpoint asserts /api/version returns the buildinfo struct shape.
func TestE2E_VersionEndpoint(t *testing.T) {
	cfg := config.Defaults()
	tx := tmuxctl.New()
	srv := server.New(&cfg, tx)
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Mux())
	defer httpSrv.Close()

	resp, err := http.Get(httpSrv.URL + "/api/version")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"version", "git_hash", "build_date"} {
		if _, ok := body[key]; !ok {
			t.Errorf("missing key %q in /api/version response: %v", key, body)
		}
	}
}

// TestE2E_PanesShape asserts the flat /api/panes endpoint returns a JSON array
// of panes carrying the fields the deck window-drilldown relies on (id / window
// / pane index / active / command / title). Skipped when no tmux session.
func TestE2E_PanesShape(t *testing.T) {
	tx := tmuxctl.New()
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer probeCancel()
	sessions, err := tx.ListSessions(probeCtx)
	if err != nil || len(sessions) == 0 {
		t.Skip("no tmux session; skipping")
	}

	cfg := config.Defaults()
	srv := server.New(&cfg, tx)
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Mux())
	defer httpSrv.Close()

	resp, err := http.Get(httpSrv.URL + "/api/panes?session=" + url.QueryEscape(sessions[0].Name))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var panes []tmuxctl.Pane
	if err := json.NewDecoder(resp.Body).Decode(&panes); err != nil {
		t.Fatalf("response not a []Pane: %v", err)
	}
	if len(panes) == 0 {
		t.Fatal("expected at least one pane in an attached session")
	}
	// id is synthesized as "<window>.<pane>" and is the key the pane_states
	// frame uses — the drilldown correlates on it, so guard the shape.
	p := panes[0]
	if p.ID == "" {
		t.Error("pane id (window.pane) must be populated")
	}
}

// TestE2E_CreateSession exercises POST /api/sessions against a real tmux
// server: named create → visible in list → duplicate 409 → bad name 400.
func TestE2E_CreateSession(t *testing.T) {
	cfg := config.Defaults()
	tx := tmuxctl.New()
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer probeCancel()
	if _, err := tx.ListSessions(probeCtx); err != nil {
		t.Skip("no tmux server; skipping")
	}

	srv := server.New(&cfg, tx)
	defer srv.Close()
	httpSrv := httptest.NewServer(srv.Mux())
	defer httpSrv.Close()

	name := "webui-e2e-" + strconv.FormatInt(time.Now().UnixNano()%1_000_000, 10)
	defer tx.Run(context.Background(), "kill-session", "-t", name)

	post := func(body string) (*http.Response, map[string]string) {
		resp, err := http.Post(httpSrv.URL+"/api/sessions", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST /api/sessions: %v", err)
		}
		defer resp.Body.Close()
		var m map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp, m
	}

	resp, m := post(`{"name":"` + name + `"}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: status %d (%v); want 201", resp.StatusCode, m)
	}
	if m["name"] != name {
		t.Errorf("create: returned name %q; want %q", m["name"], name)
	}

	listCtx, listCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer listCancel()
	sessions, err := tx.ListSessions(listCtx)
	if err != nil {
		t.Fatalf("list after create: %v", err)
	}
	found := false
	for _, s := range sessions {
		if s.Name == name {
			found = true
		}
	}
	if !found {
		t.Errorf("session %q not in tmux list-sessions after create", name)
	}

	resp, m = post(`{"name":"` + name + `"}`)
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("duplicate: status %d (%v); want 409", resp.StatusCode, m)
	}

	resp, m = post(`{"name":"bad.name"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("bad name: status %d (%v); want 400", resp.StatusCode, m)
	}
}
