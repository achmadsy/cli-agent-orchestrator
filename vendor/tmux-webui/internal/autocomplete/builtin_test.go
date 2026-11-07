package autocomplete

// builtin_test.go — unit tests for BuiltinScanner.
//
// Mutation-thinking risk list:
//  1. List is non-empty and stays at expected size as we curate it
//  2. Every emitted Item carries Type=="builtin", Source=="builtin", Icon=="/"
//  3. DisplayName begins with "/" (so UI renders the slash-form directly)
//  4. Description is non-empty (something to show in the popover)
//  5. Names are unique (no accidental dupes when curating)
//  6. Scan() is deterministic — repeated calls yield identical slices

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestBuiltinScanner_Scan_ShapeContract(t *testing.T) {
	items := NewBuiltinScanner().Scan(context.Background())
	if len(items) == 0 {
		t.Fatal("builtin list is empty")
	}
	for _, it := range items {
		if it.Type != "builtin" {
			t.Errorf("%q Type=%q; want builtin", it.Name, it.Type)
		}
		if it.Source != "builtin" {
			t.Errorf("%q Source=%q; want builtin", it.Name, it.Source)
		}
		if it.Icon != "/" {
			t.Errorf("%q Icon=%q; want /", it.Name, it.Icon)
		}
		if !strings.HasPrefix(it.DisplayName, "/") {
			t.Errorf("%q DisplayName=%q; want leading /", it.Name, it.DisplayName)
		}
		if it.Description == "" {
			t.Errorf("%q has empty Description", it.Name)
		}
		if strings.HasPrefix(it.Name, "/") {
			t.Errorf("%q Name should not include leading /", it.Name)
		}
	}
}

func TestBuiltinScanner_UniqueNames(t *testing.T) {
	seen := make(map[string]bool, len(builtinSlashCommands))
	for _, c := range builtinSlashCommands {
		if seen[c.name] {
			t.Errorf("duplicate builtin command: %q", c.name)
		}
		seen[c.name] = true
	}
}

func TestBuiltinScanner_Deterministic(t *testing.T) {
	s := NewBuiltinScanner()
	a := s.Scan(context.Background())
	b := s.Scan(context.Background())
	if !reflect.DeepEqual(a, b) {
		t.Error("Scan() is not deterministic across calls")
	}
}

func TestBuiltinScanner_CoreCommandsPresent(t *testing.T) {
	// Spot-check well-known commands users type most often. If any of these
	// goes missing we want a loud test failure during refactors. The list
	// includes both long-standing commands (compact/model/clear/help) and
	// the post-2026-Q1 additions (goal/rename/skills/schedule/plan/context/
	// rewind/ultraplan/ultrareview) plus the bundled-skill rows the docs
	// table now lists alongside built-ins (loop/simplify/batch/debug/
	// claude-api/fewer-permission-prompts).
	want := []string{
		"compact", "model", "clear", "help", "agents", "mcp", "hooks", "cost",
		"goal", "rename", "skills", "schedule", "plan", "context",
		"rewind", "ultraplan", "ultrareview", "usage", "effort",
		"loop", "simplify", "batch", "debug", "claude-api", "fewer-permission-prompts",
	}
	have := make(map[string]bool)
	for _, c := range builtinSlashCommands {
		have[c.name] = true
	}
	for _, w := range want {
		if !have[w] {
			t.Errorf("core command /%s missing from builtin list", w)
		}
	}
}
