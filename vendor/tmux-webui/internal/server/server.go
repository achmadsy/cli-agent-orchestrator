// Package server wires the HTTP routes for tmux-webui.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/operonlab/tmux-webui/internal/autocomplete"
	"github.com/operonlab/tmux-webui/internal/buildinfo"
	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/fedproxy"
	"github.com/operonlab/tmux-webui/internal/metrics"
	"github.com/operonlab/tmux-webui/internal/network"
	"github.com/operonlab/tmux-webui/internal/prefix"
	"github.com/operonlab/tmux-webui/internal/pwa"
	"github.com/operonlab/tmux-webui/internal/relay"
	"github.com/operonlab/tmux-webui/internal/rescue"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
	"github.com/operonlab/tmux-webui/internal/tts"
	"github.com/operonlab/tmux-webui/internal/upload"
	"github.com/operonlab/tmux-webui/internal/ws"
)

type Server struct {
	cfg     *config.Config
	tx      *tmuxctl.Client
	hub     *ws.Hub
	ac      *autocomplete.Engine
	prov    metrics.Provider
	upload  *upload.Handler
	tts     *tts.Store
	relay   *relay.Dispatcher // nil when relay disabled
	monitor *ws.Monitor
	rescue  *rescue.Rescuer
	// fed federates full sessions from configured hosts (config.Hosts). Empty
	// (no hosts) leaves every route byte-identical to a standalone server.
	fed *fedproxy.Registry
}

func New(cfg *config.Config, tx *tmuxctl.Client) *Server {
	pc := prefix.New(tx)

	// Append any config-provided agent commands to the builtin classifier sets
	// before pollers/monitor start reading them (append-only, builtins stay).
	ws.RegisterAgentCommands(cfg.AgentCommandsExtra, cfg.AgentHostCommandsExtra)

	var prov metrics.Provider = metrics.NewStub()
	if cfg.Metrics.Provider == "http" && cfg.Metrics.URL != "" {
		prov = metrics.NewHTTP(cfg.Metrics.URL)
	}

	hub := ws.NewHub(cfg, tx, pc, prov)

	// Plugin marketplaces + Claude Code built-in slash commands default ON (nil
	// *bool → true) to match the full Claude Code resource universe. ClaudeDir
	// still gates the disk scanners, so a tmux-webui not pointed at ~/.claude
	// degrades cleanly. MaxResults/SourcePriority carry their config zero-values
	// (0/empty) straight through to their historical defaults.
	ac := autocomplete.New(autocomplete.Options{
		ClaudeDir:       cfg.Autocomplete.ClaudeDir,
		IncludePlugins:  boolOr(cfg.Autocomplete.IncludePlugins, true),
		IncludeBuiltins: boolOr(cfg.Autocomplete.IncludeBuiltins, true),
		MaxResults:      cfg.Autocomplete.MaxResults,
		SourcePriority:  cfg.Autocomplete.SourcePriority,
		ShortcutsFile:   cfg.Autocomplete.ShortcutsFile,
	})

	rly, _ := relay.New(cfg.Relay.PaneScript, cfg.Relay.RelayScript, cfg.Relay.SignalDir)
	// New returns nil when both scripts are empty (disabled by default for OSS).
	// Real config errors (paths set but files missing) are logged and treated as disabled.

	return &Server{
		cfg:     cfg,
		tx:      tx,
		hub:     hub,
		ac:      ac,
		prov:    prov,
		upload:  upload.New(cfg.UploadDir, cfg.UploadMaxBytes),
		tts:     tts.NewStore(),
		relay:   rly,
		monitor: ws.NewMonitor(cfg.Notify, tx),
		rescue:  rescue.New(tx),
		fed:     fedproxy.NewRegistry(cfg.Hosts),
	}
}

// StartMonitor launches the cross-session agent Monitor for the lifetime of
// ctx. Unlike the old notifier this ALWAYS runs — it maintains the /api/agents
// snapshot even without a webhook; only the push side is gated on
// config.notify.webhook_url (inside the Monitor).
func (s *Server) StartMonitor(ctx context.Context) {
	go s.monitor.Run(ctx)
}

func (s *Server) Close() {
	if s.ac != nil {
		s.ac.Close()
	}
}

