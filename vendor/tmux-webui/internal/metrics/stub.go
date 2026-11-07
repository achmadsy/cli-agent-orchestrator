package metrics

import "context"

// stubProvider is the no-op implementation used in v0 before gopsutil is wired.
// It always returns an empty Snapshot so the metrics ticker loop can run
// without errors and the WebSocket payload includes an empty metrics field.
type stubProvider struct{}

// NewStub returns a Provider that always returns an empty Snapshot.
// Use this as the default until a real provider is configured.
func NewStub() Provider { return stubProvider{} }

func (stubProvider) Collect(_ context.Context) Snapshot { return Snapshot{} }
