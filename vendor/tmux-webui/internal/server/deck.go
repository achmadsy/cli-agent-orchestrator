package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	"github.com/operonlab/tmux-webui/internal/assets"
)

// deckConfig is the shape served at GET /api/deck and accepted at PUT /api/deck.
// The embedded default.json provides the baseline; an optional user file
// overrides panels by id and, in schema v2, supplies the authoritative `pages`
// array (rail tabs + their buttons) once the user has edited the deck.
//
// The server was originally read-only ("never mutated"), but the deck editor
// (Slice C) needs to persist user edits — PUT /api/deck is a deliberate
// reversal of that invariant, guarded by a size cap + structural validation +
// atomic write (see handleDeckWrite) so a bad write can't poison the layer.
//
// Sub-fields the server does not need to interpret (match/grid/buttons) are
// kept as raw JSON and forwarded verbatim, so the button schema can evolve
// frontend-only without touching this handler.
type deckConfig struct {
	Schema  string      `json:"$schema,omitempty"`
	Version int         `json:"version"`
	Pages   []deckPage  `json:"pages,omitempty"`
	Panels  []deckPanel `json:"panels"`
}

type deckPanel struct {
	ID      string          `json:"id"`
	Title   string          `json:"title,omitempty"`
	Source  string          `json:"source"`
	When    string          `json:"when,omitempty"`
	Match   json.RawMessage `json:"match,omitempty"`
	Grid    json.RawMessage `json:"grid,omitempty"`
	Buttons json.RawMessage `json:"buttons"`
}

// deckPage is a schema-v2 rail tab. `type` is one of windows|ctrl|buttons:
// windows/ctrl are computed by the frontend (their buttons are ignored), while
// buttons pages carry an editable `buttons` array (same button schema as
// panels). Buttons stay raw so the button schema evolves frontend-only.
type deckPage struct {
	ID      string          `json:"id"`
	Glyph   string          `json:"glyph,omitempty"`
	Label   string          `json:"label,omitempty"`
	LabelEn string          `json:"label_en,omitempty"`
	Type    string          `json:"type"`
	Hidden  bool            `json:"hidden,omitempty"`
	Buttons json.RawMessage `json:"buttons,omitempty"`
}

// Write-side limits for PUT /api/deck. maxDeckBody is the outer guard; the
// per-collection caps stop a single valid-JSON body from carrying an absurd
// number of pages/buttons or an oversized payload.
const (
	maxDeckBody     = 64 << 10 // 64 KiB request-body cap
	maxDeckPages    = 24
	maxPageButtons  = 48
	maxPayloadChars = 2000
)

func (s *Server) handleDeck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, loadDeckConfig())
}

// handleDeckWrite persists a full deck config (pages + panels) to the user
// override file. Semantics: snapshot-on-first-edit — the frontend sends the
// complete config, we validate it, back up any prior file to deck.json.bak,
// then atomically write it (tmp + rename). The response is the merged config
// (GET semantics), so the caller sees exactly what a subsequent GET would.
func (s *Server) handleDeckWrite(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxDeckBody)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSON(w, http.StatusRequestEntityTooLarge,
				map[string]string{"error": fmt.Sprintf("deck config exceeds %d-byte limit", maxDeckBody)})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not read request body"})
		return
	}

	var cfg deckConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	if err := validateDeckConfig(cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if err := writeUserDeck(raw); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not persist deck config"})
		return
	}
	writeJSON(w, http.StatusOK, loadDeckConfig())
}

// validateDeckConfig enforces the write-side structural limits. It intentionally
// re-parses the raw button arrays (kept as json.RawMessage on the wire) only far
// enough to count them and bound payload lengths — it does not couple to the
// full button schema, so the frontend can still evolve button fields freely.
func validateDeckConfig(cfg deckConfig) error {
	if len(cfg.Pages) > maxDeckPages {
		return fmt.Errorf("too many pages: %d (max %d)", len(cfg.Pages), maxDeckPages)
	}
	for _, pg := range cfg.Pages {
		switch pg.Type {
		case "":
			return fmt.Errorf("page %q missing type", pg.ID)
		case "windows", "ctrl", "buttons":
		default:
			return fmt.Errorf("page %q has unknown type %q", pg.ID, pg.Type)
		}
		if err := validateButtons(pg.ID, pg.Buttons); err != nil {
			return err
		}
	}
	// Legacy panels share the same payload attack surface — bound them too.
	for _, pl := range cfg.Panels {
		if err := validateButtons(pl.ID, pl.Buttons); err != nil {
			return err
		}
	}
	return nil
}

