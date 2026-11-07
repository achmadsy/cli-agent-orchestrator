package tmuxctl

import "testing"

// TestSGRButtonCode: semantic name → SGR-1006 code; wheel is 64/65; junk fails.
func TestSGRButtonCode(t *testing.T) {
	cases := map[string]struct {
		code int
		ok   bool
	}{
		"left":      {0, true},
		"middle":    {1, true},
		"right":     {2, true},
		"wheelup":   {64, true},
		"wheeldown": {65, true},
		"":          {0, false},
		"scroll":    {0, false},
	}
	for name, want := range cases {
		got, ok := sgrButtonCode(name)
		if got != want.code || ok != want.ok {
			t.Errorf("sgrButtonCode(%q) = (%d,%v), want (%d,%v)", name, got, ok, want.code, want.ok)
		}
	}
}

// TestEncodeSGRMouse: exact escape bytes, press vs release suffix, 1-based
// floor. A real terminal emits precisely these for a mouse report.
func TestEncodeSGRMouse(t *testing.T) {
	cases := []struct {
		code, col, row int
		press          bool
		want           string
	}{
		{0, 19, 4, true, "\x1b[<0;19;4M"},    // left press
		{0, 19, 4, false, "\x1b[<0;19;4m"},   // left release
		{64, 10, 5, true, "\x1b[<64;10;5M"},  // wheel up
		{65, 10, 5, true, "\x1b[<65;10;5M"},  // wheel down
		{0, 0, 0, true, "\x1b[<0;1;1M"},      // floor at 1
		{2, -3, -9, true, "\x1b[<2;1;1M"},    // negative floors too
	}
	for _, c := range cases {
		if got := encodeSGRMouse(c.code, c.col, c.row, c.press); got != c.want {
			t.Errorf("encodeSGRMouse(%d,%d,%d,%v) = %q, want %q", c.code, c.col, c.row, c.press, got, c.want)
		}
	}
}
