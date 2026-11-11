package tmuxctl

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScreenMeta(t *testing.T) {
	s, e := parseScreenMeta("80\t24\t2\t3\t1\t0\t400\n")
	if e != nil || s.Rows != 24 || !s.Alternate || s.BracketPaste {
		t.Fatalf("%+v %v", s, e)
	}
	for _, raw := range []string{"bad", "0\t24\t0\t0\t0\t0\t0", "80\t24\tx\t0\t0\t0\t0"} {
		if _, e := parseScreenMeta(raw); e == nil {
			t.Fatal("accepted invalid metadata")
		}
	}
}
func TestScreenCapturePreservesBlankRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tmux")
	script := "#!/bin/sh\nprintf '80\\t4\\t2\\t0\\t0\\t0\\t500\\nPROMPT\\n\\n\\n\\n80\\t4\\t2\\t0\\t0\\t0\\t500\\n'\n"
	if e := os.WriteFile(path, []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	s, e := New(WithBinary(path)).CaptureScreen(context.Background(), "%1")
	if e != nil || s.Content != "PROMPT\n\n\n" || len(strings.Split(s.Content, "\n")) != 4 {
		t.Fatalf("%+v %v", s, e)
	}
}
func TestScreenCaptureRejectsGeometryRace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tmux")
	script := "#!/bin/sh\nprintf '80\\t4\\t2\\t0\\t0\\t0\\t500\\nPROMPT\\n80\\t6\\t2\\t0\\t0\\t0\\t500\\n'\n"
	os.WriteFile(path, []byte(script), 0700)
	if _, e := New(WithBinary(path)).CaptureScreen(context.Background(), "%1"); e == nil {
		t.Fatal("published mismatched grid")
	}
}
