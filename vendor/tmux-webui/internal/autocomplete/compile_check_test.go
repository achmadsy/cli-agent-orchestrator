// Package autocomplete compile check — verifies the package compiles and
// public types are accessible. No logic assertions.
package autocomplete

import (
	"testing"
	"time"
)

func TestPackageCompiles(t *testing.T) {
	// Verify Engine creation and Close do not panic.
	e := New(Options{
		ClaudeDir:       "",
		RefreshInterval: time.Second,
	})
	defer e.Close()

	// Stats returns a valid Stats struct.
	s := e.Stats()
	_ = s.Skills
	_ = s.Commands
	_ = s.Agents
	_ = s.MCPServers

	// Complete returns nil (not a panic) for empty input.
	got := e.Complete("", "")
	if got != nil {
		t.Errorf("expected nil for empty query, got %v", got)
	}

	// Verify Item zero value is constructible.
	var item Item
	_ = item.Name
	_ = item.Type

	// Verify Stats zero value.
	var stats Stats
	_ = stats.Skills

	t.Log("package autocomplete: compile check passed")
}
