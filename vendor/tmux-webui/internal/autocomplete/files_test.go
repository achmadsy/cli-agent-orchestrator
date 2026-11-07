package autocomplete

// files_test.go — unit tests for the "@" file completion path: walkListFiles,
// gitListFiles, fileLister caching, and CompleteIn routing.
//
// Mutation-thinking risk list:
//  1. walkListFiles must return paths RELATIVE to root (an absolute path in a
//     suggestion would insert an @path the pane CLI can't resolve)
//  2. walkListFiles prunes node_modules/.git-style dirs and hidden entries
//  3. gitListFiles returns nil (not empty) outside a repo → fallback fires
//  4. gitListFiles respects .gitignore and still lists untracked files
//  5. fileLister serves a fresh listing after TTL expiry, cached within it
//  6. CompleteIn with cwd merges file items into the "@" branch;
//     Complete (no cwd) must NOT leak file items
//  7. typeFilter "file" narrows to files only (no agents/mcp)
//  8. Ranking: prefix match beats subsequence match among files

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// fixtureTree builds:
//
//	root/
//	  README.md
//	  internal/server/main.go
//	  node_modules/junk.js   (pruned dir)
//	  .hidden/secret.txt     (pruned dir)
//	  .dotfile               (hidden file)
func fixtureTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, d := range []string{"internal/server", "node_modules", ".hidden"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{
		"README.md",
		"internal/server/main.go",
		"node_modules/junk.js",
		".hidden/secret.txt",
		".dotfile",
	} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func hasEntry(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// ─── walkListFiles ───────────────────────────────────────────────────────────

func TestWalkListFiles_RelativeAndPruned(t *testing.T) {
	root := fixtureTree(t)
	files := walkListFiles(root)

	if !hasEntry(files, "README.md") {
		t.Errorf("missing root file; got %v", files)
	}
	if !hasEntry(files, filepath.Join("internal", "server", "main.go")) {
		t.Errorf("missing nested file (must be RELATIVE); got %v", files)
	}
	if hasEntry(files, filepath.Join("node_modules", "junk.js")) {
		t.Errorf("node_modules not pruned; got %v", files)
	}
	if hasEntry(files, filepath.Join(".hidden", "secret.txt")) || hasEntry(files, ".dotfile") {
		t.Errorf("hidden entries not skipped; got %v", files)
	}
}

// ─── gitListFiles ────────────────────────────────────────────────────────────

func TestGitListFiles_NonRepoReturnsNil(t *testing.T) {
	if files := gitListFiles(t.TempDir()); files != nil {
		t.Errorf("non-repo root: want nil (fallback trigger), got %v", files)
	}
}

func TestGitListFiles_RespectsGitignoreAndUntracked(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"tracked.go", "untracked.md", "ignored.log"} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("add", "tracked.go")

	files := gitListFiles(root)
	if files == nil {
		t.Fatal("repo root: got nil, want listing")
	}
	if !hasEntry(files, "tracked.go") || !hasEntry(files, "untracked.md") {
		t.Errorf("tracked/untracked missing; got %v", files)
	}
	if hasEntry(files, "ignored.log") {
		t.Errorf(".gitignore not respected; got %v", files)
	}
}

// ─── fileLister cache ────────────────────────────────────────────────────────

func TestFileLister_CachesWithinTTLAndRefreshesAfter(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	fl := newFileLister()
	first := fl.list(root)
	if !hasEntry(first, "a.txt") {
		t.Fatalf("initial listing missing a.txt: %v", first)
	}

	// New file appears on disk — cached listing must NOT see it yet.
	if err := os.WriteFile(filepath.Join(root, "b.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if cached := fl.list(root); hasEntry(cached, "b.txt") {
		t.Error("listing not served from cache within TTL")
	}

	// Expire the entry (white-box) — refresh must pick b.txt up.
	fl.mu.Lock()
	e := fl.cache[root]
	e.at = time.Now().Add(-2 * fileListTTL)
	fl.cache[root] = e
	fl.mu.Unlock()
	if fresh := fl.list(root); !hasEntry(fresh, "b.txt") {
		t.Errorf("expired cache not refreshed: %v", fresh)
	}
}

// ─── CompleteIn routing ──────────────────────────────────────────────────────

func TestCompleteIn_MergesFilesIntoAtBranch(t *testing.T) {
	root := fixtureTree(t)
	e := New(Options{})
	defer e.Close()

	items := e.CompleteIn(root, "@readme", "at")
	found := false
	for _, it := range items {
		if it.Type == "file" && it.Name == "README.md" {
			found = true
		}
	}
	if !found {
		t.Errorf("@readme with cwd: file item missing; got %+v", items)
	}
}

func TestComplete_NoCwdNeverLeaksFiles(t *testing.T) {
	e := New(Options{})
	defer e.Close()
	for _, it := range e.Complete("@readme", "at") {
		if it.Type == "file" {
			t.Fatalf("Complete without cwd returned file item %+v", it)
		}
	}
}

func TestCompleteIn_FileFilterNarrows(t *testing.T) {
	root := fixtureTree(t)
	e := New(Options{})
	defer e.Close()

	items := e.CompleteIn(root, "@", "file")
	if len(items) == 0 {
		t.Fatal("file filter with cwd returned nothing")
	}
	for _, it := range items {
		if it.Type != "file" {
			t.Errorf("file filter leaked %q item %q", it.Type, it.Name)
		}
	}
}

func TestCompleteIn_PrefixBeatsSubsequence(t *testing.T) {
	root := t.TempDir()
	for _, f := range []string{"main.go", "domain.gob"} { // "main" = prefix vs subsequence
		if err := os.WriteFile(filepath.Join(root, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := New(Options{})
	defer e.Close()

	items := e.CompleteIn(root, "@main", "file")
	if len(items) < 2 {
		t.Fatalf("want both fixtures matched, got %+v", items)
	}
	if items[0].Name != "main.go" {
		t.Errorf("prefix match must rank first; got %q", items[0].Name)
	}
}
