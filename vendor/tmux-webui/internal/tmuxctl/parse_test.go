package tmuxctl

import (
	"reflect"
	"testing"
)

func TestParseSessions(t *testing.T) {
	out := "main\t3\t1\t1715000000\nbg\t1\t0\t1715000100\n"
	got := parseSessions(out)
	want := []Session{
		{Name: "main", Windows: 3, Attached: 1},
		{Name: "bg", Windows: 1, Attached: 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseSessions:\n got=%+v\nwant=%+v", got, want)
	}
}

func TestParseSessionsEmpty(t *testing.T) {
	if got := parseSessions(""); got != nil {
		t.Fatalf("expected nil for empty input, got %+v", got)
	}
}

func TestParseWindows(t *testing.T) {
	out := "0\teditor\t1\t2\n1\tlogs\t0\t1\n"
	got := parseWindows(out)
	want := []Window{
		{Index: 0, Name: "editor", Active: 1, Panes: 2},
		{Index: 1, Name: "logs", Active: 0, Panes: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseWindows:\n got=%+v\nwant=%+v", got, want)
	}
}

func TestParsePanes(t *testing.T) {
	// Columns: window winname pane active width height MOUSE command title.
	// mouse_any_flag = 1 for the nvim pane (mouse tracking on), 0 for zsh.
	out := "0\teditor\t0\t1\t120\t40\t1\tnvim\tmain.go\n0\teditor\t1\t0\t60\t40\t0\tzsh\t\n"
	got := parsePanes(out)
	want := []Pane{
		{Window: 0, WindowName: "editor", Pane: 0, Active: 1, Width: 120, Height: 40, MouseMode: 1, Command: "nvim", Title: "main.go", ID: "0.0"},
		{Window: 0, WindowName: "editor", Pane: 1, Active: 0, Width: 60, Height: 40, MouseMode: 0, Command: "zsh", Title: "", ID: "0.1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsePanes:\n got=%+v\nwant=%+v", got, want)
	}
}

// Older tmux versions sometimes omit the trailing pane_title field when the
// title is empty, leaving only 8 tab-separated columns (through command). The
// parse guards with len(parts) > 8 for the optional title; mirror that.
func TestParsePanesMissingTitle(t *testing.T) {
	out := "0\teditor\t0\t1\t120\t40\t0\tzsh"
	got := parsePanes(out)
	if len(got) != 1 {
		t.Fatalf("expected 1 pane, got %+v", got)
	}
	if got[0].Title != "" {
		t.Errorf("expected empty title, got %q", got[0].Title)
	}
	if got[0].ID != "0.0" {
		t.Errorf("expected ID=0.0, got %q", got[0].ID)
	}
}

func TestParsePaneTTYs(t *testing.T) {
	out := "/dev/ttys000\n/dev/ttys008\n\n  /dev/ttys010  \n"
	got := parsePaneTTYs(out)
	want := []string{"/dev/ttys000", "/dev/ttys008", "/dev/ttys010"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsePaneTTYs:\n got=%+v\nwant=%+v", got, want)
	}
	if got := parsePaneTTYs("   "); got != nil {
		t.Fatalf("parsePaneTTYs(blank) = %+v, want nil", got)
	}
}

func TestDirectionFlag(t *testing.T) {
	cases := map[string]string{"left": "-L", "right": "-R", "up": "-U", "down": "-D"}
	for k, v := range cases {
		got, ok := directionFlag(k)
		if !ok || got != v {
			t.Errorf("directionFlag(%q) = (%q, %v); want (%q, true)", k, got, ok, v)
		}
	}
	if _, ok := directionFlag("forward"); ok {
		t.Errorf("directionFlag(\"forward\") unexpectedly succeeded")
	}
}
