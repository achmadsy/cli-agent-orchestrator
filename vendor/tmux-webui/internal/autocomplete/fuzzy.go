package autocomplete

import (
	"sort"
	"strings"
)

// fuzzyScore returns a numeric match quality between query and text.
// 1:1 port of stations/tmux-webui/autocomplete.py:_fuzzy_score:
//
//	1000 : exact prefix match
//	500  : substring match
//	1..N : subsequence match (count of query chars found in order)
//	-1   : no match (query couldn't fit as a subsequence)
//	0    : empty query
//
// Position-aware tie-breaking is intentionally NOT applied (would diverge
// from Python and surprise users porting from the old backend). v0.2 may
// add a configurable ranking strategy.
func fuzzyScore(query, text string) int {
	if query == "" {
		return 0
	}
	q := strings.ToLower(query)
	t := strings.ToLower(text)

	if strings.HasPrefix(t, q) {
		return 1000
	}
	if strings.Contains(t, q) {
		return 500
	}

	qi := 0
	for _, ch := range t {
		if qi < len(q) && ch == rune(q[qi]) {
			qi++
		}
	}
	if qi == len(q) {
		return qi
	}
	return -1
}

// rankAndFilter filters items whose fuzzy score against query is >= 0,
// sorts them by score descending, and returns the top maxResults.
// If query is empty, the original slice (up to maxResults) is returned as-is.
func rankAndFilter(items []Item, query string, maxResults int) []Item {
	if query == "" {
		if len(items) <= maxResults {
			return items
		}
		return items[:maxResults]
	}

	type scored struct {
		score int
		item  Item
	}

	results := make([]scored, 0, len(items))
	for _, it := range items {
		s := fuzzyScore(query, it.Name)
		if s >= 0 {
			results = append(results, scored{s, it})
		}
	}

	// Sort descending by score. Stable keeps scanner order on ties — same
	// observable order the old insertion sort produced, but O(n log n): the
	// "@" file candidates can push N past 20k, where insertion sort stalls.
	sort.SliceStable(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	limit := len(results)
	if limit > maxResults {
		limit = maxResults
	}
	out := make([]Item, limit)
	for i := range out {
		out[i] = results[i].item
	}
	return out
}
