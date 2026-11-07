// Package tts implements the single-slot TTS audio store and its HTTP handlers.
//
// # Overview
//
// Store holds at most one Blob at a time.  A new Push() atomically replaces
// the previous blob so memory never accumulates between TTS utterances.
//
// Two HTTP handlers are exposed:
//
//   - PushHandler — POST /api/tts/push
//     Accepts {"audio": "<base64-mp3>", "text": "<transcript>"}.
//     Decodes the audio, stores it, and calls the broadcaster callback so
//     all WebSocket clients receive a {"type":"tts","id":"…","text":"…"} frame.
//     v0: pass nil as broadcaster to disable the broadcast side-effect.
//
//   - GetHandler — GET /api/tts/{id}
//     Serves the stored MP3 as audio/mpeg.
//     Returns 404 if the id does not match the current blob.
//
// # IDs
//
// IDs are generated without an external library using nanosecond timestamp +
// random nanoseconds: fmt.Sprintf("%d%d", nowNs, randNs).  This guarantees
// uniqueness in practice because two successive pushes cannot share the same
// wall-clock nanosecond, and the random component adds additional entropy.
//
// # Wire-up (server.go)
//
//	ttsStore := tts.NewStore()
//	mux.HandleFunc("POST /api/tts/push", ttsStore.PushHandler(nil))
//	mux.HandleFunc("GET /api/tts/{id}", ttsStore.GetHandler())
//
// Replace nil with ws.Hub.BroadcastTTS once the WebSocket hub is wired.
package tts
