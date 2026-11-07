package autocomplete

import (
	"context"
	"testing"
	"time"
)

// stubScanner returns a fixed Item list — lets the test seed slash + at caches
// without touching the filesystem.
type stubScanner struct{ items []Item }

func (s stubScanner) Scan(_ context.Context) []Item { return s.items }

func newEngineWithFixtures(t *testing.T) *Engine {
	t.Helper()
	scan := stubScanner{items: []Item{
		{Name: "compact", Type: "builtin"},
		{Name: "model", Type: "builtin"},
		{Name: "explore", Type: "skill"},
		{Name: "ship-it", Type: "command"},
		{Name: "reviewer", Type: "agent"},
		{Name: "memvault", Type: "mcp"},
	}}
	e := &Engine{
		cache: newResourceCache([]Scanner{scan}, time.Hour, nil),
	}
	t.Cleanup(e.Close)
	return e
}

func itemNames(items []Item) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Name+":"+it.Type)
	}
	return out
}

func contains(items []Item, name, typ string) bool {
	for _, it := range items {
		if it.Name == name && it.Type == typ {
			return true
		}
	}
	return false
}

// TestComplete_SlashFilter is the regression test for the bug where the web UI
// sent type=slash but the engine routed the query to path completion because
// it only recognized "skill" / "command" / "builtin".
func TestComplete_SlashFilter(t *testing.T) {
	e := newEngineWithFixtures(t)

	got := e.Complete("/", "slash")
	if len(got) == 0 {
		t.Fatalf("type=slash with query=/ returned 0 items, expected builtin+skill+command")
	}
	for _, want := range [][2]string{
		{"compact", "builtin"},
		{"explore", "skill"},
		{"ship-it", "command"},
	} {
		if !contains(got, want[0], want[1]) {
			t.Errorf("type=slash missing %s (%s); got %v", want[0], want[1], itemNames(got))
		}
	}
	for _, it := range got {
		if it.Type == "path" || it.Type == "agent" || it.Type == "mcp" {
			t.Errorf("type=slash leaked non-slash item: %+v", it)
		}
	}
}

// TestComplete_AtFilter mirrors the slash regression for the "@" namespace —
// the web UI sends type=at, and the engine must return agents + mcp servers
// instead of falling through to path completion.
func TestComplete_AtFilter(t *testing.T) {
	e := newEngineWithFixtures(t)

	got := e.Complete("@", "at")
	if len(got) == 0 {
		t.Fatalf("type=at with query=@ returned 0 items, expected agent+mcp")
	}
	if !contains(got, "reviewer", "agent") {
		t.Errorf("type=at missing reviewer (agent); got %v", itemNames(got))
	}
	if !contains(got, "memvault", "mcp") {
		t.Errorf("type=at missing memvault (mcp); got %v", itemNames(got))
	}
}

// TestComplete_ImplicitSlashTrigger guards the legacy contract — when no
// typeFilter is supplied and the query begins with "/", slash items must
// still be returned (path completion must not steal the query).
func TestComplete_ImplicitSlashTrigger(t *testing.T) {
	e := newEngineWithFixtures(t)

	got := e.Complete("/comp", "")
	if !contains(got, "compact", "builtin") {
		t.Errorf("implicit slash trigger lost builtin match; got %v", itemNames(got))
	}
}

// TestComplete_MaxResultsOverride checks Options.MaxResults caps the returned
// suggestions, and that a zero value falls back to the 15 default.
func TestComplete_MaxResultsOverride(t *testing.T) {
	scan := stubScanner{items: []Item{
		{Name: "aa", Type: "builtin"}, {Name: "ab", Type: "builtin"},
		{Name: "ac", Type: "builtin"}, {Name: "ad", Type: "builtin"},
	}}
	capped := &Engine{
		cache:      newResourceCache([]Scanner{scan}, time.Hour, nil),
		maxResults: 2,
	}
	t.Cleanup(capped.Close)
	if got := capped.Complete("/a", "slash"); len(got) != 2 {
		t.Errorf("maxResults=2 → %d items; want 2 (%v)", len(got), itemNames(got))
	}

	// Zero maxResults → defaultMaxResults (15): all 4 matches surface.
	def := &Engine{cache: newResourceCache([]Scanner{scan}, time.Hour, nil)}
	t.Cleanup(def.Close)
	if got := def.Complete("/a", "slash"); len(got) != 4 {
		t.Errorf("maxResults=0 (→15) → %d items; want all 4 (%v)", len(got), itemNames(got))
	}
}

// TestComplete_SourcePriorityReorder checks that SourcePriority reorders the
// slash sources for tie-breaking at equal fuzzy score. All three fixtures are
// exact-prefix matches (score 1000), so the first item reflects source order.
func TestComplete_SourcePriorityReorder(t *testing.T) {
	scan := stubScanner{items: []Item{
		{Name: "xb", Type: "builtin"},
		{Name: "xs", Type: "skill"},
		{Name: "xc", Type: "command"},
	}}
	def := &Engine{cache: newResourceCache([]Scanner{scan}, time.Hour, nil)}
	t.Cleanup(def.Close)
	if got := def.Complete("/x", "slash"); len(got) == 0 || got[0].Type != "builtin" {
		t.Errorf("default priority: first should be builtin; got %v", itemNames(got))
	}

	re := &Engine{cache: newResourceCache([]Scanner{scan}, time.Hour, []string{"commands", "skills", "builtins"})}
	t.Cleanup(re.Close)
	if got := re.Complete("/x", "slash"); len(got) == 0 || got[0].Type != "command" {
		t.Errorf("reordered priority [commands,...]: first should be command; got %v", itemNames(got))
	}
}

// TestComplete_NarrowingFilters checks the per-type narrowing still works —
// type=skill returns only skills, type=agent returns only agents.
func TestComplete_NarrowingFilters(t *testing.T) {
	e := newEngineWithFixtures(t)

	skills := e.Complete("e", "skill")
	if !contains(skills, "explore", "skill") {
		t.Errorf("type=skill lost explore; got %v", itemNames(skills))
	}
	for _, it := range skills {
		if it.Type != "skill" {
			t.Errorf("type=skill leaked %s item: %+v", it.Type, it)
		}
	}

	agents := e.Complete("rev", "agent")
	if !contains(agents, "reviewer", "agent") {
		t.Errorf("type=agent lost reviewer; got %v", itemNames(agents))
	}
	for _, it := range agents {
		if it.Type != "agent" {
			t.Errorf("type=agent leaked %s item: %+v", it.Type, it)
		}
	}
}
