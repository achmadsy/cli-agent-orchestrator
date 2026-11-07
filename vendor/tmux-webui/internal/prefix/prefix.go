// Package prefix caches the tmux prefix key and its binding table.
//
// Frontend can't invoke "C-b" directly via send-keys (it would just be sent
// as a key press to the active program), so the server runs an FSM:
//  1. user sends prefix key → enter "prefix waiting" state
//  2. next key → look up binding in this cache → run the bound command
//
// Mirrors stations/tmux-webui/server.py:383-463.
package prefix

import (
	"context"
	"regexp"
	"strings"
	"sync"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// Cache lazily fetches the prefix key + bindings on first access.
// Safe for concurrent use; subsequent calls return the cached value.
type Cache struct {
	client *tmuxctl.Client

	mu       sync.Mutex
	keyOK    bool
	key      string
	bindOK   bool
	bindings map[string]string
}

func New(c *tmuxctl.Client) *Cache { return &Cache{client: c} }

// Key returns the global tmux prefix key (e.g., "C-b"). Falls back to "C-b"
// on any tmux error to keep the FSM functional even if the local tmux binary
// is missing or misbehaving.
func (c *Cache) Key(ctx context.Context) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.keyOK {
		return c.key
	}
	out, _ := c.client.RunOK(ctx, "show", "-gv", "prefix")
	s := strings.TrimSpace(out)
	if s == "" {
		s = "C-b"
	}
	c.key = s
	c.keyOK = true
	return s
}

// Bindings returns key→tmux-command from `tmux list-keys -T prefix`.
// Empty map on error (callers should fall back to sending the raw key).
func (c *Cache) Bindings(ctx context.Context) map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bindOK {
		return c.bindings
	}
	out, _ := c.client.RunOK(ctx, "list-keys", "-T", "prefix")
	c.bindings = parseBindings(out)
	c.bindOK = true
	return c.bindings
}

// Lookup returns the bound tmux command for keyCombo. Empty string means
// no binding — caller should send the key as a raw input.
func (c *Cache) Lookup(ctx context.Context, keyCombo string) string {
	return c.Bindings(ctx)[keyCombo]
}

// Match `bind-key [-r] -T prefix KEY CMD…` from tmux 3.x output.
// The optional `-r` flag (repeat) appears for keys like "Up" / "Left".
var bindRE = regexp.MustCompile(`^\s*bind-key\s+(?:-r\s+)?-T\s+prefix\s+(\S+)\s+(.+?)\s*$`)

func parseBindings(out string) map[string]string {
	m := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		if matches := bindRE.FindStringSubmatch(line); matches != nil {
			m[matches[1]] = matches[2]
		}
	}
	return m
}
