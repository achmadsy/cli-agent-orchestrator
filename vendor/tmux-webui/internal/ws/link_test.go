package ws

import (
	"encoding/json"
	"testing"
)

// newLinkConn builds a bare Conn wired to h with just enough state for the
// link registry (an outChan the scoped broadcast can enqueue to). No tmux, ws,
// or ctx needed — the link methods only touch h.groups and conn.outChan.
func newLinkConn(h *Hub) *Conn {
	return &Conn{hub: h, outChan: make(chan envelope, outChanSize)}
}

func testGroup(t *testing.T, h *Hub, code string) *linkGroup {
	t.Helper()
	gi, ok := h.groups.Load(code)
	if !ok {
		t.Fatalf("group %q not present", code)
	}
	return gi.(*linkGroup)
}

func groupMember(g *linkGroup, clientID string) (*Conn, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	c, ok := g.members[clientID]
	return c, ok
}

func groupSize(g *linkGroup) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.members)
}

// recv does a non-blocking receive of one queued frame.
func recv(c *Conn) (envelope, bool) {
	select {
	case e := <-c.outChan:
		return e, true
	default:
		return nil, false
	}
}

// TestLinkUpdateLWW pins last-write-wins: a fresh group starts at seq 0, a
// higher seq is accepted, a stale OR equal seq is dropped (strictly-greater),
// and the stored view only reflects accepted updates.
func TestLinkUpdateLWW(t *testing.T) {
	h := &Hub{}
	c := newLinkConn(h)
	h.joinGroup("P", "alice", "iPhone", c, true)

	if ok, snap := h.updateGroup("P", "alice", 5, "s", 2, "2.1"); !ok || snap.Seq != 5 || snap.Window != 2 {
		t.Fatalf("seq=5 on fresh group: ok=%v snap=%+v", ok, snap)
	}
	if ok, _ := h.updateGroup("P", "alice", 3, "s", 9, "9.9"); ok {
		t.Fatal("stale seq=3 must be dropped")
	}
	if ok, _ := h.updateGroup("P", "alice", 5, "s", 9, "9.9"); ok {
		t.Fatal("equal seq=5 must be dropped (LWW is strictly-greater)")
	}
	if ok, snap := h.updateGroup("P", "alice", 6, "s", 3, "3.1"); !ok || snap.Window != 3 {
		t.Fatalf("seq=6 must be accepted: ok=%v snap=%+v", ok, snap)
	}

	g := testGroup(t, h, "P")
	g.mu.Lock()
	got := g.state
	g.mu.Unlock()
	if got.Seq != 6 || got.Window != 3 || got.Pane != "3.1" {
		t.Fatalf("stored state = %+v, want seq=6 window=3 pane=3.1 (dropped updates must not persist)", got)
	}
}

// TestLinkJoinReplacesStaleConn pins that a rejoin under the same client_id
// swaps in the fresh conn pointer without duplicating the membership.
func TestLinkJoinReplacesStaleConn(t *testing.T) {
	h := &Hub{}
	old := newLinkConn(h)
	fresh := newLinkConn(h)
	h.joinGroup("P", "alice", "iPhone", old, true)
	h.joinGroup("P", "alice", "iPhone", fresh, false)

	g := testGroup(t, h, "P")
	if got, _ := groupMember(g, "alice"); got != fresh {
		t.Fatal("rejoin must replace the stale conn pointer with the fresh conn")
	}
	if n := groupSize(g); n != 1 {
		t.Fatalf("members = %d, want 1 (rejoin must not duplicate)", n)
	}
}

// TestLinkBroadcastSkipsOrigin pins that broadcastGroup enqueues to every
// member except the originating client_id, and delivers the accepted snapshot.
func TestLinkBroadcastSkipsOrigin(t *testing.T) {
	h := &Hub{}
	alice := newLinkConn(h)
	bob := newLinkConn(h)
	h.joinGroup("P", "alice", "iPhone", alice, true)
	h.joinGroup("P", "bob", "Mac", bob, false)

	ok, snap := h.updateGroup("P", "alice", 1, "s", 4, "")
	if !ok {
		t.Fatal("update must be accepted")
	}
	h.broadcastGroup("P", snap, "alice")

	if _, got := recv(alice); got {
		t.Fatal("origin (alice) must be skipped by the broadcast")
	}
	frame, got := recv(bob)
	if !got {
		t.Fatal("non-origin (bob) must receive the broadcast")
	}
	var out outLinkState
	if err := json.Unmarshal(frame, &out); err != nil {
		t.Fatalf("bob's frame did not decode: %v", err)
	}
	if out.Type != "link_state" || out.Window != 4 || out.Origin != "alice" {
		t.Fatalf("broadcast payload = %+v, want link_state window=4 origin=alice", out)
	}
}

