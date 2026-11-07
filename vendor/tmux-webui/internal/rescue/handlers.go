package rescue

import (
	"encoding/json"
	"io"
	"net/http"
)

// HandleStatus — GET /api/rescue. Cheap enough to poll: one short-deadline
// tmux call + one ps.
func (r *Rescuer) HandleStatus(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, http.StatusOK, r.Probe(req.Context()))
}

// HandleDiagnose — POST /api/rescue/diagnose. Read-only evidence collection;
// can take a few seconds when stack-sampling a spinning server.
func (r *Rescuer) HandleDiagnose(w http.ResponseWriter, req *http.Request) {
	writeJSON(w, http.StatusOK, r.Diagnose(req.Context()))
}

// HandleKillHooks — POST /api/rescue/kill-hooks. Middle rung of the ladder:
// only ever signals children of a tmux server process.
func (r *Rescuer) HandleKillHooks(w http.ResponseWriter, req *http.Request) {
	rep, err := r.KillHooks(req.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// HandleKillServer — POST /api/rescue/kill-server. Destructive (all tmux
// sessions die), so it demands an explicit {"confirm":true} body — a bare
// POST from a stray fetch or curl must not be enough.
func (r *Rescuer) HandleKillServer(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, 1<<10)).Decode(&body); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	if !body.Confirm {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kill-server requires {\"confirm\": true}"})
		return
	}
	rep, err := r.KillServer(req.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "report": rep})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
