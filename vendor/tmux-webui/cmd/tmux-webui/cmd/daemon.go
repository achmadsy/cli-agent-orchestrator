package cmd

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/daemon"
	"github.com/spf13/cobra"
)

var daemonDryRun bool

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Manage tmux-webui as a background service",
	Long:  `Install, uninstall, or check the status of tmux-webui as an OS background service.`,
}

var daemonInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install tmux-webui as a startup service",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := config.Load(cfgPath)
		if err != nil {
			return fmt.Errorf("config: %w", err)
		}
		// Refuse when another manager already owns this port — see
		// daemon.GuardPort for why.
		if err := daemon.GuardPort(cfg.Host, cfg.Port); err != nil {
			return err
		}
		mgr, err := daemon.New()
		if err != nil {
			return err
		}
		binaryPath, err := resolveBinaryPath()
		if err != nil {
			return err
		}
		return mgr.Install(binaryPath, daemonDryRun)
	},
}

var daemonUninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove tmux-webui from startup services",
	RunE: func(cmd *cobra.Command, args []string) error {
		mgr, err := daemon.New()
		if err != nil {
			return err
		}
		return mgr.Uninstall(daemonDryRun)
	},
}

var daemonStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show the daemon status",
	RunE: func(cmd *cobra.Command, args []string) error {
		mgr, err := daemon.New()
		if err != nil {
			return err
		}
		status, err := mgr.Status()
		if err != nil {
			return err
		}
		fmt.Print(status)
		return nil
	},
}

var daemonLogsCmd = &cobra.Command{
	Use:   "logs",
	Short: "Stream daemon logs",
	RunE: func(cmd *cobra.Command, args []string) error {
		mgr, err := daemon.New()
		if err != nil {
			return err
		}
		follow, _ := cmd.Flags().GetBool("follow")
		return mgr.Logs(follow)
	},
}

func init() {
	daemonCmd.PersistentFlags().BoolVar(&daemonDryRun, "dry-run", false,
		"print what would happen without actually changing system state")

	daemonLogsCmd.Flags().BoolP("follow", "f", true, "follow log output (tail -f)")

	daemonCmd.AddCommand(daemonInstallCmd)
	daemonCmd.AddCommand(daemonUninstallCmd)
	daemonCmd.AddCommand(daemonStatusCmd)
	daemonCmd.AddCommand(daemonLogsCmd)
}

// resolveBinaryPath returns the absolute path of the running binary.
func resolveBinaryPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve binary path: %w", err)
	}
	abs, err := filepath.Abs(exe)
	if err != nil {
		return "", fmt.Errorf("absolute binary path: %w", err)
	}
	return abs, nil
}