// TestLinkTeardownOnlyRemovesCurrentPointer pins the reconnect-race guard: an
// old conn tearing down after a same-client_id reconnect must NOT evict the
// live membership; only the conn that currently owns the pointer removes it,
// and the group is deleted when its last member leaves.
func TestLinkTeardownOnlyRemovesCurrentPointer(t *testing.T) {
	h := &Hub{}
	old := newLinkConn(h)
	old.clientID, old.group = "alice", "P"
	fresh := newLinkConn(h)
	fresh.clientID, fresh.group = "alice", "P"

	h.joinGroup("P", "alice", "iPhone", old, true)
	h.joinGroup("P", "alice", "iPhone", fresh, false) // reconnect replaces pointer

	old.leaveLink() // stale teardown — must be a no-op for the membership

	g := testGroup(t, h, "P")
	got, present := groupMember(g, "alice")
	if !present {
		t.Fatal("stale teardown wrongly evicted the live membership")
	}
	if got != fresh {
		t.Fatal("membership pointer must remain the fresh conn after a stale teardown")
	}

	fresh.leaveLink() // live teardown — removes the last member
	if _, ok := h.groups.Load("P"); ok {
		t.Fatal("group must be deleted once its last member leaves")
	}
}

// TestLinkLeaderOnly pins the Slice 3 leader logic wired in now: create sets
// the leader, only the leader may toggle leader_only, and while leader_only is
// on a non-leader's update is dropped while the leader's still applies.
func TestLinkLeaderOnly(t *testing.T) {
	h := &Hub{}
	leader := newLinkConn(h)
	follower := newLinkConn(h)
	h.joinGroup("P", "leader", "Mac", leader, true)
	h.joinGroup("P", "follower", "iPhone", follower, false)

	if ok, _ := h.configGroup("P", "follower", true); ok {
		t.Fatal("non-leader must not toggle leader_only")
	}
	if ok, snap := h.configGroup("P", "leader", true); !ok || !snap.LeaderOnly {
		t.Fatalf("leader config: ok=%v snap=%+v", ok, snap)
	}

	if ok, _ := h.updateGroup("P", "follower", 1, "s", 1, ""); ok {
		t.Fatal("leader_only must drop a non-leader update")
	}
	if ok, _ := h.updateGroup("P", "leader", 1, "s", 2, ""); !ok {
		t.Fatal("leader_only must still accept the leader's update")
	}
}

// TestWriteAllowed pins the SEC2 fix: leaderOnly must gate the input path, not
// just the view-follow broadcast. Before the fix any follower could type into
// the leader's pane while the "Leader-only drive" toggle was on.
func TestWriteAllowed(t *testing.T) {
	h := &Hub{}

	// Not in any party → always allowed.
	if !h.writeAllowed("", "anyone") {
		t.Error("clientID with no group should be allowed")
	}
	// In a party code that doesn't exist (torn down) → allowed (fail-open on
	// input is correct; the party is gone so there is no leader to defer to).
	if !h.writeAllowed("GHOST", "anyone") {
		t.Error("unknown group should be allowed")
	}

	leader := newLinkConn(h)
	follower := newLinkConn(h)
	h.joinGroup("P", "leader", "L", leader, true) // create → leader claims leadership
	h.joinGroup("P", "follower", "F", follower, false)

	// leaderOnly OFF (default) → everyone may drive.
	if !h.writeAllowed("P", "leader") || !h.writeAllowed("P", "follower") {
		t.Error("leaderOnly off: both leader and follower should be allowed")
	}

	// Leader turns leaderOnly ON.
	if ok, _ := h.configGroup("P", "leader", true); !ok {
		t.Fatal("configGroup(leaderOnly=true) by leader should succeed")
	}
	if !h.writeAllowed("P", "leader") {
		t.Error("leaderOnly on: leader must still be allowed to drive")
	}
	if h.writeAllowed("P", "follower") {
		t.Error("leaderOnly on: follower must be blocked from driving input")
	}

	// Toggle back off → follower regains input.
	if ok, _ := h.configGroup("P", "leader", false); !ok {
		t.Fatal("configGroup(leaderOnly=false) should succeed")
	}
	if !h.writeAllowed("P", "follower") {
		t.Error("leaderOnly off again: follower should be allowed")
	}
}
