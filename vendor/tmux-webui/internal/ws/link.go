package ws

import (
	"encoding/json"
	"sort"
	"sync"
)

// link.go implements "link mode" (party): N connections that share a
// {session, window, pane} context. It is an additive, opt-in layer — nothing
// here runs unless a client sends link_join. The party broadcast is always
// scoped to its members and NEVER goes through Hub.Broadcast (which would hit
// every connection, including unrelated sessions).

// linkState is the shared view a party converges on.
type linkState struct {
	Session string
	Window  int
	Pane    string
	Seq     int64
}

// linkGroup is one party. members maps a stable client_id to its live conn;
// devices maps the same client_id to a display name. Guarded by mu.
type linkGroup struct {
	mu         sync.Mutex
	state      linkState
	leader     string            // client_id of the creator; "" until a create join
	leaderOnly bool              // when true, only the leader's link_update drives
	members    map[string]*Conn  // client_id → live conn
	devices    map[string]string // client_id → device name
}

// snapshotLocked builds the outbound link_state frame. Caller MUST hold g.mu.
// origin is the client_id that caused this frame ("" for membership-only
// refresh / catch-up). Members are sorted by client_id so the member list is
// stable across broadcasts (map order is random and would otherwise reshuffle
// the UI on every refresh).
func (g *linkGroup) snapshotLocked(code, origin string) outLinkState {
	members := make([]linkMember, 0, len(g.members))
	for cid := range g.members {
		members = append(members, linkMember{ClientID: cid, Device: g.devices[cid]})
	}
	sort.Slice(members, func(i, j int) bool { return members[i].ClientID < members[j].ClientID })
	return outLinkState{
		Type:       "link_state",
		Group:      code,
		Session:    g.state.Session,
		Window:     g.state.Window,
		Pane:       g.state.Pane,
		Seq:        g.state.Seq,
		Origin:     origin,
		Members:    members,
		Leader:     g.leader,
		LeaderOnly: g.leaderOnly,
	}
}

// joinGroup registers (or re-registers) clientID's membership in party code,
// replacing any stale conn pointer for the same client_id (reconnect). create
// claims leadership for a freshly-formed party. Returns the current snapshot
// (origin "") for the joiner to catch up to.
func (h *Hub) joinGroup(code, clientID, device string, c *Conn, create bool) outLinkState {
	gi, _ := h.groups.LoadOrStore(code, &linkGroup{
		members: make(map[string]*Conn),
		devices: make(map[string]string),
	})
	g := gi.(*linkGroup)

	g.mu.Lock()
	defer g.mu.Unlock()
	g.members[clientID] = c // replace any stale pointer for this client_id
	if device != "" {
		g.devices[clientID] = device
	}
	// Leadership is set only by a create join, and only if unclaimed — a second
	// device sending create on an existing party must not hijack the leader.
	if create && g.leader == "" {
		g.leader = clientID
	}
	return g.snapshotLocked(code, "")
}

// updateGroup applies a member's view change under last-write-wins: accept iff
// seq is strictly greater than the stored seq. When leaderOnly is set, updates
// from non-leaders are dropped. Returns (accepted, snapshot-with-origin).
func (h *Hub) updateGroup(code, clientID string, seq int64, session string, window int, pane string) (bool, outLinkState) {
	gi, ok := h.groups.Load(code)
	if !ok {
		return false, outLinkState{}
	}
	g := gi.(*linkGroup)

	g.mu.Lock()
	defer g.mu.Unlock()
	if g.leaderOnly && clientID != g.leader {
		return false, outLinkState{}
	}
	if seq <= g.state.Seq {
		return false, outLinkState{} // stale — silently drop
	}
	g.state = linkState{Session: session, Window: window, Pane: pane, Seq: seq}
	return true, g.snapshotLocked(code, clientID)
}

// writeAllowed reports whether clientID may drive input/keys into the shared
// pane. It is false ONLY when the client is in a party that has leaderOnly set
// and the client is not the leader. A client in no party (code == "") or in a
// party without leaderOnly is always allowed.
//
// This is the input-side enforcement of the "Leader-only drive" toggle. Before,
// leaderOnly gated only updateGroup (the view-follow broadcast); handleInput /
// handleKey had no membership check, so any follower could still type into the
// leader's pane while the UI advertised leader-only control — a false ACL.
func (h *Hub) writeAllowed(code, clientID string) bool {
	if code == "" {
		return true
	}
	gi, ok := h.groups.Load(code)
	if !ok {
		return true
	}
	g := gi.(*linkGroup)
	g.mu.Lock()
	defer g.mu.Unlock()
	return !g.leaderOnly || clientID == g.leader
}

