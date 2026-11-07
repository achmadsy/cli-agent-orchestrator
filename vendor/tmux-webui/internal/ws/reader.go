package ws

import (
	"encoding/json"
	"time"

	"github.com/coder/websocket"
)

// reader blocks on wsConn.Read, parses each inbound frame as JSON, and
// dispatches to the appropriate handler. It returns when ctx is cancelled,
// the connection closes, or an unrecoverable read error occurs.
func (c *Conn) reader() error {
	for {
		_, data, err := c.ws.Read(c.ctx)
		if err != nil {
			// ctx cancellation or connection close — normal exit
			return nil
		}
		c.lastRecv.Store(epochMs()) // any inbound bytes = the client is alive

		var msg InboundMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			c.send(newError("invalid JSON: " + err.Error()))
			continue
		}

		if err := c.dispatch(&msg); err != nil {
			c.send(newInputError(err.Error()))
		}
	}
}

// dispatch routes the inbound message to the correct handler.
func (c *Conn) dispatch(msg *InboundMsg) error {
	switch msg.Type {
	case "focus":
		return c.handleFocus(msg)
	case "input":
		return c.handleInput(msg)
	case "key":
		return c.handleKey(msg)
	case "switch_window":
		return c.handleSwitchWindow(msg)
	case "new_window":
		return c.handleNewWindow(msg)
	case "close_window":
		return c.handleCloseWindow(msg)
	case "rename_window":
		return c.handleRenameWindow(msg)
	case "split_pane":
		return c.handleSplitPane(msg)
	case "close_pane":
		return c.handleClosePane(msg)
	case "fit":
		return c.handleFit(msg)
	case "fit_enable":
		c.fitMode = true
		return nil
	case "fit_disable":
		c.fitMode = false
		c.restoreLayouts()
		return nil
	case "select_pane_direction":
		return c.handleSelectPaneDirection(msg)
	case "mouse":
		return c.handleMouse(msg)
	case "autocomplete":
		c.send(outAutocomplete{Type: "autocomplete", Results: []string{}})
		return nil
	case "refresh_panes":
		return c.handleRefreshPanes()
	case "link_join":
		return c.handleLinkJoin(msg)
	case "link_leave":
		return c.handleLinkLeave(msg)
	case "link_update":
		return c.handleLinkUpdate(msg)
	case "link_config":
		return c.handleLinkConfig(msg)
	case "pong":
		// client heartbeat reply; discard
		return nil
	default:
		c.send(newError("unknown message type: " + msg.Type))
		return nil
	}
}

// ─── Individual message handlers ──────────────────────────────────────────────

func (c *Conn) handleFocus(msg *InboundMsg) error {
	target := c.paneTarget(msg.Pane)
	return c.hub.tx.SelectPane(c.ctx, target)
}

func (c *Conn) handleInput(msg *InboundMsg) error {
	if msg.Text == "" {
		return nil
	}
	if !c.hub.writeAllowed(c.group, c.clientID) {
		c.send(outInputError{Type: "input_error", Nonce: msg.Nonce, Message: "Leader-only drive is on — only the party leader can send input"})
		return nil
	}
	target := c.paneTarget(msg.Pane)
	if err := c.hub.tx.SendText(c.ctx, target, msg.Text); err != nil {
		c.send(outInputError{Type: "input_error", Nonce: msg.Nonce, Message: "Failed to send to " + msg.Pane})
		return nil
	}
	// tmux send-keys is async — give the buffer a moment to land before Enter.
	time.Sleep(50 * time.Millisecond)
	if err := c.hub.tx.SendEnter(c.ctx, target); err != nil {
		c.send(outInputError{Type: "input_error", Nonce: msg.Nonce, Message: "Failed to send Enter to " + msg.Pane})
		return nil
	}
	c.send(outInputOK{Type: "input_ok", Nonce: msg.Nonce})
	return nil
}

func (c *Conn) handleKey(msg *InboundMsg) error {
	// Gate BEFORE the FSM so a blocked key never mutates prefix state. Keys are
	// a stream (a follower may hold a key down); drop silently rather than
	// spamming input_error per keystroke — handleInput gives the explicit toast.
	if !c.hub.writeAllowed(c.group, c.clientID) {
		return nil
	}
	return c.handleKeyWithFSM(msg)
}

func (c *Conn) handleSwitchWindow(msg *InboundMsg) error {
	// Py server.py:736-749 does NOT call `tmux select-window`. It only
	// updates the per-connection active_window state and re-emits the
	// windows + visible-panes frames. Multiple WS clients can each view
	// a different window without stealing tmux's physical active state.
	c.pushWindowsAndPanes(msg.Window)
	return nil
}

func (c *Conn) handleNewWindow(_ *InboundMsg) error {
	if err := c.hub.tx.NewWindow(c.ctx, c.session); err != nil {
		return err
	}
	// New window becomes active (highest index after creation).
	windows, _ := c.hub.tx.ListWindows(c.ctx, c.session)
	maxIdx := 0
	for _, w := range windows {
		if w.Index > maxIdx {
			maxIdx = w.Index
		}
	}
	c.pushWindowsAndPanes(maxIdx)
	return nil
}

