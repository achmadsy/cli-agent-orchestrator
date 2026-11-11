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
var caoKey = regexp.MustCompile(`^(?:(?:C|M|S)-)*(?:[A-Za-z0-9]|Enter|Escape|Tab|BSpace|DC|Delete|Up|Down|Left|Right|Home|End|PPage|NPage|Space|BTab|F(?:[1-9]|1[0-2]))$`)

// Canonicalize only the restricted key protocol, without changing upstream FSM.
func caoKeySpec(key string, modifiers []string) (string, bool) {
	if len(modifiers) > 3 {
		return "", false
	}
	mods := []string{}
	shift := false
	for _, mod := range modifiers {
		switch strings.ToLower(mod) {
		case "c", "ctrl":
			mods = append(mods, "C")
		case "m", "alt":
			mods = append(mods, "M")
		case "s", "shift":
			shift = true
		default:
			return "", false
		}
	}
	if shift {
		switch {
		case key == "Tab":
			key = "BTab"
		case len(key) == 1 && strings.Contains("abcdefghijklmnopqrstuvwxyz", key):
			key = strings.ToUpper(key)
		case len(key) == 1 && strings.Contains("ABCDEFGHIJKLMNOPQRSTUVWXYZ", key):
		case len(key) == 1 && strings.Contains("1234567890-=[]\\;'/.,`", key):
			from, to := "1234567890-=[]\\;'/.,`", "!@#$%^&*()_+{}|:\"?><~"
			key = string(to[strings.Index(from, key)])
		case len(key) == 1: // DOM event.key may already be shifted punctuation.
		default:
			mods = append(mods, "S")
		}
	}
	spec := buildKeySpec(key, mods)
	if caoKey.MatchString(spec) {
		return spec, true
	}
	if len(key) == 1 && strings.Contains("[]\\^_?@", key) && len(mods) > 0 {
		return spec, true
	}
	if len(mods) == 0 && len([]rune(key)) == 1 && []rune(key)[0] >= 32 && []rune(key)[0] != 127 {
		return key, true
	}
	return "", false
}

// tmuxctl.atoi is package-private; capture output fields are advisory anyway.
func caoAtoi(s string) int { n, _ := strconv.Atoi(s); return n }

// Bounds for viewer-requested resizes: generous for 4K panes, far below any
// value a real browser viewport could produce from its own box measurements.
const (
	caoResizeMinCols = 20
	caoResizeMaxCols = 400
	caoResizeMinRows = 6
	caoResizeMaxRows = 200
)

