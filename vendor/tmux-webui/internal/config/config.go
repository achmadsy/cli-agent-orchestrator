// Package config loads tmux-webui configuration from disk.
//
// v0 uses JSON (stdlib only, no external deps). Layered config (env →
// flags → file with override semantics) is deferred to v0.2 when there
// is concrete demand; KISS for now.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Host            string  `json:"host"`
	Port            int     `json:"port"`
	PollInterval    float64 `json:"poll_interval"`
	MetricsInterval float64 `json:"metrics_interval"`
	CaptureLines    int     `json:"capture_lines"`
	UploadDir       string  `json:"upload_dir"`
	// UploadMaxBytes caps POST /api/upload (0 → 50<<20, the historical default).
	UploadMaxBytes int64              `json:"upload_max_bytes,omitempty"`
	Autocomplete   AutocompleteConfig `json:"autocomplete"`
	Metrics        MetricsConfig      `json:"metrics"`
	Relay          RelayConfig        `json:"relay,omitempty"`
	Notify         NotifyConfig       `json:"notify,omitempty"`

	// DefaultSessionCWD is the working dir new sessions start in (empty →
	// os.UserHomeDir(), the historical default). Resolved and passed to tmuxctl
	// at the call site (server.handleCreateSession) so tmuxctl stays decoupled
	// from config.
	DefaultSessionCWD string `json:"default_session_cwd,omitempty"`

	// AgentCommandsExtra / AgentHostCommandsExtra are APPENDED to the builtin
	// agent-command classifier sets (internal/ws agentstate.go) — the builtin
	// sets always stay, these only add entries. AgentCommandsExtra names full
	// coding agents (screen-text classified); AgentHostCommandsExtra names
	// generic runtimes that merely host an agent (title-only classified). Empty
	// (default) leaves the builtin sets unchanged.
	AgentCommandsExtra     []string `json:"agent_commands_extra,omitempty"`
	AgentHostCommandsExtra []string `json:"agent_host_commands_extra,omitempty"`

	// UI is an OPAQUE passthrough blob delivered verbatim to the frontend as
	// window.__UI_CONFIG__ (see internal/pwa IndexHandler). The server never
	// interprets it — the frontend owns its schema — which avoids maintaining a
	// deep UI-settings struct in both Go and JS. Empty → the frontend sees null.
	// Invalid JSON here fails loud at Load (never injected into the HTML).
	UI json.RawMessage `json:"ui,omitempty"`

	// Hosts are the FULL-SESSION federation targets: remote tmux-webui instances
	// whose sessions this "hub" lists and proxies, so one UI shows every machine.
	// Each host's sessions surface under a "<name>/<session>" prefix and every
	// session-scoped request (list/history/panes/rename/delete/create/ws) is
	// forwarded to the owning host with the prefix stripped (see internal/fedproxy).
	//
	// NOT to be confused with notify.peers (below): peers is STATUS-ONLY agent
	// federation (each Monitor scan GETs a peer's /api/agents), hosts is the full
	// session proxy. The two are deliberately separate — a status-only peer needs
	// no proxying, a proxied host publishes its own /api/agents locally. Empty = no
	// federation (default), byte-identical to a standalone server.
	Hosts []HostConfig `json:"hosts,omitempty"`

	// Token, when non-empty, gates every request behind a ?token=/cookie check
	// (see server.tokenGate). Minted at startup only in --lan mode, never
	// persisted — empty leaves a plain localhost bind tokenless and
	// byte-identical to a no-auth server.
	Token string `json:"-"`
}

// HostConfig is one full-session federation target (see Config.Hosts). Name is
// the prefix stamped on the host's sessions ("<name>/<session>"), so it must be
// non-empty, unique, and free of "/" (the separator); "local" is reserved for
// this instance's own sessions. URL is the host's base (e.g. "http://mbp:9527");
// FallbackURL is tried once when URL is unreachable (e.g. a Tailscale backup for
// a LAN primary). Token, when set, rides each forwarded request as the tw_token
// cookie so a --lan host admits it.
type HostConfig struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	FallbackURL string `json:"fallback_url,omitempty"`
	Token       string `json:"token,omitempty"`
}

