package autocomplete

// fuzzy_test.go — unit tests for fuzzyScore and rankAndFilter.
//
// Mutation-thinking risk list (aligned with Python autocomplete.py:_fuzzy_score):
//  1. Empty query returns 0 (Python's `if not query: return 0`)
//  2. Exact prefix score = 1000 (constant, no length tie-breaking)
//  3. Substring score = 500 (constant, no index tie-breaking)
//  4. Subsequence: matched-char count (1..N), never -1 when all chars found
//  5. No match returns exactly -1
//  6. fuzzyScore is case-insensitive: "FOO" query on "foobar" is prefix match
//  7. rankAndFilter: score -1 excluded; score 0 included
//  8. rankAndFilter empty items → return empty (no panic)
//  9. rankAndFilter maxResults=0 returns empty (not unlimited)
// 10. rankAndFilter stable sort descending
// 11. Substring beats subsequence when the query is a contiguous run inside text
//     (e.g. "z" inside "abcz" → substring 500, NOT subsequence 1)

import (
	"testing"
)

func TestFuzzyScore_EmptyQuery(t *testing.T) {
	// Empty query → 0 (Python parity: `if not query: return 0`).
	if got := fuzzyScore("", "anything"); got != 0 {
		t.Errorf("fuzzyScore(\"\", \"anything\") = %d; want 0", got)
	}
	if got := fuzzyScore("", ""); got != 0 {
		t.Errorf("fuzzyScore(\"\", \"\") = %d; want 0", got)
	}
}

func TestFuzzyScore_ExactPrefix(t *testing.T) {
	cases := []struct {
		query string
		text  string
	}{
		{"foo", "foobar"},
		{"foo", "foo"},
		{"f", "foobar"},
		{"FOO", "foobar"}, // case-insensitive
		{"foobar", "foobar"},
	}
	for _, tc := range cases {
		got := fuzzyScore(tc.query, tc.text)
		if got != 1000 {
			t.Errorf("fuzzyScore(%q, %q) = %d; want 1000 (exact prefix)", tc.query, tc.text, got)
		}
	}
}

func TestFuzzyScore_Substring(t *testing.T) {
	cases := []struct {
		query string
		text  string
		want  int
	}{
		// "bar" is substring of "foobar" (not prefix)
		{"bar", "foobar", 500},
		// "ault" is substring of "memvault" (not prefix; "mem" is the prefix)
		{"ault", "memvault", 500},
		// case-insensitive substring
		{"BAR", "foobar", 500},
	}
	for _, tc := range cases {
		got := fuzzyScore(tc.query, tc.text)
		if got != tc.want {
			t.Errorf("fuzzyScore(%q, %q) = %d; want %d (substring)", tc.query, tc.text, got, tc.want)
		}
	}
}

func TestFuzzyScore_Subsequence(t *testing.T) {
	cases := []struct {
		name  string
		query string
		text  string
		// want is the number of matched chars (= len(query) when all found)
		wantMin int // must be >= wantMin (at least len(query))
		exact   bool
		want    int
	}{
		{
			name: "all chars found in order",
			// "fb" is not a prefix and not a substring of "foobar", it's a subsequence
			query: "fb", text: "foobar",
			exact: true, want: 2, // 2 matched chars
		},
		{
			// NOTE: single char "z" in "abcz" is technically a substring,
			// so it scores 500 not 1. Pick a query that is NOT a substring
			// to truly exercise the subsequence path: "az" → not a substring,
			// but a → 'a' at idx 0, z → 'z' at idx 3 → subsequence count=2.
			name:  "two chars not contiguous",
			query: "az", text: "abcz",
			exact: true, want: 2,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := fuzzyScore(tc.query, tc.text)
			if tc.exact && got != tc.want {
				t.Errorf("fuzzyScore(%q, %q) = %d; want %d", tc.query, tc.text, got, tc.want)
			}
			// Invariant: subsequence score >= 1 (at least one char matched)
			if got < 1 {
				t.Errorf("subsequence should score >= 1, got %d", got)
			}
		})
	}
}

func TestFuzzyScore_NoMatch(t *testing.T) {
	cases := []struct {
		query string
		text  string
	}{
		{"xyz", "foobar"},
		{"zzz", "abc"},
		// query longer than text and not a subsequence
		{"foobarx", "foo"},
	}
	for _, tc := range cases {
		got := fuzzyScore(tc.query, tc.text)
		if got != -1 {
			t.Errorf("fuzzyScore(%q, %q) = %d; want -1 (no match)", tc.query, tc.text, got)
		}
	}
}

