package ws

// fit_test.go — unit tests for winIndexFromPaneID (also in messages_test.go)
// and the Hub-level fit-layout refcount bookkeeping (B3). The original per-Conn
// map is gone: the layout snapshot now lives at Hub scope, keyed
// "session:windowIndex" with a refcount, so a second client's teardown can no
// longer stomp the first client's still-fit shared layout.
//
// Refcount invariants under test:
//  1. first acquire stores the true original layout AND size; later acquires only
//     ++ref and keep the EARLIEST original (later snapshots are discarded)
//  2. release --refs; only the LAST out restores (size+layout) and deletes the
//     entry; an earlier departure returns the recomputed min of the remainder
//  3. an invalid first snapshot (valid==false) acquires nothing (retry later)
//  4. releasing an untracked / already-restored key is a no-op
//
// Fit sizing invariants under test:
//  5. requests are clamped to [10,1000] cols / [3,500] rows (R1 backstop)
//  6. two clients on one window converge to the per-axis min of their wants (R3);
//     an untracked window passes the request through unaggregated

import (
	"testing"
)

// TestWinIndexFromPaneID_Extended covers cases that complement messages_test.go.
func TestWinIndexFromPaneID_MultiDigit(t *testing.T) {
	cases := []struct {
		pane string
		want int
	}{
		{"12.0", 12},
		{"99.99", 99},
		{"0.0", 0},
	}
	for _, tc := range cases {
		got := winIndexFromPaneID(tc.pane)
		if got != tc.want {
			t.Errorf("winIndexFromPaneID(%q) = %d; want %d", tc.pane, got, tc.want)
		}
	}
}

// TestWinIndexFromPaneID_NonNumericFallback ensures non-numeric parts don't panic.
func TestWinIndexFromPaneID_NonNumericFallback(t *testing.T) {
	cases := []string{"abc.1", "!.0", "1a.0", " .0"}
	for _, p := range cases {
		got := winIndexFromPaneID(p)
		if got != 0 {
			t.Errorf("winIndexFromPaneID(%q) = %d; want 0 (fallback)", p, got)
		}
	}
}

// TestFitRefcount_LastOutRestoresEarliestOriginal is the core B3/R2 story: two
// clients fit the same window; the FIRST client's snapshot (layout AND size) is
// the stored original, later clients only bump the refcount, and only the LAST
// release restores — with the earliest original, not a later (already-resized) one.
func TestFitRefcount_LastOutRestoresEarliestOriginal(t *testing.T) {
	h := &Hub{}
	const key = "s:0"
	c1, c2 := &Conn{}, &Conn{}

	if !h.acquireFit(key, "ORIGINAL", true, 200, 50) {
		t.Fatal("first acquire must succeed")
	}
	// Second enabler's snapshot is POST-resize — layout and size must be discarded.
	if !h.acquireFit(key, "already-resized", true, 80, 24) {
		t.Fatal("second acquire must succeed (ref bump)")
	}

	// First release: still one holder → no restore.
	if rel := h.releaseFit(c1, key); rel.restore {
		t.Fatalf("released too early: %+v, want no restore", rel)
	}
	// Last release: restore the EARLIEST original size+layout and drop the entry.
	rel := h.releaseFit(c2, key)
	if !rel.restore || rel.layout != "ORIGINAL" || rel.cols != 200 || rel.rows != 50 {
		t.Fatalf("last-out restore = %+v; want restore ORIGINAL 200x50", rel)
	}
	// Entry deleted: releasing again is a no-op.
	if rel := h.releaseFit(c1, key); rel.restore || rel.remain {
		t.Error("releasing an already-restored key must not restore/remain")
	}
}

// TestFitRefcount_InvalidFirstSnapshotAcquiresNothing pins invariant 3: when
// the first enabler could not read the layout (valid==false) it holds no
// reference, so a later enabler that DOES read a valid layout becomes the
// storing first — the window is never restored to a state no one captured.
func TestFitRefcount_InvalidFirstSnapshotAcquiresNothing(t *testing.T) {
	h := &Hub{}
	const key = "s:2"
	c := &Conn{}

	if h.acquireFit(key, "", false, 0, 0) {
		t.Fatal("invalid first snapshot must acquire nothing")
	}
	// A later valid snapshot now becomes the stored original.
	if !h.acquireFit(key, "REAL", true, 120, 40) {
		t.Fatal("valid acquire after an invalid one must succeed")
	}
	rel := h.releaseFit(c, key)
	if !rel.restore || rel.layout != "REAL" || rel.cols != 120 || rel.rows != 40 {
		t.Fatalf("restore = %+v; want restore REAL 120x40", rel)
	}
}

