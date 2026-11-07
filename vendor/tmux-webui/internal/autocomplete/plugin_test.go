package autocomplete

// plugin_test.go — unit tests for PluginScanner.
//
// Mutation-thinking risk list:
//  1. marketplaces dir missing → Scan returns nil (no panic)
//  2. Empty marketplace with neither plugins/ nor external_plugins/ → no items
//  3. Both layouts coexist in one marketplace → both are scanned
//  4. Plugin skill missing SKILL.md → skipped, not crashed
//  5. Plugin command non-.md file in commands/ → skipped
//  6. Plugin agent gets description from model + maxTurns
//  7. DisplayName format is "<plugin>:<name>"
//  8. Source format is "plugin:<marketplace>:<plugin>"
//  9. pluginDesc prefixes "[plugin]" and truncates at 100 runes
// 10. Hidden dot-directories (.codex, .git) at marketplace and plugin level are skipped

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

// writeFile writes content to path, creating parent dirs as needed.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// claudeDirWith builds <tmp>/.claude/plugins/marketplaces/<paths…> fixtures.
// Returns the claudeDir root to pass to NewPluginScanner.
func claudeDirWith(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(filepath.Join(root, "plugins", "marketplaces"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

// findItem returns the first Item whose Name + Type match, or nil.
func findItem(items []Item, name, typ string) *Item {
	for i := range items {
		if items[i].Name == name && items[i].Type == typ {
			return &items[i]
		}
	}
	return nil
}

// ─── tests ────────────────────────────────────────────────────────────────────

func TestPluginScanner_MissingRoot_NoCrash(t *testing.T) {
	s := NewPluginScanner(filepath.Join(t.TempDir(), "does-not-exist"))
	if got := s.Scan(context.Background()); got != nil {
		t.Errorf("Scan with missing root = %v; want nil", got)
	}
}

func TestPluginScanner_EmptyMarketplace_NoItems(t *testing.T) {
	claudeDir := claudeDirWith(t)
	if err := os.MkdirAll(filepath.Join(claudeDir, "plugins", "marketplaces", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	items := NewPluginScanner(claudeDir).Scan(context.Background())
	if len(items) != 0 {
		t.Errorf("empty marketplace yielded %d items; want 0", len(items))
	}
}

func TestPluginScanner_BothLayoutsCoexist(t *testing.T) {
	claudeDir := claudeDirWith(t)
	base := filepath.Join(claudeDir, "plugins", "marketplaces", "mkt-a")

	// plugins/ layout — one skill
	writeFile(t,
		filepath.Join(base, "plugins", "alpha", "skills", "draw", "SKILL.md"),
		"---\nname: draw\ndescription: Draw something\n---\n# Draw\n")

	// external_plugins/ layout — one command
	writeFile(t,
		filepath.Join(base, "external_plugins", "beta", "commands", "ship.md"),
		"---\nname: ship\ndescription: Ship a release\n---\n## Body\n")

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	if len(items) != 2 {
		t.Fatalf("expected 2 items across both layouts, got %d: %+v", len(items), items)
	}

	skill := findItem(items, "draw", "skill")
	if skill == nil {
		t.Fatal("missing 'draw' skill item")
	}
	if skill.DisplayName != "alpha:draw" {
		t.Errorf("DisplayName = %q; want %q", skill.DisplayName, "alpha:draw")
	}
	if skill.Source != "plugin:mkt-a:alpha" {
		t.Errorf("Source = %q; want %q", skill.Source, "plugin:mkt-a:alpha")
	}
	if !strings.HasPrefix(skill.Description, "[plugin] ") {
		t.Errorf("Description = %q; want [plugin] prefix", skill.Description)
	}

	cmd := findItem(items, "ship", "command")
	if cmd == nil {
		t.Fatal("missing 'ship' command item")
	}
	if cmd.DisplayName != "beta:ship" {
		t.Errorf("cmd DisplayName = %q; want %q", cmd.DisplayName, "beta:ship")
	}
}

func TestPluginScanner_SkipsHiddenDirs(t *testing.T) {
	claudeDir := claudeDirWith(t)

	// Hidden marketplace must be ignored.
	writeFile(t,
		filepath.Join(claudeDir, "plugins", "marketplaces", ".git", "plugins", "x", "skills", "y", "SKILL.md"),
		"---\nname: y\n---\n")
	// Hidden plugin dir inside a real marketplace must be ignored.
	writeFile(t,
		filepath.Join(claudeDir, "plugins", "marketplaces", "real", "plugins", ".hidden", "skills", "z", "SKILL.md"),
		"---\nname: z\n---\n")

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	for _, it := range items {
		if strings.HasPrefix(it.Source, "plugin:.git:") || strings.HasPrefix(it.DisplayName, ".hidden:") {
			t.Errorf("hidden dir leaked into items: %+v", it)
		}
	}
}

func TestPluginScanner_SkillWithoutSkillMD_Skipped(t *testing.T) {
	claudeDir := claudeDirWith(t)
	// Skill dir exists but no SKILL.md → must be skipped (parseYAMLFrontmatter → nil).
	skillDir := filepath.Join(claudeDir, "plugins", "marketplaces", "m", "plugins", "p", "skills", "ghost")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	if len(items) != 0 {
		t.Errorf("got %d items for skill without SKILL.md; want 0", len(items))
	}
}

func TestPluginScanner_AgentDescription_FromModelAndMaxTurns(t *testing.T) {
	claudeDir := claudeDirWith(t)
	writeFile(t,
		filepath.Join(claudeDir, "plugins", "marketplaces", "m", "plugins", "p", "agents", "scout.md"),
		"---\nname: scout\nmodel: sonnet\nmaxTurns: 10\n---\n")

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	agent := findItem(items, "scout", "agent")
	if agent == nil {
		t.Fatal("missing 'scout' agent")
	}
	// pluginDesc prefixes "[plugin] " then includes the truncated raw desc.
	want := "[plugin] sonnet, max 10 turns"
	if agent.Description != want {
		t.Errorf("agent.Description = %q; want %q", agent.Description, want)
	}
	if agent.Icon != "@" {
		t.Errorf("agent.Icon = %q; want @", agent.Icon)
	}
}

func TestPluginScanner_CommandNonMD_Ignored(t *testing.T) {
	claudeDir := claudeDirWith(t)
	cmdsDir := filepath.Join(claudeDir, "plugins", "marketplaces", "m", "plugins", "p", "commands")
	writeFile(t, filepath.Join(cmdsDir, "real.md"), "---\nname: real\n---\n")
	writeFile(t, filepath.Join(cmdsDir, "README.txt"), "not a command")
	writeFile(t, filepath.Join(cmdsDir, ".DS_Store"), "junk")

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	var commands []Item
	for _, it := range items {
		if it.Type == "command" {
			commands = append(commands, it)
		}
	}
	if len(commands) != 1 || commands[0].Name != "real" {
		t.Errorf("commands = %+v; want one entry named 'real'", commands)
	}
}

// ─── installed-manifest mode ──────────────────────────────────────────────────
//
// These tests cover the "installed-only" branch of PluginScanner.Scan: when
// <claudeDir>/plugins/installed_plugins.json exists, the scanner must
// honor the manifest and not fall back to the legacy whole-tree walk.

// writeInstalledManifest writes a minimal v2 installed_plugins.json.
// `entries` is keyed by "<plugin>@<marketplace>"; each value is the
// installPath that the manifest records.
func writeInstalledManifest(t *testing.T, claudeDir string, entries map[string]string) {
	t.Helper()
	plugins := make(map[string][]map[string]string, len(entries))
	for key, installPath := range entries {
		plugins[key] = []map[string]string{
			{"scope": "user", "installPath": installPath, "version": "1.0.0"},
		}
	}
	// Marshal manually so the test is robust against schema additions.
	b := &strings.Builder{}
	b.WriteString(`{"version":2,"plugins":{`)
	first := true
	for key, arr := range plugins {
		if !first {
			b.WriteString(",")
		}
		first = false
		b.WriteString(`"`)
		b.WriteString(key)
		b.WriteString(`":[{"scope":"`)
		b.WriteString(arr[0]["scope"])
		b.WriteString(`","installPath":"`)
		b.WriteString(arr[0]["installPath"])
		b.WriteString(`","version":"`)
		b.WriteString(arr[0]["version"])
		b.WriteString(`"}]`)
	}
	b.WriteString(`}}`)
	writeFile(t, filepath.Join(claudeDir, "plugins", "installed_plugins.json"), b.String())
}

func TestPluginScanner_Installed_OnlyManifestedPluginsListed(t *testing.T) {
	claudeDir := claudeDirWith(t)

	// Installed plugin lives in the cache layout that Claude Code 1.x uses.
	installPath := filepath.Join(claudeDir, "plugins", "cache", "mkt-a", "alpha", "1.0.0")
	writeFile(t,
		filepath.Join(installPath, "skills", "draw", "SKILL.md"),
		"---\nname: draw\ndescription: Draw something\n---\n")
	writeFile(t,
		filepath.Join(installPath, "commands", "ship.md"),
		"---\nname: ship\ndescription: Ship a release\n---\n")

	// Decoy: another plugin sits in the marketplace tree but is NOT in the
	// installed manifest — must not appear.
	writeFile(t,
		filepath.Join(claudeDir, "plugins", "marketplaces", "mkt-a", "plugins", "beta", "skills", "lurk", "SKILL.md"),
		"---\nname: lurk\ndescription: should not surface\n---\n")

	writeInstalledManifest(t, claudeDir, map[string]string{
		"alpha@mkt-a": installPath,
	})

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	if len(items) != 2 {
		t.Fatalf("expected 2 items from installed alpha plugin, got %d: %+v", len(items), items)
	}
	if findItem(items, "lurk", "skill") != nil {
		t.Error("uninstalled marketplace plugin 'lurk' leaked through installed-manifest scan")
	}
	if findItem(items, "draw", "skill") == nil {
		t.Error("installed plugin skill 'draw' missing")
	}
	if findItem(items, "ship", "command") == nil {
		t.Error("installed plugin command 'ship' missing")
	}

	// Source must still namespace by marketplace + plugin, not by the
	// install path's directory name.
	if it := findItem(items, "draw", "skill"); it != nil && it.Source != "plugin:mkt-a:alpha" {
		t.Errorf("Source = %q; want plugin:mkt-a:alpha", it.Source)
	}
}

func TestPluginScanner_Installed_EmptyManifest_NoFallback(t *testing.T) {
	claudeDir := claudeDirWith(t)

	// Decoy plugin in marketplace tree — present but must NOT surface.
	writeFile(t,
		filepath.Join(claudeDir, "plugins", "marketplaces", "mkt-a", "plugins", "beta", "skills", "lurk", "SKILL.md"),
		"---\nname: lurk\n---\n")

	writeFile(t,
		filepath.Join(claudeDir, "plugins", "installed_plugins.json"),
		`{"version":2,"plugins":{}}`)

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	if len(items) != 0 {
		t.Errorf("empty manifest should yield 0 items; got %d: %+v", len(items), items)
	}
}

func TestPluginScanner_Installed_MissingInstallPath_NoCrash(t *testing.T) {
	claudeDir := claudeDirWith(t)

	// Manifest references an installPath that doesn't exist on disk.
	writeInstalledManifest(t, claudeDir, map[string]string{
		"ghost@mkt-x": filepath.Join(claudeDir, "plugins", "cache", "mkt-x", "ghost", "9.9.9"),
	})

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	if len(items) != 0 {
		t.Errorf("missing installPath should yield 0 items; got %d: %+v", len(items), items)
	}
}

func TestPluginScanner_Installed_MalformedJSON_FallsBackToTree(t *testing.T) {
	claudeDir := claudeDirWith(t)

	// Marketplace decoy that SHOULD surface via the legacy fallback when
	// the manifest is unparseable — proving the fallback path still works.
	writeFile(t,
		filepath.Join(claudeDir, "plugins", "marketplaces", "mkt-a", "plugins", "beta", "skills", "lurk", "SKILL.md"),
		"---\nname: lurk\ndescription: visible via fallback\n---\n")

	writeFile(t,
		filepath.Join(claudeDir, "plugins", "installed_plugins.json"),
		"this is not json {")

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	if findItem(items, "lurk", "skill") == nil {
		t.Error("malformed manifest should fall back to whole-tree scan; 'lurk' missing")
	}
}

func TestPluginScanner_Installed_KeyWithMultipleAtSigns(t *testing.T) {
	claudeDir := claudeDirWith(t)

	// Plugin name contains "@" (scoped-package style). The split must use
	// the rightmost "@" so the marketplace is parsed correctly.
	installPath := filepath.Join(claudeDir, "plugins", "cache", "mkt-z", "@scope", "wrap", "1.0.0")
	writeFile(t,
		filepath.Join(installPath, "skills", "tool", "SKILL.md"),
		"---\nname: tool\ndescription: scoped plugin tool\n---\n")

	writeInstalledManifest(t, claudeDir, map[string]string{
		"@scope/wrap@mkt-z": installPath,
	})

	items := NewPluginScanner(claudeDir).Scan(context.Background())
	skill := findItem(items, "tool", "skill")
	if skill == nil {
		t.Fatalf("scoped plugin's skill missing; items=%+v", items)
	}
	if skill.Source != "plugin:mkt-z:@scope/wrap" {
		t.Errorf("Source = %q; want plugin:mkt-z:@scope/wrap", skill.Source)
	}
}

func TestPluginDesc_PrefixAndTruncate(t *testing.T) {
	long := strings.Repeat("a", 200)
	got := pluginDesc(long)
	if !strings.HasPrefix(got, "[plugin] ") {
		t.Errorf("missing prefix: %q", got[:20])
	}
	// "[plugin] " + 100 runes = 109
	if len([]rune(got)) != len([]rune("[plugin] "))+100 {
		t.Errorf("truncation off: rune len = %d", len([]rune(got)))
	}
	if pluginDesc("") != "[plugin]" {
		t.Errorf("empty desc = %q; want %q", pluginDesc(""), "[plugin]")
	}
}
