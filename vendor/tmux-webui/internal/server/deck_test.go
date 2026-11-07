package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// pointDeckAtMissing makes the user-override lookup miss so tests exercise the
// embedded default deterministically (no dependency on the real ~/.config).
func pointDeckAtMissing(t *testing.T) {
	t.Helper()
	t.Setenv("TMUX_WEBUI_DECK", filepath.Join(t.TempDir(), "nonexistent.json"))
}

func TestHandleDeck_ServesEmbeddedDefault(t *testing.T) {
	pointDeckAtMissing(t)

	s := &Server{} // handleDeck reads no Server fields; zero value is fine.
	req := httptest.NewRequest(http.MethodGet, "/api/deck", nil)
	rec := httptest.NewRecorder()
	s.handleDeck(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var cfg deckConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("response not valid JSON: %v", err)
	}
	if len(cfg.Panels) == 0 {
		t.Fatal("expected at least one embedded panel")
	}
	if cfg.Panels[0].ID != "claude-idle" {
		t.Errorf("panel[0].id = %q, want claude-idle (context-first redesign)", cfg.Panels[0].ID)
	}
	if cfg.Panels[0].Source != "dynamic" {
		t.Errorf("panel[0].source = %q, want dynamic (context-first redesign)", cfg.Panels[0].Source)
	}
}

func TestEmbeddedDeckDefault_ButtonsAreValidArray(t *testing.T) {
	cfg := embeddedDeckDefault()
	if cfg.Version == 0 {
		t.Error("embedded default has no version")
	}
	if len(cfg.Panels) == 0 {
		t.Fatal("embedded default has no panels")
	}
	var btns []map[string]any
	if err := json.Unmarshal(cfg.Panels[0].Buttons, &btns); err != nil {
		t.Fatalf("panel buttons not a valid JSON array: %v", err)
	}
	if len(btns) == 0 {
		t.Error("claude-ctrl panel has no buttons")
	}
}

func TestLoadDeckConfig_UserOverrideMergesByID(t *testing.T) {
	dir := t.TempDir()
	override := `{"version":1,"panels":[
		{"id":"claude-idle","title":"Overridden","source":"static","buttons":[]},
		{"id":"custom","title":"Custom","source":"static","buttons":[]}
	]}`
	path := filepath.Join(dir, "deck.json")
	if err := os.WriteFile(path, []byte(override), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_WEBUI_DECK", path)

	cfg := loadDeckConfig()

	var claude, custom *deckPanel
	for i := range cfg.Panels {
		switch cfg.Panels[i].ID {
		case "claude-idle":
			claude = &cfg.Panels[i]
		case "custom":
			custom = &cfg.Panels[i]
		}
	}
	if claude == nil {
		t.Fatal("claude-idle missing after merge")
	}
	if claude.Title != "Overridden" {
		t.Errorf("claude-idle.title = %q, want Overridden (same id should replace)", claude.Title)
	}
	if custom == nil {
		t.Error("custom panel (new id) not appended")
	}
}

func TestLoadDeckConfig_MalformedOverrideIgnored(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deck.json")
	if err := os.WriteFile(path, []byte("{ this is not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMUX_WEBUI_DECK", path)

	cfg := loadDeckConfig()
	// Malformed override must not blank out the deck — embedded default survives.
	if len(cfg.Panels) == 0 {
		t.Fatal("malformed override blanked the deck; expected embedded default to survive")
	}
	if cfg.Panels[0].ID != "claude-idle" {
		t.Errorf("panel[0].id = %q, want claude-idle (context-first redesign)", cfg.Panels[0].ID)
	}
}
