// Package daemon manages OS-level service installation for tmux-webui.
package daemon

import (
	"fmt"
	"runtime"
)

// Manager installs, uninstalls, and reports status of the background service.
type Manager interface {
	Install(binaryPath string, dryRun bool) error
	Uninstall(dryRun bool) error
	Status() (string, error)
	Logs(follow bool) error
}

// New returns the platform-appropriate Manager.
func New() (Manager, error) {
	switch runtime.GOOS {
	case "darwin":
		return &launchdManager{}, nil
	case "linux":
		return &systemdManager{}, nil
	default:
		return nil, fmt.Errorf("daemon management not supported on %s", runtime.GOOS)
	}
}
