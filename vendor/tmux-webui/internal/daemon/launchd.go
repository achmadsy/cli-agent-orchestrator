package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"text/template"
)

const plistLabel = "dev.tmux-webui"

var plistTmpl = template.Must(template.New("plist").Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>{{.Label}}</string>
    <key>ProgramArguments</key><array>
        <string>{{.BinaryPath}}</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>{{.StdoutLog}}</string>
    <key>StandardErrorPath</key><string>{{.StderrLog}}</string>
</dict>
</plist>
`))

type launchdManager struct{}

func (m *launchdManager) plistPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", plistLabel+".plist"), nil
}

func (m *launchdManager) logDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "tmux-webui"), nil
}

func (m *launchdManager) Install(binaryPath string, dryRun bool) error {
	plistPath, err := m.plistPath()
	if err != nil {
		return err
	}
	logDir, err := m.logDir()
	if err != nil {
		return err
	}

	data := struct {
		Label      string
		BinaryPath string
		StdoutLog  string
		StderrLog  string
	}{
		Label:      plistLabel,
		BinaryPath: escapeXML(binaryPath),
		StdoutLog:  filepath.Join(logDir, "stdout.log"),
		StderrLog:  filepath.Join(logDir, "stderr.log"),
	}

	if dryRun {
		fmt.Printf("[dry-run] would write plist to: %s\n", plistPath)
		fmt.Printf("[dry-run] log dir: %s\n", logDir)
		fmt.Println("[dry-run] plist content:")
		return plistTmpl.Execute(os.Stdout, data)
	}

	// Ensure directories exist.
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o755); err != nil {
		return fmt.Errorf("create LaunchAgents dir: %w", err)
	}
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return fmt.Errorf("create log dir: %w", err)
	}

	f, err := os.Create(plistPath)
	if err != nil {
		return fmt.Errorf("create plist: %w", err)
	}
	defer f.Close()
	if err := plistTmpl.Execute(f, data); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	// Bootstrap the agent.
	uid, err := currentUID()
	if err != nil {
		return err
	}
	fmt.Printf("Installing launchd agent: %s\n", plistPath)
	cmd := exec.Command("launchctl", "bootstrap", fmt.Sprintf("gui/%s", uid), plistPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %w", err)
	}
	fmt.Println("tmux-webui daemon installed and started.")
	return nil
}

func (m *launchdManager) Uninstall(dryRun bool) error {
	plistPath, err := m.plistPath()
	if err != nil {
		return err
	}
	if dryRun {
		fmt.Printf("[dry-run] would bootout %s and remove: %s\n", plistLabel, plistPath)
		return nil
	}

	uid, err := currentUID()
	if err != nil {
		return err
	}
	cmd := exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%s/%s", uid, plistLabel))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	_ = cmd.Run() // ignore if not loaded

	if err := os.Remove(plistPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove plist: %w", err)
	}
	fmt.Println("tmux-webui daemon uninstalled.")
	return nil
}

func (m *launchdManager) Status() (string, error) {
	out, err := exec.Command("launchctl", "list", plistLabel).CombinedOutput()
	if err != nil {
		return "not loaded (not installed or not running)", nil
	}
	return string(out), nil
}

func (m *launchdManager) Logs(follow bool) error {
	logDir, err := m.logDir()
	if err != nil {
		return err
	}
	logFile := filepath.Join(logDir, "stdout.log")
	args := []string{"-f", logFile}
	if !follow {
		args = []string{"-n", "100", logFile}
	}
	cmd := exec.Command("tail", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func currentUID() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("get current user: %w", err)
	}
	return u.Uid, nil
}
