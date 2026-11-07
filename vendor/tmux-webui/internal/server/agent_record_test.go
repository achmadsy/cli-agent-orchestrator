package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/ws"
)

// newAgentTestServer builds a Server whose Monitor has an EMPTY snapshot (no
// scan run), so ResolveAgentPane never matches — enough to exercise the I4
// record/frames handlers' gate path without a live tmux. The live capture/scrub
// path is covered by the ws recorder unit tests (the hard gate).
func newAgentTestServer() *Server {
	return &Server{monitor: ws.NewMonitor(config.NotifyConfig{}, nil)}
}

// TestHandleAgentRecord_RejectsNonAgent: a pane that isn't in the Monitor's
// (agent-only) snapshot is rejected 404 rather than silently starting a
// recording of an arbitrary pane.
func TestHandleAgentRecord_RejectsNonAgent(t *testing.T) {
	s := newAgentTestServer()
	req := httptest.NewRequest(http.MethodPost, "/api/agents/rec", strings.NewReader(`{"on":true}`))
	req.SetPathValue("session", "nope")
	req.SetPathValue("pane", "%9")
	rec := httptest.NewRecorder()
	s.handleAgentRecord(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("record of unknown pane = %d, want 404", rec.Code)
	}
}

// TestHandleAgentRecord_BadJSON: a malformed body is a 400, not a panic.
func TestHandleAgentRecord_BadJSON(t *testing.T) {
	s := newAgentTestServer()
	req := httptest.NewRequest(http.MethodPost, "/api/agents/rec", strings.NewReader(`{bad`))
	req.SetPathValue("session", "s")
	req.SetPathValue("pane", "%1")
	rec := httptest.NewRecorder()
	s.handleAgentRecord(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("record with bad JSON = %d, want 400", rec.Code)
	}
}

// TestHandleAgentFrames_RejectsNonAgent: frames of an unknown pane is 404.
func TestHandleAgentFrames_RejectsNonAgent(t *testing.T) {
	s := newAgentTestServer()
	req := httptest.NewRequest(http.MethodGet, "/api/agents/frames", nil)
	req.SetPathValue("session", "nope")
	req.SetPathValue("pane", "%9")
	rec := httptest.NewRecorder()
	s.handleAgentFrames(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("frames of unknown pane = %d, want 404", rec.Code)
	}
}
