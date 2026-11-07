package tts

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"sync/atomic"
	"time"
)

// Blob is a single TTS utterance held in the store.
type Blob struct {
	ID    string
	Text  string
	Audio []byte // raw MP3 bytes
	TS    int64  // Unix millisecond timestamp of Push
}

// Store is a single-slot, lock-free TTS audio store.
// A new Push atomically replaces the previous blob — only the latest
// utterance is kept, matching the Python _tts_store.clear() + update() idiom.
type Store struct {
	cur atomic.Pointer[Blob]
}

// NewStore returns an empty Store.
func NewStore() *Store { return &Store{} }

// Push stores a new TTS blob and returns it.
// The ID is generated from the current nanosecond timestamp + random entropy
// (pure stdlib, no uuid dependency).
func (s *Store) Push(text string, audio []byte) *Blob {
	id := fmt.Sprintf("%d%d", time.Now().UnixNano(), rand.Int63()) //nolint:gosec
	blob := &Blob{
		ID:    id,
		Text:  text,
		Audio: audio,
		TS:    time.Now().UnixMilli(),
	}
	s.cur.Store(blob)
	return blob
}

// Get returns the current blob if its ID matches, or nil otherwise.
func (s *Store) Get(id string) *Blob {
	b := s.cur.Load()
	if b == nil || b.ID != id {
		return nil
	}
	return b
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────

// pushRequest is the expected JSON body for POST /api/tts/push.
type pushRequest struct {
	Audio string `json:"audio"` // base64-encoded MP3
	Text  string `json:"text"`
}

// pushResponse is returned on success.
type pushResponse struct {
	OK      bool   `json:"ok"`
	ID      string `json:"id"`
	Clients int    `json:"clients"` // v0: always 0; server fills real count after ws wired
}

// PushHandler returns an http.HandlerFunc for POST /api/tts/push.
//
// broadcaster is called after Push with the new blob's (id, text).
// Pass nil to disable broadcasting (safe in v0 before the WS hub is wired).
// In production pass ws.Hub.BroadcastTTS.
func (s *Store) PushHandler(broadcaster func(id, text string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req pushRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request: invalid JSON", http.StatusBadRequest)
			return
		}
		if req.Audio == "" {
			http.Error(w, "bad request: no audio data", http.StatusBadRequest)
			return
		}

		audio, err := base64.StdEncoding.DecodeString(req.Audio)
		if err != nil {
			// Try URL-safe variant in case the sender uses it.
			audio, err = base64.URLEncoding.DecodeString(req.Audio)
			if err != nil {
				http.Error(w, "bad request: invalid base64", http.StatusBadRequest)
				return
			}
		}

		blob := s.Push(req.Text, audio)

		if broadcaster != nil {
			broadcaster(blob.ID, blob.Text)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(pushResponse{OK: true, ID: blob.ID, Clients: 0})
	}
}

// GetHandler returns an http.HandlerFunc for GET /api/tts/{id}.
// It serves the stored MP3 with Content-Type: audio/mpeg and Cache-Control: no-store.
// Returns 404 if the id does not match the current blob.
func (s *Store) GetHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		blob := s.Get(id)
		if blob == nil {
			http.Error(w, "audio not found or expired", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(blob.Audio)
	}
}
