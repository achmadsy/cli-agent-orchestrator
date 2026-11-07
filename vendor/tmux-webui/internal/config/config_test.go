package config

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaults(t *testing.T) {
	d := Defaults()
	if d.Host != "127.0.0.1" {
		t.Errorf("Host=%q; want 127.0.0.1", d.Host)
	}
	if d.Port != 9527 {
		t.Errorf("Port=%d; want 9527", d.Port)
	}
	if d.PollInterval != 0.4 {
		t.Errorf("PollInterval=%v; want 0.4", d.PollInterval)
	}
	if d.CaptureLines != 300 {
		t.Errorf("CaptureLines=%d; want 300", d.CaptureLines)
	}
	if d.Metrics.Provider != "gopsutil" {
		t.Errorf("Metrics.Provider=%q; want gopsutil", d.Metrics.Provider)
	}
}

func TestResolveLANToken(t *testing.T) {
	// Empty env → freshly minted 32-hex token.
	tok, err := ResolveLANToken("")
	if err != nil {
		t.Fatalf("ResolveLANToken(\"\"): %v", err)
	}
	if len(tok) != 32 {
		t.Errorf("minted token len=%d; want 32", len(tok))
	}
	if _, err := hex.DecodeString(tok); err != nil {
		t.Errorf("minted token %q not hex: %v", tok, err)
	}

	// Valid fixed value → returned verbatim.
	fixed := "0123456789abcdef0123456789abcdef"
	got, err := ResolveLANToken(fixed)
	if err != nil {
		t.Fatalf("ResolveLANToken(fixed): %v", err)
	}
	if got != fixed {
		t.Errorf("got %q; want verbatim %q", got, fixed)
	}

	// Too-short value → error, no silent fallback.
	if _, err := ResolveLANToken("deadbeef"); err == nil {
		t.Errorf("expected error for 8-char token, got nil")
	}
}

func TestLoadAutoCreate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Port != 9527 {
		t.Errorf("expected default port 9527 on auto-create, got %d", cfg.Port)
	}
	// File should exist now.
	if _, err := os.Stat(path); err != nil {
		t.Errorf("expected config file auto-created at %s, got %v", path, err)
	}
}

