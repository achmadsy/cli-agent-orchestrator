package ws

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

func TestShouldNotify(t *testing.T) {
	base := time.Unix(1000, 0)
	cd := 60 * time.Second
	cases := []struct {
		name          string
		prev, cur     string
		lastPush, now time.Time
		want          bool
	}{
		{"edge into waiting, no prior push", "working", "waiting", time.Time{}, base, true},
		{"already waiting (no edge)", "waiting", "waiting", time.Time{}, base, false},
		{"leaving waiting", "waiting", "idle", time.Time{}, base, false},
		{"never waiting", "working", "idle", time.Time{}, base, false},
		{"unknown -> waiting fires", "unknown", "waiting", time.Time{}, base, true},
		{"re-entry within cooldown suppressed", "idle", "waiting", base, base.Add(30 * time.Second), false},
		{"re-entry after cooldown fires", "idle", "waiting", base, base.Add(61 * time.Second), true},
		{"re-entry exactly at cooldown fires", "idle", "waiting", base, base.Add(60 * time.Second), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := shouldNotify(c.prev, c.cur, c.lastPush, c.now, cd); got != c.want {
				t.Fatalf("shouldNotify(%q,%q,...) = %v, want %v", c.prev, c.cur, got, c.want)
			}
		})
	}
}

