package autocomplete

// claude_test.go — unit tests for ClaudeDirScanner.scanSkills filtering.
//
// Regression target: 2026-05-16 — `~/.claude/skills/.backups/` (a
// skill-curator working dir) plus `skills/skill-publisher/` (which holds
// only `references/`, no SKILL.md) were being emitted as autocomplete
// items, inflating the skill count by 2 versus disk reality.
//
// Mutation-thinking risk list:
//  1. Dot-prefix dir under skills/ → must not appear
//  2. Holder dir with no SKILL.md → must not appear
//  3. Normal skill dir with SKILL.md → must appear
//  4. SKILL.md without frontmatter → still allowed (parseYAMLFrontmatter
//     returns a non-nil map populated by extractFallbacks)

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func newClaudeFixture(t *testing.T) string {
	t.Helper()
	claudeDir := filepath.Join(t.TempDir(), ".claude")
	if err := os.MkdirAll(filepath.Join(claudeDir, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	return claudeDir
}

func TestClaudeDirScanner_SkipsHiddenSkillDirs(t *testing.T) {
	claudeDir := newClaudeFixture(t)

	// Real skill — must surface.
	writeFile(t,
		filepath.Join(claudeDir, "skills", "real", "SKILL.md"),
		"---\nname: real\ndescription: real skill\n---\n")

	// Hidden dir (matches skill-curator's `.backups`) — must NOT surface.
	writeFile(t,
		filepath.Join(claudeDir, "skills", ".backups", "snapshot-2026-05-15", "SKILL.md"),
		"---\nname: backup-leak\n---\n")

	items := NewClaudeDirScanner(claudeDir).Scan(context.Background())
	if findItem(items, "real", "skill") == nil {
		t.Fatal("real skill missing")
	}
	for _, it := range items {
		if it.Name == ".backups" || it.Name == "backup-leak" {
			t.Errorf("hidden dir leaked into items: %+v", it)
		}
	}
}

func TestClaudeDirScanner_SkipsHolderDirsWithoutSKILLMD(t *testing.T) {
	claudeDir := newClaudeFixture(t)

	// Real skill — must surface.
	writeFile(t,
		filepath.Join(claudeDir, "skills", "real", "SKILL.md"),
		"---\nname: real\ndescription: real skill\n---\n")

	// Holder dir — has subdirs but no SKILL.md. Mirrors the live
	// `skill-publisher/` that broke counts in 2026-05-16.
	if err := os.MkdirAll(
		filepath.Join(claudeDir, "skills", "skill-publisher", "references"),
		0o755,
	); err != nil {
		t.Fatal(err)
	}

	items := NewClaudeDirScanner(claudeDir).Scan(context.Background())

	if findItem(items, "real", "skill") == nil {
		t.Fatal("real skill missing")
	}
	if findItem(items, "skill-publisher", "skill") != nil {
		t.Error("holder dir without SKILL.md surfaced as a skill")
	}
	// Exactly one skill in this fixture.
	count := 0
	for _, it := range items {
		if it.Type == "skill" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("got %d skill items; want 1 (the real one)", count)
	}
}

func TestClaudeDirScanner_SKILLMDWithoutFrontmatter_StillCounted(t *testing.T) {
	claudeDir := newClaudeFixture(t)

	// SKILL.md exists but has no `---` frontmatter block.
	// parseYAMLFrontmatter still returns a non-nil map (populated by the
	// fallback name/description extractor), so the skill must still appear.
	writeFile(t,
		filepath.Join(claudeDir, "skills", "frontmatterless", "SKILL.md"),
		"# Just a body\n\nDescription line goes here.\n")

	items := NewClaudeDirScanner(claudeDir).Scan(context.Background())
	if findItem(items, "frontmatterless", "skill") == nil {
		t.Errorf("skill with SKILL.md but no frontmatter should still surface; items=%+v", items)
	}
}
