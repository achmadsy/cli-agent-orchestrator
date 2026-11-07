package metrics_test

// metrics_test.go — unit tests for HTTPProvider and StubProvider.
//
// Mutation-thinking risk list:
//  1. HTTPProvider with 404 response → empty Snapshot (not panic)
//  2. HTTPProvider with timeout → empty Snapshot (not panic)
//  3. HTTPProvider with malformed JSON → empty Snapshot (not panic)
//  4. llm_display key must be excluded from LLM map
//  5. llm_key without second underscore (e.g., "llm_x") must be skipped
//  6. Empty string values for llm_* must be skipped
//  7. "?" values for llm_* must be skipped
//  8. Valid llm_cc_5h → nested map {"cc": {"5h": "..."}}
//  9. Multiple llm providers build separate nested maps
// 10. Stub always returns empty Snapshot

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/operonlab/tmux-webui/internal/metrics"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

// newSysmonServer creates a test server that responds with the given JSON body.
func newSysmonServer(t *testing.T, statusCode int, body any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		if body != nil {
			if err := json.NewEncoder(w).Encode(body); err != nil {
				t.Errorf("test server: encode error: %v", err)
			}
		}
	}))
}

// ─── StubProvider ─────────────────────────────────────────────────────────────

func TestStub_AlwaysEmpty(t *testing.T) {
	p := metrics.NewStub()
	for i := 0; i < 3; i++ {
		snap := p.Collect(context.Background())
		if snap.Net != "" || snap.CPU != "" || snap.Mem != "" || snap.Disk != "" {
			t.Errorf("stub returned non-empty snapshot: %+v", snap)
		}
		if snap.LLM != nil {
			t.Errorf("stub returned non-nil LLM map: %+v", snap.LLM)
		}
	}
}

// ─── HTTPProvider — system fields ─────────────────────────────────────────────

func TestHTTP_ParsesSystemDisplayFields(t *testing.T) {
	body := map[string]any{
		"net_display":  "↑1MB ↓2MB",
		"cpu_display":  "12.5%",
		"mem_display":  "4.2GB/16GB",
		"disk_display": "120GB/500GB",
	}
	srv := newSysmonServer(t, 200, body)
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	if snap.Net != "↑1MB ↓2MB" {
		t.Errorf("Net = %q; want %q", snap.Net, "↑1MB ↓2MB")
	}
	if snap.CPU != "12.5%" {
		t.Errorf("CPU = %q; want %q", snap.CPU, "12.5%")
	}
	if snap.Mem != "4.2GB/16GB" {
		t.Errorf("Mem = %q; want %q", snap.Mem, "4.2GB/16GB")
	}
	if snap.Disk != "120GB/500GB" {
		t.Errorf("Disk = %q; want %q", snap.Disk, "120GB/500GB")
	}
}

// ─── HTTPProvider — LLM nested grouping ───────────────────────────────────────

func TestHTTP_LLM_GroupsByProvider(t *testing.T) {
	body := map[string]any{
		"llm_cc_5h":  "12K",
		"llm_cc_7d":  "85K",
		"llm_gm_pro": "3K",
	}
	srv := newSysmonServer(t, 200, body)
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	if snap.LLM == nil {
		t.Fatal("LLM map is nil; expected nested grouping")
	}
	cc, ok := snap.LLM["cc"]
	if !ok {
		t.Fatalf("LLM map missing 'cc' provider; got keys: %v", keys(snap.LLM))
	}
	if cc["5h"] != "12K" {
		t.Errorf("cc.5h = %q; want %q", cc["5h"], "12K")
	}
	if cc["7d"] != "85K" {
		t.Errorf("cc.7d = %q; want %q", cc["7d"], "85K")
	}
	gm, ok := snap.LLM["gm"]
	if !ok {
		t.Fatalf("LLM map missing 'gm' provider")
	}
	if gm["pro"] != "3K" {
		t.Errorf("gm.pro = %q; want %q", gm["pro"], "3K")
	}
}

func TestHTTP_LLM_ExcludesLLMDisplay(t *testing.T) {
	body := map[string]any{
		"llm_display": "CC:12K GM:3K", // should be excluded
		"llm_cc_5h":   "12K",
	}
	srv := newSysmonServer(t, 200, body)
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	if snap.LLM == nil {
		t.Fatal("LLM map is nil")
	}
	// "llm_display" must not appear as a provider key
	if _, found := snap.LLM["display"]; found {
		t.Error("'display' appeared as LLM provider — llm_display was not excluded")
	}
}

