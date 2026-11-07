package fedproxy

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// wsDialTimeout bounds each remote /ws handshake attempt so a dead host's dial
// can't hang the browser socket for the OS connect timeout.
const wsDialTimeout = 5 * time.Second

// ProxyWS bridges the browser WebSocket (already routed to this hub) to the
// host's /ws for remoteSession, piping frames verbatim in BOTH directions until
// either side closes. It is a DUMB PIPE: each frame is relayed byte-for-byte
// with its message type, never inspected or re-encoded. On a dial failure the
// accepted browser socket is closed with a status the frontend treats as a
// normal drop (it just reconnects).
func (h *Host) ProxyWS(w http.ResponseWriter, r *http.Request, remoteSession string) {
	// Default AcceptOptions (Origin==Host for browsers, no InsecureSkipVerify) —
	// same posture as the local ws upgrade in internal/ws.
	client, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
	if err != nil {
		return // Accept already wrote the HTTP error
	}
	// A dumb pipe carries the remote's full terminal-output frames, which can
	// exceed coder/websocket's 32KiB default read limit — lift it on both ends.
	client.SetReadLimit(-1)

	remote, err := h.dialWS(r.Context(), remoteSession)
	if err != nil {
		slog.Warn("federation ws dial failed", "host", h.name, "session", remoteSession, "err", err)
		_ = client.Close(websocket.StatusTryAgainLater, "federation: host unreachable")
		return
	}
	remote.SetReadLimit(-1)

	// Pipe both directions. The first side to error cancels ctx, unblocking the
	// other Read so both goroutines exit; then we close both sockets.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go pipeFrames(ctx, cancel, remote, client) // remote → browser
	pipeFrames(ctx, cancel, client, remote)    // browser → remote (blocks until done)

	_ = client.Close(websocket.StatusNormalClosure, "bye")
	_ = remote.Close(websocket.StatusNormalClosure, "bye")
}

// pipeFrames copies frames from src to dst until either errors, then cancels the
// shared ctx so the opposite-direction pump also unwinds.
func pipeFrames(ctx context.Context, cancel context.CancelFunc, src, dst *websocket.Conn) {
	defer cancel()
	for {
		typ, data, err := src.Read(ctx)
		if err != nil {
			return
		}
		if err := dst.Write(ctx, typ, data); err != nil {
			return
		}
	}
}

// dialWS opens a WebSocket to the host's /ws for session, trying the sticky/
// primary ws base then the fallback once (mirroring the REST sticky+fallback),
// carrying the host token as the tw_token cookie. Each attempt is bounded by
// wsDialTimeout so a black-hole base fails fast.
func (h *Host) dialWS(ctx context.Context, session string) (*websocket.Conn, error) {
	if h.Down() {
		return nil, fmt.Errorf("host %s: down (negative-cached, retries within %s)", h.name, hostDownWindow)
	}
	hdr := http.Header{}
	if h.token != "" {
		hdr.Set("Cookie", "tw_token="+h.token)
	}
	// h.client carries the dial-bounded transport, so a black-hole base costs
	// hostDialTimeout here too (wsDialTimeout only caps a slow handshake).
	opts := &websocket.DialOptions{HTTPHeader: hdr, HTTPClient: h.client}

	var lastErr error
	for _, base := range h.baseOrder() {
		wsURL := toWSScheme(base) + "/ws?session=" + url.QueryEscape(session)
		dctx, dcancel := context.WithTimeout(ctx, wsDialTimeout)
		conn, _, err := websocket.Dial(dctx, wsURL, opts)
		dcancel() // handshake done (or failed); the conn's lifetime is independent
		if err != nil {
			lastErr = err
			continue
		}
		h.markUp()
		h.rememberBase(base)
		return conn, nil
	}
	h.markDown()
	return nil, lastErr
}

// toWSScheme rewrites an http(s) base URL to its ws(s) equivalent. A base with
// neither scheme is returned unchanged (Dial will then reject it loudly).
func toWSScheme(base string) string {
	switch {
	case strings.HasPrefix(base, "https://"):
		return "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		return "ws://" + strings.TrimPrefix(base, "http://")
	default:
		return base
	}
}
