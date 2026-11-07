package ws

// messages_test.go — unit tests for message marshalling, buildKeySpec,
// winIndexFromPaneID, stepUp, and metricsTickEvery.
//
// Mutation-thinking risk list (things likely to break silently):
//  1. outError.Type = "error" vs outInputError.Type = "input_error" — swap regression
//  2. buildKeySpec modifier deduplication — same modifier supplied twice
//  3. buildKeySpec stable ordering: C before M before S
//  4. buildKeySpec unknown modifier is silently dropped (not an error)
//  5. winIndexFromPaneID: empty string, missing ".", non-numeric prefix
//  6. stepUp: hitting the pollMax cap exactly
//  7. metricsTickEvery: zero division guard, exact divisor (ceil(1.0)=1 not 2)
//  8. JSON marshal of every outbound type must not panic and must include "type" field

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/operonlab/tmux-webui/internal/metrics"
)

// ─── outError / outInputError type strings ────────────────────────────────────

func TestNewError_TypeString(t *testing.T) {
	e := newError("something went wrong")
	if e.Type != "error" {
		t.Errorf("newError.Type = %q; want %q", e.Type, "error")
	}
	if e.Message != "something went wrong" {
		t.Errorf("newError.Message = %q; want %q", e.Message, "something went wrong")
	}
}

func TestNewInputError_TypeString(t *testing.T) {
	e := newInputError("bad key")
	if e.Type != "input_error" {
		t.Errorf("newInputError.Type = %q; want %q", e.Type, "input_error")
	}
	if e.Message != "bad key" {
		t.Errorf("newInputError.Message = %q; want %q", e.Message, "bad key")
	}
}

// Regression: error/input_error must NOT be confused.
func TestErrorVsInputError_TypesDiffer(t *testing.T) {
	if newError("x").Type == newInputError("x").Type {
		t.Error("outError and outInputError have the same Type string — they must differ")
	}
}

// ─── JSON marshal of all outbound types ───────────────────────────────────────

func mustMarshal(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal(%T) failed: %v", v, err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("json.Unmarshal back to map failed: %v", err)
	}
	return m
}

func TestMarshal_outError(t *testing.T) {
	m := mustMarshal(t, newError("boom"))
	if m["type"] != "error" {
		t.Errorf("type = %q; want %q", m["type"], "error")
	}
	if m["message"] != "boom" {
		t.Errorf("message = %q; want %q", m["message"], "boom")
	}
}

func TestMarshal_outInputError(t *testing.T) {
	m := mustMarshal(t, newInputError("bad"))
	if m["type"] != "input_error" {
		t.Errorf("type = %q; want %q", m["type"], "input_error")
	}
}

func TestMarshal_outPing(t *testing.T) {
	m := mustMarshal(t, outPing{Type: "ping", Ts: 1234567890})
	if m["type"] != "ping" {
		t.Errorf("type = %q; want %q", m["type"], "ping")
	}
	if int64(m["ts"].(float64)) != 1234567890 {
		t.Errorf("ts = %v; want 1234567890", m["ts"])
	}
}

func TestMarshal_outPrefixActive(t *testing.T) {
	m := mustMarshal(t, outPrefixActive{Type: "prefix_active"})
	if m["type"] != "prefix_active" {
		t.Errorf("type = %q; want %q", m["type"], "prefix_active")
	}
}

func TestMarshal_outTTS(t *testing.T) {
	m := mustMarshal(t, outTTS{Type: "tts", ID: "abc", Text: "hello"})
	if m["type"] != "tts" {
		t.Errorf("type = %q; want %q", m["type"], "tts")
	}
	if m["id"] != "abc" {
		t.Errorf("id = %q; want %q", m["id"], "abc")
	}
}

func TestMarshal_outAutocomplete(t *testing.T) {
	m := mustMarshal(t, outAutocomplete{Type: "autocomplete", Results: []string{"a", "b"}})
	if m["type"] != "autocomplete" {
		t.Errorf("type = %q; want %q", m["type"], "autocomplete")
	}
}

func TestMarshal_outMetrics_EmptySnapshot(t *testing.T) {
	m := mustMarshal(t, outMetrics{Type: "metrics", Metrics: metrics.Snapshot{}})
	if m["type"] != "metrics" {
		t.Errorf("type = %q; want %q", m["type"], "metrics")
	}
}

