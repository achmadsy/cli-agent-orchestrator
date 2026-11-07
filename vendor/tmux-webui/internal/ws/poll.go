package ws

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// ─── Pane-state detection ──────────────────────────────────────────────────────
// The classifier lives in agentstate.go (classifyPane + stateDebouncer) with
// region extraction in regions.go — OSC-title signal, transcript freeze,
// blocked/idle region rules, per-pane debouncing. The frontend deck-detect.js
// keeps a text-only approximation for the focused-pane strip; the backend is
// authoritative for the pane_states lamps (it alone sees #{pane_title}).
//
// The polling ITSELF (adaptive ticker, capture/diff, pane_states tick, metrics
// cadence) lives in poller.go — one sessionPoller goroutine per tmux session,
// shared by every Conn subscribed to that session (P1). This file holds only the
// pure helpers those loops call. The capture/diff cost that used to be paid once
// per Conn is now paid once per session; two tabs on one session no longer double
// the subprocess load.

// Adaptive backoff DEFAULTS, used when config.PollInterval is zero. The live
// ladder is derived per session poller from config (newPollLadder); these
// consts stay the fallback and the reference the ladder tests pin against.
const (
	pollMin  = 400 * time.Millisecond
	pollMax  = 2000 * time.Millisecond
	pollStep = 400 * time.Millisecond
)

// pollLadder holds one poller's adaptive interval parameters: min is the floor
// (reset target on any change/wake), step the per-quiet-tick increment, max the
// ceiling.
type pollLadder struct {
	min  time.Duration
	max  time.Duration
	step time.Duration
}

// defaultPollLadder reproduces the historical 0.4→2.0s ladder (const defaults).
var defaultPollLadder = pollLadder{min: pollMin, max: pollMax, step: pollStep}

// newPollLadder derives the ladder from config.PollInterval (seconds). Zero or
// negative preserves the const defaults exactly; otherwise min=step=interval
// and max=5*min, so the default 0.4s reproduces today's 0.4/0.4/2.0 ladder.
func newPollLadder(pollInterval float64) pollLadder {
	if pollInterval <= 0 {
		return defaultPollLadder
	}
	min := time.Duration(pollInterval * float64(time.Second))
	return pollLadder{min: min, max: 5 * min, step: min}
}

// reBrailleSpinner: agents rotate a braille glyph in their OSC title every
// ~100ms while working. Left in the signature it would drift every poll tick
// and spam panes frames; the client's tool detection only reads the title's
// words, so the spinner is noise.
var reBrailleSpinner = regexp.MustCompile(`[\x{2800}-\x{28FF}]`)

// paneListSig fingerprints the visible pane list identity: id, window,
// window name, foreground command, and OSC title (spinner-normalized).
// Geometry is deliberately excluded — resizes already flow through output
// frames and must not respawn pane headers.
func paneListSig(panes []tmuxctl.Pane, activeWin int) string {
	var b strings.Builder
	for _, p := range visiblePanes(panes, activeWin) {
		title := reBrailleSpinner.ReplaceAllString(p.Title, "")
		// MouseMode in the sig so a program toggling mouse tracking (e.g. yazi
		// launching in place) pushes a fresh panes frame → the client learns the
		// pane is injectable without a window switch. Width/Height too, so after a
		// fit resize the client's paneInfo updates — the geometric fit reads
		// info.width and would otherwise mis-converge from a stale size.
		fmt.Fprintf(&b, "%s|%d|%s|%s|%d|%dx%d|%s;", p.ID, p.Window, p.WindowName, p.Command, p.MouseMode, p.Width, p.Height, title)
	}
	return b.String()
}

// stepUp advances interval by one step, capped at the ladder's max.
func (l pollLadder) stepUp(d time.Duration) time.Duration {
	next := d + l.step
	if next > l.max {
		return l.max
	}
	return next
}

// metricsTickEvery computes ⌈metricsInterval / pollInterval⌉ (minimum 1).
func metricsTickEvery(metricsInterval, pollInterval float64) int {
	if pollInterval <= 0 {
		return 1
	}
	n := int(math.Ceil(metricsInterval / pollInterval))
	if n < 1 {
		n = 1
	}
	return n
}

// mergeState returns the higher-priority of two pane states when aggregating
// the panes of one window. Priority: waiting > working > idle > unknown —
// attention-first (herdr semantics): a pane BLOCKED on the human must shine
// through even when a sibling pane in the same window is happily working.
// (The old working>waiting order let a busy pane mask a blocked one — the
// window never pulsed red exactly when it mattered.) The empty string (zero
// value for a not-yet-seen window) ranks lowest.
func mergeState(a, b string) string {
	if stateRank(b) > stateRank(a) {
		return b
	}
	if a == "" {
		return b
	}
	return a
}

func stateRank(s string) int {
	switch s {
	case "waiting":
		return 3
	case "working":
		return 2
	case "idle":
		return 1
	default: // "unknown" or ""
		return 0
	}
}
