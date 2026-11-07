package server_test

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/operonlab/tmux-webui/internal/ws"
)

// dialWS opens a raw client WebSocket against a newFedServer instance.
func dialWS(t *testing.T, httpURL, session string) *websocket.Conn {
	t.Helper()
	u, _ := url.Parse(httpURL)
	u.Scheme = "ws"
	u.Path = "/ws"
	u.RawQuery = "session=" + session
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	c.SetReadLimit(-1)
	return c
}

// readUntilClosed drains frames until the server closes the conn (true) or
// our own deadline fires first (false = conn still open).
func readUntilClosed(c *websocket.Conn, deadline time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			return ctx.Err() == nil // server closed us vs our deadline expired
		}
	}
}

// TestWSLivenessClosesZombie: a client that never sends anything (no pongs) is
// a zombie — the server must tear it down after LivenessTimeout instead of
// holding its poller subscription forever. This is the 2026-07-06 follow-up:
// iOS Safari network flaps often deliver no FIN (WebKit 247943), so the pong
// silence is the only signal the server gets.
func TestWSLivenessClosesZombie(t *testing.T) {
	old := ws.LivenessTimeout
	ws.LivenessTimeout = 600 * time.Millisecond // ping every 200ms, dead after 600ms silent
	t.Cleanup(func() { ws.LivenessTimeout = old })

	hs := newFedServer(t, "zsess", nil, "")
	c := dialWS(t, hs.URL, "zsess")
	defer c.Close(websocket.StatusNormalClosure, "test done")

	// Never send a frame. The server must close us within ~LivenessTimeout +
	// one ping interval + slack; 3s is generous and still catches the old
	// behavior (no liveness = stays open indefinitely).
	if !readUntilClosed(c, 3*time.Second) {
		t.Fatal("zombie conn still open after 3s; liveness timeout not enforced")
	}
}

// TestWSLivenessSpeakingClientStaysOpen: a client that keeps talking (pongs)
// must NOT be reaped — liveness only kills the silent.
func TestWSLivenessSpeakingClientStaysOpen(t *testing.T) {
	old := ws.LivenessTimeout
	ws.LivenessTimeout = 600 * time.Millisecond
	t.Cleanup(func() { ws.LivenessTimeout = old })

	hs := newFedServer(t, "livesess", nil, "")
	c := dialWS(t, hs.URL, "livesess")
	defer c.Close(websocket.StatusNormalClosure, "test done")

	// Pong every 150ms (< 600ms budget) while reading server frames; the conn
	// must survive well past several liveness windows.
	stop := time.After(2 * time.Second)
	tick := time.NewTicker(150 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return // survived 2s (>3 liveness windows) — pass
		case <-tick.C:
			wctx, cancel := context.WithTimeout(context.Background(), time.Second)
			err := c.Write(wctx, websocket.MessageText, []byte(`{"type":"pong"}`))
			cancel()
			if err != nil {
				t.Fatalf("speaking client was closed by the server: %v", err)
			}
		}
	}
}
