package cmd

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/operonlab/tmux-webui/internal/daemon"
	"github.com/spf13/cobra"
)

var uninstallYes bool

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove tmux-webui binary, config, daemon, uploads",
	Long: `Remove every artifact tmux-webui installed:
  - daemon unit (launchd plist on macOS / systemd user unit on Linux)
  - ~/.config/tmux-webui/
  - <UserCacheDir>/tmux-webui/ (uploads + logs)
  - the binary at $(command -v tmux-webui)

Use -y to skip the confirmation prompt.`,
	RunE: runUninstall,
}

func init() {
	uninstallCmd.Flags().BoolVarP(&uninstallYes, "yes", "y", false, "skip confirmation")
}

func runUninstall(cmd *cobra.Command, args []string) error {
	if !uninstallYes {
		fmt.Print("This will remove tmux-webui binary, config, daemon, uploads. Continue? [y/N] ")
		ans, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		ans = strings.TrimSpace(strings.ToLower(ans))
		if ans != "y" && ans != "yes" {
			fmt.Println("Aborted.")
			return nil
		}
	}

	// 1. Daemon uninstall (best-effort).
	if d, err := daemon.New(); err == nil {
		if uerr := d.Uninstall(false); uerr != nil {
			fmt.Fprintln(os.Stderr, "warning: daemon uninstall:", uerr)
		}
	}

	// 2. Remove config + cache dirs.
	home, _ := os.UserHomeDir()
	cfgDir := filepath.Join(home, ".config", "tmux-webui")
	if err := os.RemoveAll(cfgDir); err == nil {
		fmt.Println("removed", cfgDir)
	}
	cache, _ := os.UserCacheDir()
	cacheDir := filepath.Join(cache, "tmux-webui")
	if err := os.RemoveAll(cacheDir); err == nil {
		fmt.Println("removed", cacheDir)
	}

	// 3. Remove binary.
	exe, err := os.Executable()
	if err == nil {
		if err := os.Remove(exe); err == nil {
			fmt.Println("removed", exe)
		} else {
			fmt.Fprintf(os.Stderr, "warning: could not remove %s: %v\n", exe, err)
			fmt.Fprintln(os.Stderr, "        you may need: sudo rm "+exe)
		}
	}

	fmt.Println()
	fmt.Println("tmux-webui uninstalled.")
	fmt.Println("If installed via Homebrew, also run:  brew uninstall tmux-webui")
	return nil
}
