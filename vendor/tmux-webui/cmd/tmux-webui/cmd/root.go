// Package cmd implements the cobra command tree for tmux-webui.
package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var cfgPath string

var rootCmd = &cobra.Command{
	Use:   "tmux-webui",
	Short: "Browser-based tmux interface",
	Long: `tmux-webui serves a PWA that lets you view and interact with tmux sessions
from any browser on the same network.

Run without arguments to start the server (equivalent to 'tmux-webui serve').`,
	// Default action: run serve.
	RunE: func(cmd *cobra.Command, args []string) error {
		return serveCmd.RunE(cmd, args)
	},
}

// Execute is the entry point called from main.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().StringVar(&cfgPath, "config", "",
		"config file path (default: ~/.config/tmux-webui/config.json)")

	rootCmd.AddCommand(serveCmd)
	rootCmd.AddCommand(daemonCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(uninstallCmd)
	rootCmd.AddCommand(versionCmd)
}
