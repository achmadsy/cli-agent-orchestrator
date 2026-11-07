// Package fedproxy federates multiple tmux-webui instances behind one UI.
//
// One instance acts as the "hub": it lists and proxies sessions from remote
// instances ("hosts", config.Hosts). A remote session surfaces under a
// "<host>/<session>" prefix, and every SESSION-SCOPED request is forwarded to
// the owning host with the prefix stripped and the host's tw_token cookie
// attached; the response is piped back verbatim. A dead/slow host is skipped
// fail-soft — the local view always returns.
//
// # What proxies (forwarded to the owning host, prefix stripped)
//
//   - GET    /api/sessions               — MERGED: local + each host's list, fanned
//     out concurrently; remote entries carry host=<name> and a "<name>/…" name.
//   - GET    /api/history?session=…       — session query param carries the prefix.
//   - GET    /api/panes?session=…         — flat pane list; forwarded when the
//     session param targets a host, else the local first-session default.
//   - GET    /api/sessions/{name}/panes   — name path segment carries the prefix.
//   - GET    /api/sessions/{name}/windows — window list for a remote session.
//   - PATCH  /api/sessions/{name}         — rename.
//   - DELETE /api/sessions/{name}         — kill.
//   - POST   /api/sessions                — optional "host" body field routes create.
//   - /ws?session=<host>/<rest>           — DUMB byte pipe to the host's /ws.
//
// # What stays LOCAL-ONLY (never federated, always served by this instance)
//
// relay, notify (webhook push), metrics, upload, deck, agents (/api/agents is
// its OWN status-only federation via config.notify.peers — see monitor.go, and
// the /api/agents/{session}/{pane}/record|frames I4 recorders which gate on the
// LOCAL snapshot), plus rescue, autocomplete, link/QR, version, and health.
// These are machine-local by nature (a metrics snapshot, an upload target, a
// rescue console for THIS tmux server) and carry no host prefix to route on.
//
// # Not to be confused with notify.peers
//
// config.notify.peers is STATUS-ONLY agent federation (each Monitor scan GETs a
// peer's /api/agents). config.Hosts is the FULL session proxy. They are kept
// separate on purpose and are not unified here.
package fedproxy
