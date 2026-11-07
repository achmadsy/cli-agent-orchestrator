// compile_check_test.go — verifies the package compiles and the public API is
// accessible.  No logic tests; behaviour is covered by the integration harness.
package metrics_test

import (
	"context"
	"testing"

	"github.com/operonlab/tmux-webui/internal/metrics"
)

func TestCompile(t *testing.T) {
	var _ metrics.Provider = metrics.NewStub()
	var _ metrics.Provider = metrics.NewHTTP("http://127.0.0.1:10103/sysmon/current")

	snap := metrics.NewStub().Collect(context.Background())
	_ = snap
}
