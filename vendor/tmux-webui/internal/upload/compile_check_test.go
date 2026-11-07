// compile_check_test.go — verifies the package compiles and the public API is
// accessible.  No logic tests; behaviour is covered by the integration harness.
package upload_test

import (
	"net/http"
	"testing"

	"github.com/operonlab/tmux-webui/internal/upload"
)

func TestCompile(t *testing.T) {
	h := upload.New("/tmp/tmux-webui-upload-test", 0)
	var _ http.HandlerFunc = h.HTTP()
}
