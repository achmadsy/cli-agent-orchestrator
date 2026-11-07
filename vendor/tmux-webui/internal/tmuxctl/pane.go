package tmuxctl

import (
	"context"
	"errors"
	"strconv"
	"strings"
)

func (c *Client) ResizePane(ctx context.Context, target string, cols, rows int) error {
	_, err := c.Run(ctx, "resize-pane", "-t", target, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
	return err
}

// ResizeWindow sets a window's size (requires window-size manual, which the
// workshop tmux sets globally). Used by the mobile single-pane fit: a sole pane
// can't be sized below its window, so the WINDOW must shrink for a fullscreen
// TUI (yazi/lazygit) to match the phone. target may be "session:winIdx".
func (c *Client) ResizeWindow(ctx context.Context, target string, cols, rows int) error {
	_, err := c.Run(ctx, "resize-window", "-t", target, "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
	return err
}

// WindowSize returns the target window's (width, height) in cells; target may be
// "session:winIdx". Returns (0, 0, error) on any failure so the caller can skip a
// resize it has no trustworthy size for. Mirrors LayoutOf's display-message shape;
// used by fit-mode to capture the pre-fit window size for restore (R2).
func (c *Client) WindowSize(ctx context.Context, target string) (int, int, error) {
	out, ok := c.RunOK(ctx, "display-message", "-t", target, "-p", "#{window_width}\t#{window_height}")
	if !ok {
		return 0, 0, errors.New("tmuxctl: window size query failed")
	}
	parts := strings.SplitN(strings.TrimSpace(out), "\t", 2)
	if len(parts) < 2 {
		return 0, 0, errors.New("tmuxctl: unexpected window size output")
	}
	return atoi(parts[0]), atoi(parts[1]), nil
}

// WindowPaneCount returns how many panes the target's window holds (0 on error).
// Used to pick window- vs pane-resize in fit: only a single-pane window needs
// its window resized.
func (c *Client) WindowPaneCount(ctx context.Context, target string) int {
	out, ok := c.RunOK(ctx, "display-message", "-t", target, "-p", "#{window_panes}")
	if !ok {
		return 0
	}
	return atoi(strings.TrimSpace(out))
}

// PaneCurrentPath returns the target pane's working directory ("" on any
// failure). Used by @-file autocomplete: the @path token is resolved by the
// CLI running INSIDE the pane, so completions must be relative to ITS cwd,
// not the tmux-webui server's.
func (c *Client) PaneCurrentPath(ctx context.Context, target string) string {
	out, ok := c.RunOK(ctx, "display-message", "-t", target, "-p", "#{pane_current_path}")
	if !ok {
		return ""
	}
	return strings.TrimSpace(out)
}

func (c *Client) SplitWindow(ctx context.Context, target string, horizontal bool) error {
	flag := "-v"
	if horizontal {
		flag = "-h"
	}
	// -c keeps the new pane in the SPLIT pane's directory; without it the pane
	// inherits the tmux-webui server process cwd (its install dir), not the
	// user's working directory.
	_, err := c.Run(ctx, "split-window", flag, "-t", target, "-c", "#{pane_current_path}")
	return err
}

func (c *Client) KillPane(ctx context.Context, target string) error {
	_, err := c.Run(ctx, "kill-pane", "-t", target)
	return err
}

// SelectLayout applies a tmux layout preset. Empty layout falls back to
// "even-horizontal" to match Python's default.
func (c *Client) SelectLayout(ctx context.Context, target, layout string) error {
	if layout == "" {
		layout = "even-horizontal"
	}
	_, err := c.Run(ctx, "select-layout", "-t", target, layout)
	return err
}

// SelectPaneByDirection moves focus by direction: left/right/up/down (case-insensitive).
func (c *Client) SelectPaneByDirection(ctx context.Context, target, direction string) error {
	flag, ok := directionFlag(strings.ToLower(direction))
	if !ok {
		return errors.New("tmuxctl: invalid direction: " + direction)
	}
	_, err := c.Run(ctx, "select-pane", "-t", target, flag)
	return err
}

func directionFlag(d string) (string, bool) {
	switch d {
	case "left":
		return "-L", true
	case "right":
		return "-R", true
	case "up":
		return "-U", true
	case "down":
		return "-D", true
	}
	return "", false
}

// SelectPane focuses a specific pane by tmux target (e.g., "session:0.1").
func (c *Client) SelectPane(ctx context.Context, target string) error {
	_, err := c.Run(ctx, "select-pane", "-t", target)
	return err
}

// LayoutOf returns the window-layout string. Used by fit-mode to save/restore
// layouts when the frontend resizes panes.
func (c *Client) LayoutOf(ctx context.Context, target string) (string, error) {
	out, ok := c.RunOK(ctx, "display-message", "-t", target, "-p", "#{window_layout}")
	if !ok {
		return "", nil
	}
	return strings.TrimSpace(out), nil
}