func (s *Server) Mux() http.Handler {
	mux := http.NewServeMux()

	// PWA shell
	mux.Handle("GET /{$}", pwa.IndexHandler(s.cfg.UI))
	mux.Handle("GET /sw.js", pwa.SwjsHandler())
	mux.Handle("GET /manifest.json", pwa.AssetFile("manifest.json", "application/manifest+json"))
	mux.Handle("GET /icon-192.svg", pwa.AssetFile("icon-192.svg", "image/svg+xml"))
	mux.Handle("GET /icon-512.svg", pwa.AssetFile("icon-512.svg", "image/svg+xml"))
	mux.Handle("GET /icon-192.png", pwa.AssetFile("icon-192.png", "image/png"))
	mux.Handle("GET /icon-512.png", pwa.AssetFile("icon-512.png", "image/png"))
	mux.Handle("GET /icon-maskable-512.png", pwa.AssetFile("icon-maskable-512.png", "image/png"))
	mux.Handle("GET /static/", pwa.StaticFS())

	// Workshop Py version is reverse-proxied behind nginx with /apps/tmux/
	// prefix; the embedded index.html still references those URLs. Serve
	// the same files at both paths so the OSS binary works without needing
	// to edit the frontend HTML.
	mux.Handle("GET /apps/tmux/manifest.json", pwa.AssetFile("manifest.json", "application/manifest+json"))
	mux.Handle("GET /apps/tmux/icon-192.svg", pwa.AssetFile("icon-192.svg", "image/svg+xml"))
	mux.Handle("GET /apps/tmux/icon-512.svg", pwa.AssetFile("icon-512.svg", "image/svg+xml"))
	mux.Handle("GET /apps/tmux/icon-192.png", pwa.AssetFile("icon-192.png", "image/png"))
	mux.Handle("GET /apps/tmux/icon-512.png", pwa.AssetFile("icon-512.png", "image/png"))
	mux.Handle("GET /apps/tmux/icon-maskable-512.png", pwa.AssetFile("icon-maskable-512.png", "image/png"))
	mux.Handle("GET /favicon.ico", pwa.AssetFile("icon-192.png", "image/png"))

	// Read-only tmux queries
	mux.HandleFunc("GET /api/sessions", s.handleListSessions)
	mux.HandleFunc("POST /api/sessions", s.handleCreateSession)
	mux.HandleFunc("PATCH /api/sessions/{name}", s.handleRenameSession)
	mux.HandleFunc("DELETE /api/sessions/{name}", s.handleDeleteSession)
	mux.HandleFunc("GET /api/sessions/{name}/panes", s.handleListPanes)
	mux.HandleFunc("GET /api/sessions/{name}/windows", s.handleListWindows)
	// Flat, session-agnostic pane list (deck window-drilldown). Accepts an
	// optional ?session=<name>; defaults to the first session when omitted.
	mux.HandleFunc("GET /api/panes", s.handlePanesAll)
	// Cross-session agent status snapshot (Monitor). Read-only; sits behind the
	// same token gate as /api/sessions (it's inside mux, not exempted).
	mux.HandleFunc("GET /api/agents", s.handleAgents)
	// I4 per-pane output replay (opt-in): POST toggles recording for one agent
	// pane, GET serves its captured frames. Both behind the same token gate;
	// {pane} is the tmux pane id ("%5", from /api/agents) or pane index.
	mux.HandleFunc("POST /api/agents/{session}/{pane}/record", s.handleAgentRecord)
	mux.HandleFunc("GET /api/agents/{session}/{pane}/frames", s.handleAgentFrames)

	// H1 on-demand deep scrollback: one-shot capture past the live window's
	// cfg.CaptureLines cap. Query params (not path) — tmux pane ids carry '%'.
	mux.HandleFunc("GET /api/history", s.handleHistory)

	// Health check (precedes auth — exempted from tokenGate below)
	mux.HandleFunc("GET /health", s.handleHealth)

	// Rescue: out-of-band recovery for a wedged tmux server. The console page
	// and every action bypass the tmux socket entirely (ps/kill by PID), so
	// they keep working when normal tmux calls only time out. Destructive
	// steps are confirm-gated inside the handlers; all ride the token gate.
	mux.Handle("GET /rescue", pwa.RescueHandler())
	mux.HandleFunc("GET /api/rescue", s.rescue.HandleStatus)
	mux.HandleFunc("POST /api/rescue/diagnose", s.rescue.HandleDiagnose)
	mux.HandleFunc("POST /api/rescue/kill-hooks", s.rescue.HandleKillHooks)
	mux.HandleFunc("POST /api/rescue/kill-server", s.rescue.HandleKillServer)

	// Build/version info
	mux.HandleFunc("GET /api/version", s.handleVersion)

	// Metrics (REST snapshot for non-ws polling)
	mux.HandleFunc("GET /api/metrics", s.handleMetrics)

	// WebSocket. A ?session=<host>/<rest> targeting a configured host is proxied
	// to that host's /ws as a dumb byte pipe; everything else hits the local hub
	// upgrade unchanged (identical when no hosts are configured).
	mux.Handle("/ws", s.wsHandler())

	// Autocomplete
	mux.HandleFunc("GET /api/autocomplete", s.handleAutocomplete)
	mux.HandleFunc("GET /api/autocomplete/refresh", s.handleAutocompleteRefresh)

	// Link mode (party): join-URL QR, rendered server-side (spec §3 Slice 3)
	mux.HandleFunc("GET /api/link/qr", s.handleLinkQR)

	// Deck mode config: GET serves embedded default + optional user override
	// (pages authoritative when the user file carries them); PUT persists a
	// full config to the user override file (64KB cap + validation inside).
	mux.HandleFunc("GET /api/deck", s.handleDeck)
	mux.HandleFunc("PUT /api/deck", s.handleDeckWrite)

	// Upload (50MB cap inside handler)
	mux.Handle("POST /api/upload", s.upload.HTTP())

	// TTS push + serve
	mux.Handle("POST /api/tts/push", s.tts.PushHandler(s.hub.BroadcastTTS))
	mux.Handle("GET /api/tts/{id}", s.tts.GetHandler())

	// Relay (optional; nil when scripts not configured)
	if s.relay != nil {
		mux.Handle("POST /api/relay", s.relay.DispatchHandler())
		mux.Handle("GET /api/relay/check", s.relay.CheckHandler())
	} else {
		mux.HandleFunc("/api/relay", notImplemented("/api/relay — disabled (config.relay scripts not set)"))
		mux.HandleFunc("/api/relay/check", notImplemented("/api/relay/check — disabled (config.relay scripts not set)"))
	}

	// LAN-mode access gate wraps the whole mux (ws included, since it routes
	// through mux). Empty token = plain localhost bind, byte-identical to a
	// no-auth server.
	var handler http.Handler = mux
	if s.cfg.Token != "" {
		handler = s.tokenGate(handler)
	}
	return logRequests(handler)
}

