package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/operonlab/tmux-webui/internal/buildinfo"
	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/network"
	"github.com/operonlab/tmux-webui/internal/server"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
	"github.com/spf13/cobra"
)

var (
	serveHost string
	servePort int
	serveLAN  bool
	serveOpen bool
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the tmux-webui HTTP server (default command)",
	Long:  `Start the HTTP server that serves the tmux-webui PWA.`,
	RunE:  runServe,
}

func init() {
	serveCmd.Flags().StringVar(&serveHost, "host", "", "override config host")
	serveCmd.Flags().IntVar(&servePort, "port", 0, "override config port")
	serveCmd.Flags().BoolVar(&serveLAN, "lan", false, "bind 0.0.0.0 and show LAN addresses + QR")
	serveCmd.Flags().BoolVar(&serveOpen, "open", false, "open browser after start")
}

func runServe(_ *cobra.Command, _ []string) error {
	// 1. Load config.
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if serveHost != "" {
		cfg.Host = serveHost
	}
	if servePort != 0 {
		cfg.Port = servePort
	}
	if serveLAN {
		cfg.Host = "0.0.0.0"
		tok, err := config.ResolveLANToken(os.Getenv("TMUX_WEBUI_TOKEN"))
		if err != nil {
			return fmt.Errorf("mint LAN token: %w", err)
		}
		cfg.Token = tok
	}

	// 2. Check tmux binary.
	if _, err := exec.LookPath("tmux"); err != nil {
		fmt.Fprintln(os.Stderr, "tmux not found.")
		fmt.Fprintln(os.Stderr, "Install: brew install tmux        (macOS)")
		fmt.Fprintln(os.Stderr, "         sudo apt install tmux    (Debian/Ubuntu)")
		fmt.Fprintln(os.Stderr, "         sudo pacman -S tmux      (Arch)")
		os.Exit(1)
	}

	tx := tmuxctl.New()
	srv := server.New(cfg, tx)
	defer srv.Close()

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Mux(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	fmt.Printf("%s\n", buildinfo.String())

	// 3. LAN mode: list interfaces + QR.
	if serveLAN {
		lans := network.LocalAddresses()
		if len(lans) > 0 {
			fmt.Println("\nAvailable on:")
			for _, lan := range lans {
				tag := ""
				if lan.IsTailscale {
					tag = " [Tailscale]"
				}
				url := fmt.Sprintf("http://%s:%d/#token=%s", lan.IP, cfg.Port, cfg.Token)
				fmt.Printf("  %s (%s)%s\n", url, lan.Name, tag)
			}
			// Print QR for the first (highest-priority) address. The token rides
			// the URL FRAGMENT (#token=), which the browser keeps client-side; the
			// gate's bootstrap reads it, sets the cookie, and reloads clean. Using
			// a fragment (not ?token=) keeps the token out of proxy logs and
			// link-preview unfurlers (SEC1).
			primaryURL := fmt.Sprintf("http://%s:%d/#token=%s", lans[0].IP, cfg.Port, cfg.Token)
			fmt.Printf("\nScan to open %s:\n", primaryURL)
			network.PrintQR(primaryURL)
		}
	} else {
		fmt.Printf("→ http://%s\n", addr)
	}
	fmt.Println("(Ctrl+C to stop)")

	// 4. Open browser if requested.
	if serveOpen {
		url := fmt.Sprintf("http://127.0.0.1:%d", cfg.Port)
		openBrowser(url)
	}

	// 5. Start server.
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	// Cross-session agent Monitor: always maintains the /api/agents snapshot;
	// the push side is a no-op unless config.notify.webhook_url is set.
	srv.StartMonitor(ctx)

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()

	select {
	case <-ctx.Done():
		fmt.Println("\nshutting down...")
		shutdownCtx, sc := context.WithTimeout(context.Background(), 5*time.Second)
		defer sc()
		_ = httpSrv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("server error: %w", err)
		}
	}
	return nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
