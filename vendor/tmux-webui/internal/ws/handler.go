package ws

import (
	"net/http"
	"regexp"

	"github.com/coder/websocket"
)

// reSessionName mirrors server.go's allowlist so the ws upgrade rejects a
// malformed ?session= before it reaches tmuxctl (own copy — keeps the diff to
// this file; server.go's is unexported).
var reSessionName = regexp.MustCompile(`^[A-Za-z0-9_@-]{1,50}$`)

// UpgradeHandler returns an http.Handler that upgrades HTTP connections to
// WebSocket and runs the connection lifecycle.
//
// It expects a "session" query parameter matching reSessionName; a missing or
// malformed session yields 400.
//
// Usage in server.go:
//
//	mux.Handle("/ws", hub.UpgradeHandler())
func (h *Hub) UpgradeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		session := r.URL.Query().Get("session")
		if !reSessionName.MatchString(session) {
			http.Error(w, "invalid ?session= parameter", http.StatusBadRequest)
			return
		}

		// Default AcceptOptions enforce Origin-host == request-Host (browsers
		// send Origin; nginx forwards the public Host), while non-browser
		// clients that omit Origin still connect. No InsecureSkipVerify.
		wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
		if err != nil {
			// Accept already wrote an HTTP error response.
			return
		}

		conn := newConn(r.Context(), h, wsConn, session)
		h.add(conn)

		// Run blocks until the connection is fully torn down.
		conn.Run()
	})
}