// tokenGate enforces the LAN-mode access token minted at startup. A request is
// authorized iff it carries the tw_token cookie. Otherwise the gate serves a
// tiny JS bootstrap (tokenBootstrapHTML) that reads the token from the URL
// FRAGMENT (#token=), stores it in the cookie, and reloads through the gate.
//
// The token lives in the fragment, NOT a ?token= query param, precisely because
// the browser never transmits a fragment to the server — so it cannot leak into
// proxy/access logs or, critically, into link-preview unfurlers that fetch a
// shared party URL server-side (SEC1: a query token in a link pasted to a chat
// app was harvested off-device). See link.js joinURL() and serve.go's printed
// URL/QR, which now emit #token=. The cookie is deliberately NOT httponly so
// link.js can read it to carry the token onto party join URLs.
//
// /health is exempted unconditionally — health checks precede auth.
//
// ponytail: single static token per server run; rotate-on-interval if a
// long-lived --lan deployment ever matters.
func (s *Server) tokenGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		if c, err := r.Cookie("tw_token"); err == nil && tokenEqual(c.Value, s.cfg.Token) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, tokenBootstrapHTML)
	})
}

// tokenBootstrapHTML is served on an unauthorized request. Its inline JS reads
// the token from the URL fragment (which the initial request could not carry to
// the server), writes the cookie, and reloads with the fragment dropped — so
// the token is consumed entirely client-side and never appears in any request
// line. A wrong/absent token terminates cleanly: the reload has no fragment, so
// the script falls through to the unlock message instead of looping.
const tokenBootstrapHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tmux-webui</title></head>
<body style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0d1117;color:#c9d1d9;padding:2rem;font-size:14px">
<p id="msg">unlocking&hellip;</p>
<script>
(function () {
  var token = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  if (token) {
    document.cookie = "tw_token=" + encodeURIComponent(token) + "; path=/; samesite=lax";
    location.replace(location.pathname + location.search); // drop #token, keep ?party=…, reload through the gate
  } else {
    document.getElementById("msg").textContent = "scan the QR from the terminal to unlock";
  }
})();
</script>
</body></html>
`

// tokenEqual compares two tokens in constant time.
func tokenEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// wsHandler routes a WebSocket upgrade: a ?session= that resolves to a
// configured host is proxied to that host's /ws (dumb byte pipe, prefix
// stripped); anything else — including a local session name containing "/"
// whose prefix is not a host — falls through to the local hub upgrade. With no
// hosts configured, fed.Resolve always returns remote=false so this is a
// transparent pass-through.
func (s *Server) wsHandler() http.Handler {
	up := s.hub.UpgradeHandler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session := r.URL.Query().Get("session")
		if h, remoteSession, remote := s.fed.Resolve(session); remote {
			h.ProxyWS(w, r, remoteSession)
			return
		}
		up.ServeHTTP(w, r)
	})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	sessions, err := s.tx.ListSessions(ctx)
	if err != nil {
		sessions = nil
	}
	// No hosts: byte-identical to the original ([] on empty, raw list otherwise).
	if s.fed.Empty() {
		if sessions == nil {
			writeJSON(w, http.StatusOK, []any{})
			return
		}
		writeJSON(w, http.StatusOK, sessions)
		return
	}
	// Federated: local sessions (host="") + each host's sessions (prefixed,
	// host-tagged), fanned out concurrently; a dead host is skipped fail-soft.
	writeJSON(w, http.StatusOK, s.fed.MergeSessions(ctx, sessions))
}

// reSessionName is a conservative allowlist: tmux itself only rejects "." /
// ":" / empty, but shell-hostile names help nobody downstream (targets,
// status bars, channel ids all interpolate the name).
var reSessionName = regexp.MustCompile(`^[A-Za-z0-9_@-]{1,50}$`)

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
		// Host, when set to a configured host name, creates the session on that
		// host instead of locally (default empty = local). The forwarded body
		// drops host so the remote sees a plain local create.
		Host string `json:"host,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	if req.Host != "" {
		h, ok := s.fed.Host(req.Host)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown host: " + req.Host})
			return
		}
		body, _ := json.Marshal(map[string]string{"name": req.Name})
		h.ForwardBody(w, r, "/api/sessions", body)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name != "" && !reSessionName.MatchString(name) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session name: letters, digits, - _ @ only, max 50 chars"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	created, err := s.tx.NewSession(ctx, name, s.cfg.DefaultSessionCWD)
	if err != nil {
		code := http.StatusInternalServerError
		if strings.Contains(err.Error(), "duplicate session") {
			code = http.StatusConflict
		}
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"name": created})
}

