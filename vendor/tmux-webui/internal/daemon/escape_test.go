package daemon

import (
	"bytes"
	"encoding/xml"
	"strings"
	"testing"
)

func TestEscapeXML(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain path unchanged", "/usr/local/bin/tmux-webui", "/usr/local/bin/tmux-webui"},
		{"ampersand and angle brackets", "/tmp/evil & <script>/tmux-webui", "/tmp/evil &amp; &lt;script&gt;/tmux-webui"},
		{"quotes", `a"b'c`, "a&#34;b&#39;c"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := escapeXML(tc.in); got != tc.want {
				t.Errorf("escapeXML(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestEscapeSystemdExec(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain path unchanged", "/usr/local/bin/tmux-webui", "/usr/local/bin/tmux-webui"},
		{"percent doubled (specifier escape)", "/opt/100%-done/tmux-webui", "/opt/100%%-done/tmux-webui"},
		{"space triggers quoting", "/opt/my apps/tmux-webui", `"/opt/my apps/tmux-webui"`},
		{"embedded quote escaped", `/opt/weird"path/tmux-webui`, `"/opt/weird\"path/tmux-webui"`},
		{"embedded backslash escaped", `/opt/weird\path/tmux-webui`, `"/opt/weird\\path/tmux-webui"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := escapeSystemdExec(tc.in); got != tc.want {
				t.Errorf("escapeSystemdExec(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestPlistTemplateEscapesBinaryPath renders the real plist template (the
// same code path Install uses) with a path containing XML metacharacters and
// asserts the result parses as well-formed XML. This is a regression guard:
// without escapeXML, an unescaped "&"/"<" in BinaryPath corrupts the plist
// and fails to load in launchd. Only Execute() runs here — no file writes,
// no launchctl, this never touches ~/Library/LaunchAgents.
func TestPlistTemplateEscapesBinaryPath(t *testing.T) {
	evil := `/tmp/a & b <hack> "quoted"/tmux-webui`
	data := struct {
		Label      string
		BinaryPath string
		StdoutLog  string
		StderrLog  string
	}{
		Label:      plistLabel,
		BinaryPath: escapeXML(evil),
		StdoutLog:  "/tmp/stdout.log",
		StderrLog:  "/tmp/stderr.log",
	}
	var buf bytes.Buffer
	if err := plistTmpl.Execute(&buf, data); err != nil {
		t.Fatalf("template execute: %v", err)
	}
	var doc struct {
		XMLName xml.Name `xml:"plist"`
	}
	if err := xml.Unmarshal(buf.Bytes(), &doc); err != nil {
		t.Fatalf("rendered plist is not well-formed XML: %v\n%s", err, buf.String())
	}
	if !strings.Contains(buf.String(), "&amp;") {
		t.Errorf("expected escaped ampersand in rendered plist, got:\n%s", buf.String())
	}
}

// TestSystemdUnitTemplateEscapesBinaryPath renders the real unit template
// with a path containing systemd metacharacters (space + "%") and asserts
// ExecStart carries the escaped, quoted form instead of a raw path that
// would either be word-split or trigger specifier expansion.
func TestSystemdUnitTemplateEscapesBinaryPath(t *testing.T) {
	evil := "/opt/100% used/tmux-webui"
	data := struct{ BinaryPath string }{BinaryPath: escapeSystemdExec(evil)}

	var buf bytes.Buffer
	if err := unitTmpl.Execute(&buf, data); err != nil {
		t.Fatalf("template execute: %v", err)
	}
	got := buf.String()
	wantLine := `ExecStart="/opt/100%% used/tmux-webui" serve`
	if !strings.Contains(got, wantLine) {
		t.Errorf("rendered unit missing escaped ExecStart line %q, got:\n%s", wantLine, got)
	}
}
