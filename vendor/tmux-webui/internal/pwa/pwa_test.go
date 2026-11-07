package pwa

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// renderIndex drives IndexHandler for "/" and returns the rendered body.
func renderIndex(t *testing.T, ui json.RawMessage) string {
	t.Helper()
	rec := httptest.NewRecorder()
	IndexHandler(ui).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; want 200", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "{{ ui_config_json }}") {
		t.Fatalf("ui_config_json directive left unsubstituted")
	}
	return body
}

// TestIndexHandler_UIConfigAbsent: a nil blob emits the JS literal null.
func TestIndexHandler_UIConfigAbsent(t *testing.T) {
	body := renderIndex(t, nil)
	if !strings.Contains(body, "window.__UI_CONFIG__ = null;") {
		t.Errorf("absent UI blob did not render null; body excerpt around marker missing")
	}
}

// TestIndexHandler_UIConfigBlob: a valid blob is injected verbatim.
func TestIndexHandler_UIConfigBlob(t *testing.T) {
	body := renderIndex(t, json.RawMessage(`{"theme":"dark","cols":3}`))
	if !strings.Contains(body, `window.__UI_CONFIG__ = {"theme":"dark","cols":3};`) {
		t.Errorf("valid UI blob not injected verbatim")
	}
}

// TestIndexHandler_ScriptBreakout: a "</script>" inside the blob is escaped to
// "<\/script>" so it cannot terminate the inline <script> early.
func TestIndexHandler_ScriptBreakout(t *testing.T) {
	body := renderIndex(t, json.RawMessage(`{"x":"BREAK</script>OUT"}`))
	if !strings.Contains(body, `BREAK<\/script>OUT`) {
		t.Errorf("script-breakout payload was not escaped to <\\/script>")
	}
	if strings.Contains(body, "BREAK</script>OUT") {
		t.Errorf("raw </script> from the blob survived into the HTML (breakout risk)")
	}
}