// caoResize resizes only the pinned window. Caller must validate exact target
// and hold the restricted sizing claim; never use upstream global layout fit.
func caoResize(ctx context.Context, tx *tmuxctl.Client, t CAOTarget, cols, rows int) error {
	if cols < caoResizeMinCols || cols > caoResizeMaxCols || rows < caoResizeMinRows || rows > caoResizeMaxRows {
		return errors.New("resize out of range")
	}
	_, err := tx.Run(ctx, "resize-window", "-t", t.WindowID,
		"-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows))
	return err
}

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
	raw, err := tx.Run(ctx, "display-message", "-t", t.PaneID, "-p", "#{socket_path}", ";", "list-panes", "-s", "-t", "="+t.Session, "-F", "#{pane_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_active}\t#{pane_width}\t#{pane_height}\t#{mouse_any_flag}\t#{pane_current_command}\t#{window_panes}\t#{pane_title}")
	if err != nil {
		return nil, errors.New("terminal unavailable")
	}
	actual, rest, ok := strings.Cut(raw, "\n")
	if !ok || actual != t.Socket {
		return nil, errors.New("tmux socket mismatch")
	}
	raw = rest
	anchor := false
	var panes []tmuxctl.Pane
	for _, line := range strings.Split(strings.TrimSuffix(raw, "\n"), "\n") {
		p := strings.SplitN(line, "\t", 12)
		if len(p) < 12 || p[1] != t.WindowID {
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
		panes = append(panes, tmuxctl.Pane{Window: caoAtoi(p[2]), WindowName: p[3], Pane: caoAtoi(p[4]), Active: caoAtoi(p[5]), Width: caoAtoi(p[6]), Height: caoAtoi(p[7]), WindowPanes: caoAtoi(p[10]), MouseMode: caoAtoi(p[8]), Command: p[9], Title: p[11], ID: p[0]})
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
	cache := &caoHistoryCache{}
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
		before, e := tx.ScreenMeta(r.Context(), pane)
		if e != nil {
			http.Error(w, "screen unavailable", 503)
			return
		}
		boundary := r.URL.Query().Get("boundary")
		if before.Alternate || boundary != "" && boundary != before.Boundary {
			http.Error(w, "history boundary changed", 409)
			return
		}
		snapshotID := r.URL.Query().Get("snapshot")
		var snapshot caoHistorySnapshot
		if offset > 0 {
			var ok bool
			snapshot, ok = cache.get(snapshotID, t, pane, before.Boundary)
			if !ok {
				http.Error(w, "history snapshot expired", 409)
				return
			}
		} else {
			// One bounded immutable capture per reader, not relative pagination
			// into a history buffer that can evict equal-sized rows at its cap.
			content, captureErr := tx.CapturePane(r.Context(), pane, caoHistoryDepth)
			if captureErr != nil {
				http.Error(w, "capture unavailable", 503)
				return
			}
			if len(content) > caoHistoryBytes {
				http.Error(w, "history response too large", 413)
				return
			}
			after, metaErr := tx.ScreenMeta(r.Context(), pane)
			if metaErr != nil || after.Boundary != before.Boundary {
				http.Error(w, "history boundary changed", 409)
				return
			}
			snapshotID, snapshot = cache.put(t, pane, before.Boundary, content, before.Rows)
			if snapshotID == "" {
				http.Error(w, "history unavailable", 503)
				return
			}
		}
		content, exhausted := snapshot.page(lines, offset)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]any{"content": content, "lines": lines, "offset": offset, "boundary": before.Boundary, "snapshot": snapshotID, "exhausted": exhausted})
	})
}

