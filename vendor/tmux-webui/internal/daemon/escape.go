package daemon

import (
	"encoding/xml"
	"strings"
)

// escapeXML escapes s for safe inclusion as XML character data (a plist
// <string> element's text) — text/template does no escaping on its own
// (unlike html/template), so a BinaryPath containing "&", "<", ">", quotes,
// or control characters would otherwise corrupt the generated plist.
func escapeXML(s string) string {
	var b strings.Builder
	if err := xml.EscapeText(&b, []byte(s)); err != nil {
		// EscapeText only errors on writer failures; strings.Builder never
		// fails a Write, so this is unreachable in practice.
		return s
	}
	return b.String()
}

// escapeSystemdExec escapes s for safe use as a single ExecStart= argument.
// Per systemd.service(5): "%" begins a specifier expansion (escape as "%%"),
// and the line is word-split like a shell, so a path containing whitespace
// or a quote must be double-quoted (with embedded backslashes/quotes
// escaped) to survive as one argv entry.
func escapeSystemdExec(s string) string {
	s = strings.ReplaceAll(s, "%", "%%")
	if !strings.ContainsAny(s, " \t\"'\\") {
		return s
	}
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}
