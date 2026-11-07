package tmuxctl

import (
	"context"
	"errors"
	"fmt"
	"unicode"
)

// maxWindowNameLen caps rename-window input so a runaway name can't blow up
// the tab strip; tmux itself has no such limit.
const maxWindowNameLen = 50

func (c *Client) NewWindow(ctx context.Context, session string) error {
	// -c keeps the new window in the active pane's directory; without it the
	// window inherits the tmux-webui server process cwd, not the user's dir.
	_, err := c.Run(ctx, "new-window", "-t", session, "-c", "#{pane_current_path}")
	return err
}

func (c *Client) KillWindow(ctx context.Context, session string, window int) error {
	_, err := c.Run(ctx, "kill-window", "-t", fmt.Sprintf("%s:%d", session, window))
	return err
}

// RenameWindow renames a window. tmux itself accepts almost any name, so
// validation here stays minimal: non-empty, no control characters, capped at
// maxWindowNameLen.
func (c *Client) RenameWindow(ctx context.Context, session string, window int, name string) error {
	if name == "" {
		return errors.New("tmuxctl: window name must not be empty")
	}
	if len(name) > maxWindowNameLen {
		return errors.New("tmuxctl: window name too long (max 50)")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return errors.New("tmuxctl: window name must not contain control characters")
		}
	}
	_, err := c.Run(ctx, "rename-window", "-t", fmt.Sprintf("%s:%d", session, window), name)
	return err
}