func TestHTTP_LLM_SkipsEmptyValues(t *testing.T) {
	body := map[string]any{
		"llm_cc_5h": "",   // empty → skip
		"llm_cc_7d": "?",  // "?" → skip
		"llm_gm_5h": "5K", // valid
	}
	srv := newSysmonServer(t, 200, body)
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	if snap.LLM == nil {
		t.Fatal("LLM map is nil")
	}
	if _, ok := snap.LLM["cc"]; ok {
		t.Error("'cc' should not appear when all its values are empty or '?'")
	}
}

func TestHTTP_LLM_SkipsKeyWithoutSecondUnderscore(t *testing.T) {
	// "llm_x" has only one underscore after "llm_" → sep = -1 → skip
	body := map[string]any{
		"llm_x":     "value",
		"llm_cc_5h": "12K",
	}
	srv := newSysmonServer(t, 200, body)
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	if snap.LLM == nil {
		t.Fatal("LLM map is nil")
	}
	// "x" (with no metric part) must not be a provider
	if _, ok := snap.LLM["x"]; ok {
		t.Error("'x' appeared as LLM provider — key without second underscore should be skipped")
	}
	// "cc" from llm_cc_5h should be present
	if _, ok := snap.LLM["cc"]; !ok {
		t.Error("'cc' missing from LLM map")
	}
}

func TestHTTP_LLM_NonStringValueSkipped(t *testing.T) {
	body := map[string]any{
		"llm_cc_5h": 12345, // integer, not string → skip
		"llm_gm_5h": "5K",
	}
	srv := newSysmonServer(t, 200, body)
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	if snap.LLM == nil {
		t.Fatal("LLM map is nil")
	}
	if _, ok := snap.LLM["cc"]; ok {
		t.Error("'cc' should not appear when its value is not a string")
	}
}

// ─── HTTPProvider — error paths ───────────────────────────────────────────────

func TestHTTP_404_ReturnsEmptySnapshot(t *testing.T) {
	srv := newSysmonServer(t, 404, nil)
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	// Must not panic; all fields should be empty.
	if snap.CPU != "" || snap.Net != "" || snap.LLM != nil {
		t.Errorf("404 should produce empty Snapshot, got %+v", snap)
	}
}

func TestHTTP_MalformedJSON_ReturnsEmptySnapshot(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("{not valid json"))
	}))
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	if snap.CPU != "" || snap.LLM != nil {
		t.Errorf("malformed JSON should produce empty Snapshot, got %+v", snap)
	}
}

func TestHTTP_Timeout_ReturnsEmptySnapshot(t *testing.T) {
	// Server that sleeps longer than the provider's 3 s timeout.
	// We use a very short timeout (10ms) via a custom URL that immediately
	// closes the connection to simulate a fast timeout without sleeping.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Second) // will be cancelled by client timeout
		w.WriteHeader(200)
	}))
	defer srv.Close()

	// Create provider with artificially small timeout to avoid slow tests.
	// Since NewHTTP doesn't expose timeout, we use a cancelled context instead.
	p := metrics.NewHTTP(srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	snap := p.Collect(ctx)

	if snap.CPU != "" || snap.LLM != nil {
		t.Errorf("timeout should produce empty Snapshot, got %+v", snap)
	}
}

func TestHTTP_NetworkError_ReturnsEmptySnapshot(t *testing.T) {
	// Point at a port that refuses connections.
	p := metrics.NewHTTP("http://127.0.0.1:1") // port 1 should be refused
	snap := p.Collect(context.Background())

	if snap.CPU != "" || snap.LLM != nil {
		t.Errorf("network error should produce empty Snapshot, got %+v", snap)
	}
}

func TestHTTP_EmptyBody_ReturnsEmptySnapshot(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()

	p := metrics.NewHTTP(srv.URL)
	snap := p.Collect(context.Background())

	// All fields should be zero values.
	if snap.CPU != "" || snap.Net != "" || snap.Mem != "" || snap.Disk != "" || snap.LLM != nil {
		t.Errorf("empty JSON body should produce zero Snapshot, got %+v", snap)
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func keys(m map[string]map[string]string) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}
