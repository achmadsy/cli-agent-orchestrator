package tmuxctl

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// Screen is a bounded active-grid snapshot, never a saved alternate grid.
// Metadata travels with the grid so height/mode changes cannot race browser frames.
type Screen struct {
	Content      string `json:"content"`
	Cols         int    `json:"cols"`
	Rows         int    `json:"rows"`
	CursorX      int    `json:"cursor_x"`
	CursorY      int    `json:"cursor_y"`
	Alternate    bool   `json:"alternate"`
	BracketPaste bool   `json:"bracket_paste"`
	History      int    `json:"history"`
	Boundary     string `json:"boundary"`
	Activity     string `json:"-"`
}

const screenFormat = "#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{alternate_on}\t#{?bracket_paste_flag,1,0}\t#{history_size}\t#{history_bytes}"

func (c *Client) ScreenMeta(ctx context.Context, target string) (Screen, error) {
	raw, err := c.Run(ctx, "display-message", "-t", target, "-p", screenFormat)
	if err != nil {
		return Screen{}, err
	}
	return parseScreenMeta(raw)
}
func parseScreenMeta(raw string) (Screen, error) {
	parts := strings.Split(strings.TrimSuffix(raw, "\n"), "\t")
	if len(parts) != 7 && len(parts) != 8 {
		return Screen{}, fmt.Errorf("invalid screen metadata")
	}
	vals := make([]int, 7)
	for i, p := range parts[:7] {
		n, e := strconv.Atoi(p)
		if e != nil {
			return Screen{}, fmt.Errorf("invalid screen field")
		}
		vals[i] = n
	}
	s := Screen{Cols: vals[0], Rows: vals[1], CursorX: vals[2], CursorY: vals[3], Alternate: vals[4] != 0, BracketPaste: vals[5] != 0, History: vals[6]}
	if s.Cols < 1 || s.Rows < 1 || s.Cols > 1000 || s.Rows > 1000 {
		return Screen{}, fmt.Errorf("screen dimensions out of range")
	}
	if len(parts) == 8 {
		s.Activity = parts[7]
	}
	s.Boundary = fmt.Sprintf("%dx%d:%t:%d:%s", s.Cols, s.Rows, s.Alternate, s.History, s.Activity)
	return s, nil
}
func (c *Client) CaptureScreen(ctx context.Context, target string) (Screen, error) {
	for i := 0; i < 3; i++ {
		// Execute on one tmux command queue to avoid three process round trips.
		// No terminal output is evaluated or interpolated into tmux commands.
		raw, err := c.Run(ctx, "display-message", "-t", target, "-p", screenFormat, ";", "capture-pane", "-t", target, "-p", "-S", "0", "-e", ";", "display-message", "-t", target, "-p", screenFormat)
		if err != nil {
			return Screen{}, err
		}
		first := strings.IndexByte(raw, '\n')
		end := strings.LastIndexByte(strings.TrimSuffix(raw, "\n"), '\n')
		if first < 0 || end <= first {
			return Screen{}, fmt.Errorf("invalid capture envelope")
		}
		before, err := parseScreenMeta(raw[:first])
		if err != nil {
			return Screen{}, err
		}
		after, err := parseScreenMeta(raw[end+1:])
		if err != nil {
			return Screen{}, err
		}
		content := raw[first+1 : end+1]
		if before.Boundary != after.Boundary || before.CursorX != after.CursorX || before.CursorY != after.CursorY || before.BracketPaste != after.BracketPaste {
			continue
		}
		if len(content) > 2<<20 {
			return Screen{}, fmt.Errorf("screen limit")
		}
		// capture-pane appends one record delimiter; retain every real blank row.
		lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
		if len(lines) > after.Rows {
			continue
		}
		for len(lines) < after.Rows {
			lines = append(lines, "")
		}
		after.Content = strings.Join(lines, "\n")
		return after, nil
	}
	return Screen{}, fmt.Errorf("screen changed during capture")
}
