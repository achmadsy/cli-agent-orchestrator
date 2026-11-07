package autocomplete

import "context"

// Item represents a single autocomplete suggestion.
type Item struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name,omitempty"`
	Description string `json:"description,omitempty"`
	Type        string `json:"type"` // "skill" | "command" | "agent" | "mcp" | "builtin" | "path" | "file" | "shortcut"
	Icon        string `json:"icon,omitempty"`
	// Source records origin: empty / "user" for ~/.claude scanner,
	// "plugin:<marketplace>:<plugin>" for marketplace plugins,
	// "builtin" for Claude Code built-in slash commands.
	Source string `json:"source,omitempty"`
	// Insert, when non-empty, is the exact text a pick places in the input
	// buffer instead of Name — shortcuts map a short keyword to a longer
	// command/prompt.
	Insert string `json:"insert,omitempty"`
}

// Scanner is the interface implemented by resource scanners (Claude dir, etc.).
// Scan performs the full directory walk and returns all discovered items.
// Implementations must be safe to call concurrently.
type Scanner interface {
	Scan(ctx context.Context) []Item
}
