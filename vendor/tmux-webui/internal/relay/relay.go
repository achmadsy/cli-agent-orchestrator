package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Dispatcher is the optional relay backend. Returns nil from New() when
// disabled (paneScript or relayScript empty); callers should fall back
// to 501 stub.
type Dispatcher struct {
	paneScript  string
	relayScript string
	signalDir   string
}

// New returns nil when relay is disabled (any required path empty).
// Returns a non-nil error if config points at non-existent scripts —
// surfacing misconfiguration loudly rather than silently disabling.
func New(paneScript, relayScript, signalDir string) (*Dispatcher, error) {
	if paneScript == "" || relayScript == "" {
		return nil, nil
	}
	if signalDir == "" {
		signalDir = "/tmp"
	}
	if _, err := os.Stat(paneScript); err != nil {
		return nil, fmt.Errorf("relay pane_pool_script not found: %s", paneScript)
	}
	if _, err := os.Stat(relayScript); err != nil {
		return nil, fmt.Errorf("relay relay_script not found: %s", relayScript)
	}
	return &Dispatcher{paneScript: paneScript, relayScript: relayScript, signalDir: signalDir}, nil
}

// paneAcquireArgv builds the argv for acquiring a relay pane. Pulled out of
// Dispatch as a pure function so tests can assert its shape without
// executing bash.
func paneAcquireArgv(paneScript string) []string {
	return []string{"bash", paneScript, "acquire", "1"}
}

// relayDispatchArgv builds the argv for starting the background relay run.
// Pulled out of Dispatch as a pure function so tests can assert its shape
// without executing bash.
func relayDispatchArgv(relayScript, pane, command, signalFile string, timeoutSec int) []string {
	return []string{"bash", relayScript, pane, "", command,
		"--no-forward", "--signal", signalFile, "--timeout", fmt.Sprintf("%d", timeoutSec)}
}

// normalizeTimeout clamps timeoutSec to the allowed dispatch window,
// defaulting out-of-range values to 600s. Pulled out of Dispatch as a pure
// function so its boundary behavior is testable directly.
func normalizeTimeout(timeoutSec int) int {
	if timeoutSec <= 0 || timeoutSec > 1800 {
		return 600
	}
	return timeoutSec
}

// Dispatch acquires a pane and starts the relay run in background.
// Returns immediately; caller polls Check via signal file.
func (d *Dispatcher) Dispatch(ctx context.Context, command string, timeoutSec int) (pane, signalFile string, err error) {
	timeoutSec = normalizeTimeout(timeoutSec)
	acquireArgv := paneAcquireArgv(d.paneScript)
	out, err := exec.CommandContext(ctx, acquireArgv[0], acquireArgv[1:]...).Output()
	if err != nil {
		return "", "", fmt.Errorf("relay acquire: %w", err)
	}
	pane = strings.TrimSpace(string(out))
	if pane == "" {
		return "", "", errors.New("relay acquire returned empty pane")
	}

	signalFile = filepath.Join(d.signalDir,
		fmt.Sprintf("relay-webui-%d-%d.done", time.Now().UnixMilli(), os.Getpid()))

	dispatchArgv := relayDispatchArgv(d.relayScript, pane, command, signalFile, timeoutSec)
	cmd := exec.Command(dispatchArgv[0], dispatchArgv[1:]...)
	if err := cmd.Start(); err != nil {
		return "", "", fmt.Errorf("relay dispatch: %w", err)
	}
	go func() { _ = cmd.Process.Release() }()
	return pane, signalFile, nil
}

// Check inspects the signal file. Returns "completed" when present,
// "running" otherwise. Path validation prevents traversal: the file
// MUST live in d.signalDir AND start with "relay-webui-".
func (d *Dispatcher) Check(signalFile string) (string, error) {
	if !strings.HasPrefix(filepath.Base(signalFile), "relay-webui-") {
		return "", errors.New("invalid signal file name")
	}
	abs, err := filepath.Abs(signalFile)
	if err != nil {
		return "", err
	}
	if filepath.Dir(abs) != filepath.Clean(d.signalDir) {
		return "", errors.New("signal file outside signal_dir")
	}
	if _, err := os.Stat(abs); err == nil {
		return "completed", nil
	}
	return "running", nil
}

// DispatchHandler returns the POST /api/relay handler.
type dispatchRequest struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
}

func (d *Dispatcher) DispatchHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req dispatchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Command == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		pane, sig, err := d.Dispatch(ctx, req.Command, req.Timeout)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"pane":        pane,
			"signal_file": sig,
		})
	}
}

// CheckHandler returns the GET /api/relay/check handler.
func (d *Dispatcher) CheckHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sig := r.URL.Query().Get("signal_file")
		if sig == "" {
			http.Error(w, "signal_file required", http.StatusBadRequest)
			return
		}
		status, err := d.Check(sig)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":      status,
			"signal_file": sig,
		})
	}
}
