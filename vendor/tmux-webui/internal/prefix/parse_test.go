package prefix

import (
	"reflect"
	"testing"
)

// Sample output from `tmux list-keys -T prefix` on tmux 3.4.
// Whitespace is intentionally ragged — tmux pads columns differently across
// versions and platforms (Homebrew, OpenBSD, Alpine).
const sample34 = `bind-key    -T prefix C-b           send-prefix
bind-key    -T prefix C-o           rotate-window
bind-key    -T prefix C-z           suspend-client
bind-key    -T prefix Space         next-layout
bind-key    -T prefix !             break-pane
bind-key    -T prefix "             split-window
bind-key    -T prefix #             list-buffers
bind-key    -T prefix %             split-window -h
bind-key    -T prefix c             new-window
bind-key    -T prefix d             detach-client
bind-key    -T prefix x             confirm-before -p "kill-pane #P? (y/n)" kill-pane
bind-key -r -T prefix Up            select-pane -U
bind-key -r -T prefix Down          select-pane -D
bind-key -r -T prefix Left          select-pane -L
bind-key -r -T prefix Right         select-pane -R
`

func TestParseBindings_tmux34(t *testing.T) {
	got := parseBindings(sample34)
	checks := map[string]string{
		"C-b":   "send-prefix",
		"c":     "new-window",
		"%":     "split-window -h",
		"x":     `confirm-before -p "kill-pane #P? (y/n)" kill-pane`,
		"Up":    "select-pane -U",
		"Right": "select-pane -R",
		"!":     "break-pane",
	}
	for key, want := range checks {
		if got[key] != want {
			t.Errorf("binding[%q] = %q; want %q", key, got[key], want)
		}
	}
	if len(got) != 15 {
		t.Errorf("expected 15 bindings, got %d", len(got))
	}
}

func TestParseBindings_emptyAndGarbage(t *testing.T) {
	if got := parseBindings(""); len(got) != 0 {
		t.Errorf("expected empty map, got %+v", got)
	}
	garbage := "this is not a tmux line\nbind-key without -T prefix Foo Bar\n"
	got := parseBindings(garbage)
	if len(got) != 0 {
		t.Errorf("expected zero bindings from non-prefix lines, got %+v", got)
	}
}

func TestParseBindings_repeatFlag(t *testing.T) {
	out := `bind-key -r -T prefix Up   select-pane -U
bind-key    -T prefix C-a  send-prefix
`
	want := map[string]string{
		"Up":  "select-pane -U",
		"C-a": "send-prefix",
	}
	got := parseBindings(out)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseBindings: got=%+v want=%+v", got, want)
	}
}
