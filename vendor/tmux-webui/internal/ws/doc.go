// Package ws implements the WebSocket layer for tmux-webui.
//
// # Architecture
//
// A single Hub manages the set of active connections. Each Conn represents one
// WebSocket client and owns three goroutines tied together by an errgroup:
//
//   - reader   – blocks on wsConn.Read, parses inbound JSON, dispatches handlers
//   - writer   – drains outChan → wsConn.Write (only goroutine allowed to write)
//   - heartbeat – 15-second ticker that sends {type:"ping", ts:epoch_ms}
//
// Polling is NOT per-conn. The Hub runs one shared sessionPoller goroutine per
// tmux session (poller.go), started when the first Conn subscribes and stopped
// when the last leaves. It does the adaptive-interval capture/diff
// (0.4s→0.8→1.2→1.6→2.0s, resets on change or poke), the 1s pane_states tick, and
// the metrics cadence ONCE per session, fanning typed frames out to each
// subscriber (each keeps its own activeWindow view). Sysmon metrics are cached at
// Hub level so N sessions share one fetch per interval (P3).
//
// Any conn goroutine returning cancels the shared context, causing the others to
// exit. Deferred cleanup unsubscribes from the poller, restores layouts, calls
// Hub.Remove, and ws.Close.
//
// # Protocol (client → server)
//
//	focus              {pane: string}
//	input              {pane, text}
//	key                {pane, key, modifiers?: []string}
//	switch_window      {window: int}
//	new_window         {}
//	close_window       {window: int}
//	fit                {pane, cols, rows}
//	fit_enable         {}
//	fit_disable        {}
//	select_pane_direction {pane, direction: "left"|"right"|"up"|"down"}
//	autocomplete       {query: string}  (stub: returns empty results)
//	refresh_panes      {}
//	pong               {ts}            (client reply; ignored)
//
// # Protocol (server → client)
//
//	error              {message}
//	windows            {windows: [...], active: int}
//	panes              {panes: [...]}
//	output             {panes: {paneId: content}}  // incremental, changed only
//	metrics            {metrics: {}}
//	ping               {ts: epoch_ms}
//	prefix_active      {}
//	input_error        {message}
//	tts                {id, text}  // via Hub.Broadcast
//	autocomplete       {results: []}
//
// # Integration with server.go
//
// Replace the /ws stub in server.go with the following:
//
//	import (
//	    "github.com/operonlab/tmux-webui/internal/prefix"
//	    "github.com/operonlab/tmux-webui/internal/ws"
//	)
//
//	// In New() or Mux(), after building tx and cfg:
//	prefixCache := prefix.New(tx)
//	prov := metrics.NewStub() // or metrics.NewHTTP(url)
//	hub := ws.NewHub(cfg, tx, prefixCache, prov)
//
//	// Replace the /ws stub in Mux():
//	//   mux.HandleFunc("/ws", notImplemented(...))
//	// with:
//	mux.Handle("/ws", hub.UpgradeHandler())
//
// The Hub is safe for concurrent use and has no background goroutines of its own.
// All per-connection goroutines are started in Conn.Run (called from UpgradeHandler).
package ws
