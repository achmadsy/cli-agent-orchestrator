package autocomplete

// shortcuts.go — user-defined shortcut completion (bare-word trigger).
//
// Shortcuts are the user's own frequently-typed commands and prompt
// prefixes (yazi, lazygit, ultracode …) — deliberately separate from the
// Claude-resource types (skill/command/agent/mcp), which describe the CLI
// agent's universe rather than the user's habits. They live in a plain
// JSON file the user edits directly:
//
//	{
//	  "shortcuts": [
//	    {
//	      "name": "lazygit",
//	      "insert": "lazygit",
//	      "description": "git TUI",
//	      "keywords": ["lg"]
//	    }
//	  ]
//	}
//
// name is what fuzzy matching runs against; insert (default: name) is what
// a pick places in the input buffer; each keywords entry becomes an alias
// item ("lg → lazygit") so muscle-memory abbreviations also match. The file
// is re-read on every cache refresh — edits show up without a restart
// (or immediately via /api/autocomplete/refresh).

import (
	"context"
	"encoding/json"
	"log"
	"os"
)

// shortcutsFileMaxBytes caps the config read — a shortcuts file is hand
// written; anything near this size is a mistake, not a config.
const shortcutsFileMaxBytes = 1 << 20 // 1 MiB

type shortcutEntry struct {
	Name        string   `json:"name"`
	Insert      string   `json:"insert,omitempty"`
	Description string   `json:"description,omitempty"`
	Keywords    []string `json:"keywords,omitempty"`
}

type shortcutsFile struct {
	Shortcuts []shortcutEntry `json:"shortcuts"`
}

// ShortcutScanner reads user-defined shortcuts from a JSON file.
type ShortcutScanner struct {
	path string
}

// NewShortcutScanner returns a scanner over the given shortcuts file.
func NewShortcutScanner(path string) *ShortcutScanner {
	return &ShortcutScanner{path: path}
}

// Scan implements Scanner. A missing file is normal (feature unused) and
// returns nil silently; a malformed file is a user error and is logged
// loud rather than silently yielding an empty menu.
func (s *ShortcutScanner) Scan(_ context.Context) []Item {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil
	}
	if len(data) > shortcutsFileMaxBytes {
		log.Printf("autocomplete: shortcuts file %s exceeds %d bytes, ignoring", s.path, shortcutsFileMaxBytes)
		return nil
	}

	var f shortcutsFile
	if err := json.Unmarshal(data, &f); err != nil {
		log.Printf("autocomplete: shortcuts file %s: %v", s.path, err)
		return nil
	}

	var out []Item
	for _, e := range f.Shortcuts {
		if e.Name == "" {
			continue
		}
		insert := e.Insert
		if insert == "" {
			insert = e.Name
		}
		out = append(out, Item{
			Name:        e.Name,
			Description: e.Description,
			Type:        "shortcut",
			Icon:        "»",
			Source:      "shortcuts",
			Insert:      insert,
		})
		for _, kw := range e.Keywords {
			if kw == "" || kw == e.Name {
				continue
			}
			out = append(out, Item{
				Name:        kw,
				DisplayName: kw + " → " + e.Name,
				Description: e.Description,
				Type:        "shortcut",
				Icon:        "»",
				Source:      "shortcuts",
				Insert:      insert,
			})
		}
	}
	return out
}
