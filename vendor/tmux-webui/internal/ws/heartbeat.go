package ws

import (
	"log/slog"
	"time"
)

// LivenessTimeout is how long a conn may stay inbound-silent before the server
// tears it down as a zombie. The client answers every ping with a pong, so a
// healthy conn speaks at least once per ping interval; the ping interval is
// derived as LivenessTimeout/3, i.e. three missed pings = dead. Without this,
// a phone that vanishes mid-air (network flap, iOS PWA backgrounding — WebKit
// 247943 often never delivers a FIN) leaves a zombie conn holding its poller
// subscription until a TCP write finally errors. Package var (not config) so
// the liveness test can shorten it.
var LivenessTimeout = 45 * time.Second

// heartbeat sends a {type:"ping", ts:epoch_ms} frame every LivenessTimeout/3
// (15s at the default) and enforces LivenessTimeout against lastRecv (stamped
// by the reader on every inbound frame). A silent conn is cancelled via
// c.cancel() directly — returning an error would only cancel the errgroup's
// DERIVED ctx, which is not the c.ctx the reader/writer actually block on.
// Returns when c.ctx is cancelled.
func (c *Conn) heartbeat() error {
	ticker := time.NewTicker(LivenessTimeout / 3)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return nil
		case <-ticker.C:
			if silent := time.Duration(epochMs()-c.lastRecv.Load()) * time.Millisecond; silent > LivenessTimeout {
				slog.Info("ws liveness timeout — closing zombie conn",
					"session", c.session, "silent", silent.Truncate(100*time.Millisecond))
				c.cancel()
				return nil
			}
			c.send(outPing{Type: "ping", Ts: epochMs()})
		}
	}
}
