package autocomplete

import (
	"os"
	"path/filepath"
	"strings"
)

const defaultPathMaxResults = 15

// completePath returns filesystem path completion suggestions for partial.
// Mirrors Python complete_path():
//
//   - "~" is expanded via os.UserHomeDir.
//   - partial ending with "/" → list directory contents.
//   - otherwise → match entries in the same directory by prefix.
//   - Hidden entries (starting with ".") are skipped unless partial starts with ".".
func completePath(partial string, maxResults int) []Item {
	if maxResults <= 0 {
		maxResults = defaultPathMaxResults
	}

	expanded := expandTilde(partial)

	// If the expanded path is a directory without trailing slash, add one.
	if !strings.HasSuffix(expanded, "/") {
		if info, err := os.Stat(expanded); err == nil && info.IsDir() {
			expanded += "/"
		}
	}

	var baseDir, prefix string
	if strings.HasSuffix(expanded, "/") {
		baseDir = expanded
		prefix = ""
	} else {
		baseDir = filepath.Dir(expanded)
		if baseDir == "" {
			baseDir = "."
		}
		prefix = strings.ToLower(filepath.Base(expanded))
	}

	entries, err := os.ReadDir(baseDir)
	if err != nil {
		return nil
	}

	// Sort is guaranteed by os.ReadDir (lexicographic).
	results := make([]Item, 0, maxResults)
	for _, e := range entries {
		name := e.Name()

		// Skip hidden unless prefix starts with ".".
		if strings.HasPrefix(name, ".") && !strings.HasPrefix(prefix, ".") {
			continue
		}

		// Prefix filter.
		if prefix != "" && !strings.HasPrefix(strings.ToLower(name), prefix) {
			continue
		}

		isDir := e.IsDir()
		display := name
		if isDir {
			display += "/"
		}

		// Reconstruct completion preserving the original "~" style if needed.
		var completed string
		if strings.HasSuffix(expanded, "/") {
			completed = partial + display
		} else {
			// Rebuild preserving ~ prefix.
			if strings.HasPrefix(partial, "~/") || partial == "~" {
				home, _ := os.UserHomeDir()
				full := filepath.Join(baseDir, name)
				rel, _ := filepath.Rel(home, full)
				completed = "~/" + rel
				if isDir {
					completed += "/"
				}
			} else {
				completed = filepath.Join(filepath.Dir(partial), display)
			}
		}

		desc := "file"
		if isDir {
			desc = "directory"
		}

		results = append(results, Item{
			Name:        completed,
			DisplayName: display,
			Description: desc,
			Type:        "path",
			Icon:        "/",
		})
		if len(results) >= maxResults {
			break
		}
	}

	return results
}

// expandTilde replaces a leading "~" with the user's home directory.
func expandTilde(p string) string {
	if p == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return home + p[1:]
	}
	return p
}
