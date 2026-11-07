// Package autocomplete provides a fuzzy-matching autocomplete engine for the
// tmux-webui terminal input bar. It is a 1:1 Go port of the Python
// autocomplete.py module (Phase 1.7).
//
// # Architecture
//
// The package is split into focused files:
//
//   - scanner.go  — Scanner interface + Item struct
//   - fuzzy.go    — fuzzyScore + rankAndFilter helpers
//   - path.go     — filesystem path completion
//   - claude.go   — optional ~/.claude scanner + minimal YAML frontmatter parser
//   - cache.go    — ResourceCache with mutex + time.Ticker auto-refresh
//   - complete.go — Complete(query, typeFilter) main entry point (router)
//
// # Integration with server.go
//
// Import and wire up in your HTTP server:
//
//	import "github.com/operonlab/tmux-webui/internal/autocomplete"
//
//	ac := autocomplete.New(autocomplete.Options{
//	    ClaudeDir: cfg.Autocomplete.ClaudeDir,
//	})
//	defer ac.Close()
//
//	mux.HandleFunc("GET /api/autocomplete", func(w http.ResponseWriter, r *http.Request) {
//	    q := r.URL.Query().Get("q")
//	    t := r.URL.Query().Get("type")
//	    items := ac.Complete(q, t)
//	    if items == nil {
//	        items = []autocomplete.Item{}
//	    }
//	    w.Header().Set("Content-Type", "application/json")
//	    json.NewEncoder(w).Encode(items)
//	})
//
//	mux.HandleFunc("GET /api/autocomplete/refresh", func(w http.ResponseWriter, r *http.Request) {
//	    stats := ac.Refresh()
//	    w.Header().Set("Content-Type", "application/json")
//	    json.NewEncoder(w).Encode(stats)
//	})
//
//	mux.HandleFunc("GET /api/autocomplete/stats", func(w http.ResponseWriter, r *http.Request) {
//	    stats := ac.Stats()
//	    w.Header().Set("Content-Type", "application/json")
//	    json.NewEncoder(w).Encode(stats)
//	})
//
// # Routing rules
//
// Complete() routes by the first character of query (mirroring Python version):
//
//   - "/" prefix  → slash items (skills + commands), optional typeFilter "skill"/"command"
//   - "@" prefix  → at items (agents + mcp servers)
//   - "path" typeFilter or "~"/"." prefix or "/" in query → path completion
//   - empty query → empty slice
package autocomplete
