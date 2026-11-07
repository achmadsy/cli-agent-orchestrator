package autocomplete

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// PluginScanner walks plugin marketplaces under <claudeDir>/plugins/.
//
// Two modes:
//
//  1. **Installed-only** (preferred, matches Claude Code behavior). If
//     <claudeDir>/plugins/installed_plugins.json exists, the scanner reads
//     it and only emits items from plugins the user has actually `/plugin
//     install`ed. Each entry's `installPath` is treated as the plugin root
//     (it normally lives under <claudeDir>/plugins/cache/<marketplace>/
//     <plugin>/<version>/).
//
//  2. **Fallback whole-tree** (legacy). If the manifest is absent or
//     unparseable, the scanner walks every plugin under
//     <claudeDir>/plugins/marketplaces/<marketplace>/{plugins,
//     external_plugins}/<plugin>/. This is what the original scanner did
//     and is kept so OSS users (and tests using bare marketplace fixtures)
//     continue to work without a manifest.
//
// Both "external_plugins/" and "plugins/" subdir layouts coexist in the
// wild — the fallback scans either.
type PluginScanner struct {
	claudeDir string
}

// NewPluginScanner returns a scanner rooted at claudeDir (e.g. "~/.claude").
// The path must already be expanded (no "~").
func NewPluginScanner(claudeDir string) *PluginScanner {
	return &PluginScanner{claudeDir: claudeDir}
}

// installedPlugin is one entry resolved from installed_plugins.json.
type installedPlugin struct {
	marketplace string
	plugin      string
	installPath string
}

// installedPluginsManifest mirrors the v2 schema:
//
//	{
//	  "version": 2,
//	  "plugins": {
//	    "<plugin>@<marketplace>": [
//	      { "scope": "user", "installPath": "...", "version": "..." }
//	    ]
//	  }
//	}
type installedPluginsManifest struct {
	Version int                                `json:"version"`
	Plugins map[string][]installedPluginRecord `json:"plugins"`
}

type installedPluginRecord struct {
	Scope       string `json:"scope"`
	InstallPath string `json:"installPath"`
	Version     string `json:"version"`
}

// Scan implements Scanner. Returns nil if neither manifest nor marketplaces
// dir can be read.
func (s *PluginScanner) Scan(_ context.Context) []Item {
	if installed, ok := s.readInstalled(); ok {
		return s.scanInstalled(installed)
	}
	return s.scanMarketplaceTree()
}

// readInstalled loads installed_plugins.json. Returns ok=false (no manifest
// or unparseable) so the caller falls back to the legacy whole-tree scan.
// A manifest with an empty plugins map returns ok=true with no entries —
// the user has explicitly installed nothing, and the legacy fallback would
// otherwise flood the menu with every marketplace plugin.
func (s *PluginScanner) readInstalled() ([]installedPlugin, bool) {
	path := filepath.Join(s.claudeDir, "plugins", "installed_plugins.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var m installedPluginsManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, false
	}

	out := make([]installedPlugin, 0, len(m.Plugins))
	for key, records := range m.Plugins {
		// key format: "<plugin>@<marketplace>". Split on the rightmost "@"
		// because plugin names occasionally contain "@" (rare but possible
		// for scoped packages), while marketplace names are simple slugs.
		at := strings.LastIndex(key, "@")
		if at < 0 {
			continue
		}
		plugin, marketplace := key[:at], key[at+1:]
		if plugin == "" || marketplace == "" {
			continue
		}
		for _, rec := range records {
			if rec.InstallPath == "" {
				continue
			}
			out = append(out, installedPlugin{
				marketplace: marketplace,
				plugin:      plugin,
				installPath: rec.InstallPath,
			})
		}
	}
	return out, true
}

