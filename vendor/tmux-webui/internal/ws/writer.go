package ws

import "github.com/coder/websocket"

// writer is the only goroutine permitted to call wsConn.Write.
// It drains outChan and writes each pre-marshalled envelope to the wire.
// Returns (silently) when c.ctx is cancelled.
func (c *Conn) writer() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case b := <-c.outChan:
			if err := c.ws.Write(c.ctx, websocket.MessageText, b); err != nil {
				// Write failed (connection closed, ctx cancelled, etc.).
				// Cancel our context to trigger a clean shutdown of the
				// other goroutines.
				c.cancel()
				return
			}
		}
	}
}
