package autocomplete

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// ClaudeDirScanner scans ~/.claude/{skills,commands,agents} and settings.json
// for autocomplete items. It implements Scanner.
type ClaudeDirScanner struct {
	claudeDir string
}

// NewClaudeDirScanner returns a scanner rooted at claudeDir (e.g. "~/.claude").
// The path must already be expanded (no "~").
func NewClaudeDirScanner(claudeDir string) *ClaudeDirScanner {
	return &ClaudeDirScanner{claudeDir: claudeDir}
}

// Scan implements Scanner. It walks skills, commands, agents, and settings.json.
func (s *ClaudeDirScanner) Scan(_ context.Context) []Item {
	var out []Item
	out = append(out, s.scanSkills()...)
	out = append(out, s.scanCommands()...)
	out = append(out, s.scanAgents()...)
	out = append(out, s.scanMCPServers()...)
	return out
}

func (s *ClaudeDirScanner) scanSkills() []Item {
	dir := filepath.Join(s.claudeDir, "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var out []Item
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		slug := e.Name()
		// Skip hidden dirs (e.g. `.backups` written by skill-curator). They
		// are not user-invocable skills.
		if strings.HasPrefix(slug, ".") {
			continue
		}
		md := filepath.Join(dir, slug, "SKILL.md")
		fm := parseYAMLFrontmatter(md)
		// PluginScanner already drops dirs without SKILL.md; mirror that
		// here so plain holder dirs (e.g. one containing only `references/`)
		// don't surface as empty skill entries.
		if fm == nil {
			continue
		}

		desc := truncate(fm["description"], 100)
		displayName := fm["name"]
		if displayName == "" {
			displayName = slug
		}

		out = append(out, Item{
			Name:        slug,
			DisplayName: displayName,
			Description: desc,
			Type:        "skill",
			Icon:        "/",
		})
	}
	return out
}

func (s *ClaudeDirScanner) scanCommands() []Item {
	dir := filepath.Join(s.claudeDir, "commands")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var out []Item
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		base := strings.TrimSuffix(e.Name(), ".md")
		fm := parseYAMLFrontmatter(filepath.Join(dir, e.Name()))

		desc := truncate(fm["description"], 100)
		displayName := fm["name"]
		if displayName == "" {
			displayName = base
		}

		out = append(out, Item{
			Name:        base,
			DisplayName: displayName,
			Description: desc,
			Type:        "command",
			Icon:        "/",
		})
	}
	return out
}

func (s *ClaudeDirScanner) scanAgents() []Item {
	dir := filepath.Join(s.claudeDir, "agents")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var out []Item
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		base := strings.TrimSuffix(e.Name(), ".md")
		fm := parseYAMLFrontmatter(filepath.Join(dir, e.Name()))

		// Build description from model + maxTurns fields (mirrors Python).
		var descParts []string
		if m := fm["model"]; m != "" {
			descParts = append(descParts, m)
		}
		if mt := fm["maxTurns"]; mt != "" {
			descParts = append(descParts, "max "+mt+" turns")
		}

		displayName := fm["name"]
		if displayName == "" {
			displayName = base
		}

		out = append(out, Item{
			Name:        base,
			DisplayName: displayName,
			Description: strings.Join(descParts, ", "),
			Type:        "agent",
			Icon:        "@",
		})
	}
	return out
}

func (s *ClaudeDirScanner) scanMCPServers() []Item {
	settingsPath := filepath.Join(s.claudeDir, "settings.json")
	return parseMCPServersFromFile(settingsPath)
}

// parseMCPServersFromFile reads mcpServers from a JSON settings file.
func parseMCPServersFromFile(path string) []Item {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}

	var raw struct {
		MCPServers map[string]struct {
			Command string `json:"command"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}

	out := make([]Item, 0, len(raw.MCPServers))
	for name, cfg := range raw.MCPServers {
		desc := "MCP server"
		if cfg.Command != "" {
			desc = "MCP: " + cfg.Command
		}
		out = append(out, Item{
			Name:        name,
			DisplayName: name,
			Description: desc,
			Type:        "mcp",
			Icon:        "@",
		})
	}
	return out
}

// ── Minimal YAML frontmatter parser ───────────────────────────────────────────

// parseYAMLFrontmatter reads at most 4 KB of a markdown file and extracts
// the YAML frontmatter block (between leading "---" lines).
//
// Supported:
//   - Simple scalar values:     key: value
//   - Quoted values:            key: "value" or key: 'value'
//   - Block scalars (>-, >, |-, |): value spans subsequent indented lines
//
// NOT supported: nested maps, anchors, tags, flow sequences.
// Returns nil on any error; caller treats nil as empty.
func parseYAMLFrontmatter(path string) map[string]string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	buf := make([]byte, 4096)
	n, _ := f.Read(buf)
	content := string(buf[:n])

	result := map[string]string{}

	// Must start with "---".
	if !strings.HasPrefix(content, "---") {
		// No frontmatter — try to extract name from first "# " header.
		extractFallbacks(content, "", result)
		return result
	}

	// Find the closing "---".
	end := strings.Index(content[3:], "\n---")
	var body string
	var fmText string
	if end == -1 {
		// No closing delimiter — treat whole file as body.
		body = content
	} else {
		fmText = strings.TrimSpace(content[3 : 3+end])
		body = strings.TrimSpace(content[3+end+4:])
	}

	if fmText != "" {
		lines := strings.Split(fmText, "\n")
		i := 0
		for i < len(lines) {
			line := lines[i]
			// Only top-level keys (not indented).
			colonIdx := strings.Index(line, ":")
			if colonIdx > 0 && !strings.HasPrefix(line, " ") {
				key := strings.TrimSpace(line[:colonIdx])
				val := strings.TrimSpace(line[colonIdx+1:])

				// Strip surrounding quotes.
				val = stripQuotes(val)

				// Handle block scalars.
				if val == ">-" || val == ">" || val == "|-" || val == "|" {
					var parts []string
					i++
					for i < len(lines) && (strings.HasPrefix(lines[i], "  ") || strings.TrimSpace(lines[i]) == "") {
						trimmed := strings.TrimSpace(lines[i])
						if trimmed != "" {
							parts = append(parts, trimmed)
						}
						i++
					}
					result[key] = strings.Join(parts, " ")
					continue
				}
				result[key] = val
			}
			i++
		}
	}

	extractFallbacks(content, body, result)
	return result
}

// extractFallbacks fills in missing "name" (from first "# " header in body)
// and "description" (from first non-header, non-separator paragraph line).
func extractFallbacks(fullContent, body string, result map[string]string) {
	// Use body if available, otherwise full content.
	src := body
	if src == "" {
		src = fullContent
	}

	if _, ok := result["name"]; !ok {
		for _, line := range strings.Split(src, "\n") {
			if strings.HasPrefix(line, "# ") {
				result["name"] = strings.TrimSpace(line[2:])
				break
			}
		}
	}

	if _, ok := result["description"]; !ok {
		for _, line := range strings.Split(src, "\n") {
			line = strings.TrimSpace(line)
			if line != "" && !strings.HasPrefix(line, "#") && !strings.HasPrefix(line, "---") {
				if len(line) > 120 {
					line = line[:120]
				}
				result["description"] = line
				break
			}
		}
	}
}

// stripQuotes removes surrounding double or single quotes from a YAML scalar.
func stripQuotes(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// truncate returns s trimmed to at most n runes.
func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