type AutocompleteConfig struct {
	// ClaudeDir, when set, enables scanning ~/.claude/{skills,commands,agents}.
	// Empty disables Claude resource autocomplete; path autocomplete is always on.
	ClaudeDir string `json:"claude_dir,omitempty"`
	// IncludePlugins / IncludeBuiltins gate the plugin-marketplace scan and the
	// curated built-in slash-command roster. Pointer so an absent key defaults to
	// true (the historical always-on behavior); set false to disable.
	IncludePlugins  *bool `json:"include_plugins,omitempty"`
	IncludeBuiltins *bool `json:"include_builtins,omitempty"`
	// MaxResults caps the suggestions returned per query (0 → 15, the historical
	// default).
	MaxResults int `json:"max_results,omitempty"`
	// SourcePriority orders the slash-item sources for tie-breaking at equal
	// fuzzy score (empty → ["builtins","skills","commands"], the historical
	// order). Sources omitted from the list keep their default position after the
	// listed ones — a partial list reorders, never drops.
	SourcePriority []string `json:"source_priority,omitempty"`

	// ShortcutsFile points at the user-defined shortcut list (JSON; see
	// internal/autocomplete/shortcuts.go for the format). Defaults to
	// shortcuts.json next to the config file; empty string disables.
	// (An earlier custom_phrases config field was dropped in favor of
	// shortcuts: same use case, richer semantics — bare-word trigger,
	// keyword aliases, separate editable file.)
	ShortcutsFile string `json:"shortcuts_file,omitempty"`
}

type MetricsConfig struct {
	// Provider: "gopsutil" (default, built-in) or "http" (pull from URL).
	Provider string `json:"provider"`
	// URL is consumed when Provider == "http". Workshop dogfood points this
	// at http://127.0.0.1:10103/sysmon/current.
	URL string `json:"url,omitempty"`
}

// NotifyConfig drives the cross-session agent Monitor: a server-lifetime
// goroutine that scans every session, maintains an all-sessions agent-status
// snapshot for the UI (GET /api/agents), and POSTs a push payload to WebhookURL
// when an agent pane transitions into the "waiting on you" state. The snapshot
// is always maintained; empty WebhookURL = push off (default), so a stock
// server keeps a live snapshot but never POSTs. Point WebhookURL at a push
// backend (e.g. the workshop notification module's /send, with an auth header
// in WebhookHeaders) to get lock-screen alerts while the app is closed.
type NotifyConfig struct {
	WebhookURL     string            `json:"webhook_url,omitempty"`
	WebhookHeaders map[string]string `json:"webhook_headers,omitempty"`
	// Interval is the Monitor scan period in seconds (default 3).
	Interval float64 `json:"interval,omitempty"`
	// Cooldown throttles per-pane re-notification in seconds (default 60): a
	// pane sitting in waiting won't re-push until it leaves and re-enters, and a
	// fast re-entry is still capped to this.
	Cooldown float64 `json:"cooldown,omitempty"`
	// NoPreview drops the pane's last line from the push body. Default (false)
	// includes it — it's your own device and the prompt is the useful part.
	NoPreview bool `json:"no_preview,omitempty"`
	// URLBase is prepended to the push url so tapping opens the app (default "/").
	URLBase string `json:"url_base,omitempty"`

	// RecordMaxFrames and RecordMaxBytes bound the I4 per-pane replay ring —
	// whichever ceiling binds first evicts the oldest frame. Recording is OFF by
	// default (opt-in per pane via POST /api/agents/{session}/{pane}/record), so
	// these only matter once a pane is being recorded. Defaults: 200 frames /
	// 4MB (RecordMaxFrames<=0 → 200, RecordMaxBytes<=0 → 4<<20).
	RecordMaxFrames int `json:"record_max_frames,omitempty"`
	RecordMaxBytes  int `json:"record_max_bytes,omitempty"`

	// Peers are the I6 remote-host status federation sources: Tailscale/LAN-
	// reachable tmux-webui base URLs (e.g. "http://host-b:10105"). Each Monitor
	// scan also GETs each peer's /api/agents with a SHORT timeout, best-effort —
	// a dead/slow peer is logged and skipped, never blocking the local scan.
	// Remote agents are tagged host=<peer> and their pane ids host-prefixed so
	// they never collide with local ones. STATUS ONLY — there is no cross-host
	// input/focus (out of scope by design). Empty = no federation (default).
	Peers []string `json:"peers,omitempty"`
	// PeerToken, when set, is carried as the tw_token cookie on each peer poll so
	// a token-gated (--lan) peer admits the read-only /api/agents request. Peers
	// are trusted LAN hosts; leave empty for tokenless peers.
	PeerToken string `json:"peer_token,omitempty"`
}