func (c *Conn) handleCloseWindow(msg *InboundMsg) error {
	if err := c.hub.tx.KillWindow(c.ctx, c.session, msg.Window); err != nil {
		return err
	}
	windows, _ := c.hub.tx.ListWindows(c.ctx, c.session)
	if len(windows) == 0 {
		// Py server.py:773-779 sends an error and exits the read loop.
		c.send(newError("All windows closed"))
		c.cancel()
		return nil
	}
	// Py server.py:780-781: if the killed window was active, fall back to
	// the FIRST window in the remaining list (not tmux's auto-pick).
	active := int(c.activeWindow.Load())
	if msg.Window == active {
		active = windows[0].Index
	}
	c.pushWindowsAndPanes(active)
	return nil
}

func (c *Conn) handleRenameWindow(msg *InboundMsg) error {
	if err := c.hub.tx.RenameWindow(c.ctx, c.session, msg.Window, msg.Name); err != nil {
		return err
	}
	c.pushWindowsAndPanes(int(c.activeWindow.Load()))
	return nil
}

func (c *Conn) handleSplitPane(msg *InboundMsg) error {
	target := c.paneTarget(msg.Pane)
	if err := c.hub.tx.SplitWindow(c.ctx, target, msg.Direction == "h"); err != nil {
		return err
	}
	c.pushWindowsAndPanes(int(c.activeWindow.Load()))
	return nil
}

func (c *Conn) handleClosePane(msg *InboundMsg) error {
	target := c.paneTarget(msg.Pane)
	if err := c.hub.tx.KillPane(c.ctx, target); err != nil {
		return err
	}
	// Killing the last pane in a window also closes that window — mirror
	// handleCloseWindow's fallback so the view never points at a dead window.
	windows, _ := c.hub.tx.ListWindows(c.ctx, c.session)
	if len(windows) == 0 {
		c.send(newError("All windows closed"))
		c.cancel()
		return nil
	}
	active := int(c.activeWindow.Load())
	stillThere := false
	for _, w := range windows {
		if w.Index == active {
			stillThere = true
			break
		}
	}
	if !stillThere {
		active = windows[0].Index
	}
	c.pushWindowsAndPanes(active)
	return nil
}

func (c *Conn) handleSelectPaneDirection(msg *InboundMsg) error {
	target := c.paneTarget(msg.Pane)
	return c.hub.tx.SelectPaneByDirection(c.ctx, target, msg.Direction)
}

// handleMouse injects a mouse event (wheel/click/drag) into the pane's program
// as an SGR-1006 report. The frontend only sends these for panes it sees as
// mouse-mode (#{mouse_any_flag}); a program not in mouse mode just ignores the
// bytes, so a stray event is harmless. Errors (unknown button, dead pane) are
// swallowed — a mis-tapped mouse event should never tear down the WS.
func (c *Conn) handleMouse(msg *InboundMsg) error {
	target := c.paneTarget(msg.Pane)
	_ = c.hub.tx.SendMouseSGR(c.ctx, target, msg.MButton, msg.MX, msg.MY, msg.MPhase)
	return nil
}

func (c *Conn) handleRefreshPanes() error {
	// Py server.py:837-839 only sends `panes`, not `windows`, and does
	// NOT clear last_contents. Match exactly.
	panes, _ := c.hub.tx.ListPanes(c.ctx, c.session)
	active := int(c.activeWindow.Load())
	c.send(outPanes{Type: "panes", Panes: visiblePanes(panes, active)})
	return nil
}

// paneTarget builds a tmux target string from pane id.
// pane id format: "winIdx.paneIdx" (e.g. "0.1") → "session:0.1"
func (c *Conn) paneTarget(pane string) string {
	if pane == "" {
		return c.session
	}
	return c.session + ":" + pane
}

// itoa converts int to string without importing strconv in reader.go
// (strconv is already used in other files; keep reader.go self-contained).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	result := make([]byte, 0, 10)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		result = append([]byte{byte('0' + n%10)}, result...)
		n /= 10
	}
	if neg {
		result = append([]byte{'-'}, result...)
	}
	return string(result)
}

// pushWindowsAndPanes refreshes the frontend view after a window-set change.
// Updates activeWindow, sets snapshotDirty so the session poller re-emits all
// output for THIS conn, and sends fresh windows + panes (filtered) frames.
//
// Replaces the old sendWindowsAndPanes which never filtered, leaving the
// frontend with stale pane content from previously-active windows.
func (c *Conn) pushWindowsAndPanes(active int) {
	c.activeWindow.Store(int32(active))
	c.snapshotDirty.Store(true)

	windows, _ := c.hub.tx.ListWindows(c.ctx, c.session)
	if windows == nil {
		windows = nil // explicit no-op; outWindows handles nil via json
	}
	c.send(outWindows{Type: "windows", Windows: windows, Active: active})

	panes, _ := c.hub.tx.ListPanes(c.ctx, c.session)
	c.send(outPanes{Type: "panes", Panes: visiblePanes(panes, active)})

	// Wake the session poller so the new window's pane content is captured
	// immediately instead of waiting for the adaptive ticker (which may have
	// backed off to 2 s on a quiet screen).
	c.poke()
}

// Ensure websocket import used (Read call in reader loop).
var _ = websocket.MessageText
