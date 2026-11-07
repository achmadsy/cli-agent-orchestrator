package ws

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// TestFrameRingCountEviction is an I4 hard gate: the ring evicts the OLDEST
// frame once the count ceiling is exceeded, keeps timestamps intact, and
// preserves oldest→newest order.
func TestFrameRingCountEviction(t *testing.T) {
	r := newFrameRing(3, 1<<20) // count binds, bytes generous
	if got := r.snapshot(); got != nil {
		t.Fatalf("empty ring snapshot = %+v, want nil", got)
	}
	for i := 0; i < 5; i++ {
		r.push(string(rune('a'+i)), int64(100+i)) // "a"@100 ... "e"@104
	}
	got := r.snapshot()
	want := []Frame{
		{Content: "c", AtUnix: 102},
		{Content: "d", AtUnix: 103},
		{Content: "e", AtUnix: 104},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after count eviction = %+v, want %+v", got, want)
	}
	if r.bytes != 3 {
		t.Fatalf("running byte total = %d, want 3", r.bytes)
	}
}

// TestFrameRingByteEviction is the other half of the I4 hard gate: the ring
// evicts the oldest while the BYTE total exceeds its ceiling, independent of the
// (generous) count cap, and its running byte total stays under the ceiling.
func TestFrameRingByteEviction(t *testing.T) {
	r := newFrameRing(1000, 10) // bytes bind, count generous
	r.push("aaaa", 1)           // 4 bytes  -> [aaaa]            (4)
	r.push("bbbb", 2)           // 8 bytes  -> [aaaa bbbb]       (8)
	r.push("cccc", 3)           // 12 > 10  -> evict aaaa        (8)
	got := r.snapshot()
	want := []Frame{{Content: "bbbb", AtUnix: 2}, {Content: "cccc", AtUnix: 3}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("after byte eviction = %+v, want %+v", got, want)
	}
	if r.bytes > r.maxBytes {
		t.Fatalf("running bytes %d exceeds maxBytes %d", r.bytes, r.maxBytes)
	}
}

// TestFrameRingSingleOversizeKept: a lone frame larger than maxBytes is still
// retained — the newest frame is never evicted, so a scrub target always exists.
func TestFrameRingSingleOversizeKept(t *testing.T) {
	r := newFrameRing(1000, 4)
	big := strings.Repeat("x", 100) // > maxBytes
	r.push(big, 7)
	got := r.snapshot()
	if len(got) != 1 || got[0].Content != big || got[0].AtUnix != 7 {
		t.Fatalf("oversize single frame = %+v, want the one big frame retained", got)
	}
	// A second even-bigger frame replaces it (keep newest, drop older).
	big2 := strings.Repeat("y", 200)
	r.push(big2, 8)
	got = r.snapshot()
	if len(got) != 1 || got[0].Content != big2 || got[0].AtUnix != 8 {
		t.Fatalf("after second oversize = %+v, want only the newest big frame", got)
	}
}

// TestRecorderOnChangeAndStop: the recorder pushes a frame only when the content
// CHANGES, and stop() clears the buffer (frees the recording).
func TestRecorderOnChangeAndStop(t *testing.T) {
	rc := newRecorder(0, 0) // defaults
	const key = "zzObsA\x00%3"
	if rc.isRecording(key) {
		t.Fatal("key should not be recording before start")
	}
	// record before start is a no-op.
	rc.record(key, "frame1", 1)
	if _, ok := rc.frames(key); ok {
		t.Fatal("record before start must not create a recording")
	}

	rc.start(key)
	rc.record(key, "frame1", 1)
	rc.record(key, "frame1", 2) // unchanged -> skipped
	rc.record(key, "frame2", 3) // changed   -> retained
	rc.record(key, "frame2", 4) // unchanged -> skipped
	frames, ok := rc.frames(key)
	if !ok {
		t.Fatal("frames() ok=false after start")
	}
	want := []Frame{{Content: "frame1", AtUnix: 1}, {Content: "frame2", AtUnix: 3}}
	if !reflect.DeepEqual(frames, want) {
		t.Fatalf("frames = %+v, want %+v (only real changes retained)", frames, want)
	}

	rc.stop(key)
	if rc.isRecording(key) {
		t.Fatal("key still recording after stop")
	}
	if _, ok := rc.frames(key); ok {
		t.Fatal("stop must clear the buffer (frames ok should be false)")
	}
}