// TestFitRefcount_KeysAreIndependent pins per-window isolation: releasing one
// window's key never touches another's, so restore order across windows is
// each key's own last-out.
func TestFitRefcount_KeysAreIndependent(t *testing.T) {
	h := &Hub{}
	c := &Conn{}
	h.acquireFit("s:0", "L0", true, 100, 30)
	h.acquireFit("s:1", "L1", true, 110, 35)

	if rel := h.releaseFit(c, "s:1"); !rel.restore || rel.layout != "L1" {
		t.Fatalf("window 1 restore = %+v; want restore L1", rel)
	}
	if rel := h.releaseFit(c, "s:0"); !rel.restore || rel.layout != "L0" {
		t.Fatalf("window 0 restore = %+v; want restore L0", rel)
	}
}

// TestFitRefcount_ReleaseUntrackedKey pins invariant 4: releasing a key that was
// never acquired is a harmless no-op (guards teardown running with no fits).
func TestFitRefcount_ReleaseUntrackedKey(t *testing.T) {
	h := &Hub{}
	if rel := h.releaseFit(&Conn{}, "s:9"); rel.restore || rel.remain {
		t.Error("releasing an untracked key must not report restore/remain")
	}
}

// TestClampFitDimensions pins the R1 backstop: a degenerate client's request is
// clamped to [10,1000] cols / [3,500] rows before it can ever reach tmux.
func TestClampFitDimensions(t *testing.T) {
	cases := []struct {
		inC, inR, wantC, wantR int
	}{
		{0, 0, 10, 3},           // the 38x1 spiral floor: below min → clamp up
		{5, 1, 10, 3},           // just below both mins
		{10, 3, 10, 3},          // exactly at min → unchanged
		{80, 24, 80, 24},        // typical terminal → unchanged
		{1000, 500, 1000, 500},  // exactly at max → unchanged
		{5000, 9999, 1000, 500}, // above max → clamp down
		{-3, -1, 10, 3},         // negative degenerate → clamp up
	}
	for _, tc := range cases {
		if got := clampCols(tc.inC); got != tc.wantC {
			t.Errorf("clampCols(%d) = %d; want %d", tc.inC, got, tc.wantC)
		}
		if got := clampRows(tc.inR); got != tc.wantR {
			t.Errorf("clampRows(%d) = %d; want %d", tc.inR, got, tc.wantR)
		}
	}
}

// TestFitMinAggregation is the core R3 story: two clients fitting one window
// converge to the smaller of their wants (per-axis min), a mid-life want update
// moves the effective size, and releasing a client recomputes the min over the
// remainder; the last out restores the original size+layout.
func TestFitMinAggregation(t *testing.T) {
	h := &Hub{}
	const key = "s:0"
	c1, c2 := &Conn{}, &Conn{}

	if !h.acquireFit(key, "ORIG", true, 200, 60) {
		t.Fatal("c1 acquire must succeed")
	}
	// Sole fitter → effective = its own want.
	if col, row := h.registerWant(c1, key, 120, 40); col != 120 || row != 40 {
		t.Fatalf("single want eff = %dx%d; want 120x40", col, row)
	}
	// c2 joins wanting a smaller box → effective = min = 80x24.
	if !h.acquireFit(key, "ORIG2", true, 200, 60) {
		t.Fatal("c2 acquire must succeed (ref bump)")
	}
	if col, row := h.registerWant(c2, key, 80, 24); col != 80 || row != 24 {
		t.Fatalf("two-want eff = %dx%d; want 80x24 (smaller wins)", col, row)
	}
	// c1 updates to fewer cols but more rows → per-axis min: 70 cols, 24 rows.
	if col, row := h.registerWant(c1, key, 70, 50); col != 70 || row != 24 {
		t.Fatalf("mixed-axis eff = %dx%d; want 70x24", col, row)
	}
	// c2 (the small-rows client) leaves → remain, recompute min over {c1:70x50}.
	rel := h.releaseFit(c2, key)
	if !rel.remain || rel.restore {
		t.Fatalf("release c2 = %+v; want remain (others still fit)", rel)
	}
	if rel.cols != 70 || rel.rows != 50 {
		t.Fatalf("recomputed min after c2 leaves = %dx%d; want 70x50 (grow back)", rel.cols, rel.rows)
	}
	// c1 leaves (last out) → restore the original size+layout.
	rel = h.releaseFit(c1, key)
	if !rel.restore || rel.cols != 200 || rel.rows != 60 || rel.layout != "ORIG" {
		t.Fatalf("last-out = %+v; want restore ORIG 200x60", rel)
	}
}

// TestRegisterWantUntracked pins the degraded path: when the window was never
// tracked (snapshot capture failed, no entry) registerWant returns the passed
// size unaggregated so the resize still happens for the sole client.
func TestRegisterWantUntracked(t *testing.T) {
	h := &Hub{}
	if col, row := h.registerWant(&Conn{}, "s:404", 90, 30); col != 90 || row != 30 {
		t.Fatalf("untracked want = %dx%d; want passthrough 90x30", col, row)
	}
}

// TestFitKey pins the "session:windowIndex" key/target format.
func TestFitKey(t *testing.T) {
	c := &Conn{session: "main"}
	if got := c.fitKey(3); got != "main:3" {
		t.Errorf("fitKey(3) = %q; want main:3", got)
	}
}
