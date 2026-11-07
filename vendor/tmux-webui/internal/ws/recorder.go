package ws

import "sync"

// I4 per-pane output replay recorder (opt-in). Recording is NOT on by default —
// it costs memory, so it's started per pane through a gated control
// (POST /api/agents/{session}/{pane}/record). While a pane is being recorded the
// Monitor's scan captures the pane's ANSI-preserved content each tick and hands
// it here; a frame is retained only when the content CHANGED from the previous
// one. Frames are held in a ring bounded by BOTH a frame count AND a byte total
// (config.NotifyConfig.RecordMaxFrames / RecordMaxBytes, defaults 200 / 4MB) so
// a busy pane can't grow the buffer without bound. Stop clears the buffer.

// defaultRecordMaxFrames / defaultRecordMaxBytes back the ring when the config
// leaves them at 0; recordCaptureLines is the scrollback depth each frame
// captures (ANSI preserved) — a full-ish screen, still cheap because recording
// is opt-in and rare.
const (
	defaultRecordMaxFrames = 200
	defaultRecordMaxBytes  = 4 << 20 // 4 MiB
	recordCaptureLines     = 200
)

// Frame is one captured pane content snapshot: the raw (ANSI-preserved) content
// and the unix second it was captured. Ships inside the GET frames payload;
// camelCase JSON to match the deck's other agent frames.
type Frame struct {
	Content string `json:"content"`
	AtUnix  int64  `json:"atUnix"`
}

// frameRing is a bounded FIFO of one pane's replay frames. PURE: push takes the
// timestamp as an argument (never time.Now) so append / dual eviction stay
// deterministic under test. It evicts the oldest frame while EITHER ceiling is
// exceeded (count > maxFrames, or bytes > maxBytes) but always keeps at least
// the newest frame — a single frame larger than maxBytes is still retained so a
// scrub target always exists. Unit-tested as the I4 hard gate.
type frameRing struct {
	maxFrames int
	maxBytes  int
	frames    []Frame
	bytes     int // running sum of len(frames[i].Content)
}

func newFrameRing(maxFrames, maxBytes int) *frameRing {
	if maxFrames < 1 {
		maxFrames = 1
	}
	if maxBytes < 1 {
		maxBytes = 1
	}
	return &frameRing{maxFrames: maxFrames, maxBytes: maxBytes}
}

// push appends a frame and evicts the oldest while over either ceiling, keeping
// at least the newest frame.
func (r *frameRing) push(content string, atUnix int64) {
	r.frames = append(r.frames, Frame{Content: content, AtUnix: atUnix})
	r.bytes += len(content)
	evict := 0
	for len(r.frames)-evict > 1 &&
		(len(r.frames)-evict > r.maxFrames || r.bytes > r.maxBytes) {
		r.bytes -= len(r.frames[evict].Content)
		evict++
	}
	if evict > 0 {
		// Compact the retained tail onto the head of the backing array (forward
		// copy, dest<src — safe) so the slice never grows without bound.
		r.frames = append(r.frames[:0], r.frames[evict:]...)
	}
}

// snapshot copies the retained frames (oldest→newest) so a caller can ship them
// without racing a concurrent push. nil when empty.
func (r *frameRing) snapshot() []Frame {
	if len(r.frames) == 0 {
		return nil
	}
	out := make([]Frame, len(r.frames))
	copy(out, r.frames)
	return out
}

// paneRecording is one pane's live recording: its frame ring plus the last
// content seen, used to record only on a real change.
type paneRecording struct {
	ring *frameRing
	last string
	// seen guards the first frame: an initial empty capture ("") differs from
	// the "" zero value of last, so without this the empty first frame would be
	// dropped — but an empty pane rarely matters and we'd rather the first
	// non-trivial frame land. seen flips on the first record() so a genuinely
	// empty pane still gets one frame.
	seen bool
}

// recorder owns every active per-pane recording, keyed by notifyKey(session,
// paneID) — the same namespacing the Monitor's scan uses. Concurrent: the scan
// goroutine writes frames while the /api/agents/.../record and .../frames HTTP
// handlers start/stop/read, so all access is guarded by mu.
type recorder struct {
	maxFrames int
	maxBytes  int

	mu   sync.Mutex
	recs map[string]*paneRecording
}

func newRecorder(maxFrames, maxBytes int) *recorder {
	if maxFrames < 1 {
		maxFrames = defaultRecordMaxFrames
	}
	if maxBytes < 1 {
		maxBytes = defaultRecordMaxBytes
	}
	return &recorder{maxFrames: maxFrames, maxBytes: maxBytes, recs: map[string]*paneRecording{}}
}

// start begins (or keeps) a recording for key. Idempotent: re-starting an active
// recording keeps its existing frames.
func (rc *recorder) start(key string) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.recs[key] == nil {
		rc.recs[key] = &paneRecording{ring: newFrameRing(rc.maxFrames, rc.maxBytes)}
	}
}

// stop ends a recording and frees its buffer (drop the map entry). Idempotent.
func (rc *recorder) stop(key string) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	delete(rc.recs, key)
}

// isRecording reports whether key is being recorded (drives the scan's per-tick
// capture — no capture cost for panes that aren't recording).
func (rc *recorder) isRecording(key string) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.recs[key] != nil
}

// record pushes content into key's ring, but only when it CHANGED from the last
// frame (a redraw-identical capture is skipped). No-op when key isn't recording.
func (rc *recorder) record(key, content string, atUnix int64) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	pr := rc.recs[key]
	if pr == nil {
		return
	}
	if pr.seen && content == pr.last {
		return
	}
	pr.seen = true
	pr.last = content
	pr.ring.push(content, atUnix)
}

// frames returns a copy of key's retained frames and whether it's recording.
// (nil, false) when the pane isn't being recorded.
func (rc *recorder) frames(key string) ([]Frame, bool) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	pr := rc.recs[key]
	if pr == nil {
		return nil, false
	}
	return pr.ring.snapshot(), true
}

// reap stops recordings whose pane key is no longer live (the Monitor's scan
// passes the set of keys it still sees), so a closed pane's buffer is freed.
func (rc *recorder) reap(live map[string]bool) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	for k := range rc.recs {
		if !live[k] {
			delete(rc.recs, k)
		}
	}
}
