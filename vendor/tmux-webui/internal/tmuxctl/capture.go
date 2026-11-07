package tmuxctl

import (
	"context"
	"strconv"
	"strings"
)

// CapturePane returns the visible content of a pane with ANSI escape sequences
// (-e) so the frontend ANSI parser sees colors. lines is the scrollback depth;
// 0 falls back to 300 (the config default — keep the two in sync).
//
// A tmux failure is PROPAGATED (not swallowed to "",nil): callers use the error
// to hold their last-good state through a transient capture flake instead of
// treating a blank capture as truth — a blanked pane would drop a blocked
// agent's ✳ waiting lamp (the "never miss waiting" invariant). Only the "can't
// find pane/session/window" class — a target that no longer exists — maps to
// the empty+nil success return, because an empty capture of a dead pane is a
// legitimate empty, not a flake.
func (c *Client) CapturePane(ctx context.Context, target string, lines int) (string, error) {
	if lines <= 0 {
		lines = 300
	}
	out, err := c.Run(ctx, "capture-pane", "-t", target, "-p", "-S", strconv.Itoa(-lines), "-e")
	if err != nil {
		if isDeadTarget(err) {
			return "", nil
		}
		return "", err
	}
	return out, nil
}

// CapturePaneRange captures a history slice by absolute line offsets above the
// visible top: -S -startAbove .. -E -endAbove. endAbove 0 means "down to the
// visible bottom" (the -E flag is omitted), i.e. the CapturePane shape. Used by
// the H1 paged history fetch: chunk k is (offset+chunk, offset+1), which tmux
// clamps to the real history start — a fully-consumed history returns a short
// or single-line result, which the caller uses as the exhaustion signal.
// Verified live: -S -10000 -E -5001 abuts -S -5000 with no gap or overlap.
func (c *Client) CapturePaneRange(ctx context.Context, target string, startAbove, endAbove int) (string, error) {
	args := []string{"capture-pane", "-t", target, "-p", "-S", strconv.Itoa(-startAbove), "-e"}
	if endAbove > 0 {
		args = append(args, "-E", strconv.Itoa(-endAbove))
	}
	out, err := c.Run(ctx, args...)
	if err != nil {
		if isDeadTarget(err) {
			return "", nil
		}
		return "", err
	}
	return out, nil
}

// isDeadTarget reports whether err is tmux's "can't find pane/session/window"
// complaint — the target is gone, which is a legitimate empty result rather
// than a transient capture failure to be held through.
func isDeadTarget(err error) bool {
	return err != nil && strings.Contains(err.Error(), "can't find")
}
