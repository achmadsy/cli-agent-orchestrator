package ws

// CAO's deliberately narrow entrypoint does not expose upstream's unrestricted
// dispatcher, prefix FSM, layout fitting, global monitor or session lifecycle.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

var caoID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
var caoStablePane = regexp.MustCompile(`^%[0-9]+$`)
var caoStableWindow = regexp.MustCompile(`^@[0-9]+$`)
var caoKey = regexp.MustCompile(`^(?:(?:C|M|S)-)*(?:[A-Za-z0-9]|Enter|Escape|Tab|BSpace|DC|Delete|Up|Down|Left|Right|Home|End|PPage|NPage|Space|BTab|F[1-9][0-2]?)$`)

// tmuxctl.atoi is package-private; capture output fields are advisory anyway.
func caoAtoi(s string) int { n, _ := strconv.Atoi(s); return n }

// CAOTarget comes only from the authenticated Python gateway, never directly
// from a browser. Stable IDs are pinned for the lifetime of a viewer lease.
type CAOTarget struct{ Session, Terminal, WindowID, PaneID, Mode, Socket string }

func caoOwnOption(ctx context.Context, tx *tmuxctl.Client, scope, target string) (string, error) {
	raw, err := tx.Run(ctx, "show-options", scope, "-t", target)
	if err != nil {
		return "", errors.New("ownership query failed")
	}
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "@cao_terminal_id ") {
			return strings.TrimPrefix(line, "@cao_terminal_id "), nil
		}
	}
	return "", nil
}

func CAOTargetFromRequest(r *http.Request) (CAOTarget, error) {
	q := r.URL.Query()
	t := CAOTarget{q.Get("session"), q.Get("terminal"), q.Get("window_id"), q.Get("pane_id"), q.Get("mode"), q.Get("socket")}
	if !reSessionName.MatchString(t.Session) || !strings.HasPrefix(t.Session, "cao-") || !caoID.MatchString(t.Terminal) || !caoStableWindow.MatchString(t.WindowID) || !caoStablePane.MatchString(t.PaneID) || (t.Mode != "pane" && t.Mode != "window") {
		return t, errors.New("invalid CAO target")
	}
	return t, nil
}

// caoPanes verifies OWN scoped options, not inherited options or reusable names.
// The stable pane anchor must still belong to this session/window. Replacement
// objects, renamed sessions and moved panes fail closed instead of being followed.
func caoPanes(ctx context.Context, tx *tmuxctl.Client, t CAOTarget) ([]tmuxctl.Pane, error) {
	raw, err := tx.Run(ctx, "list-panes", "-s", "-t", "="+t.Session, "-F", "#{pane_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_active}\t#{pane_width}\t#{pane_height}\t#{mouse_any_flag}\t#{pane_current_command}\t#{pane_title}")
	if err != nil {
		return nil, errors.New("terminal unavailable")
	}
	actual, err := tx.Run(ctx, "display-message", "-t", t.PaneID, "-p", "#{socket_path}")
	if err != nil || strings.TrimSpace(actual) != t.Socket {
		return nil, errors.New("tmux socket mismatch")
	}
	anchor := false
	var panes []tmuxctl.Pane
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		p := strings.SplitN(line, "\t", 11)
		if len(p) < 11 || p[1] != t.WindowID {
			continue
		}
		if p[0] == t.PaneID {
			anchor = true
		}
		if t.Mode == "pane" && p[0] != t.PaneID {
			continue
		}
		// A shared pane-mode window may still carry the FIRST terminal's window
		// stamp. A sibling with its own different terminal ID is never authorized.
		if t.Mode == "window" {
			own, e := caoOwnOption(ctx, tx, "-p", p[0])
			if e != nil {
				return nil, e
			}
			if own != "" && own != t.Terminal {
				continue
			}
		}
		panes = append(panes, tmuxctl.Pane{Window: caoAtoi(p[2]), WindowName: p[3], Pane: caoAtoi(p[4]), Active: caoAtoi(p[5]), Width: caoAtoi(p[6]), Height: caoAtoi(p[7]), MouseMode: caoAtoi(p[8]), Command: p[9], Title: p[10], ID: p[0]})
	}
	if !anchor || len(panes) == 0 {
		return nil, errors.New("terminal target changed")
	}
	scope, target := "-w", t.WindowID
	if t.Mode == "pane" {
		scope, target = "-p", t.PaneID
	}
	own, err := caoOwnOption(ctx, tx, scope, target)
	if err != nil || own != t.Terminal {
		return nil, errors.New("terminal ownership changed")
	}
	return panes, nil
}

