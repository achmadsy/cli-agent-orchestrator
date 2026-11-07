// Package tmuxctl wraps tmux subprocess calls used by tmux-webui.
// It mirrors stations/tmux-webui/tmux_manager.py and the relevant
// primitives in libs/tmux-lib/tmux_lib/primitives.py.
package tmuxctl

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Client runs tmux commands. Construct with New().
type Client struct {
	bin     string
	timeout time.Duration
	socket  string
}

type Option func(*Client)

// WithSocket pins the server explicitly (including isolated test sockets).
func WithSocket(p string) Option { return func(c *Client) { c.socket = p } }
func WithBinary(p string) Option { return func(c *Client) { c.bin = p } }

func (c *Client) command(ctx context.Context, args ...string) *exec.Cmd {
	if c.socket != "" {
		args = append([]string{"-S", c.socket}, args...)
	}
	return exec.CommandContext(ctx, c.bin, args...)
}
func WithTimeout(d time.Duration) Option { return func(c *Client) { c.timeout = d } }

func New(opts ...Option) *Client {
	c := &Client{bin: "tmux", timeout: 10 * time.Second}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Binary returns the tmux executable this client runs. The rescue package
// spawns its own abandonable probe processes with it (a wedged server can
// leave clients stuck in uninterruptible connect(), so rescue cannot use the
// blocking Run path).
func (c *Client) Binary() string { return c.bin }

// run executes tmux with the given args and returns stdout. Stderr is folded
// into the returned error so callers can surface tmux complaints.
func (c *Client) Run(ctx context.Context, args ...string) (string, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.timeout)
		defer cancel()
	}
	cmd := c.command(ctx, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("tmux %s: %w (stderr: %s)", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

// runOK swallows errors. Use for queries where an empty result is the
// natural fallback (e.g., list-sessions on an empty server).
func (c *Client) RunOK(ctx context.Context, args ...string) (string, bool) {
	s, err := c.Run(ctx, args...)
	return s, err == nil
}
