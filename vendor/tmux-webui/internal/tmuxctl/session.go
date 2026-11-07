package tmuxctl

import (
	"context"
	"os"
	"strings"
)

// NewSession creates a detached session and returns the name tmux actually
// assigned (-P -F round-trips auto-numbered names when name is empty). cwd is
// the session's working dir; empty falls back to the user's home dir. The
// caller (server) passes config.DefaultSessionCWD here so tmuxctl stays
// decoupled from config.
func (c *Client) NewSession(ctx context.Context, name, cwd string) (string, error) {
	args := []string{"new-session", "-d", "-P", "-F", "#{session_name}"}
	// Without -c the session inherits the tmux-webui server process cwd
	// (daemon working dir), not anywhere the user would expect.
	if cwd == "" {
		if home, err := os.UserHomeDir(); err == nil {
			cwd = home
		}
	}
	if cwd != "" {
		args = append(args, "-c", cwd)
	}
	if name != "" {
		args = append(args, "-s", name)
	}
	out, err := c.Run(ctx, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// RenameSession renames an existing session. The "=" prefix pins the target to
// an exact match so a rename can't accidentally hit a prefix-sibling session.
func (c *Client) RenameSession(ctx context.Context, old, name string) error {
	_, err := c.Run(ctx, "rename-session", "-t", "="+old, name)
	return err
}

// KillSession destroys a session. Exact-match target ("=") matters more here
// than anywhere else — a stray prefix match would tear down the wrong session.
func (c *Client) KillSession(ctx context.Context, name string) error {
	_, err := c.Run(ctx, "kill-session", "-t", "="+name)
	return err
}