func CAOHistory(tx *tmuxctl.Client) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t, err := CAOTargetFromRequest(r)
		if err != nil {
			http.Error(w, "invalid target", 400)
			return
		}
		panes, err := caoPanes(r.Context(), tx, t)
		if err != nil {
			http.Error(w, "terminal unavailable", 410)
			return
		}
		pane := r.URL.Query().Get("pane")
		found := false
		for _, p := range panes {
			if p.ID == pane {
				found = true
			}
		}
		if !found {
			http.Error(w, "pane not authorized", 403)
			return
		}
		lines, _ := strconv.Atoi(r.URL.Query().Get("lines"))
		if lines <= 0 {
			lines = 5000
		}
		if lines > 5000 {
			lines = 5000
		}
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		if offset < 0 || offset > 100000 {
			http.Error(w, "history limit", 400)
			return
		}
		var content string
		if offset == 0 {
			content, err = tx.CapturePane(r.Context(), pane, lines)
		} else {
			content, err = tx.CapturePaneRange(r.Context(), pane, offset+lines, offset+1)
		}
		if err != nil {
			http.Error(w, "capture unavailable", 503)
			return
		}
		if len(content) > 512<<10 {
			http.Error(w, "history response too large", 413)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"content": content, "lines": lines, "offset": offset})
	})
}