// TestLoadHostsValid: a well-formed hosts list loads and round-trips its fields.
func TestLoadHostsValid(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	body := `{"hosts":[{"name":"mbp","url":"http://mbp:9527","fallback_url":"http://100.64.0.2:9527","token":"tok"},{"name":"studio","url":"http://studio:9527"}]}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Hosts) != 2 {
		t.Fatalf("Hosts len=%d; want 2", len(cfg.Hosts))
	}
	h := cfg.Hosts[0]
	if h.Name != "mbp" || h.URL != "http://mbp:9527" || h.FallbackURL != "http://100.64.0.2:9527" || h.Token != "tok" {
		t.Errorf("Hosts[0]=%+v; want fully populated mbp host", h)
	}
	if cfg.Hosts[1].FallbackURL != "" || cfg.Hosts[1].Token != "" {
		t.Errorf("Hosts[1]=%+v; want empty fallback/token", cfg.Hosts[1])
	}
}

// TestLoadHostsInvalid: each validation rule (name with "/", reserved "local",
// duplicate, empty) fails loud at load rather than silently loading a broken
// federation config.
func TestLoadHostsInvalid(t *testing.T) {
	cases := map[string]string{
		"slash in name":  `{"hosts":[{"name":"a/b","url":"http://x"}]}`,
		"reserved local": `{"hosts":[{"name":"local","url":"http://x"}]}`,
		"duplicate name": `{"hosts":[{"name":"mbp","url":"http://x"},{"name":"mbp","url":"http://y"}]}`,
		"empty name":     `{"hosts":[{"name":"","url":"http://x"}]}`,
	}
	for label, body := range cases {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.json")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Errorf("%s: expected Load error, got nil", label)
		}
	}
}

// TestLoadNewTunables: the config-backend tunables round-trip, and each keeps
// its zero-value default (current behavior) when the key is absent.
func TestLoadNewTunables(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	body := `{
		"upload_max_bytes": 1048576,
		"default_session_cwd": "/tmp/work",
		"agent_commands_extra": ["myagent", "otheragent"],
		"agent_host_commands_extra": ["deno"],
		"autocomplete": {
			"include_plugins": false,
			"max_results": 7,
			"source_priority": ["commands", "skills"],
			"shortcuts_file": "/tmp/shortcuts.json"
		}
	}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.UploadMaxBytes != 1048576 {
		t.Errorf("UploadMaxBytes=%d; want 1048576", cfg.UploadMaxBytes)
	}
	if cfg.DefaultSessionCWD != "/tmp/work" {
		t.Errorf("DefaultSessionCWD=%q; want /tmp/work", cfg.DefaultSessionCWD)
	}
	if len(cfg.AgentCommandsExtra) != 2 || cfg.AgentCommandsExtra[0] != "myagent" {
		t.Errorf("AgentCommandsExtra=%v; want [myagent otheragent]", cfg.AgentCommandsExtra)
	}
	if len(cfg.AgentHostCommandsExtra) != 1 || cfg.AgentHostCommandsExtra[0] != "deno" {
		t.Errorf("AgentHostCommandsExtra=%v; want [deno]", cfg.AgentHostCommandsExtra)
	}
	if cfg.Autocomplete.IncludePlugins == nil || *cfg.Autocomplete.IncludePlugins {
		t.Errorf("Autocomplete.IncludePlugins=%v; want explicit false", cfg.Autocomplete.IncludePlugins)
	}
	// IncludeBuiltins absent → nil (resolved to true at the call site).
	if cfg.Autocomplete.IncludeBuiltins != nil {
		t.Errorf("Autocomplete.IncludeBuiltins=%v; want nil (absent)", cfg.Autocomplete.IncludeBuiltins)
	}
	if cfg.Autocomplete.MaxResults != 7 {
		t.Errorf("Autocomplete.MaxResults=%d; want 7", cfg.Autocomplete.MaxResults)
	}
	if len(cfg.Autocomplete.SourcePriority) != 2 || cfg.Autocomplete.SourcePriority[0] != "commands" {
		t.Errorf("Autocomplete.SourcePriority=%v; want [commands skills]", cfg.Autocomplete.SourcePriority)
	}
	if cfg.Autocomplete.ShortcutsFile != "/tmp/shortcuts.json" {
		t.Errorf("Autocomplete.ShortcutsFile=%q; want /tmp/shortcuts.json", cfg.Autocomplete.ShortcutsFile)
	}

	// Defaults preserved: an old config without these keys keeps zero values
	// (each resolves to the historical behavior downstream).
	def, err := Load(filepath.Join(dir, "absent.json"))
	if err != nil {
		t.Fatalf("Load absent: %v", err)
	}
	if def.UploadMaxBytes != 0 || def.DefaultSessionCWD != "" || def.UI != nil ||
		def.Autocomplete.MaxResults != 0 || def.Autocomplete.IncludePlugins != nil {
		t.Errorf("absent-key config carried non-zero tunables: %+v", def)
	}
}

// TestLoadUIBlob: a valid ui blob round-trips verbatim; an invalid one fails
// loud at Load rather than reaching the HTML injector.
func TestLoadUIBlob(t *testing.T) {
	dir := t.TempDir()

	valid := filepath.Join(dir, "valid.json")
	if err := os.WriteFile(valid, []byte(`{"ui":{"theme":"dark","cols":3}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(valid)
	if err != nil {
		t.Fatalf("Load valid ui: %v", err)
	}
	if !json.Valid(cfg.UI) || !strings.Contains(string(cfg.UI), `"theme":"dark"`) {
		t.Errorf("UI blob not preserved verbatim: %s", cfg.UI)
	}

	invalid := filepath.Join(dir, "invalid.json")
	if err := os.WriteFile(invalid, []byte(`{"ui":{bad}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(invalid); err == nil {
		t.Errorf("expected Load error for invalid ui blob, got nil")
	}
}

func TestLoadOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	body := `{"host":"0.0.0.0","port":12345,"capture_lines":300,"metrics":{"provider":"http","url":"http://localhost:10103/sysmon/current"}}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Host != "0.0.0.0" {
		t.Errorf("Host=%q; want 0.0.0.0", cfg.Host)
	}
	if cfg.Port != 12345 {
		t.Errorf("Port=%d; want 12345", cfg.Port)
	}
	if cfg.CaptureLines != 300 {
		t.Errorf("CaptureLines=%d; want 300", cfg.CaptureLines)
	}
	if cfg.Metrics.URL != "http://localhost:10103/sysmon/current" {
		t.Errorf("Metrics.URL=%q", cfg.Metrics.URL)
	}
	// Defaults preserved for unspecified fields.
	if cfg.PollInterval != 0.4 {
		t.Errorf("PollInterval=%v; want default 0.4", cfg.PollInterval)
	}
}