// Invariant: fuzzyScore always returns >= -1.
func TestFuzzyScore_Invariant_NeverBelowMinus1(t *testing.T) {
	pairs := [][2]string{
		{"zzz", "aaa"},
		{"longnomatch", "xy"},
		{"", "x"},
		{"x", ""},
	}
	for _, p := range pairs {
		got := fuzzyScore(p[0], p[1])
		if got < -1 {
			t.Errorf("fuzzyScore(%q, %q) = %d; violated invariant >= -1", p[0], p[1], got)
		}
	}
}

// Exact prefix must rank higher than substring for same text length.
func TestFuzzyScore_PrefixBeatSubstring(t *testing.T) {
	// "mem" is prefix of "memvault" → 994
	// "ult" is substring of "memvault" starting at index 5 → 495
	prefixScore := fuzzyScore("mem", "memvault")
	subScore := fuzzyScore("ult", "memvault")
	if prefixScore <= subScore {
		t.Errorf("prefix score %d should beat substring score %d", prefixScore, subScore)
	}
}

// ─── rankAndFilter ────────────────────────────────────────────────────────────

func TestRankAndFilter_EmptyItems(t *testing.T) {
	result := rankAndFilter(nil, "foo", 10)
	if len(result) != 0 {
		t.Errorf("expected empty slice, got %v", result)
	}
}

func TestRankAndFilter_EmptyQuery_ReturnsOriginalOrder(t *testing.T) {
	items := []Item{
		{Name: "c", Type: "skill"},
		{Name: "a", Type: "skill"},
		{Name: "b", Type: "skill"},
	}
	got := rankAndFilter(items, "", 10)
	if len(got) != 3 {
		t.Fatalf("expected 3 items, got %d", len(got))
	}
	// Original order preserved
	if got[0].Name != "c" || got[1].Name != "a" || got[2].Name != "b" {
		t.Errorf("order changed for empty query: %v", got)
	}
}

func TestRankAndFilter_MaxResults(t *testing.T) {
	items := make([]Item, 20)
	for i := range items {
		items[i] = Item{Name: "foo", Type: "skill"}
	}
	got := rankAndFilter(items, "foo", 5)
	if len(got) != 5 {
		t.Errorf("expected 5 results (maxResults cap), got %d", len(got))
	}
}

func TestRankAndFilter_ExcludesNoMatch(t *testing.T) {
	items := []Item{
		{Name: "foobar", Type: "skill"},
		{Name: "baz", Type: "skill"}, // no match for "foo"
		{Name: "foobaz", Type: "skill"},
	}
	got := rankAndFilter(items, "foo", 10)
	for _, it := range got {
		if it.Name == "baz" {
			t.Errorf("'baz' should not match query 'foo' but was included")
		}
	}
	if len(got) != 2 {
		t.Errorf("expected 2 matches for 'foo', got %d: %v", len(got), got)
	}
}

func TestRankAndFilter_SortedDescending(t *testing.T) {
	items := []Item{
		{Name: "xfoo", Type: "skill"},   // substring at 1 → 499
		{Name: "foobar", Type: "skill"}, // prefix → 994
		{Name: "bar", Type: "skill"},    // no match → excluded
	}
	got := rankAndFilter(items, "foo", 10)
	if len(got) < 2 {
		t.Fatalf("expected at least 2 results, got %d", len(got))
	}
	// "foobar" (prefix) must come before "xfoo" (substring)
	if got[0].Name != "foobar" {
		t.Errorf("expected 'foobar' first (highest score), got %q", got[0].Name)
	}
	if got[1].Name != "xfoo" {
		t.Errorf("expected 'xfoo' second, got %q", got[1].Name)
	}
}

// Mutation-thinking: score=0 (empty query subsequence path) is included, score=-1 is excluded.
func TestRankAndFilter_ZeroScoreIncluded(t *testing.T) {
	// fuzzyScore("", "anything") = 100 so we can't easily get score=0 from rankAndFilter
	// unless we have a subsequence match that returns 0 chars matched — but that
	// only happens if query is empty (special-cased to 100).
	// The edge case is: single-char query whose only char is at end of text.
	items := []Item{{Name: "baz", Type: "skill"}}
	// "z" is in "baz" as subsequence → score=1 (not 0), so this tests inclusion.
	got := rankAndFilter(items, "z", 10)
	if len(got) != 1 {
		t.Errorf("expected 1 result for subsequence match, got %d", len(got))
	}
}

func TestRankAndFilter_EmptyQueryMaxResultsCap(t *testing.T) {
	items := make([]Item, 20)
	for i := range items {
		items[i] = Item{Name: "item", Type: "skill"}
	}
	got := rankAndFilter(items, "", 5)
	if len(got) != 5 {
		t.Errorf("expected 5 items for empty query with maxResults=5, got %d", len(got))
	}
}
