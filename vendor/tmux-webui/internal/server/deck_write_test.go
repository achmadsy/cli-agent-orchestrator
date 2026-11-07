package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// putDeck runs a PUT /api/deck against a handler whose user-override path is a
// fresh temp file, returning the recorder and the path so callers can inspect
// the persisted file / its .bak.
func putDeck(t *testing.T, body string) (*httptest.ResponseRecorder, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "deck.json")
	t.Setenv("TMUX_WEBUI_DECK", path)
	s := &Server{} // handleDeckWrite reads no Server fields.
	req := httptest.NewRequest(http.MethodPut, "/api/deck", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleDeckWrite(rec, req)
	return rec, path
}

const validDeckBody = `{"version":2,"pages":[` +
	`{"id":"win","type":"windows","glyph":"⊞","label":"窗口","label_en":"WIN"},` +
	`{"id":"custom","type":"buttons","glyph":"»","label":"我的","label_en":"MINE",` +
	`"buttons":[{"label":"測試","label_en":"Test","icon":"★",` +
	`"action":{"type":"macro","steps":[{"type":"input","payload":"hi"},{"type":"key","payload":"Enter"}]}}]}` +
	`],"panels":[]}`

func TestHandleDeckWrite_ValidWritesAndReadsBack(t *testing.T) {
	rec, path := putDeck(t, validDeckBody)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	// Response is the merged config; pages come from the override wholesale.
	var got deckConfig
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("response not valid JSON: %v", err)
	}
	if len(got.Pages) != 2 {
		t.Fatalf("response pages = %d, want 2 (override authoritative, not merged with default 5)", len(got.Pages))
	}
	if got.Pages[0].ID != "win" || got.Pages[1].ID != "custom" {
		t.Errorf("page ids = %q,%q; want win,custom", got.Pages[0].ID, got.Pages[1].ID)
	}
	// Persisted file exists and round-trips.
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("persisted file missing: %v", err)
	}
	var savedCfg deckConfig
	if err := json.Unmarshal(saved, &savedCfg); err != nil {
		t.Fatalf("persisted file not valid JSON: %v", err)
	}
	if len(savedCfg.Pages) != 2 {
		t.Errorf("persisted pages = %d, want 2", len(savedCfg.Pages))
	}
	// Atomic write must leave no *.tmp turds behind.
	turds, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp"))
	if len(turds) != 0 {
		t.Errorf("leftover temp files after atomic write: %v", turds)
	}
}

func TestHandleDeckWrite_PagesAuthoritativeOnGet(t *testing.T) {
	_, path := putDeck(t, validDeckBody)
	// TMUX_WEBUI_DECK is still set to path by putDeck (t.Setenv persists for the test).
	_ = path

	cfg := loadDeckConfig()
	if len(cfg.Pages) != 2 {
		t.Fatalf("loadDeckConfig pages = %d, want 2 (user file authoritative)", len(cfg.Pages))
	}
	// Panels were empty in the override → base (embedded default) panels survive.
	if len(cfg.Panels) == 0 {
		t.Error("embedded default panels should survive an override with no panels")
	}
	if cfg.Panels[0].ID != "claude-idle" {
		t.Errorf("panel[0].id = %q, want claude-idle", cfg.Panels[0].ID)
	}
}

func TestHandleDeckWrite_TooLargeRejected(t *testing.T) {
	body := `{"version":2,"pages":[],"panels":[],"_pad":"` + strings.Repeat("a", 70000) + `"}`
	rec, path := putDeck(t, body)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("oversized body must not have been persisted")
	}
}

func TestHandleDeckWrite_MalformedJSONRejected(t *testing.T) {
	rec, path := putDeck(t, "{ this is not json")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("malformed body must not have been persisted")
	}
}

func TestHandleDeckWrite_TooManyPagesRejected(t *testing.T) {
	var pages []string
	for i := 0; i < maxDeckPages+1; i++ {
		pages = append(pages, `{"id":"p","type":"buttons"}`)
	}
	body := `{"version":2,"pages":[` + strings.Join(pages, ",") + `],"panels":[]}`
	rec, _ := putDeck(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (pages > %d)", rec.Code, maxDeckPages)
	}
}

func TestHandleDeckWrite_TooManyButtonsRejected(t *testing.T) {
	var btns []string
	for i := 0; i < maxPageButtons+1; i++ {
		btns = append(btns, `{"label":"x","action":{"type":"key","payload":"Enter"}}`)
	}
	body := `{"version":2,"pages":[{"id":"custom","type":"buttons","buttons":[` +
		strings.Join(btns, ",") + `]}],"panels":[]}`
	rec, _ := putDeck(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (buttons > %d)", rec.Code, maxPageButtons)
	}
}

