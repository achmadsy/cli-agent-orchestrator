package cmd

import (
	"fmt"

	"github.com/operonlab/tmux-webui/internal/buildinfo"
	"github.com/operonlab/tmux-webui/internal/update"
	"github.com/spf13/cobra"
)

var updateCheckOnly bool

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update tmux-webui to the latest release",
	Long: `Fetch the latest release from GitHub and replace the running binary.
Use --check to only compare versions without downloading.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		latest, err := update.LatestVersion()
		if err != nil {
			return fmt.Errorf("check for updates: %w", err)
		}

		current := buildinfo.Version
		fmt.Printf("Current version: %s\n", current)
		fmt.Printf("Latest version:  %s\n", latest)

		if updateCheckOnly {
			if current == latest || "v"+current == "v"+latest {
				fmt.Println("Already up to date.")
			} else {
				fmt.Println("Update available. Run `tmux-webui update` to install.")
			}
			return nil
		}

		if current == latest {
			fmt.Println("Already up to date.")
			return nil
		}

		return update.Apply()
	},
}

func init() {
	updateCmd.Flags().BoolVar(&updateCheckOnly, "check", false, "check for updates without downloading")
}
