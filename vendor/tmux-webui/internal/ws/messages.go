package ws

import (
	"github.com/operonlab/tmux-webui/internal/metrics"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// ─── Inbound (client → server) ────────────────────────────────────────────────

// InboundMsg is the envelope parsed from every client frame.
type InboundMsg struct {
	Type string `json:"type"`

	// focus / input / key / fit / select_pane_direction
	Pane string `json:"pane,omitempty"`

	// input
	Text string `json:"text,omitempty"`

	// key
	Key       string   `json:"key,omitempty"`
	Modifiers []string `json:"modifiers,omitempty"`

	// switch_window / close_window / rename_window
	Window int `json:"window,omitempty"`

	// rename_window
	Name string `json:"name,omitempty"`

	// fit
	Cols int `json:"cols,omitempty"`
	Rows int `json:"rows,omitempty"`
	// Restricted CAO resize policy. Owner identity is server connection-local.
	Auto      bool   `json:"auto,omitempty"`
	Takeover  bool   `json:"takeover,omitempty"`
	Release   bool   `json:"release,omitempty"`
	SeqResize uint64 `json:"resize_seq,omitempty"`

	// select_pane_direction
	Direction string `json:"direction,omitempty"`

	// mouse (TUI passthrough): MButton left|middle|right|wheelup|wheeldown,
	// MPhase press|release (wheel ignores phase), MX/MY = 1-based col/row.
	MButton string `json:"mbutton,omitempty"`
	MPhase  string `json:"mphase,omitempty"`
	MX      int    `json:"mx,omitempty"`
	MY      int    `json:"my,omitempty"`

	// input ack correlation (echoed back in input_ok / input_error)
	Nonce string `json:"nonce,omitempty"`

	// autocomplete
	Query string `json:"query,omitempty"`

	// pong
	Ts int64 `json:"ts,omitempty"`

	// link mode (see link.go)
	Group      string `json:"group,omitempty"`
	ClientID   string `json:"client_id,omitempty"`
	Device     string `json:"device,omitempty"`
	Session    string `json:"session,omitempty"`
	Seq        int64  `json:"seq,omitempty"`
	Create     bool   `json:"create,omitempty"`
	LeaderOnly bool   `json:"leader_only,omitempty"`
}

// ─── Outbound (server → client) ───────────────────────────────────────────────

// outError is sent when the server encounters a client-visible error.
type outError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func newError(msg string) outError { return outError{Type: "error", Message: msg} }

// outInputError is sent for input handling failures (distinct from general errors).
type outInputError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Nonce   string `json:"nonce,omitempty"`
}

func newInputError(msg string) outInputError {
	return outInputError{Type: "input_error", Message: msg}
}

// outInputOK acknowledges a successfully delivered input frame, echoing the
// client-supplied nonce so the UI can clear the matching pending input.
type outInputOK struct {
	Type  string `json:"type"`
	Nonce string `json:"nonce,omitempty"`
}

// outWindows carries the window list + active window index.
type outWindows struct {
	Type    string           `json:"type"`
	Windows []tmuxctl.Window `json:"windows"`
	Active  int              `json:"active"`
}

// outPanes carries the full pane list.
type outPanes struct {
	Type  string         `json:"type"`
	Panes []tmuxctl.Pane `json:"panes"`
}

// outOutput carries incremental pane output (only changed panes).
type outOutput struct {
	Type  string            `json:"type"`
	Panes map[string]string `json:"panes"`
}

// Restricted snapshots keep active screen separate from paged history.
type caoSnapshot struct {
	tmuxctl.Screen
	Seq   uint64 `json:"seq"`
	Epoch uint64 `json:"epoch"`
}
type outScreens struct {
	Type    string                 `json:"type"`
	Version int                    `json:"version"`
	Panes   map[string]caoSnapshot `json:"panes"`
}

// outMetrics carries system + LLM usage metrics for the statusline.
type outMetrics struct {
	Type    string           `json:"type"`
	Metrics metrics.Snapshot `json:"metrics"`
}

// outPing is the heartbeat sent every 15 s.
type outPing struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
}

// outPrefixActive notifies the client that the prefix key was intercepted.
type outPrefixActive struct {
	Type string `json:"type"`
}

// outTTS is broadcast to all connections by Hub.Broadcast.
type outTTS struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Text string `json:"text"`
}

// outAutocomplete is the stub autocomplete response.
type outAutocomplete struct {
	Type    string   `json:"type"`
	Results []string `json:"results"`
}

// outPaneStates carries the pane-state frame: States is the per-WINDOW
// aggregate (keyed by window index, attention-first max) that colours the
// SESS keys / rail pills; Panes is the per-PANE debounced state (keyed by
// pane id) — the authoritative reading for the focused-pane strip and the
// waiting count (per pane, not per window). Values: "working" | "idle" |
// "waiting" | "unknown" — short enums, never full text.
type outPaneStates struct {
	Type   string            `json:"type"`
	States map[string]string `json:"states"`
	Panes  map[string]string `json:"panes,omitempty"`
}

// linkMember is one party member in an outLinkState frame.
type linkMember struct {
	ClientID string `json:"client_id"`
	Device   string `json:"device"`
}

// outLinkState is the party's shared view + membership, sent to members on
// join catch-up, membership change, and every accepted link_update. origin is
// the client_id that caused the frame ("" for membership-only refresh); the
// client ignores a frame whose origin is its own client_id.
type outLinkState struct {
	Type       string       `json:"type"`
	Group      string       `json:"group"`
	Session    string       `json:"session"`
	Window     int          `json:"window"`
	Pane       string       `json:"pane"`
	Seq        int64        `json:"seq"`
	Origin     string       `json:"origin"`
	Members    []linkMember `json:"members"`
	Leader     string       `json:"leader"`
	LeaderOnly bool         `json:"leader_only"`
}