func TestLastNonEmptyLine(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"   \n  \n", ""},
		{"first\nsecond\n", "second"},
		{"only line", "only line"},
		{"a\nb\n\n\n", "b"},
		{"  padded  ", "padded"},
	}
	for _, c := range cases {
		if got := lastNonEmptyLine(c.in); got != c.want {
			t.Fatalf("lastNonEmptyLine(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// Rune cap: 200 CJK chars -> 120 runes + ellipsis, not a byte cut (no mojibake).
	long := ""
	for i := 0; i < 200; i++ {
		long += "字"
	}
	got := lastNonEmptyLine(long)
	if r := []rune(got); len(r) != 121 || r[120] != '…' {
		t.Fatalf("cap failed: got %d runes, last=%q", len(r), string(r[len(r)-1]))
	}
}

// TestMonitorDefaults adapts the former TestNotifierDefaults to the Monitor
// rename. The Monitor's default scan interval is 3s (Phase 0), cooldown 60s.
func TestMonitorDefaults(t *testing.T) {
	m := NewMonitor(config.NotifyConfig{}, nil)
	if m.interval() != 3*time.Second {
		t.Fatalf("default interval = %v, want 3s", m.interval())
	}
	if m.cooldown() != 60*time.Second {
		t.Fatalf("default cooldown = %v, want 60s", m.cooldown())
	}
	m2 := NewMonitor(config.NotifyConfig{Interval: 2, Cooldown: 10}, nil)
	if m2.interval() != 2*time.Second || m2.cooldown() != 10*time.Second {
		t.Fatalf("override failed: interval=%v cooldown=%v", m2.interval(), m2.cooldown())
	}
}

// TestMonitorPost adapts the former TestNotifierPost to the Monitor rename: the
// generic webhook POST still carries the configured headers and a JSON body.
func TestMonitorPost(t *testing.T) {
	var gotCT, gotAuth, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT = r.Header.Get("Content-Type")
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	m := NewMonitor(config.NotifyConfig{
		WebhookURL:     srv.URL,
		WebhookHeaders: map[string]string{"Authorization": "Bearer tok123"},
	}, nil)
	m.post(context.Background(), map[string]any{"title": "hi", "tag": "t1"})

	if gotCT != "application/json" {
		t.Fatalf("content-type = %q", gotCT)
	}
	if gotAuth != "Bearer tok123" {
		t.Fatalf("auth header = %q, want the configured value", gotAuth)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(gotBody), &decoded); err != nil {
		t.Fatalf("body not valid JSON: %v (%q)", err, gotBody)
	}
	if decoded["title"] != "hi" || decoded["tag"] != "t1" {
		t.Fatalf("payload round-trip mismatch: %v", decoded)
	}
}

// A non-2xx response must not panic or block — best-effort delivery.
func TestMonitorPostNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	m := NewMonitor(config.NotifyConfig{WebhookURL: srv.URL}, nil)
	m.post(context.Background(), map[string]any{"title": "x"}) // must return cleanly
}

// TestParseContextLine is the I5 hard gate: the pure status-line parser must
// tolerate the real line, legacy/partial forms, k/M suffixes, and junk without
// panicking or fabricating a value.
func TestParseContextLine(t *testing.T) {
	const eps = 0.001
	cases := []struct {
		name          string
		in            string
		wantPct       float64
		wantUsed      int
		wantMax       int
		wantOK        bool
		derivePctFrom bool // pct derived from tokens: compare used/max*100
	}{
		{"real line", "context: 12.3% (32.1k/262.1k)", 12.3, 32100, 262100, true, false},
		{"percentage only (legacy)", "Context left until auto-compact: 45%", 45, 0, 0, true, false},
		{"tokens only → derive pct", "context 100000/200000", 50, 100000, 200000, true, false},
		{"M suffix", "context: 5% (1.5M/2M)", 5, 1500000, 2000000, true, false},
		{"uppercase K", "Context: 8% (10K/262K)", 8, 10000, 262000, true, false},
		{"multiline picks the context line", "some output\nblah 99%\ncontext: 3.5% (9k/262k)\ntrailing", 3.5, 9000, 262000, true, false},
		{"earlier percent in same line ignored", "loading 88% … context: 7% (1k/2k)", 7, 1000, 2000, true, false},
		{"no context line", "just some pane output\n❯ ready", 0, 0, 0, false, false},
		{"empty", "", 0, 0, 0, false, false},
		{"context word but no numbers", "context is unclear here", 0, 0, 0, false, false},
		{"zero percent no tokens is treated as absent", "context: 0%", 0, 0, 0, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pct, used, max, ok := parseContextLine(c.in)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v (pct=%v used=%d max=%d)", ok, c.wantOK, pct, used, max)
			}
			if !c.wantOK {
				if pct != 0 || used != 0 || max != 0 {
					t.Fatalf("absent line must return zeros, got pct=%v used=%d max=%d", pct, used, max)
				}
				return
			}
			if used != c.wantUsed || max != c.wantMax {
				t.Fatalf("tokens = %d/%d, want %d/%d", used, max, c.wantUsed, c.wantMax)
			}
			if diff := pct - c.wantPct; diff > eps || diff < -eps {
				t.Fatalf("pct = %v, want %v", pct, c.wantPct)
			}
		})
	}
}

// fakeMonTmux injects a fixed session/pane/capture set so the snapshot and
// state-transition logic are testable without a live tmux server.
type fakeMonTmux struct {
	sessions []tmuxctl.Session
	panes    map[string][]tmuxctl.Pane
	captures map[string]string // target ("session:paneID") -> screen content
}

func (f *fakeMonTmux) ListSessions(ctx context.Context) ([]tmuxctl.Session, error) {
	return f.sessions, nil
}
func (f *fakeMonTmux) ListPanes(ctx context.Context, session string) ([]tmuxctl.Pane, error) {
	return f.panes[session], nil
}
func (f *fakeMonTmux) CapturePane(ctx context.Context, target string, lines int) (string, error) {
	return f.captures[target], nil
}

// waitingScreen is a claude permission prompt that classifies as "waiting".
const waitingScreen = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n"