// CAOHandler reuses upstream's wire types, renderer and input primitives while
// limiting each connection to exact, live CAO-owned targets. Restricted sizing
// is arbitrated per window; upstream global/layout fit stays non-mutating.
func CAOHandler(tx *tmuxctl.Client) http.Handler {
	sizing := &caoSizing{}
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
		owner := &caoSizingOwner{}
		defer sizing.release(t, owner)
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
		last := map[string]tmuxctl.Screen{}
		epochs := map[string]uint64{}
		var sequence uint64
		activeUntil := time.Now()
		captureQueued := false
		requestCapture := func() {
			activeUntil = time.Now().Add(1200 * time.Millisecond)
			if !captureQueued {
				ticker.Reset(30 * time.Millisecond)
				captureQueued = true
			}
		}
		lastSig := ""
		lastRecv := time.Now()
		seen := map[string]bool{}
		var nonces []string
		refresh := func() error {
			captureQueued = false
			panes, e := caoPanes(ctx, tx, t)
			if e != nil {
				return e
			}
			sig := paneListSig(panes, 0) + fmt.Sprint(panes[0].WindowPanes)
			if sig != lastSig {
				lastSig = sig
				if e = send(outWindows{Type: "windows", Windows: []tmuxctl.Window{{Index: panes[0].Window, Name: panes[0].WindowName, Active: 1, Panes: len(panes)}}, Active: panes[0].Window}); e != nil {
					return e
				}
				if e = send(outPanes{Type: "panes", Panes: panes}); e != nil {
					return e
				}
			}
			changed := map[string]caoSnapshot{}
			for _, p := range panes {
				s, e := tx.CaptureScreen(ctx, p.ID)
				if e != nil {
					continue
				} // bounded unstable capture: retain last good grid
				old, ok := last[p.ID]
				if !ok || old != s {
					if !ok || old.Alternate != s.Alternate || old.Cols != s.Cols || old.Rows != s.Rows {
						epochs[p.ID]++
					}
					sequence++
					changed[p.ID] = caoSnapshot{Screen: s, Seq: sequence, Epoch: epochs[p.ID]}
					last[p.ID] = s
				}
			}
			if len(changed) > 0 {
				activeUntil = time.Now().Add(1200 * time.Millisecond)
			}
			interval := 400 * time.Millisecond
			if time.Now().Before(activeUntil) {
				interval = 80 * time.Millisecond
			}
			ticker.Reset(interval)
			if len(changed) > 0 {
				return send(outScreens{Type: "screens", Version: 2, Panes: changed})
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
				case "input", "paste", "key", "mouse", "focus", "fit", "resize":
					if !found {
						return
					}
				default:
					return
				}
				switch msg.Type {
				case "focus", "fit":
					continue // client focus only; never auto-mutate shared layout
				case "resize":
					if msg.Release {
						sizing.release(t, owner)
						_ = send(outSizing{Type: "sizing", State: "released", Seq: msg.SeqResize})
						continue
					}
					state := sizing.apply(t, owner, msg.Takeover && !msg.Auto, time.Now(), func() string {
						if _, err := caoPanes(ctx, tx, t); err != nil {
							return "target_changed"
						}
						if msg.Auto && !caoSinglePane(ctx, tx, t) {
							return "shared_window"
						}
						return ""
					}, func() error {
						// A dimensionless automatic request renews an owned claim;
						// it never reapplies old geometry on a heartbeat.
						if msg.Auto && msg.Cols == 0 && msg.Rows == 0 {
							return nil
						}
						return caoResize(ctx, tx, t, msg.Cols, msg.Rows)
					})
					if send(outSizing{Type: "sizing", State: state, Seq: msg.SeqResize}) != nil {
						return
					}
					if state == "owned" && msg.Cols != 0 && refresh() != nil {
						return
					}
					continue
				case "input", "paste":
					if msg.Type == "paste" {
						meta, err := tx.ScreenMeta(ctx, msg.Pane)
						unsafe := strings.ContainsAny(msg.Text, "\r\n\t")
						if err != nil || (unsafe && !meta.BracketPaste) || strings.ContainsFunc(msg.Text, func(r rune) bool { return (r < 32 && r != '\n' && r != '\t') || r == 127 }) {
							_ = send(outInputError{Type: "input_error", Nonce: msg.Nonce, Message: "Paste blocked: unsupported control data or target paste mode; use the composer"})
							continue
						}
					}
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
					if msg.Type == "paste" {
						e = tx.PasteLiteral(ctx, msg.Pane, msg.Text, "cao_web_"+hex.EncodeToString(random[:]))
					} else {
						e = tx.SendTextWithBuf(ctx, msg.Pane, msg.Text, "cao_web_"+hex.EncodeToString(random[:]))
						if e == nil {
							e = tx.SendEnter(ctx, msg.Pane)
						}
					}
					requestCapture()
					if e != nil {
						_ = send(outInputError{Type: "input_error", Nonce: msg.Nonce, Message: "Delivery uncertain; inspect output before retrying"})
					} else {
						_ = send(outInputOK{Type: "input_ok", Nonce: msg.Nonce})
					}
				case "key":
					key, ok := caoKeySpec(msg.Key, msg.Modifiers)
					if !ok {
						_ = send(newInputError("Unsupported key"))
						continue
					}
					requestCapture()
					if len([]rune(key)) == 1 {
						_ = tx.SendText(ctx, msg.Pane, key)
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
	return fmt.Sprintf("cao-terminal/%s", "195ad23136c500b10fc88ba50397a25fa7b8c4d9-grid-v2")
}
