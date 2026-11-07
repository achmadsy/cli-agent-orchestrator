package autocomplete

import (
	"os"
	"strings"
	"time"
)

const defaultMaxResults = 15

// Options configures the autocomplete Engine.
type Options struct {
	// ClaudeDir enables scanning of ~/.claude/{skills,commands,agents}.
	// Pass an empty string to disable; path completion is always enabled.
	// "~" is NOT expanded here — pass os.UserHomeDir() + "/.claude" explicitly,
	// or use ExpandClaudeDir() if you want automatic "~/.claude" expansion.
	ClaudeDir string

	// RefreshInterval controls how often the background scanner runs.
	// Zero defaults to 5 minutes.
	RefreshInterval time.Duration

	// IncludePlugins enables scanning of
	// ~/.claude/plugins/marketplaces/<m>/{external_plugins,plugins}/<p>/{skills,commands,agents}/.
	// Requires ClaudeDir to be set; ignored otherwise.
	IncludePlugins bool

	// IncludeBuiltins enables the curated list of Claude Code built-in slash
	// commands (/compact, /model, /clear, etc.).
	IncludeBuiltins bool

	// MaxResults caps the suggestions returned per query. Zero → defaultMaxResults
	// (15), the historical default.
	MaxResults int

	// SourcePriority orders the slash-item sources for tie-breaking at equal fuzzy
	// score. Empty → the canonical builtins/skills/commands order. A source
	// omitted from the list keeps its default position after the listed ones
	// (reorder, never drop).
	SourcePriority []string

	// ShortcutsFile, when set, enables user-defined shortcut completion from
	// that JSON file (see shortcuts.go for the format). A missing file is
	// fine — the source stays empty until the user creates it.
	ShortcutsFile string
}

// DefaultOptions returns Options with plugin + builtin scanning enabled — the
// recommended baseline for matching the full Claude Code resource universe.
// Callers wanting legacy user-only behavior construct Options literally.
func DefaultOptions(claudeDir string) Options {
	return Options{
		ClaudeDir:       claudeDir,
		IncludePlugins:  true,
		IncludeBuiltins: true,
	}
}

// ExpandClaudeDir returns ~/.claude expanded to an absolute path.
// Returns empty string if home dir is unavailable.
func ExpandClaudeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home + "/.claude"
}

// Engine is the main autocomplete engine.
type Engine struct {
	cache      *ResourceCache
	files      *fileLister
	maxResults int // 0 → defaultMaxResults, resolved per Complete call
}

// New creates an Engine with the provided options. A background scanner goroutine
// is started immediately when at least one source is enabled.
func New(opts Options) *Engine {
	var scanners []Scanner
	if opts.ClaudeDir != "" {
		scanners = append(scanners, NewClaudeDirScanner(opts.ClaudeDir))
		if opts.IncludePlugins {
			scanners = append(scanners, NewPluginScanner(opts.ClaudeDir))
		}
	}
	if opts.IncludeBuiltins {
		scanners = append(scanners, NewBuiltinScanner())
	}
	if opts.ShortcutsFile != "" {
		scanners = append(scanners, NewShortcutScanner(opts.ShortcutsFile))
	}
	return &Engine{
		cache:      newResourceCache(scanners, opts.RefreshInterval, opts.SourcePriority),
		files:      newFileLister(),
		maxResults: opts.MaxResults,
	}
}

// Complete routes the query and returns up to e.maxResults suggestions (0 →
// defaultMaxResults, 15).
//
// Routing rules:
//
//   - typeFilter == "path"                              → path completion
//   - typeFilter == "slash"                             → slash items (builtin + skill + command)
//   - typeFilter == "skill" / "command" / "builtin"     → slash items, narrowed by type
//   - typeFilter == "" && query starts with "/"         → slash items
//   - typeFilter == "at" / "agent" / "mcp" / "file"     → at items (agents + mcp + files)
//   - typeFilter == "" && query starts with "@"         → at items
//   - typeFilter == "shortcut"                          → user-defined shortcuts (bare-word trigger)
//   - typeFilter == "" && query starts with "~" / "./"  → path completion
//   - typeFilter == "" && query contains "/"            → path completion
//   - empty query                                       → empty slice
func (e *Engine) Complete(query, typeFilter string) []Item {
	return e.CompleteIn("", query, typeFilter)
}

// CompleteIn is Complete with a working-directory context: when cwd is
// non-empty, the "@" branch additionally offers files under cwd (fzf-style,
// relative paths) alongside agents/mcp. The web UI passes the focused pane's
// cwd so "@parti" completes to a path the CLI inside that pane can resolve.
func (e *Engine) CompleteIn(cwd, query, typeFilter string) []Item {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil
	}

	limit := e.maxResults
	if limit <= 0 {
		limit = defaultMaxResults
	}

	// Explicit path mode.
	if typeFilter == "path" {
		return completePath(query, limit)
	}

	// Bare-word shortcut trigger — no sigil to strip, the query IS the
	// keyword. Only reachable via explicit typeFilter: an implicit fallback
	// would shadow the path/slash/at detection below.
	if typeFilter == "shortcut" {
		return rankAndFilter(e.cache.shortcutItems(), query, limit)
	}

	// Slash trigger → builtin / skill / command items.
	// Accept the umbrella "slash" filter (sent by the web UI), the per-type
	// narrowing filters, and the implicit "/"-prefix detection.
	if typeFilter == "slash" || typeFilter == "skill" || typeFilter == "command" || typeFilter == "builtin" ||
		(typeFilter == "" && strings.HasPrefix(query, "/")) {

		search := strings.TrimLeft(query, "/")
		items := e.cache.slashItems()

		// Narrow by typeFilter when a specific type was requested.
		if typeFilter == "skill" || typeFilter == "command" || typeFilter == "builtin" {
			items = filterByType(items, typeFilter)
		}

		return rankAndFilter(items, search, limit)
	}

	// "@" trigger → agent, mcp, or file items.
	// Accept the umbrella "at" filter, the per-type narrowing filters
	// ("agent", "mcp", "file"), and the implicit "@"-prefix detection.
	if typeFilter == "at" || typeFilter == "agent" || typeFilter == "mcp" || typeFilter == "file" ||
		(typeFilter == "" && strings.HasPrefix(query, "@")) {

		search := strings.TrimLeft(query, "@")

		var items []Item
		if typeFilter != "file" {
			items = e.cache.atItems()
			if typeFilter == "agent" || typeFilter == "mcp" {
				items = filterByType(items, typeFilter)
			}
		}
		if cwd != "" && (typeFilter == "" || typeFilter == "at" || typeFilter == "file") {
			items = append(items, e.fileCandidates(cwd)...)
		}

		return rankAndFilter(items, search, limit)
	}

	// Implicit path detection.
	if strings.HasPrefix(query, "~/") || strings.HasPrefix(query, "./") ||
		strings.Contains(query, "/") {
		return completePath(query, limit)
	}

	return nil
}

// Refresh forces an immediate re-scan and returns the updated Stats.
func (e *Engine) Refresh() Stats {
	return e.cache.forceRefresh()
}

// Stats returns the current cache statistics without triggering a scan.
func (e *Engine) Stats() Stats {
	return e.cache.snapshot()
}

// Close stops the background refresh goroutine. Call via defer after New().
func (e *Engine) Close() {
	e.cache.Close()
}

// filterByType returns only items whose Type matches t.
func filterByType(items []Item, t string) []Item {
	out := make([]Item, 0, len(items))
	for _, it := range items {
		if it.Type == t {
			out = append(out, it)
		}
	}
	return out
}