// ─── InboundMsg round-trip ─────────────────────────────────────────────────────

func TestInboundMsg_UnmarshalRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		json string
		want InboundMsg
	}{
		{
			name: "key with modifiers",
			json: `{"type":"key","pane":"0.0","key":"x","modifiers":["Ctrl","Shift"]}`,
			want: InboundMsg{Type: "key", Pane: "0.0", Key: "x", Modifiers: []string{"Ctrl", "Shift"}},
		},
		{
			name: "fit message",
			json: `{"type":"fit","pane":"0.1","cols":80,"rows":24}`,
			want: InboundMsg{Type: "fit", Pane: "0.1", Cols: 80, Rows: 24},
		},
		{
			name: "pong",
			json: `{"type":"pong","ts":1234567890123}`,
			want: InboundMsg{Type: "pong", Ts: 1234567890123},
		},
		{
			name: "switch_window",
			json: `{"type":"switch_window","window":3}`,
			want: InboundMsg{Type: "switch_window", Window: 3},
		},
		{
			name: "autocomplete query",
			json: `{"type":"autocomplete","query":"/mem"}`,
			want: InboundMsg{Type: "autocomplete", Query: "/mem"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got InboundMsg
			if err := json.Unmarshal([]byte(tc.json), &got); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if got.Type != tc.want.Type {
				t.Errorf("Type: got %q; want %q", got.Type, tc.want.Type)
			}
			if got.Pane != tc.want.Pane {
				t.Errorf("Pane: got %q; want %q", got.Pane, tc.want.Pane)
			}
			if got.Cols != tc.want.Cols {
				t.Errorf("Cols: got %d; want %d", got.Cols, tc.want.Cols)
			}
			if got.Rows != tc.want.Rows {
				t.Errorf("Rows: got %d; want %d", got.Rows, tc.want.Rows)
			}
			if got.Ts != tc.want.Ts {
				t.Errorf("Ts: got %d; want %d", got.Ts, tc.want.Ts)
			}
			if got.Window != tc.want.Window {
				t.Errorf("Window: got %d; want %d", got.Window, tc.want.Window)
			}
			if got.Query != tc.want.Query {
				t.Errorf("Query: got %q; want %q", got.Query, tc.want.Query)
			}
		})
	}
}

// ─── buildKeySpec ─────────────────────────────────────────────────────────────

func TestBuildKeySpec(t *testing.T) {
	cases := []struct {
		name      string
		key       string
		modifiers []string
		want      string
	}{
		{"no modifiers", "x", nil, "x"},
		{"empty modifiers", "Enter", []string{}, "Enter"},
		{"ctrl only", "c", []string{"Ctrl"}, "C-c"},
		{"alt alias M", "b", []string{"M"}, "M-b"},
		{"shift only", "a", []string{"Shift"}, "S-a"},
		{"ctrl+alt stable order", "x", []string{"Alt", "Ctrl"}, "C-M-x"},
		{"ctrl+shift stable order", "a", []string{"Shift", "Ctrl"}, "C-S-a"},
		{"all three stable order", "x", []string{"Shift", "Alt", "Ctrl"}, "C-M-S-x"},
		// Mutation-thinking: duplicate modifiers must not produce double prefix
		{"duplicate ctrl", "x", []string{"Ctrl", "Ctrl"}, "C-x"},
		// Unknown modifiers are silently dropped
		{"unknown modifier", "x", []string{"Meta", "Ctrl"}, "C-x"},
		// Case-insensitive matching
		{"ctrl lowercase", "x", []string{"ctrl"}, "C-x"},
		{"CTRL uppercase", "x", []string{"CTRL"}, "C-x"},
		// C alias
		{"C alias for ctrl", "x", []string{"C"}, "C-x"},
		{"S alias for shift", "x", []string{"S"}, "S-x"},
		// Special keys unchanged
		{"up arrow no mod", "Up", nil, "Up"},
		{"F1 no mod", "F1", nil, "F1"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildKeySpec(tc.key, tc.modifiers)
			if got != tc.want {
				t.Errorf("buildKeySpec(%q, %v) = %q; want %q", tc.key, tc.modifiers, got, tc.want)
			}
		})
	}
}

// ─── winIndexFromPaneID ───────────────────────────────────────────────────────