type RelayConfig struct {
	// PaneScript is the path to a shell script that allocates a relay pane.
	// Empty disables /api/relay (returns 501).
	PaneScript  string `json:"pane_pool_script,omitempty"`
	RelayScript string `json:"relay_script,omitempty"`
	SignalDir   string `json:"signal_dir,omitempty"`
}

func Defaults() Config {
	cache, _ := os.UserCacheDir()
	home, _ := os.UserHomeDir()
	return Config{
		Host:            "127.0.0.1",
		Port:            9527,
		PollInterval:    0.4,
		MetricsInterval: 5.0,
		CaptureLines:    300,
		UploadDir:       filepath.Join(cache, "tmux-webui", "uploads"),
		Autocomplete: AutocompleteConfig{
			ShortcutsFile: filepath.Join(home, ".config", "tmux-webui", "shortcuts.json"),
		},
		Metrics: MetricsConfig{Provider: "gopsutil"},
	}
}

// MintToken returns a 128-bit random token as 32 hex chars, for LAN-mode
// access gating. Minted once at startup, carried by the printed URL + QR,
// never persisted.
func MintToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ResolveLANToken picks the LAN-mode gate token from an env value (typically
// TMUX_WEBUI_TOKEN). Empty env mints a fresh random token as before; a
// non-empty value is used verbatim so a reverse proxy can inject a stable
// token across restarts. A set-but-too-short value fails loud rather than
// silently minting, so a misconfigured proxy is caught at startup.
func ResolveLANToken(envVal string) (string, error) {
	if envVal == "" {
		return MintToken()
	}
	if len(envVal) < 16 {
		return "", fmt.Errorf("TMUX_WEBUI_TOKEN must be at least 16 chars (got %d)", len(envVal))
	}
	return envVal, nil
}

func DefaultPath() string {
	if p := os.Getenv("TMUX_WEBUI_CONFIG"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "tmux-webui", "config.json")
}

// Load reads config from path (or DefaultPath if empty).
// On first run (file missing), it auto-creates the file with defaults so
// non-technical users get a working config they can edit.
func Load(path string) (*Config, error) {
	if path == "" {
		path = DefaultPath()
	}
	cfg := Defaults()

	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		if werr := writeDefaults(path, cfg); werr != nil {
			fmt.Fprintln(os.Stderr, "tmux-webui: could not create default config:", werr)
		}
		return &cfg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("config read %s: %w", path, err)
	}
	if len(data) == 0 {
		return &cfg, nil
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("config parse %s: %w", path, err)
	}
	if err := validateHosts(cfg.Hosts); err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	// The outer Unmarshal already rejects a syntactically broken document, but
	// validate the opaque UI blob explicitly so it can never reach the HTML
	// injector as garbage (belt-and-suspenders for a programmatically-set UI).
	if len(cfg.UI) > 0 && !json.Valid(cfg.UI) {
		return nil, fmt.Errorf("config %s: ui must be valid JSON", path)
	}
	return &cfg, nil
}

// validateHosts fails loud on a malformed federation host list: each name must
// be non-empty, free of "/" (the "<name>/<session>" prefix separator), not the
// reserved label "local", and unique across the list. An empty list (the
// default, no federation) passes unchanged.
func validateHosts(hosts []HostConfig) error {
	seen := make(map[string]bool, len(hosts))
	for i, h := range hosts {
		switch {
		case h.Name == "":
			return fmt.Errorf("hosts[%d]: name must be non-empty", i)
		case strings.Contains(h.Name, "/"):
			return fmt.Errorf("hosts[%d] %q: name must not contain '/' (it is the federation prefix separator)", i, h.Name)
		case h.Name == "local":
			return fmt.Errorf(`hosts[%d]: name "local" is reserved for this instance's own sessions`, i)
		case seen[h.Name]:
			return fmt.Errorf("hosts[%d]: duplicate host name %q", i, h.Name)
		}
		seen[h.Name] = true
	}
	return nil
}

func writeDefaults(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}
