// Package metrics provides system and LLM usage metrics for tmux-webui.
//
// # Overview
//
// The package defines a Provider interface and a Snapshot value type.
// Two concrete providers are available:
//
//   - StubProvider: always returns an empty Snapshot; used by default in v0
//     to avoid introducing a gopsutil dependency before it is needed.
//
//   - HTTPProvider: fetches a JSON payload from a configurable URL (e.g.
//     http://127.0.0.1:10103/sysmon/current from the agent-metrics station)
//     and maps the display fields onto Snapshot.  Parsing logic mirrors the
//     Python status_metrics() function in tmux_manager.py.
//
// # Configuration
//
//	// from config.MetricsConfig
//	if cfg.Metrics.Provider == "http" && cfg.Metrics.URL != "" {
//	    prov = metrics.NewHTTP(cfg.Metrics.URL)
//	} else {
//	    prov = metrics.NewStub()
//	}
//
// # LLM key convention
//
// The sysmon JSON can contain keys of the form llm_{provider}_{metric}
// (e.g. llm_cc_5h, llm_gm_pro).  HTTPProvider groups these into a nested
// map[provider]map[metric]value, dropping empty / "?" values.
// The key llm_display is explicitly excluded.
package metrics
