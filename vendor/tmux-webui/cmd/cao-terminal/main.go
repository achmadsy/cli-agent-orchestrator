// cao-terminal is the only supported CAO sidecar entrypoint. Unlike the full
// upstream server, it has no rescue, session CRUD, monitor, update or upload APIs.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/operonlab/tmux-webui/internal/config"
	"github.com/operonlab/tmux-webui/internal/pwa"
	"github.com/operonlab/tmux-webui/internal/tmuxctl"
	"github.com/operonlab/tmux-webui/internal/ws"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:9528", "loopback listen address")
	socket := flag.String("socket", "", "explicit tmux socket path")
	cfgPath := flag.String("config", "", "optional non-secret UI config JSON")
	version := flag.Bool("version", false, "print pinned protocol version")
	flag.Parse()
	if *version {
		fmt.Println(ws.CAOVersion())
		return
	}
	host, _, err := net.SplitHostPort(*addr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		fmt.Fprintln(os.Stderr, "listen must be a numeric loopback address")
		os.Exit(2)
	}
	secret := os.Getenv("CAO_TERMINAL_INTERNAL_TOKEN")
	if len(secret) < 32 {
		fmt.Fprintln(os.Stderr, "CAO_TERMINAL_INTERNAL_TOKEN must contain at least 32 characters")
		os.Exit(2)
	}
	cfg := config.Defaults()
	if *cfgPath != "" {
		data, e := os.ReadFile(*cfgPath)
		if e != nil || json.Unmarshal(data, &cfg) != nil {
			fmt.Fprintln(os.Stderr, "invalid config")
			os.Exit(2)
		}
	}
	tx := tmuxctl.New(tmuxctl.WithSocket(*socket))
	mux := http.NewServeMux()
	mux.Handle("GET /{$}", pwa.IndexHandler(cfg.UI))
	mux.Handle("GET /static/", pwa.StaticFS())
	mux.Handle("GET /ws", ws.CAOHandler(tx))
	mux.Handle("GET /api/history", ws.CAOHistory(tx))
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "version": ws.CAOVersion()})
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		supplied := r.Header.Get("X-CAO-Terminal-Token")
		if subtle.ConstantTimeCompare([]byte(secret), []byte(supplied)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	go func() {
		<-ctx.Done()
		c, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = srv.Shutdown(c)
	}()
	if err = srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "sidecar listen failed")
		os.Exit(1)
	}
}
