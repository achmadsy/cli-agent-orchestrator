package autocomplete

import (
	"context"
	"log"
	"sync"
	"time"
)

const defaultRefreshInterval = 5 * time.Minute

// Stats reports how many items are currently cached.
type Stats struct {
	Skills     int `json:"skills"`
	Commands   int `json:"commands"`
	Agents     int `json:"agents"`
	MCPServers int `json:"mcp_servers"`
	Builtins   int `json:"builtins"`
	Shortcuts  int `json:"shortcuts"`
}

// canonicalSlashSources is the default slash-source order — also the tie-break
// order used to append any source a partial SourcePriority omits.
var canonicalSlashSources = []string{"builtins", "skills", "commands"}

// ResourceCache holds a snapshot of scanned Claude resources and refreshes
// them periodically using a time.Ticker. All fields are protected by a Mutex.
type ResourceCache struct {
	mu        sync.Mutex
	skills    []Item
	commands  []Item
	agents    []Item
	mcps      []Item
	builtins  []Item
	shortcuts []Item

	scanners       []Scanner // empty / nil disables background scanning
	sourcePriority []string  // slash-source tie-break order
	interval       time.Duration
	ticker         *time.Ticker
	done           chan struct{}
}

// newResourceCache creates a cache and starts the background refresh ticker.
// Pass nil or empty scanners to disable background scanning. Empty
// sourcePriority defaults to the canonical builtins/skills/commands order.
func newResourceCache(scanners []Scanner, interval time.Duration, sourcePriority []string) *ResourceCache {
	if interval <= 0 {
		interval = defaultRefreshInterval
	}
	if len(sourcePriority) == 0 {
		sourcePriority = canonicalSlashSources
	}
	c := &ResourceCache{
		scanners:       scanners,
		sourcePriority: sourcePriority,
		interval:       interval,
		done:           make(chan struct{}),
	}

	// Initial synchronous scan so the cache is warm on first Complete() call.
	c.doScan()

	// Start background ticker.
	c.ticker = time.NewTicker(interval)
	go c.loop()

	return c
}

// loop runs the periodic refresh in a goroutine until Close() is called.
func (c *ResourceCache) loop() {
	for {
		select {
		case <-c.ticker.C:
			c.doScan()
		case <-c.done:
			return
		}
	}
}

// doScan calls every configured scanner and updates the cache atomically.
// Items from later scanners are appended after earlier ones, so caller
// ordering controls precedence (e.g. builtin → user → plugin).
func (c *ResourceCache) doScan() {
	if len(c.scanners) == 0 {
		return
	}

	var skills, commands, agents, mcps, builtins, shortcuts []Item
	ctx := context.Background()
	for _, s := range c.scanners {
		if s == nil {
			continue
		}
		for _, it := range s.Scan(ctx) {
			switch it.Type {
			case "skill":
				skills = append(skills, it)
			case "command":
				commands = append(commands, it)
			case "agent":
				agents = append(agents, it)
			case "mcp":
				mcps = append(mcps, it)
			case "builtin":
				builtins = append(builtins, it)
			case "shortcut":
				shortcuts = append(shortcuts, it)
			}
		}
	}

	c.mu.Lock()
	c.skills = skills
	c.commands = commands
	c.agents = agents
	c.mcps = mcps
	c.builtins = builtins
	c.shortcuts = shortcuts
	c.mu.Unlock()

	log.Printf("autocomplete: scan complete — %d skills, %d commands, %d agents, %d MCP servers, %d builtins, %d shortcuts",
		len(skills), len(commands), len(agents), len(mcps), len(builtins), len(shortcuts))
}

// slashItems returns the slash-query candidates (builtin + skills + commands),
// ordered so the pre-ranking sequence decides ties at equal fuzzy score
// (rankAndFilter's sort is stable).
//
// Sources are emitted in SourcePriority order; any canonical source the
// priority list omits keeps its default position after the listed ones
// (reorder, never drop). User-defined shortcuts are NOT part of slash queries —
// they have their own bare-word trigger (see shortcutItems).
func (c *ResourceCache) slashItems() []Item {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Item, 0, len(c.builtins)+len(c.skills)+len(c.commands))

	emitted := make(map[string]bool, len(canonicalSlashSources))
	appendSource := func(src string) {
		switch src {
		case "builtins":
			out = append(out, c.builtins...)
		case "skills":
			out = append(out, c.skills...)
		case "commands":
			out = append(out, c.commands...)
		default:
			return // unknown source name — ignore
		}
		emitted[src] = true
	}
	for _, src := range c.sourcePriority {
		if !emitted[src] {
			appendSource(src)
		}
	}
	for _, src := range canonicalSlashSources {
		if !emitted[src] {
			appendSource(src)
		}
	}
	return out
}

// atItems returns a copy of agents + mcp servers (for "@" prefix queries).
func (c *ResourceCache) atItems() []Item {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Item, 0, len(c.agents)+len(c.mcps))
	out = append(out, c.agents...)
	out = append(out, c.mcps...)
	return out
}

// shortcutItems returns a copy of user-defined shortcuts (bare-word queries).
func (c *ResourceCache) shortcutItems() []Item {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Item, len(c.shortcuts))
	copy(out, c.shortcuts)
	return out
}

// snapshot returns current stats without triggering a scan.
func (c *ResourceCache) snapshot() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Stats{
		Skills:     len(c.skills),
		Commands:   len(c.commands),
		Agents:     len(c.agents),
		MCPServers: len(c.mcps),
		Builtins:   len(c.builtins),
		Shortcuts:  len(c.shortcuts),
	}
}

// forceRefresh triggers an immediate synchronous scan and returns updated stats.
func (c *ResourceCache) forceRefresh() Stats {
	c.doScan()
	return c.snapshot()
}

// Close stops the background ticker goroutine.
func (c *ResourceCache) Close() {
	if c.ticker != nil {
		c.ticker.Stop()
	}
	close(c.done)
}
