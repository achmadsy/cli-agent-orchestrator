package ws

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

// Restricted history pagination uses immutable bounded captures, never offsets
// into a rolling tmux history. history_size/history_bytes are not generations:
// equal-width output at history-limit can replace rows without changing either.
const caoHistorySnapshots = 16
const caoHistoryDepth = 5000
const caoHistoryBytes = 512 << 10

type caoHistorySnapshot struct {
	target   CAOTarget
	pane     string
	boundary string
	rows     int
	lines    []string
	expires  time.Time
}

type caoHistoryCache struct {
	sync.Mutex
	items map[string]caoHistorySnapshot
}

func (c *caoHistoryCache) put(target CAOTarget, pane, boundary, content string, rows int) (string, caoHistorySnapshot) {
	c.Lock()
	defer c.Unlock()
	if c.items == nil {
		c.items = make(map[string]caoHistorySnapshot)
	}
	now := time.Now()
	for id, item := range c.items {
		if now.After(item.expires) {
			delete(c.items, id)
		}
	}
	if len(c.items) >= caoHistorySnapshots {
		var oldest string
		for id, item := range c.items {
			if oldest == "" || item.expires.Before(c.items[oldest].expires) {
				oldest = id
			}
		}
		delete(c.items, oldest)
	}
	var random [20]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", caoHistorySnapshot{}
	}
	id := hex.EncodeToString(random[:])
	item := caoHistorySnapshot{target: target, pane: pane, boundary: boundary, rows: rows,
		lines: strings.Split(strings.TrimSuffix(content, "\n"), "\n"), expires: now.Add(2 * time.Minute)}
	c.items[id] = item
	return id, item
}

func (c *caoHistoryCache) get(id string, target CAOTarget, pane, boundary string) (caoHistorySnapshot, bool) {
	c.Lock()
	defer c.Unlock()
	item, ok := c.items[id]
	if !ok || time.Now().After(item.expires) || item.target != target || item.pane != pane || item.boundary != boundary {
		return caoHistorySnapshot{}, false
	}
	return item, true
}

func (s caoHistorySnapshot) page(lines, offset int) (string, bool) {
	// The first page includes the captured live grid. Subsequent pages are only
	// the history immediately preceding it in this same immutable capture.
	end := len(s.lines)
	if offset > 0 {
		end = len(s.lines) - s.rows - offset
	}
	if end <= 0 {
		return "", true
	}
	start := len(s.lines) - s.rows - offset - lines
	if start < 0 {
		start = 0
	}
	if start > end {
		start = end
	}
	return strings.Join(s.lines[start:end], "\n") + "\n", start == 0
}
