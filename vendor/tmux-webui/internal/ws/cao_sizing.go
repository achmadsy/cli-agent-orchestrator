package ws

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/operonlab/tmux-webui/internal/tmuxctl"
)

// Claims are local to the restricted sidecar process and keyed by real tmux
// identity. The opaque owner is allocated per accepted connection, never read
// from a browser frame. Hold the lock through validation + resize so competing
// viewers cannot both pass a check and then race the real window dimensions.
type caoSizingKey struct{ socket, window string }
type caoSizingClaim struct {
	owner *caoSizingOwner
	until time.Time
}
type caoSizingOwner struct{ marker byte }
type caoSizing struct {
	mu     sync.Mutex
	claims map[caoSizingKey]caoSizingClaim
}

const caoSizingTTL = 20 * time.Second

func (s *caoSizing) release(t CAOTarget, owner *caoSizingOwner) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := caoSizingKey{t.Socket, t.WindowID}
	if s.claims[key].owner == owner {
		delete(s.claims, key)
	}
}

func (s *caoSizing) apply(t CAOTarget, owner *caoSizingOwner, takeover bool, now time.Time, validate func() string, resize func() error) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claims == nil {
		s.claims = make(map[caoSizingKey]caoSizingClaim)
	}
	// Bound memory by active claims rather than all windows ever visited.
	for key, claim := range s.claims {
		if !now.Before(claim.until) {
			delete(s.claims, key)
		}
	}
	key := caoSizingKey{t.Socket, t.WindowID}
	claim := s.claims[key]
	if reason := validate(); reason != "" {
		if claim.owner == owner {
			delete(s.claims, key)
		}
		return reason
	}
	if claim.owner != nil && claim.owner != owner && !takeover {
		return "other_viewer"
	}
	if err := resize(); err != nil {
		return "resize_unavailable"
	}
	s.claims[key] = caoSizingClaim{owner: owner, until: now.Add(caoSizingTTL)}
	return "owned"
}

func caoSinglePane(ctx context.Context, tx *tmuxctl.Client, t CAOTarget) bool {
	// Query the REAL window, not len(caoPanes), which can hide a foreign sibling.
	raw, err := tx.Run(ctx, "list-panes", "-t", t.WindowID, "-F", "#{pane_id}")
	return err == nil && strings.TrimSpace(raw) == t.PaneID
}

type outSizing struct {
	Type  string `json:"type"`
	State string `json:"state"`
	Seq   uint64 `json:"resize_seq,omitempty"`
}