// configGroup toggles leader-only-drive. Only the leader's client_id is
// accepted. Returns (accepted, snapshot) with origin "" so every member
// refreshes its leader/leaderOnly UI state.
func (h *Hub) configGroup(code, clientID string, leaderOnly bool) (bool, outLinkState) {
	gi, ok := h.groups.Load(code)
	if !ok {
		return false, outLinkState{}
	}
	g := gi.(*linkGroup)

	g.mu.Lock()
	defer g.mu.Unlock()
	if clientID != g.leader {
		return false, outLinkState{}
	}
	g.leaderOnly = leaderOnly
	return true, g.snapshotLocked(code, "")
}

// leaveGroup removes clientID's membership, but ONLY if the group's current
// pointer for that client_id is still c. This guards the session-switch
// reconnect race: a fresh conn for the same client_id may already have replaced
// the pointer in joinGroup before the old conn tears down — the old teardown
// must not evict the live membership. Deletes the group when it empties.
// Returns the post-leave snapshot and whether the group still has members.
func (h *Hub) leaveGroup(code, clientID string, c *Conn) (outLinkState, bool) {
	gi, ok := h.groups.Load(code)
	if !ok {
		return outLinkState{}, false
	}
	g := gi.(*linkGroup)

	g.mu.Lock()
	if cur, ok := g.members[clientID]; ok && cur == c {
		delete(g.members, clientID)
		delete(g.devices, clientID)
	}
	if len(g.members) == 0 {
		g.mu.Unlock()
		h.groups.Delete(code)
		return outLinkState{}, false
	}
	snap := g.snapshotLocked(code, "")
	g.mu.Unlock()
	return snap, true
}

// broadcastGroup marshals msg once and enqueues it to every member except
// exceptClientID, reusing the non-blocking drop-on-overflow send pattern from
// Hub.Broadcast — but scoped to this party's members only.
func (h *Hub) broadcastGroup(code string, msg any, exceptClientID string) {
	gi, ok := h.groups.Load(code)
	if !ok {
		return
	}
	g := gi.(*linkGroup)

	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	env := envelope(b)

	g.mu.Lock()
	defer g.mu.Unlock()
	for cid, conn := range g.members {
		if cid == exceptClientID {
			continue
		}
		select {
		case conn.outChan <- env:
		default:
			// drop on overflow; the slow connection will eventually close itself
		}
	}
}

// ─── Conn-side handlers (dispatched from reader.go) ────────────────────────────

// handleLinkJoin registers this conn in a party, replies to it with the party's
// current state (catch-up), then refreshes membership for the other members.
func (c *Conn) handleLinkJoin(msg *InboundMsg) error {
	if msg.Group == "" || msg.ClientID == "" {
		return nil
	}
	c.clientID = msg.ClientID
	c.group = msg.Group
	snap := c.hub.joinGroup(msg.Group, msg.ClientID, msg.Device, c, msg.Create)
	c.send(snap)                                        // catch-up to the joining conn
	c.hub.broadcastGroup(msg.Group, snap, msg.ClientID) // membership refresh to others
	return nil
}

// handleLinkUpdate applies the sender's view change (LWW) and broadcasts the
// accepted state to every member except the originator.
func (c *Conn) handleLinkUpdate(msg *InboundMsg) error {
	if c.group == "" || c.clientID == "" {
		return nil
	}
	accepted, snap := c.hub.updateGroup(c.group, c.clientID, msg.Seq, msg.Session, msg.Window, msg.Pane)
	if !accepted {
		return nil
	}
	c.hub.broadcastGroup(c.group, snap, c.clientID)
	return nil
}

// handleLinkLeave removes this conn from its party and refreshes the remainder.
func (c *Conn) handleLinkLeave(_ *InboundMsg) error {
	code, clientID := c.group, c.clientID
	if code == "" {
		return nil
	}
	if snap, ok := c.hub.leaveGroup(code, clientID, c); ok {
		c.hub.broadcastGroup(code, snap, "")
	}
	c.group = ""
	return nil
}

// handleLinkConfig toggles leader-only-drive (leader only) and refreshes all.
func (c *Conn) handleLinkConfig(msg *InboundMsg) error {
	if c.group == "" || c.clientID == "" {
		return nil
	}
	accepted, snap := c.hub.configGroup(c.group, c.clientID, msg.LeaderOnly)
	if !accepted {
		return nil
	}
	c.hub.broadcastGroup(c.group, snap, "")
	return nil
}

// leaveLink is the teardown-side party departure, called from Conn.Run's defer.
// It removes membership only if the party still points at THIS conn for its
// client_id (see leaveGroup's reconnect-race guard).
func (c *Conn) leaveLink() {
	if c.group == "" || c.clientID == "" {
		return
	}
	if snap, ok := c.hub.leaveGroup(c.group, c.clientID, c); ok {
		c.hub.broadcastGroup(c.group, snap, "")
	}
}
