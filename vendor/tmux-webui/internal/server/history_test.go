package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// TestClampHistoryLines: the per-chunk clamp — default on junk, floor 200,
// NO upper cap (total depth is unbounded by design; a huge chunk only costs
// its requester, and tmux clamps to real history anyway).
func TestClampHistoryLines(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 5000},       // absent → default chunk
		{"abc", 5000},    // junk → default
		{"-5", 5000},     // negative → default
		{"0", 5000},      // zero → default
		{"50", 200},      // below floor → floor
		{"5000", 5000},   // pass-through
		{"99999", 99999}, // no cap — passes through
	}
	for _, c := range cases {
		if got := clampHistoryLines(c.in); got != c.want {
			t.Errorf("clampHistoryLines(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

// TestParseHistoryOffset: junk/negative → 0 (first chunk), else pass-through.
func TestParseHistoryOffset(t *testing.T) {
	for in, want := range map[string]int{"": 0, "abc": 0, "-1": 0, "0": 0, "5000": 5000} {
		if got := parseHistoryOffset(in); got != want {
			t.Errorf("parseHistoryOffset(%q) = %d, want %d", in, got, want)
		}
	}
}

// TestHandleHistory_MissingParams: session and pane are both required — 400,
// not a capture of an empty target.
func TestHandleHistory_MissingParams(t *testing.T) {
	s := &Server{}
	for _, url := range []string{"/api/history", "/api/history?session=s", "/api/history?pane=%251"} {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		rec := httptest.NewRecorder()
		s.handleHistory(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", url, rec.Code)
		}
	}
}

// TestHandleHistory_CaptureOK drives the real handler through a fake tmux
// binary (/bin/echo prints the capture-pane args back as "content"), asserting
// the 200 path: target composed as session:paneID, clamped lines echoed in the
// JSON, content non-empty.
func TestHandleHistory_CaptureOK(t *testing.T) {
	s := &Server{tx: tmuxctl.New(tmuxctl.WithBinary("/bin/echo"))}
	req := httptest.NewRequest(http.MethodGet, "/api/history?session=s&pane=%251&lines=500", nil)
	rec := httptest.NewRecorder()
	s.handleHistory(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var got struct {
		Content string `json:"content"`
		Lines   int    `json:"lines"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if got.Lines != 500 {
		t.Errorf("lines = %d, want 500", got.Lines)
	}
	// /bin/echo prints the args: "capture-pane -t s:%1 -p -S -500 -e"
	if !strings.Contains(got.Content, "-t s:%1") || !strings.Contains(got.Content, "-S -500") {
		t.Errorf("capture target/depth not in content: %q", got.Content)
	}
}

// TestHandleHistory_OffsetChunk: offset>0 routes to the RANGE capture — chunk
// (offset=5000, lines=500) must ask tmux for -S -5500 -E -5001 (the 500 lines
// immediately older than the 5000 already loaded).
func TestHandleHistory_OffsetChunk(t *testing.T) {
	s := &Server{tx: tmuxctl.New(tmuxctl.WithBinary("/bin/echo"))}
	req := httptest.NewRequest(http.MethodGet, "/api/history?session=s&pane=%251&lines=500&offset=5000", nil)
	rec := httptest.NewRecorder()
	s.handleHistory(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("offset chunk = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var got struct {
		Content string `json:"content"`
		Offset  int    `json:"offset"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if got.Offset != 5000 {
		t.Errorf("offset = %d, want 5000", got.Offset)
	}
	if !strings.Contains(got.Content, "-S -5500") || !strings.Contains(got.Content, "-E -5001") {
		t.Errorf("range flags wrong: %q", got.Content)
	}
}
