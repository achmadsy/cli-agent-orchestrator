package ws

// Region extraction for the agent-state classifier — a clean-room Go port of
// the region algorithms in workshop's libs/agent-state (regions.py) and the
// herdr detection engine's manifest.rs. herdr is AGPL-3.0; NO source was
// copied. The algorithms below (horizontal-rule detection, prompt-box body
// isolation, bottom-non-empty windowing) are re-derived from the documented
// engine semantics and validated against the real Claude Code TUI chrome in
// internal/ws/testdata/deck-state-fixtures.json.
//
// Every function takes the pane's screen as an already-ANSI-stripped slice of
// lines (see splitLines) and returns the sub-slice a rule matches against.
// When a region's anchor cannot be found, the convention matches herdr:
//   - promptBoxBody       → (nil, false): rule simply does not match.
//   - afterLastHorizontalRule → whole content (NOT empty) when no rule exists.
//   - bottomNonEmptyLines → nil when the screen has no non-empty line.
// The two no-anchor fallbacks intentionally differ; callers must not unify them.

import (
	"regexp"
	"strings"
	"unicode"
)

// horizontalRuleRune is U+2500 BOX DRAWINGS LIGHT HORIZONTAL (`─`) — the glyph
// Claude renders for prompt-box borders and plan separators. NOT ASCII '-',
// and NOT the light-double-dash `╌` (U+254C) some plan screens use, so those
// screens correctly have "no rule" and fall back to whole-content regions.
const horizontalRuleRune = '─'

// splitLines splits on '\n' and strips a trailing '\r' per line (CRLF-safe),
// mirroring Rust's str::lines() so the port stays byte-faithful.
func splitLines(s string) []string {
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	return lines
}

// isHorizontalRule reports whether a line is a box-drawing horizontal rule.
// A line qualifies when, after trimming both ends, it begins with a run of
// U+2500 that either spans the whole (trimmed) line or is at least 3 long even
// with trailing text (so `─── Title` qualifies but `── Title` does not, and a
// lone `─` qualifies). Only a LEADING run counts.
func isHorizontalRule(line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	runes := []rune(trimmed)
	ruleChars := 0
	for ruleChars < len(runes) && runes[ruleChars] == horizontalRuleRune {
		ruleChars++
	}
	if ruleChars == 0 {
		return false
	}
	suffix := strings.TrimLeftFunc(string(runes[ruleChars:]), unicode.IsSpace)
	return suffix == "" || ruleChars >= 3
}

// wholeRecent returns the entire screen unchanged.
func wholeRecent(lines []string) []string { return lines }

// afterLastHorizontalRule returns every line below the bottom-most horizontal
// rule. When the screen has no rule at all it returns the WHOLE content (herdr
// semantics — this fallback differs from promptBoxBody's).
func afterLastHorizontalRule(lines []string) []string {
	last := -1
	for i, l := range lines {
		if isHorizontalRule(l) {
			last = i
		}
	}
	if last < 0 {
		return lines
	}
	return lines[last+1:]
}

// promptBoxMaxTrailing is the most non-empty lines allowed BELOW the composer
// box's bottom border: the status bar (🔖 / 🤖 / ⏵⏵) plus one hint line. A
// rule-pair deeper in scrollback (streamed content below it) is not the box.
const promptBoxMaxTrailing = 4