// validateButtons parses a raw button array (if present) and enforces the
// per-collection count cap and per-payload length cap. A missing/empty array
// is valid (windows/ctrl pages carry no editable buttons).
func validateButtons(ownerID string, raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	var btns []struct {
		Action struct {
			Payload string `json:"payload"`
			Steps   []struct {
				Payload string `json:"payload"`
			} `json:"steps"`
		} `json:"action"`
	}
	if err := json.Unmarshal(raw, &btns); err != nil {
		return fmt.Errorf("%q buttons not a valid array: %v", ownerID, err)
	}
	if len(btns) > maxPageButtons {
		return fmt.Errorf("%q has too many buttons: %d (max %d)", ownerID, len(btns), maxPageButtons)
	}
	for _, b := range btns {
		if len(b.Action.Payload) > maxPayloadChars {
			return fmt.Errorf("%q button payload exceeds %d chars", ownerID, maxPayloadChars)
		}
		for _, st := range b.Action.Steps {
			if len(st.Payload) > maxPayloadChars {
				return fmt.Errorf("%q macro step payload exceeds %d chars", ownerID, maxPayloadChars)
			}
		}
	}
	return nil
}

// writeUserDeck backs up any existing user deck to <path>.bak, then atomically
// writes raw to the user deck path via a same-dir temp file + rename (rename is
// atomic within one filesystem). raw is persisted verbatim so unknown button
// fields survive the round-trip (the RawMessage-forwarding contract).
func writeUserDeck(raw []byte) error {
	path := userDeckPath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if existing, err := os.ReadFile(path); err == nil {
		if err := os.WriteFile(path+".bak", existing, 0o644); err != nil {
			return err
		}
	}
	tmp, err := os.CreateTemp(dir, "deck-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func loadDeckConfig() deckConfig {
	base := embeddedDeckDefault()
	override, ok := userDeckOverride()
	if !ok {
		return base
	}
	return mergeDeck(base, override)
}

func embeddedDeckDefault() deckConfig {
	fallback := deckConfig{Version: 1, Panels: []deckPanel{}}
	raw, err := fs.ReadFile(assets.FS, "static/deck/default.json")
	if err != nil {
		return fallback
	}
	var cfg deckConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return fallback
	}
	if cfg.Panels == nil {
		cfg.Panels = []deckPanel{}
	}
	return cfg
}

// userDeckPath returns the optional user override location. TMUX_WEBUI_DECK
// overrides it (mainly for tests), else ~/.config/tmux-webui/deck.json —
// mirroring the config.json convention (config.go).
func userDeckPath() string {
	if p := os.Getenv("TMUX_WEBUI_DECK"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "tmux-webui", "deck.json")
}

func userDeckOverride() (deckConfig, bool) {
	var cfg deckConfig
	raw, err := os.ReadFile(userDeckPath())
	if err != nil {
		return cfg, false
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		// Malformed override → ignore, fall back to embedded default.
		return cfg, false
	}
	return cfg, true
}

// mergeDeck overlays override onto base. Panels merge by id (same id replaces
// in place, new id appends, base order preserved) — the legacy contract kept
// for the old deck.js fallback / dock path.
//
// Pages (schema v2) are NOT merged by id: once the override file carries a
// `pages` array it is authoritative wholesale (the frontend always PUTs the
// complete pages list, so "snapshot-on-first-edit + last-write-wins" is the
// intended semantic). A nil override.Pages (field absent) leaves base.Pages —
// this is why the distinction is nil vs empty slice, not len==0.
func mergeDeck(base, override deckConfig) deckConfig {
	idx := make(map[string]int, len(base.Panels))
	for i, p := range base.Panels {
		idx[p.ID] = i
	}
	for _, op := range override.Panels {
		if i, ok := idx[op.ID]; ok {
			base.Panels[i] = op
		} else {
			base.Panels = append(base.Panels, op)
			idx[op.ID] = len(base.Panels) - 1
		}
	}
	if override.Pages != nil {
		base.Pages = override.Pages
	}
	if override.Version != 0 {
		base.Version = override.Version
	}
	return base
}