// scanInstalled emits items from each installed plugin's resolved install
// path. Missing or unreadable paths are silently skipped — the manifest can
// out-live the cache during plugin uninstall races.
func (s *PluginScanner) scanInstalled(installed []installedPlugin) []Item {
	var out []Item
	for _, ip := range installed {
		out = append(out, s.scanPlugin(ip.installPath, ip.marketplace, ip.plugin)...)
	}
	return out
}

// scanMarketplaceTree is the legacy behavior — walk every plugin dir in
// every marketplace, regardless of install state. Preserved for fixture
// tests and OSS callers without a Claude Code installation.
func (s *PluginScanner) scanMarketplaceTree() []Item {
	root := filepath.Join(s.claudeDir, "plugins", "marketplaces")
	marketplaces, err := os.ReadDir(root)
	if err != nil {
		return nil
	}

	var out []Item
	for _, m := range marketplaces {
		if !m.IsDir() || strings.HasPrefix(m.Name(), ".") {
			continue
		}
		marketDir := filepath.Join(root, m.Name())
		for _, layout := range []string{"plugins", "external_plugins"} {
			pluginsRoot := filepath.Join(marketDir, layout)
			plugins, err := os.ReadDir(pluginsRoot)
			if err != nil {
				continue
			}
			for _, p := range plugins {
				if !p.IsDir() || strings.HasPrefix(p.Name(), ".") {
					continue
				}
				out = append(out, s.scanPlugin(filepath.Join(pluginsRoot, p.Name()), m.Name(), p.Name())...)
			}
		}
	}
	return out
}

// scanPlugin reads one plugin's {skills,commands,agents} subdirs and tags
// each item with marketplace + plugin namespace.
func (s *PluginScanner) scanPlugin(pluginDir, marketplace, plugin string) []Item {
	source := "plugin:" + marketplace + ":" + plugin
	var out []Item
	out = append(out, scanPluginSkills(filepath.Join(pluginDir, "skills"), plugin, source)...)
	out = append(out, scanPluginCommands(filepath.Join(pluginDir, "commands"), plugin, source)...)
	out = append(out, scanPluginAgents(filepath.Join(pluginDir, "agents"), plugin, source)...)
	return out
}

func scanPluginSkills(dir, plugin, source string) []Item {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Item
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		slug := e.Name()
		fm := parseYAMLFrontmatter(filepath.Join(dir, slug, "SKILL.md"))
		if fm == nil {
			continue
		}
		name := fm["name"]
		if name == "" {
			name = slug
		}
		out = append(out, Item{
			Name:        name,
			DisplayName: plugin + ":" + name,
			Description: pluginDesc(fm["description"]),
			Type:        "skill",
			Icon:        "/",
			Source:      source,
		})
	}
	return out
}

func scanPluginCommands(dir, plugin, source string) []Item {
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
		name := fm["name"]
		if name == "" {
			name = base
		}
		out = append(out, Item{
			Name:        name,
			DisplayName: plugin + ":" + name,
			Description: pluginDesc(fm["description"]),
			Type:        "command",
			Icon:        "/",
			Source:      source,
		})
	}
	return out
}

func scanPluginAgents(dir, plugin, source string) []Item {
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
		name := fm["name"]
		if name == "" {
			name = base
		}
		var descParts []string
		if m := fm["model"]; m != "" {
			descParts = append(descParts, m)
		}
		if mt := fm["maxTurns"]; mt != "" {
			descParts = append(descParts, "max "+mt+" turns")
		}
		desc := strings.Join(descParts, ", ")
		out = append(out, Item{
			Name:        name,
			DisplayName: plugin + ":" + name,
			Description: pluginDesc(desc),
			Type:        "agent",
			Icon:        "@",
			Source:      source,
		})
	}
	return out
}

// pluginDesc prefixes [plugin] visually so user and plugin items are
// distinguishable in the UI even when the Source field is ignored.
func pluginDesc(raw string) string {
	if raw == "" {
		return "[plugin]"
	}
	return "[plugin] " + truncate(raw, 100)
}