func TestHandleDeckWrite_PayloadTooLongRejected(t *testing.T) {
	huge := strings.Repeat("x", maxPayloadChars+1)
	body := `{"version":2,"pages":[{"id":"custom","type":"buttons","buttons":[` +
		`{"label":"x","action":{"type":"input","payload":"` + huge + `"}}]}],"panels":[]}`
	rec, _ := putDeck(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (payload > %d)", rec.Code, maxPayloadChars)
	}
}

func TestHandleDeckWrite_MacroStepPayloadTooLongRejected(t *testing.T) {
	huge := strings.Repeat("x", maxPayloadChars+1)
	body := `{"version":2,"pages":[{"id":"custom","type":"buttons","buttons":[` +
		`{"label":"x","action":{"type":"macro","steps":[{"type":"input","payload":"` + huge + `"}]}}]}],"panels":[]}`
	rec, _ := putDeck(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (macro step payload > %d)", rec.Code, maxPayloadChars)
	}
}

func TestHandleDeckWrite_PageMissingTypeRejected(t *testing.T) {
	body := `{"version":2,"pages":[{"id":"custom","label":"我的"}],"panels":[]}`
	rec, _ := putDeck(t, body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (page missing type)", rec.Code)
	}
}

func TestHandleDeckWrite_BackupCreatedOnOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "deck.json")
	t.Setenv("TMUX_WEBUI_DECK", path)
	s := &Server{}

	first := `{"version":2,"pages":[{"id":"first","type":"buttons"}],"panels":[]}`
	second := `{"version":2,"pages":[{"id":"second","type":"buttons"}],"panels":[]}`

	req1 := httptest.NewRequest(http.MethodPut, "/api/deck", strings.NewReader(first))
	s.handleDeckWrite(httptest.NewRecorder(), req1)
	// First write: no prior file, so no .bak yet.
	if _, err := os.Stat(path + ".bak"); !os.IsNotExist(err) {
		t.Error("first write should not create a .bak (no prior file)")
	}

	req2 := httptest.NewRequest(http.MethodPut, "/api/deck", strings.NewReader(second))
	s.handleDeckWrite(httptest.NewRecorder(), req2)

	bak, err := os.ReadFile(path + ".bak")
	if err != nil {
		t.Fatalf("second write should back up prior file to .bak: %v", err)
	}
	var bakCfg deckConfig
	if err := json.Unmarshal(bak, &bakCfg); err != nil {
		t.Fatalf(".bak not valid JSON: %v", err)
	}
	if len(bakCfg.Pages) != 1 || bakCfg.Pages[0].ID != "first" {
		t.Errorf(".bak = %+v, want the FIRST write's pages", bakCfg.Pages)
	}
	// Live file now holds the second write.
	live, _ := os.ReadFile(path)
	var liveCfg deckConfig
	_ = json.Unmarshal(live, &liveCfg)
	if len(liveCfg.Pages) != 1 || liveCfg.Pages[0].ID != "second" {
		t.Errorf("live file = %+v, want the SECOND write's pages", liveCfg.Pages)
	}
}

// TestHandlePanesAll_UnknownSessionEmpty exercises the flat panes endpoint
// deterministically: an explicit, non-existent session makes tmux error out
// (whether or not a tmux server is running), and the handler must degrade to a
// 200 + empty JSON array rather than 500.
func TestHandlePanesAll_UnknownSessionEmpty(t *testing.T) {
	s := &Server{tx: tmuxctl.New()}
	req := httptest.NewRequest(http.MethodGet, "/api/panes?session=__no_such_session_xyz__", nil)
	rec := httptest.NewRecorder()
	s.handlePanesAll(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var panes []tmuxctl.Pane
	if err := json.Unmarshal(rec.Body.Bytes(), &panes); err != nil {
		t.Fatalf("response not a JSON array: %v (body: %s)", err, rec.Body.String())
	}
	if len(panes) != 0 {
		t.Errorf("unknown session should yield empty panes, got %d", len(panes))
	}
}

func TestHandleDeckWrite_UnknownPageTypeRejected(t *testing.T) {
	rec, _ := putDeck(t, `{"version":2,"pages":[{"id":"x","type":"bogus","label":"x"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown page type: status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unknown type") {
		t.Fatalf("error should name the unknown type, got: %s", rec.Body.String())
	}
}