func TestWinIndexFromPaneID(t *testing.T) {
	cases := []struct {
		pane string
		want int
	}{
		{"0.0", 0},
		{"0.1", 0},
		{"1.0", 1},
		{"2.3", 2},
		{"10.5", 10},
		// Fallback cases:
		{"", 0},    // empty string
		{"abc", 0}, // no dot, non-numeric
		{".1", 0},  // empty window part
		{"a.1", 0}, // non-numeric window part
		{"0", 0},   // no dot — parts[0] is "0", valid
	}

	for _, tc := range cases {
		t.Run(tc.pane, func(t *testing.T) {
			got := winIndexFromPaneID(tc.pane)
			if got != tc.want {
				t.Errorf("winIndexFromPaneID(%q) = %d; want %d", tc.pane, got, tc.want)
			}
		})
	}
}

// ─── stepUp ───────────────────────────────────────────────────────────────────

func TestStepUp(t *testing.T) {
	cases := []struct {
		name  string
		input time.Duration
		want  time.Duration
	}{
		{"min → min+step", pollMin, pollMin + pollStep},
		{"below max, steps up", pollMin + pollStep, pollMin + 2*pollStep},
		{"at max, stays", pollMax, pollMax},
		{"above max is capped", pollMax + pollStep, pollMax},
		// Mutation: step from pollMax-pollStep should land exactly at pollMax, not exceed
		{"one step below max", pollMax - pollStep, pollMax},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := defaultPollLadder.stepUp(tc.input)
			if got != tc.want {
				t.Errorf("stepUp(%v) = %v; want %v", tc.input, got, tc.want)
			}
		})
	}
}

// TestNewPollLadder pins the config → ladder derivation: a zero interval
// preserves the const defaults exactly, and the default 0.4s reproduces today's
// 0.4/0.4/2.0 ladder (min=step=interval, max=5*min).
func TestNewPollLadder(t *testing.T) {
	zero := newPollLadder(0)
	if zero != defaultPollLadder {
		t.Errorf("newPollLadder(0) = %+v; want defaults %+v", zero, defaultPollLadder)
	}
	def := newPollLadder(0.4)
	if def.min != 400*time.Millisecond || def.step != 400*time.Millisecond || def.max != 2000*time.Millisecond {
		t.Errorf("newPollLadder(0.4) = %+v; want 0.4/0.4/2.0s ladder", def)
	}
	// A custom interval scales the whole ladder (min=step, max=5*min).
	cust := newPollLadder(1.0)
	if cust.min != time.Second || cust.step != time.Second || cust.max != 5*time.Second {
		t.Errorf("newPollLadder(1.0) = %+v; want 1/1/5s ladder", cust)
	}
}

// ─── metricsTickEvery ─────────────────────────────────────────────────────────

func TestMetricsTickEvery(t *testing.T) {
	cases := []struct {
		name            string
		metricsInterval float64
		pollInterval    float64
		want            int
	}{
		// Basic: 5s metrics / 0.4s poll = ceil(12.5) = 13
		{"standard", 5.0, 0.4, 13},
		// Exact divisor: ceil(1.0) = 1, not 2
		{"exact divisor", 2.0, 2.0, 1},
		// metricsInterval < pollInterval: ceil(0.5) = 1 (minimum 1)
		{"metrics shorter than poll", 0.2, 0.4, 1},
		// Zero poll guard → returns 1
		{"zero poll", 5.0, 0.0, 1},
		// Negative poll guard → returns 1
		{"negative poll", 5.0, -1.0, 1},
		// metrics = 0: ceil(0) = 0 but minimum 1
		{"zero metrics", 0.0, 0.4, 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := metricsTickEvery(tc.metricsInterval, tc.pollInterval)
			if got != tc.want {
				t.Errorf("metricsTickEvery(%v, %v) = %d; want %d",
					tc.metricsInterval, tc.pollInterval, got, tc.want)
			}
		})
	}
}

// ─── itoa ─────────────────────────────────────────────────────────────────────

func TestItoa(t *testing.T) {
	cases := []struct {
		n    int
		want string
	}{
		{0, "0"},
		{1, "1"},
		{10, "10"},
		{100, "100"},
		{-1, "-1"},
		{-42, "-42"},
		{999, "999"},
	}
	for _, tc := range cases {
		got := itoa(tc.n)
		if got != tc.want {
			t.Errorf("itoa(%d) = %q; want %q", tc.n, got, tc.want)
		}
	}
}
