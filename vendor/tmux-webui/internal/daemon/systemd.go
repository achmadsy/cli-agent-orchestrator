package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"text/template"
)

var unitTmpl = template.Must(template.New("unit").Parse(`[Unit]
Description=tmux-webui
After=default.target

[Service]
ExecStart={{.BinaryPath}} serve
Restart=on-failure
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`))

type systemdManager struct{}

func (m *systemdManager) unitPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user", "tmux-webui.service"), nil
}

func (m *systemdManager) Install(binaryPath string, dryRun bool) error {
	unitPath, err := m.unitPath()
	if err != nil {
		return err
	}

	data := struct{ BinaryPath string }{BinaryPath: escapeSystemdExec(binaryPath)}

	if dryRun {
		fmt.Printf("[dry-run] would write unit to: %s\n", unitPath)
		fmt.Println("[dry-run] unit content:")
		if err := unitTmpl.Execute(os.Stdout, data); err != nil {
			return err
		}
		fmt.Println("[dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now tmux-webui")
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		return fmt.Errorf("create systemd user dir: %w", err)
	}
	f, err := os.Create(unitPath)
	if err != nil {
		return fmt.Errorf("create unit file: %w", err)
	}
	defer f.Close()
	if err := unitTmpl.Execute(f, data); err != nil {
		return fmt.Errorf("write unit file: %w", err)
	}

	fmt.Printf("Installing systemd user service: %s\n", unitPath)

	reload := exec.Command("systemctl", "--user", "daemon-reload")
	reload.Stdout = os.Stdout
	reload.Stderr = os.Stderr
	if err := reload.Run(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}

	enable := exec.Command("systemctl", "--user", "enable", "--now", "tmux-webui")
	enable.Stdout = os.Stdout
	enable.Stderr = os.Stderr
	if err := enable.Run(); err != nil {
		return fmt.Errorf("systemctl enable: %w", err)
	}

	fmt.Println("tmux-webui daemon installed and started.")
	fmt.Println("Tip: run `loginctl enable-linger $USER` to keep the service running after logout.")
	return nil
}

func (m *systemdManager) Uninstall(dryRun bool) error {
	unitPath, err := m.unitPath()
	if err != nil {
		return err
	}
	if dryRun {
		fmt.Printf("[dry-run] would disable + remove: %s\n", unitPath)
		return nil
	}

	stop := exec.Command("systemctl", "--user", "disable", "--now", "tmux-webui")
	stop.Stdout = os.Stdout
	stop.Stderr = os.Stderr
	_ = stop.Run()

	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove unit file: %w", err)
	}
	fmt.Println("tmux-webui daemon uninstalled.")
	return nil
}

func (m *systemdManager) Status() (string, error) {
	out, err := exec.Command("systemctl", "--user", "status", "tmux-webui").CombinedOutput()
	if err != nil {
		return string(out), nil
	}
	return string(out), nil
}

func (m *systemdManager) Logs(follow bool) error {
	args := []string{"--user", "-u", "tmux-webui"}
	if follow {
		args = append(args, "-f")
	} else {
		args = append(args, "-n", "100")
	}
	cmd := exec.Command("journalctl", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
