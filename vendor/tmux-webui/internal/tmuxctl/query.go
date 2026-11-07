package tmuxctl

import (
	"context"
	"strconv"
	"strings"
)

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func (c *Client) ListSessions(ctx context.Context) ([]Session, error) {
	out, ok := c.RunOK(ctx, "list-sessions", "-F",
		"#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}")
	if !ok {
		return nil, nil
	}
	return parseSessions(out), nil
}

func parseSessions(out string) []Session {
	var sessions []Session
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 3 {
			continue
		}
		sessions = append(sessions, Session{
			Name:     parts[0],
			Windows:  atoi(parts[1]),
			Attached: atoi(parts[2]),
		})
	}
	return sessions
}

// PaneTTYs returns the pane_tty ("/dev/ttys000" form) of every pane across all
// sessions, for the Monitor's presence overlay to exclude processes a tmux pane
// already owns. Best-effort: an empty server or a failed query yields nil.
func (c *Client) PaneTTYs(ctx context.Context) []string {
	out, ok := c.RunOK(ctx, "list-panes", "-a", "-F", "#{pane_tty}")
	if !ok {
		return nil
	}
	return parsePaneTTYs(out)
}

func parsePaneTTYs(out string) []string {
	var ttys []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			ttys = append(ttys, line)
		}
	}
	return ttys
}

func (c *Client) ListWindows(ctx context.Context, session string) ([]Window, error) {
	out, ok := c.RunOK(ctx, "list-windows", "-t", session, "-F",
		"#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}")
	if !ok {
		return nil, nil
	}
	return parseWindows(out), nil
}

func parseWindows(out string) []Window {
	var windows []Window
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 4 {
			continue
		}
		windows = append(windows, Window{
			Index:  atoi(parts[0]),
			Name:   parts[1],
			Active: atoi(parts[2]),
			Panes:  atoi(parts[3]),
		})
	}
	return windows
}

func (c *Client) ListPanes(ctx context.Context, session string) ([]Pane, error) {
	out, ok := c.RunOK(ctx, "list-panes", "-s", "-t", session, "-F",
		"#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_active}"+
			"\t#{pane_width}\t#{pane_height}\t#{mouse_any_flag}\t#{pane_current_command}\t#{pane_title}")
	if !ok {
		return nil, nil
	}
	return parsePanes(out), nil
}

func parsePanes(out string) []Pane {
	var panes []Pane
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 8 {
			continue
		}
		title := ""
		if len(parts) > 8 {
			title = parts[8]
		}
		win, p := parts[0], parts[2]
		panes = append(panes, Pane{
			Window:     atoi(win),
			WindowName: parts[1],
			Pane:       atoi(p),
			Active:     atoi(parts[3]),
			Width:      atoi(parts[4]),
			Height:     atoi(parts[5]),
			MouseMode:  atoi(parts[6]),
			Command:    parts[7],
			Title:      title,
			ID:         win + "." + p,
		})
	}
	return panes
}