// promptBoxBody returns the lines strictly between the composer box's top and
// bottom borders (both excluded). ok=false when no box is present — callers
// treat that as "rule does not match" (herdr maps it to empty text).
//
// The composer box is SHAPE-matched, not just rule-pair-matched (real capture
// 2026-07-02, CC v2.1.198): it is the bottom-most pair of ─ rules whose
// interior STARTS with the ❯ input line (empty, or holding typed/wrapped
// input) and whose bottom border has only the status bar beneath it. Both
// constraints kill screens the old any-two-rules scan misread as a box:
//   - AskUserQuestion menus carry an INTERNAL ─ rule (between the listed
//     options and "N. Chat about this"), so the menu body ("☐ …" header first)
//     read as a box interior and the hasBox gate short-circuited
//     live_blocked_form → the pane read idle while blocked on the human.
//   - Streamed output quoting box chrome (a "❯ …" line between two ─
//     separators mid-scrollback) fabricated a box on a working pane.
//
// Known reliance: the internal-rule defense assumes real select menus put a
// header ("☐ …" + the question) before the first option, so the interior of
// their rule pair is NOT ❯-led. A hypothetical headerless menu whose first
// interior line is the ❯ cursor option would read as a box; no such menu has
// been observed on the real TUI.
func promptBoxBody(lines []string) ([]string, bool) {
	top, bottom, ok := promptBoxSpan(lines)
	if !ok {
		return nil, false
	}
	return lines[top+1 : bottom], true
}

// promptBoxSpan locates the composer box and returns the indices of its top
// and bottom border lines. ok=false when no shape-valid box is present.
func promptBoxSpan(lines []string) (top, bottom int, ok bool) {
	// bottom border: the bottom-most rule with ≤ promptBoxMaxTrailing
	// non-empty lines below it.
	bottom = -1
	trailing := 0
	for i := len(lines) - 1; i >= 0; i-- {
		if isHorizontalRule(lines[i]) {
			bottom = i
			break
		}
		if strings.TrimSpace(lines[i]) != "" {
			trailing++
			if trailing > promptBoxMaxTrailing {
				return 0, 0, false
			}
		}
	}
	if bottom < 0 {
		return 0, 0, false
	}
	top = -1
	for i := bottom - 1; i >= 0; i-- {
		if isHorizontalRule(lines[i]) {
			top = i
			break
		}
	}
	if top < 0 {
		return 0, 0, false
	}
	// shape: the first non-empty interior line must be the ❯ input line.
	for _, l := range lines[top+1 : bottom] {
		if strings.TrimSpace(l) == "" {
			continue
		}
		if rePromptLine.MatchString(l) {
			return top, bottom, true
		}
		return 0, 0, false
	}
	return 0, 0, false // empty interior (adjacent rules) is not an input box
}

// bottomNonEmptyLines anchors at the n-th-from-bottom non-empty line (or the
// top-most non-empty line when fewer than n exist) and returns from there to
// the true end of the screen — blank lines in between are kept verbatim, per
// herdr. Returns nil when n<=0 or the screen has no non-empty line.
func bottomNonEmptyLines(lines []string, n int) []string {
	if n <= 0 {
		return nil
	}
	anchor := -1
	count := 0
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			anchor = i
			count++
			if count == n {
				break
			}
		}
	}
	if anchor < 0 {
		return nil
	}
	return lines[anchor:]
}

// ── gate helpers (herdr gate_matches semantics on a region slice) ───────────

// regionText joins region lines with '\n' (for whole-region contains/regex).
func regionText(region []string) string { return strings.Join(region, "\n") }

// regionContainsAll reports whether the (lowercased) region contains EVERY
// needle. Needles must already be lowercase. Empty needle list → true.
func regionContainsAll(region, needles []string) bool {
	lower := strings.ToLower(regionText(region))
	for _, n := range needles {
		if !strings.Contains(lower, n) {
			return false
		}
	}
	return true
}

// regionContainsAny reports whether the (lowercased) region contains ANY
// needle. Needles must already be lowercase. Empty needle list → false.
func regionContainsAny(region, needles []string) bool {
	lower := strings.ToLower(regionText(region))
	for _, n := range needles {
		if strings.Contains(lower, n) {
			return true
		}
	}
	return false
}

// regionLineMatch reports whether ANY single line in the region matches re
// (herdr line_regex semantics — anchors like ^/$ bind to one line).
func regionLineMatch(region []string, re *regexp.Regexp) bool {
	for _, l := range region {
		if re.MatchString(l) {
			return true
		}
	}
	return false
}