// TestMonitorSnapshotShape verifies the snapshot holds exactly the agent pane
// (with correct coordinates, tool, state, tailPreview, a plausible sinceUnix)
// and that a plain shell pane never appears as an agent.
func TestMonitorSnapshotShape(t *testing.T) {
	fx := &fakeMonTmux{
		sessions: []tmuxctl.Session{{Name: "zzObsA"}},
		panes: map[string][]tmuxctl.Pane{
			"zzObsA": {
				{Window: 1, WindowName: "agent", Pane: 0, Command: "claude", Title: "", ID: "1.0"},
				{Window: 1, WindowName: "agent", Pane: 1, Command: "zsh", Title: "", ID: "1.1"},
			},
		},
		captures: map[string]string{"zzObsA:1.0": waitingScreen},
	}
	m := NewMonitor(config.NotifyConfig{}, fx)
	now := time.Unix(5000, 0)
	m.scan(context.Background(), now, map[string]*stateDebouncer{}, map[string]string{}, map[string]int64{}, map[string]time.Time{}, map[string]*stateRing{})

	agents, genAt := m.Snapshot()
	if len(agents) != 1 {
		t.Fatalf("snapshot has %d agents, want 1 (plain shell must not appear): %+v", len(agents), agents)
	}
	a := agents[0]
	if a.Session != "zzObsA" || a.Window != 1 || a.WindowName != "agent" || a.Pane != 0 || a.PaneID != "1.0" {
		t.Fatalf("coordinates wrong: %+v", a)
	}
	if a.Tool != "claude" {
		t.Fatalf("tool = %q, want claude", a.Tool)
	}
	if a.State != "waiting" {
		t.Fatalf("state = %q, want waiting", a.State)
	}
	if a.Host != "local" {
		t.Fatalf("host = %q, want local", a.Host)
	}
	if a.TailPreview == "" {
		t.Fatalf("tailPreview empty, want the last non-empty screen line")
	}
	if a.SinceUnix != now.Unix() {
		t.Fatalf("sinceUnix = %d, want %d", a.SinceUnix, now.Unix())
	}
	if genAt != now {
		t.Fatalf("generated_at = %v, want %v", genAt, now)
	}
}

// TestMonitorStateTransitionTimestamp verifies sinceUnix stays put while the
// state is unchanged and resets when the pane enters a new state.
func TestMonitorStateTransitionTimestamp(t *testing.T) {
	fx := &fakeMonTmux{
		sessions: []tmuxctl.Session{{Name: "zzObsB"}},
		panes: map[string][]tmuxctl.Pane{
			"zzObsB": {{Window: 0, WindowName: "w", Pane: 0, Command: "claude", Title: "", ID: "0.0"}},
		},
		captures: map[string]string{"zzObsB:0.0": "esc to interrupt\n"}, // working
	}
	m := NewMonitor(config.NotifyConfig{}, fx)
	debounce := map[string]*stateDebouncer{}
	prev := map[string]string{}
	since := map[string]int64{}
	lastPush := map[string]time.Time{}
	rings := map[string]*stateRing{}

	// t1: enters working.
	m.scan(context.Background(), time.Unix(1000, 0), debounce, prev, since, lastPush, rings)
	if a, _ := m.Snapshot(); a[0].State != "working" || a[0].SinceUnix != 1000 {
		t.Fatalf("t1: state=%q since=%d, want working/1000", a[0].State, a[0].SinceUnix)
	}

	// t2: still working — sinceUnix must NOT advance.
	m.scan(context.Background(), time.Unix(1500, 0), debounce, prev, since, lastPush, rings)
	if a, _ := m.Snapshot(); a[0].State != "working" || a[0].SinceUnix != 1000 {
		t.Fatalf("t2: state=%q since=%d, want working/1000 (unchanged)", a[0].State, a[0].SinceUnix)
	}

	// t3: transition to waiting — sinceUnix resets to the entry time.
	fx.captures["zzObsB:0.0"] = waitingScreen
	m.scan(context.Background(), time.Unix(2000, 0), debounce, prev, since, lastPush, rings)
	a, _ := m.Snapshot()
	if a[0].State != "waiting" || a[0].SinceUnix != 2000 {
		t.Fatalf("t3: state=%q since=%d, want waiting/2000", a[0].State, a[0].SinceUnix)
	}

	// I3: the timeline ring recorded exactly the two real transitions
	// (working@1000 → waiting@2000); the unchanged t2 tick must NOT add an entry.
	want := []StateEvent{{State: "working", AtUnix: 1000}, {State: "waiting", AtUnix: 2000}}
	if !reflect.DeepEqual(a[0].Recent, want) {
		t.Fatalf("t3 recent = %+v, want %+v", a[0].Recent, want)
	}
}

