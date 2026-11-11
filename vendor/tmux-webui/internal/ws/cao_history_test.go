package ws

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestCAOHistoryFrozenPagesAtEviction(t *testing.T) {
	cache := &caoHistoryCache{}
	target := CAOTarget{Session: "cao-test", PaneID: "%1", Terminal: "abc"}
	rows := make([]string, 1220)
	for i := range rows {
		rows[i] = fmt.Sprintf("ROW_%04d", i)
	}
	id, frozen := cache.put(target, "%1", "same-count-and-bytes", strings.Join(rows, "\n")+"\n", 20)
	page, exhausted := frozen.page(500, 0)
	if !strings.HasPrefix(page, "ROW_0700\n") || !strings.Contains(page, "ROW_1219") || exhausted {
		t.Fatal("first page shape")
	}
	// tmux can now evict old equal-width lines without changing metadata; the
	// next page must remain relative to the original immutable capture.
	next, ok := cache.get(id, target, "%1", "same-count-and-bytes")
	if !ok {
		t.Fatal("missing immutable page")
	}
	page, exhausted = next.page(500, 500)
	if !strings.HasPrefix(page, "ROW_0200\n") || !strings.HasSuffix(page, "ROW_0699\n") || exhausted {
		t.Fatal("overlap or gap")
	}
	page, exhausted = next.page(500, 1000)
	if !strings.HasPrefix(page, "ROW_0000\n") || !strings.HasSuffix(page, "ROW_0199\n") || !exhausted {
		t.Fatal("oldest page")
	}
	wrong := target
	wrong.Terminal = "other"
	if _, ok := cache.get(id, wrong, "%1", "same-count-and-bytes"); ok {
		t.Fatal("foreign target")
	}
	if _, ok := cache.get(id, target, "%2", "same-count-and-bytes"); ok {
		t.Fatal("foreign pane")
	}
	if _, ok := cache.get(id, target, "%1", "changed"); ok {
		t.Fatal("changed boundary")
	}
	item := cache.items[id]
	item.expires = time.Now().Add(-time.Second)
	cache.items[id] = item
	if _, ok := cache.get(id, target, "%1", "same-count-and-bytes"); ok {
		t.Fatal("expired page")
	}
}

func TestCAOHistoryCacheBounded(t *testing.T) {
	cache := &caoHistoryCache{}
	for i := 0; i < 100; i++ {
		cache.put(CAOTarget{}, "%1", "b", "one\n", 1)
	}
	if len(cache.items) != caoHistorySnapshots {
		t.Fatal("unbounded cache")
	}
}
