// compile_check_test.go — verifies the package compiles and the public API is
// accessible.  No logic tests; behaviour is covered by the integration harness.
package tts_test

import (
	"net/http"
	"testing"

	"github.com/operonlab/tmux-webui/internal/tts"
)

func TestCompile(t *testing.T) {
	s := tts.NewStore()

	blob := s.Push("hello", []byte{0x00})
	if blob == nil {
		t.Fatal("Push returned nil")
	}

	got := s.Get(blob.ID)
	if got == nil {
		t.Fatal("Get returned nil for known id")
	}

	miss := s.Get("nonexistent")
	if miss != nil {
		t.Fatal("Get should return nil for unknown id")
	}

	var _ http.HandlerFunc = s.PushHandler(nil)
	var _ http.HandlerFunc = s.GetHandler()
}
