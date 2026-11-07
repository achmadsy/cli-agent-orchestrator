package autocomplete

// shortcuts_test.go — unit tests for ShortcutScanner and the bare-word
// "shortcut" routing branch.
//
// Mutation-thinking risk list:
//  1. Missing file → nil, silently (feature unused is not an error)
//  2. Malformed JSON → nil + no panic (user typo must not kill the menu)
//  3. insert defaults to name when omitted
//  4. keywords become alias items carrying the SAME Insert payload
//  5. Entries without a name are skipped
//  6. typeFilter "shortcut" is a private namespace: shortcuts never leak
//     into "/" or "@" menus, and those types never leak into "shortcut"
//  7. Stats counts shortcuts

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func writeShortcuts(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "shortcuts.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

const fixtureShortcuts = `{
  "shortcuts": [
    {"name": "lazygit", "description": "git TUI", "keywords": ["lg"]},
    {"name": "ultracode", "insert": "ultracode ", "description": "multi-agent prefix"},
    {"name": ""}
  ]
}`

// ─── ShortcutScanner ─────────────────────────────────────────────────────────

func TestShortcutScanner_MissingFileReturnsNil(t *testing.T) {
	s := NewShortcutScanner(filepath.Join(t.TempDir(), "nope.json"))
	if items := s.Scan(context.Background()); items != nil {
		t.Errorf("missing file: want nil, got %v", items)
	}
}

func TestShortcutScanner_MalformedJSONReturnsNil(t *testing.T) {
	s := NewShortcutScanner(writeShortcuts(t, "{not json"))
	if items := s.Scan(context.Background()); items != nil {
		t.Errorf("malformed file: want nil, got %v", items)
	}
}

func TestShortcutScanner_ParsesEntriesAndAliases(t *testing.T) {
	s := NewShortcutScanner(writeShortcuts(t, fixtureShortcuts))
	items := s.Scan(context.Background())

	byName := map[string]Item{}
	for _, it := range items {
		if it.Type != "shortcut" {
			t.Fatalf("non-shortcut type %q leaked from scanner", it.Type)
		}
		byName[it.Name] = it
	}

	if len(items) != 3 { // lazygit + lg alias + ultracode; empty name skipped
		t.Fatalf("want 3 items, got %d: %v", len(items), items)
	}
	if got := byName["lazygit"].Insert; got != "lazygit" {
		t.Errorf("insert must default to name; got %q", got)
	}
	if got := byName["ultracode"].Insert; got != "ultracode " {
		t.Errorf("explicit insert not preserved; got %q", got)
	}
	lg, ok := byName["lg"]
	if !ok {
		t.Fatal("keyword alias 'lg' missing")
	}
	if lg.Insert != "lazygit" || lg.DisplayName != "lg → lazygit" {
		t.Errorf("alias must carry target insert + arrow display; got %+v", lg)
	}
}

// ─── Routing ─────────────────────────────────────────────────────────────────

func newShortcutEngine(t *testing.T) *Engine {
	t.Helper()
	e := New(Options{ShortcutsFile: writeShortcuts(t, fixtureShortcuts)})
	t.Cleanup(e.Close)
	return e
}

func TestComplete_ShortcutFilterMatchesBareWord(t *testing.T) {
	e := newShortcutEngine(t)

	items := e.Complete("laz", "shortcut")
	if len(items) == 0 || items[0].Name != "lazygit" {
		t.Fatalf("bare 'laz' must surface lazygit first; got %+v", items)
	}
	if items[0].Insert != "lazygit" {
		t.Errorf("shortcut item lost its Insert payload: %+v", items[0])
	}
}

func TestComplete_ShortcutNamespaceIsolation(t *testing.T) {
	e := newShortcutEngine(t)

	for _, it := range e.Complete("/laz", "") {
		if it.Type == "shortcut" {
			t.Errorf("shortcut leaked into slash menu: %+v", it)
		}
	}
	for _, it := range e.Complete("@laz", "at") {
		if it.Type == "shortcut" {
			t.Errorf("shortcut leaked into at menu: %+v", it)
		}
	}
	for _, it := range e.Complete("laz", "shortcut") {
		if it.Type != "shortcut" {
			t.Errorf("non-shortcut leaked into shortcut menu: %+v", it)
		}
	}
}

func TestStats_CountsShortcuts(t *testing.T) {
	e := newShortcutEngine(t)
	if got := e.Stats().Shortcuts; got != 3 {
		t.Errorf("Stats.Shortcuts = %d, want 3", got)
	}
}