// CAOHandler reuses upstream's wire types, renderer and input primitives while
// limiting each connection to exact, live CAO-owned targets. Fit is deliberately
// non-mutating: tmux layouts are shared with other agents and attached clients.
func CAOHandler(tx *tmuxctl.Client) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t, err := CAOTargetFromRequest(r)
		if err != nil {
			http.Error(w, "invalid target", 400)
			return
		}
		if _, err = caoPanes(r.Context(), tx, t); err != nil {
			http.Error(w, "terminal unavailable", 410)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "viewer closed")
		conn.SetReadLimit(65536)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		inbound := make(chan InboundMsg, 1)
		go func() {
			defer cancel()
			for {
				_, data, err := conn.Read(ctx)
				if err != nil {
					return
				}
				var msg InboundMsg
				if json.Unmarshal(data, &msg) != nil {
					return
				}
				select {
				case inbound <- msg:
				case <-ctx.Done():
					return
				}
			}
		}()
		send := func(v any) error {
			b, e := json.Marshal(v)
			if e != nil {
				return e
			}
			if len(b) > 1<<20 {
				return errors.New("output limit")
			}
			return conn.Write(ctx, websocket.MessageText, b)
		}
		ticker := time.NewTicker(400 * time.Millisecond)
		defer ticker.Stop()
		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()
		last := map[string]string{}
		lastSig := ""
		lastRecv := time.Now()
		seen := map[string]bool{}
		var nonces []string
		refresh := func() error {
			panes, e := caoPanes(ctx, tx, t)
			if e != nil {
				return e
			}
			sig := paneListSig(panes, 0)
			if sig != lastSig {
				lastSig = sig
				if e = send(outWindows{Type: "windows", Windows: []tmuxctl.Window{{Index: panes[0].Window, Name: panes[0].WindowName, Active: 1, Panes: len(panes)}}, Active: panes[0].Window}); e != nil {
					return e
				}
				if e = send(outPanes{Type: "panes", Panes: panes}); e != nil {
					return e
				}
			}
			changed := map[string]string{}
			for _, p := range panes {
				s, e := tx.CapturePane(ctx, p.ID, 300)
				if e != nil {
					return e
				}
				if len(s) > 2<<20 {
					return errors.New("capture limit")
				}
				if old, ok := last[p.ID]; !ok || old != s {
					changed[p.ID] = s
					last[p.ID] = s
				}
			}
			if len(changed) > 0 {
				return send(outOutput{Type: "output", Panes: changed})
			}
			return nil
		}
		if refresh() != nil {
			return
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if refresh() != nil {
					return
				}
			case <-ping.C:
				if time.Since(lastRecv) > 45*time.Second {
					return
				}
				if send(outPing{Type: "ping", Ts: epochMs()}) != nil {
					return
				}
			case msg := <-inbound:
				lastRecv = time.Now()
				panes, e := caoPanes(ctx, tx, t)
				if e != nil {
					return
				}
				found := false
				for _, p := range panes {
					if p.ID == msg.Pane {
						found = true
					}
				}
				switch msg.Type {
				case "pong", "fit_enable", "fit_disable", "autocomplete":
					continue
				case "refresh_panes":
					lastSig = ""
					continue
				case "switch_window":
					if msg.Window != panes[0].Window {
						return
					}
					continue
				case "input", "key", "mouse", "focus", "fit":
					if !found {
						return
					}
				default:
					return
				}
				switch msg.Type {
				case "focus", "fit":
					continue // client focus only; never mutate shared layout
				case "input":
					if len(msg.Text) > 60000 || len(msg.Nonce) > 128 {
						return
					}
					if msg.Nonce != "" && seen[msg.Nonce] {
						_ = send(outInputOK{Type: "input_ok", Nonce: msg.Nonce})
						continue
					}
					if msg.Text == "" {
						continue
					}
					// Remember before dispatch: an ambiguous partial send must never be retried.
					if msg.Nonce != "" {
						seen[msg.Nonce] = true
						nonces = append(nonces, msg.Nonce)
						if len(nonces) > 128 {
							delete(seen, nonces[0])
							nonces = nonces[1:]
						}
					}
					var random [12]byte
					_, _ = rand.Read(random[:])
					e = tx.SendTextWithBuf(ctx, msg.Pane, msg.Text, "cao_web_"+hex.EncodeToString(random[:]))
					if e == nil {
						e = tx.SendEnter(ctx, msg.Pane)
					}
					if e != nil {
						_ = send(outInputError{Type: "input_error", Nonce: msg.Nonce, Message: "Delivery uncertain; inspect output before retrying"})
					} else {
						_ = send(outInputOK{Type: "input_ok", Nonce: msg.Nonce})
					}
				case "key":
					key := buildKeySpec(msg.Key, msg.Modifiers)
					if !caoKey.MatchString(key) {
						// Single printable shell/Unicode keys are literal data, never
						// option names or tmux command separators.
						if len([]rune(msg.Key)) == 1 && len(msg.Modifiers) == 0 && []rune(msg.Key)[0] >= 32 {
							_ = tx.SendText(ctx, msg.Pane, msg.Key)
						} else {
							_ = send(newInputError("Unsupported key"))
						}
						continue
					}
					// No prefix FSM: C-b then x must not turn into kill-pane/global commands.
					_ = tx.SendKey(ctx, msg.Pane, key)
				case "mouse":
					if msg.MX < 1 || msg.MX > 1000 || msg.MY < 1 || msg.MY > 1000 {
						return
					}
					_ = tx.SendMouseSGR(ctx, msg.Pane, msg.MButton, msg.MX, msg.MY, msg.MPhase)
				}
			}
		}
	})
}

func CAOVersion() string {
	return fmt.Sprintf("cao-terminal/%s", "195ad23136c500b10fc88ba50397a25fa7b8c4d9")
}
