package metrics

import "context"

// Snapshot holds a point-in-time view of system and LLM usage metrics.
// All string fields use the pre-formatted display strings produced by
// the agent-metrics sysmon endpoint — ready to render in the UI as-is.
//
// Fields are omitted from JSON when empty so the WebSocket payload stays lean.
type Snapshot struct {
	Net  string                       `json:"net,omitempty"`
	CPU  string                       `json:"cpu,omitempty"`
	Mem  string                       `json:"mem,omitempty"`
	Disk string                       `json:"disk,omitempty"`
	LLM  map[string]map[string]string `json:"llm,omitempty"`
}

// Provider collects a Snapshot on demand.
// Implementations must be safe for concurrent use and must never block
// indefinitely — callers hold locks or are inside a ticker goroutine.
type Provider interface {
	Collect(ctx context.Context) Snapshot
}
