package metrics

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// httpProvider pulls metrics from a JSON endpoint compatible with the
// agent-metrics sysmon API (e.g. http://127.0.0.1:10103/sysmon/current).
//
// Parsing mirrors the Python status_metrics() function in tmux_manager.py:
//   - net_display, cpu_display, mem_display, disk_display → Snapshot fields
//   - llm_{provider}_{metric} keys (excluding llm_display) → nested LLM map
//
// The HTTP timeout is 3 s to avoid blocking the metrics ticker.
// Any error (network, parse, etc.) returns an empty Snapshot — metrics are
// best-effort and must never degrade the main UI.
type httpProvider struct {
	url    string
	client *http.Client
}

// NewHTTP returns a Provider that fetches metrics from the given URL.
// url should be the sysmon/current endpoint, e.g.
// "http://127.0.0.1:10103/sysmon/current".
func NewHTTP(url string) Provider {
	return &httpProvider{
		url: url,
		client: &http.Client{
			Timeout: 3 * time.Second,
		},
	}
}

func (p *httpProvider) Collect(ctx context.Context) Snapshot {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.url, nil)
	if err != nil {
		return Snapshot{}
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return Snapshot{}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Snapshot{}
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return Snapshot{}
	}

	// Unmarshal into a generic map so we can iterate all keys.
	var data map[string]any
	if err := json.Unmarshal(body, &data); err != nil {
		return Snapshot{}
	}

	snap := Snapshot{}

	// System metrics — copy pre-formatted display strings directly.
	snap.Net = stringVal(data, "net_display")
	snap.CPU = stringVal(data, "cpu_display")
	snap.Mem = stringVal(data, "mem_display")
	snap.Disk = stringVal(data, "disk_display")

	// LLM usage — group by provider.
	// Key pattern: llm_{provider}_{metric}, e.g. llm_cc_5h, llm_gm_pro.
	// Exclude: llm_display (summary string, not per-provider).
	// Skip: empty values and "?" placeholders (same as Python version).
	llm := map[string]map[string]string{}
	for k, v := range data {
		if !strings.HasPrefix(k, "llm_") || k == "llm_display" {
			continue
		}
		s, ok := v.(string)
		if !ok || s == "" || s == "?" {
			continue
		}
		rest := k[4:] // strip "llm_"
		sep := strings.IndexByte(rest, '_')
		if sep < 0 {
			continue
		}
		provider, metric := rest[:sep], rest[sep+1:]
		if _, ok := llm[provider]; !ok {
			llm[provider] = map[string]string{}
		}
		llm[provider][metric] = s
	}
	if len(llm) > 0 {
		snap.LLM = llm
	}

	return snap
}

// stringVal extracts a string from a map[string]any, returning "" on miss/type-mismatch.
func stringVal(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}
