package server

import (
	"encoding/json"
	"testing"
)

// Slice 2a: a dynamic "working" panel must exist and carry when="working" so the
// frontend detection can swap to it. This also guards against the deckPanel
// struct dropping the When field (which would silently break context switching —
// When must survive the unmarshal→serve round-trip).
func TestEmbeddedDeckDefault_HasWorkingPanel(t *testing.T) {
	cfg := embeddedDeckDefault()

	var working *deckPanel
	for i := range cfg.Panels {
		if cfg.Panels[i].ID == "claude-working" {
			working = &cfg.Panels[i]
		}
	}
	if working == nil {
		t.Fatal("claude-working panel missing from embedded default")
	}
	if working.Source != "dynamic" {
		t.Errorf("claude-working.source = %q, want dynamic", working.Source)
	}
	if working.When != "working" {
		t.Errorf("claude-working.when = %q, want working (When must survive (de)serialization)", working.When)
	}
	var btns []map[string]any
	if err := json.Unmarshal(working.Buttons, &btns); err != nil {
		t.Fatalf("working panel buttons invalid JSON: %v", err)
	}
	if len(btns) == 0 {
		t.Error("working panel has no buttons")
	}
}

// A static fallback panel must remain intact alongside the dynamic panels —
// panelsForState degrades to it when no dynamic `when` matches (regression
// guard for the Slice 1 degrade path under the context-first redesign, where
// panel[0] is now dynamic claude-idle and the static fallback is claude-base).
func TestEmbeddedDeckDefault_StaticPanelIntact(t *testing.T) {
	cfg := embeddedDeckDefault()
	if len(cfg.Panels) < 2 {
		t.Fatalf("expected >=2 panels (dynamic + static fallback), got %d", len(cfg.Panels))
	}
	var static *deckPanel
	for i := range cfg.Panels {
		if cfg.Panels[i].Source == "static" {
			static = &cfg.Panels[i]
			break
		}
	}
	if static == nil {
		t.Fatal("no static fallback panel in embedded default — degrade path is dead")
	}
	var btns []map[string]any
	if err := json.Unmarshal(static.Buttons, &btns); err != nil {
		t.Fatalf("static panel buttons invalid JSON: %v", err)
	}
	if len(btns) == 0 {
		t.Error("static fallback panel has no buttons")
	}
}