// TestStateRingAppendAndCap is an I3 hard gate: the pure ring appends only real
// transitions (coalescing repeats) and evicts the oldest past its cap.
func TestStateRingAppendAndCap(t *testing.T) {
	r := newStateRing(3)
	if got := r.snapshot(); got != nil {
		t.Fatalf("empty ring snapshot = %+v, want nil", got)
	}
	// A repeat of the trailing state is a no-op (keeps the first entry time).
	r.push("working", 100)
	r.push("working", 150)
	if got := r.snapshot(); len(got) != 1 || got[0] != (StateEvent{"working", 100}) {
		t.Fatalf("after coalesced repeat = %+v, want [{working 100}]", got)
	}
	r.push("waiting", 200)
	r.push("idle", 300)
	// cap=3, all three fit oldest→newest.
	if got := r.snapshot(); !reflect.DeepEqual(got, []StateEvent{{"working", 100}, {"waiting", 200}, {"idle", 300}}) {
		t.Fatalf("at cap = %+v", got)
	}
	// A fourth distinct transition evicts the oldest ({working 100}).
	r.push("working", 400)
	if got := r.snapshot(); !reflect.DeepEqual(got, []StateEvent{{"waiting", 200}, {"idle", 300}, {"working", 400}}) {
		t.Fatalf("after eviction = %+v", got)
	}
	// snapshot is a copy — mutating it must not corrupt the ring.
	snap := r.snapshot()
	snap[0].State = "MUTATED"
	if r.snapshot()[0].State != "waiting" {
		t.Fatalf("snapshot aliased the ring's backing storage")
	}
	// Degenerate cap clamps to 1 (never panics, keeps only the newest).
	one := newStateRing(0)
	one.push("a", 1)
	one.push("b", 2)
	if got := one.snapshot(); !reflect.DeepEqual(got, []StateEvent{{"b", 2}}) {
		t.Fatalf("cap<1 clamp = %+v, want [{b 2}]", got)
	}
}

// TestStateDurations is an I3 hard gate: the pure fold sums seconds per state,
// treats the last transition as open until now, and clamps negative spans.
func TestStateDurations(t *testing.T) {
	if got := stateDurations(nil, 100); len(got) != 0 {
		t.Fatalf("empty fold = %+v, want {}", got)
	}
	ev := []StateEvent{{"working", 100}, {"waiting", 160}, {"idle", 180}}
	// working: 160-100=60, waiting: 180-160=20, idle (open): 250-180=70.
	got := stateDurations(ev, 250)
	if got["working"] != 60 || got["waiting"] != 20 || got["idle"] != 70 {
		t.Fatalf("durations = %+v, want working=60 waiting=20 idle=70", got)
	}
	// Same state re-entered accumulates across segments:
	// working = (10-0) + (20-15) = 15; waiting = 15-10 = 5.
	ev2 := []StateEvent{{"working", 0}, {"waiting", 10}, {"working", 15}}
	got2 := stateDurations(ev2, 20)
	if got2["working"] != 15 || got2["waiting"] != 5 {
		t.Fatalf("re-entry fold = %+v, want working=15 waiting=5", got2)
	}
	// now BEFORE the last entry (clock skew) clamps the open segment to 0, and an
	// out-of-order middle span clamps too — never negative.
	got3 := stateDurations([]StateEvent{{"working", 100}, {"waiting", 90}}, 80)
	if got3["working"] != 0 || got3["waiting"] != 0 {
		t.Fatalf("skew fold = %+v, want all zero", got3)
	}
}