func (s *Server) handleRenameSession(w http.ResponseWriter, r *http.Request) {
	old := r.PathValue("name")
	if h, sess, remote := s.fed.Resolve(old); remote {
		h.Forward(w, r, "/api/sessions/"+url.PathEscape(sess))
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	name := strings.TrimSpace(req.Name)
	if !reSessionName.MatchString(name) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session name: letters, digits, - _ @ only, max 50 chars"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.tx.RenameSession(ctx, old, name); err != nil {
		code := http.StatusInternalServerError
		if strings.Contains(err.Error(), "duplicate session") {
			code = http.StatusConflict
		}
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if h, sess, remote := s.fed.Resolve(name); remote {
		h.Forward(w, r, "/api/sessions/"+url.PathEscape(sess))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := s.tx.KillSession(ctx, name); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

func (s *Server) handleListPanes(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if h, sess, remote := s.fed.Resolve(name); remote {
		h.Forward(w, r, "/api/sessions/"+url.PathEscape(sess)+"/panes")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	panes, err := s.tx.ListPanes(ctx, name)
	if err != nil || panes == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, panes)
}

// handlePanesAll returns every pane across all windows of a session as a flat
// list (the deck window-drilldown fetches this on demand instead of riding the
// 1s pane_states frame). Session comes from ?session=<name>; when omitted it
// defaults to the first session so a bare call still resolves. Missing tmux /
// unknown session degrades to an empty array with 200 (same as the other
// read-only query handlers).
func (s *Server) handlePanesAll(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	session := r.URL.Query().Get("session")
	if h, sess, remote := s.fed.Resolve(session); remote {
		h.Forward(w, r, "/api/panes?session="+url.QueryEscape(sess))
		return
	}
	if session == "" {
		if sessions, err := s.tx.ListSessions(ctx); err == nil && len(sessions) > 0 {
			session = sessions[0].Name
		}
	}
	if session == "" {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	panes, err := s.tx.ListPanes(ctx, session)
	if err != nil || panes == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, panes)
}

func (s *Server) handleListWindows(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if h, sess, remote := s.fed.Resolve(name); remote {
		h.Forward(w, r, "/api/sessions/"+url.PathEscape(sess)+"/windows")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	windows, err := s.tx.ListWindows(ctx, name)
	if err != nil || windows == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, windows)
}

// handleAgents returns the Monitor's cross-session agent-status snapshot:
// {agents:[AgentStatus...], generated_at}. generated_at is a unix timestamp (0
// before the first scan completes). The snapshot is served as [] rather than
// null when empty so the frontend can iterate unconditionally.
func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	agents, genAt := s.monitor.Snapshot()
	if agents == nil {
		agents = []ws.AgentStatus{}
	}
	var gen int64
	if !genAt.IsZero() {
		gen = genAt.Unix()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"agents":       agents,
		"generated_at": gen,
	})
}

// handleAgentRecord starts/stops the I4 replay recorder for one agent pane.
// Body: {"on": true|false}. The pane must currently be an agent pane in the
// Monitor's snapshot (ResolveAgentPane gates this — recording a shell pane is
// rejected 404). Stop clears the buffer. Returns {recording, pane}.
func (s *Server) handleAgentRecord(w http.ResponseWriter, r *http.Request) {
	session := r.PathValue("session")
	pane := r.PathValue("pane")
	var req struct {
		On bool `json:"on"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	paneID, ok := s.monitor.ResolveAgentPane(session, pane)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not an agent pane (unknown session/pane, or not currently classified as an agent)"})
		return
	}
	if req.On {
		s.monitor.StartRecording(session, paneID)
	} else {
		s.monitor.StopRecording(session, paneID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"recording": req.On, "pane": paneID})
}

// handleAgentFrames serves the I4 recorder's captured frames for one agent pane:
// {frames:[{content, atUnix}...], recording}. frames is [] (never null) when the
// pane is recording but nothing has been captured yet; recording=false (with
// empty frames) when the pane isn't being recorded.
func (s *Server) handleAgentFrames(w http.ResponseWriter, r *http.Request) {
	session := r.PathValue("session")
	pane := r.PathValue("pane")
	paneID, ok := s.monitor.ResolveAgentPane(session, pane)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not an agent pane (unknown session/pane, or not currently classified as an agent)"})
		return
	}
	frames, recording := s.monitor.Frames(session, paneID)
	if frames == nil {
		frames = []ws.Frame{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"frames":    frames,
		"recording": recording,
		"pane":      paneID,
	})
}

// handleHistory serves H1 on-demand deep scrollback, PAGED: chunk k is the
// `lines`-line slice starting `offset` history lines above the visible top
// (offset=0 additionally includes the visible screen — the first fetch replaces
// the live window). The frontend keeps requesting deeper chunks while the user
// scrolls at the top; tmux clamps the range to the real history start, so a
// short (or ≤1-line) result is the exhaustion signal — total depth is
// deliberately uncapped ("有多少載多少"). Read-only; behind the token gate.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	session := r.URL.Query().Get("session")
	pane := r.URL.Query().Get("pane")
	if session == "" || pane == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session and pane query params required"})
		return
	}
	// Remote session: forward with the host prefix stripped from ?session=,
	// every other query param (pane/lines/offset) preserved verbatim.
	if h, sess, remote := s.fed.Resolve(session); remote {
		q := r.URL.Query()
		q.Set("session", sess)
		h.Forward(w, r, "/api/history?"+q.Encode())
		return
	}
	lines := clampHistoryLines(r.URL.Query().Get("lines"))
	offset := parseHistoryOffset(r.URL.Query().Get("offset"))
	// Deep captures are bigger than the poller's — allow more than the usual 5s.
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var content string
	var err error
	if offset <= 0 {
		content, err = s.tx.CapturePane(ctx, session+":"+pane, lines)
	} else {
		content, err = s.tx.CapturePaneRange(ctx, session+":"+pane, offset+lines, offset+1)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"content": content, "lines": lines, "offset": offset})
}

// clampHistoryLines parses the per-chunk depth. Default 5000 (one smooth
// prepend on a phone); floor 200 (below that the live window already covers
// it). No upper cap — the TOTAL depth is unbounded by design, and a huge
// single chunk only costs its own requester. tmux clamps to the pane's real
// history_size, so over-asking is harmless.
func clampHistoryLines(q string) int {
	n, err := strconv.Atoi(q)
	if err != nil || n <= 0 {
		return 5000
	}
	if n < 200 {
		return 200
	}
	return n
}

// parseHistoryOffset parses how many history lines the client already has;
// junk/negative → 0 (first chunk).
func parseHistoryOffset(q string) int {
	n, err := strconv.Atoi(q)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// handleHealth is a minimal liveness probe — no tmux/auth dependency, used by
// health checks (e.g. `curl http://127.0.0.1:PORT/health`, see COMMANDS.md).
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"version":    buildinfo.Version,
		"git_hash":   buildinfo.GitHash,
		"build_date": buildinfo.BuildDate,
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.prov.Collect(ctx))
}

func (s *Server) handleAutocomplete(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	t := r.URL.Query().Get("type")

	// Optional pane context: "@" queries complete files relative to the
	// focused pane's cwd. Fail-open to no-cwd (agents/mcp still complete)
	// on a missing/odd pane id or a wedged tmux.
	cwd := ""
	if pane := r.URL.Query().Get("pane"); isPaneID(pane) {
		ctx, cancel := context.WithTimeout(r.Context(), 1*time.Second)
		cwd = s.tx.PaneCurrentPath(ctx, pane)
		cancel()
	}

	items := s.ac.CompleteIn(cwd, q, t)
	if items == nil {
		items = []autocomplete.Item{}
	}
	writeJSON(w, http.StatusOK, items)
}

// isPaneID reports whether p looks like a tmux pane id ("%12") — the only
// pane addressing form the web UI uses.
func isPaneID(p string) bool {
	if len(p) < 2 || p[0] != '%' {
		return false
	}
	for i := 1; i < len(p); i++ {
		if p[i] < '0' || p[i] > '9' {
			return false
		}
	}
	return true
}

func (s *Server) handleAutocompleteRefresh(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.ac.Refresh())
}

// handleLinkQR renders the party join URL as a PNG QR code (spec §3 Slice 3).
// text is capped well under the QR encoder's practical limit — join URLs are
// short (origin + basePath + 4-char code) so 512 is a generous ceiling.
func (s *Server) handleLinkQR(w http.ResponseWriter, r *http.Request) {
	text := r.URL.Query().Get("text")
	if text == "" || len(text) > 512 {
		http.Error(w, "text required (max 512 chars)", http.StatusBadRequest)
		return
	}
	png, err := network.RenderPNG(text)
	if err != nil {
		http.Error(w, "qr encode failed: "+err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store") // code changes per party; never cache
	w.Write(png)
}

// boolOr resolves a nil-defaulting *bool config toggle (nil → def).
func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

func notImplemented(reason string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, reason, http.StatusNotImplemented)
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		fmt.Printf("%s %s %d %s\n", r.Method, r.URL.Path, rec.status, time.Since(start))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap exposes the underlying ResponseWriter so http.NewResponseController
// (used by coder/websocket for Hijack) can reach the real Hijacker. Without
// this, WS upgrade returns 501 because the middleware hides the interface.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
