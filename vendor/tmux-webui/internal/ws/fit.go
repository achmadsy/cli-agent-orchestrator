package ws

import (
	"context"
	"strings"
	"time"
)

// Fit-mode sanity bounds. A degenerate client (a phone whose terminal DOM fed
// its own scrollback height back into the size computation) once shrank real
// windows to 38x1 / 153x7; clamping the request BEFORE it reaches tmux makes a
// misbehaving client unable to 1-row a shared window again (R1 backstop).
const (
	minFitCols, maxFitCols = 10, 1000
	minFitRows, maxFitRows = 3, 500
)

func clampCols(cols int) int { return clampInt(cols, minFitCols, maxFitCols) }
func clampRows(rows int) int { return clampInt(rows, minFitRows, maxFitRows) }

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// handleFit handles a "fit" inbound message.
//
// When fitMode is true:
//  1. Determine the window index from pane id (e.g. "0.1" → winIdx=0).
//  2. Clamp the requested (cols, rows) to sane bounds (R1 backstop).
//  3. On this conn's first fit of that window, take a Hub-level reference to the
//     window's original layout AND size (see Hub.acquireFit) — the first global
//     enabler stores the true pre-fit state, later enablers only bump the
//     refcount.
//  4. Register this conn's desired size and resize the target to the EFFECTIVE
//     (min-across-clients) size so two clients on one window converge to the
//     smaller instead of fighting last-writer-wins (R3).
//
// When fitMode is false the message is silently ignored.
func (c *Conn) handleFit(msg *InboundMsg) error {
	if !c.fitMode {
		return nil
	}
	if msg.Pane == "" {
		return nil
	}

	cols := clampCols(msg.Cols)
	rows := clampRows(msg.Rows)

	target := c.paneTarget(msg.Pane)
	winIdx := winIndexFromPaneID(msg.Pane)
	key := c.fitKey(winIdx)

	// Take a shared reference before the first resize of this window. The layout
	// and size snapshot lives at Hub scope (keyed "session:windowIndex",
	// refcounted) so the LAST client out — not the first — restores the pre-fit
	// state (B3/R2). Snapshot outside the Hub lock (they are tmux calls);
	// acquireFit keeps it only for the first enabler and discards it for later ones.
	if !c.fitWindows[winIdx] {
		layout, lerr := c.hub.tx.LayoutOf(c.ctx, target)
		origW, origH, _ := c.hub.tx.WindowSize(c.ctx, target)
		if c.hub.acquireFit(key, layout, lerr == nil && layout != "", origW, origH) {
			c.fitWindows[winIdx] = true
		}
	}

	// Register this conn's want and resize to the min across all fitters (R3).
	effCols, effRows := c.hub.registerWant(c, key, cols, rows)

	// A sole pane fills its window and can't be resized below it, so a fullscreen
	// TUI (the mobile yazi/lazygit case) needs the WINDOW resized. Multi-pane
	// windows keep per-pane resize so a split layout still fits each pane's box.
	if c.hub.tx.WindowPaneCount(c.ctx, target) <= 1 {
		return c.hub.tx.ResizeWindow(c.ctx, key, effCols, effRows)
	}
	return c.hub.tx.ResizePane(c.ctx, target, effCols, effRows)
}

// restoreLayouts releases this conn's fit references. Called on fit_disable or
// connection teardown. Each window this conn still holds is --ref'd; the LAST
// conn out for a window restores its earliest original size + layout, while an
// earlier departure re-applies the min of the remaining clients so the window
// grows back instead of staying stuck at the leaver's (possibly smaller) size.
//
// Teardown runs from Conn.Run's defer AFTER c.cancel(), so c.ctx is already
// cancelled — issuing the tmux commands on it would fail "context canceled" and
// silently leave the user's panes stuck resized. The restore must outlive the
// conn ctx, so it runs on a fresh background ctx with its own short deadline.
func (c *Conn) restoreLayouts() {
	if len(c.fitWindows) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for winIdx := range c.fitWindows {
		key := c.fitKey(winIdx)
		rel := c.hub.releaseFit(c, key)
		switch {
		case rel.restore:
			// Restore the pre-fit WINDOW SIZE before the layout string: a layout
			// encodes absolute pane geometry, so applying it at the shrunk size
			// would re-freeze the window small (R2). Skip the resize when the
			// original size was never captured (origW/H == 0).
			if rel.cols > 0 && rel.rows > 0 {
				_ = c.hub.tx.ResizeWindow(ctx, key, rel.cols, rel.rows)
			}
			_ = c.hub.tx.SelectLayout(ctx, key, rel.layout)
		case rel.remain && rel.cols > 0 && rel.rows > 0:
			// ponytail: window-level regrow only; a multi-pane window's per-pane
			// geometry corrects on the remaining client's next fit message.
			// Upgrade to per-pane re-apply if split layouts visibly lag on leave.
			_ = c.hub.tx.ResizeWindow(ctx, key, rel.cols, rel.rows)
		}
	}
	c.fitWindows = make(map[int]bool)
}

// fitKey builds the Hub.fitLayouts map key for a window: "session:windowIndex".
// It doubles as the tmux target for the window's layout restore.
func (c *Conn) fitKey(winIdx int) string {
	return c.session + ":" + itoa(winIdx)
}

// winIndexFromPaneID extracts the window index from a pane id like "0.1".
// Falls back to 0 on any parse error.
func winIndexFromPaneID(paneID string) int {
	parts := strings.SplitN(paneID, ".", 2)
	if len(parts) == 0 {
		return 0
	}
	n := 0
	for _, ch := range parts[0] {
		if ch < '0' || ch > '9' {
			return 0
		}
		n = n*10 + int(ch-'0')
	}
	return n
}