// TestRecorderReap frees recordings for panes no longer present.
func TestRecorderReap(t *testing.T) {
	rc := newRecorder(0, 0)
	rc.start("s\x00%1")
	rc.start("s\x00%2")
	rc.reap(map[string]bool{"s\x00%1": true}) // %2 vanished
	if !rc.isRecording("s\x00%1") {
		t.Fatal("live pane recording was reaped")
	}
	if rc.isRecording("s\x00%2") {
		t.Fatal("vanished pane recording survived reap")
	}
}

// TestMonitorRecordIntegration wires the recorder through the real scan: start
// recording an agent pane, run scans as its screen changes, and assert the
// captured frames reflect the changes (ANSI/content preserved, injected
// timestamps) and that ResolveAgentPane gates on agent panes only.
func TestMonitorRecordIntegration(t *testing.T) {
	fx := &fakeMonTmux{
		sessions: []tmuxctl.Session{{Name: "zzObsR"}},
		panes: map[string][]tmuxctl.Pane{
			"zzObsR": {
				{Window: 0, WindowName: "agent", Pane: 0, Command: "claude", Title: "", ID: "%7"},
				{Window: 0, WindowName: "sh", Pane: 1, Command: "zsh", Title: "", ID: "%8"},
			},
		},
		captures: map[string]string{"zzObsR:%7": "esc to interrupt\n"}, // working
	}
	m := NewMonitor(config.NotifyConfig{}, fx)
	debounce := map[string]*stateDebouncer{}
	prev := map[string]string{}
	since := map[string]int64{}
	lastPush := map[string]time.Time{}
	rings := map[string]*stateRing{}
	scan := func(ts int64) {
		m.scan(context.Background(), time.Unix(ts, 0), debounce, prev, since, lastPush, rings)
	}

	// Prime the snapshot so ResolveAgentPane can see the pane.
	scan(1000)

	// The shell pane is not an agent → recording rejected.
	if _, ok := m.ResolveAgentPane("zzObsR", "1"); ok {
		t.Fatal("shell pane (index 1) resolved as an agent")
	}
	// The agent pane resolves both by pane id and pane index.
	if id, ok := m.ResolveAgentPane("zzObsR", "%7"); !ok || id != "%7" {
		t.Fatalf("agent resolve by id = %q,%v; want %q,true", id, ok, "%7")
	}
	if id, ok := m.ResolveAgentPane("zzObsR", "0"); !ok || id != "%7" {
		t.Fatalf("agent resolve by index = %q,%v; want %q,true", id, ok, "%7")
	}

	// Not recording yet → no frames.
	if _, ok := m.Frames("zzObsR", "%7"); ok {
		t.Fatal("frames present before recording started")
	}

	m.StartRecording("zzObsR", "%7")
	scan(1001) // captures the current "working" screen (frame 1)
	fx.captures["zzObsR:%7"] = "\x1b[32mDone\x1b[0m\n$ "
	scan(1002) // screen changed → frame 2 (ANSI preserved)
	scan(1003) // unchanged → no new frame

	frames, ok := m.Frames("zzObsR", "%7")
	if !ok {
		t.Fatal("frames ok=false while recording")
	}
	if len(frames) != 2 {
		t.Fatalf("captured %d frames, want 2: %+v", len(frames), frames)
	}
	if frames[0].Content != "esc to interrupt\n" || frames[0].AtUnix != 1001 {
		t.Fatalf("frame0 = %+v, want the working screen @1001", frames[0])
	}
	if !strings.Contains(frames[1].Content, "\x1b[32m") || frames[1].AtUnix != 1002 {
		t.Fatalf("frame1 = %+v, want ANSI-preserved changed screen @1002", frames[1])
	}

	m.StopRecording("zzObsR", "%7")
	if _, ok := m.Frames("zzObsR", "%7"); ok {
		t.Fatal("frames survived StopRecording (buffer not cleared)")
	}
}
