package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/operonlab/tmux-webui/internal/config"
)

// okHandler is the protected downstream; a 200 body proves the gate let it through.
func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("protected"))
	})
}

func gateFor(token string) http.Handler {
	s := &Server{cfg: &config.Config{Token: token}}
	return s.tokenGate(okHandler())
}

func TestTokenGate_ValidCookiePasses(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{Name: "tw_token", Value: "secret"})
	rec := httptest.NewRecorder()
	gateFor("secret").ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != "protected" {
		t.Fatalf("valid cookie should reach downstream, got %d %q", rec.Code, rec.Body.String())
	}
}

func TestTokenGate_HealthExempt(t *testing.T) {
	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()
	gateFor("secret").ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("/health must bypass the gate, got %d", rec.Code)
	}
}

// TestTokenGate_QueryTokenRejected is the SEC1 assertion: a ?token= query must
// NO LONGER authenticate. Before the fix a valid query token set the cookie and
// passed; now the token must arrive via the fragment (client-side), so a query
// token is ignored and the bootstrap is served instead. This is what closes the
// link-preview-unfurler leak vector.
func TestTokenGate_QueryTokenRejected(t *testing.T) {
	req := httptest.NewRequest("GET", "/?token=secret", nil)
	rec := httptest.NewRecorder()
	gateFor("secret").ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("query token must not authenticate, got %d", rec.Code)
	}
	if sc := rec.Header().Get("Set-Cookie"); sc != "" {
		t.Fatalf("gate must not set a cookie from a query token (leak path), got %q", sc)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("unauthorized response should be the HTML bootstrap, got Content-Type %q", ct)
	}
}

// TestTokenGate_BootstrapReadsFragment pins the bootstrap contract: its JS reads
// the token from location.hash and sets the cookie client-side. If this markup
// drifts, fragment-mode auth silently breaks (users stuck on the unlock page).
func TestTokenGate_BootstrapServed(t *testing.T) {
	req := httptest.NewRequest("GET", "/?party=ABCD", nil)
	rec := httptest.NewRecorder()
	gateFor("secret").ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no cookie should yield 401 bootstrap, got %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"location.hash", `get("token")`, "tw_token=", "location.replace"} {
		if !strings.Contains(body, want) {
			t.Errorf("bootstrap HTML missing %q — fragment auth would break", want)
		}
	}
}
