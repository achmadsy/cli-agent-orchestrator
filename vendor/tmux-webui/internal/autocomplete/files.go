package autocomplete

// files.go — recursive file completion backing the "@" trigger.
//
// Unlike path.go (explicit "~/"/"./" prefixes, one directory level at a
// time), this is the fzf-style search: list every file under a root (the
// TARGET PANE's cwd — the CLI inside the pane resolves "@path" against its
// own working directory, not the server's), fuzzy-rank the relative paths,
// and return the best matches.
//
// Listing prefers `git ls-files` (respects .gitignore, fast even on large
// repos) and falls back to a bounded filepath.WalkDir for non-repo roots.

import (
	"context"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// fileListTTL bounds how stale a cached listing may be. Keystrokes within
	// a typing burst reuse the cache; a new file shows up within seconds.
	fileListTTL = 15 * time.Second

	// maxFileList caps the candidate pool per root.
	// ponytail: flat cap drops files beyond 20k in huge monorepo roots;
	// switch to incremental/indexed listing if that ever bites.
	maxFileList = 20000

	// walkMaxDepth bounds the non-git fallback walk.
	walkMaxDepth = 8

	gitListTimeout = 3 * time.Second
)

// walkSkipDirs are pruned during the non-git fallback walk — the usual
// .gitignore suspects. Without this a node_modules blows straight past
// maxFileList with junk before real files are seen.
var walkSkipDirs = map[string]bool{
	".git": true, "node_modules": true, ".venv": true, "venv": true,
	"__pycache__": true, ".cache": true, "dist": true, "build": true,
	"target": true, ".worktrees": true,
}

type fileCacheEntry struct {
	files []string
	at    time.Time
}

// fileLister caches per-root file listings. Concurrent misses on the same
// root may scan twice; harmless (last write wins, both results equivalent).
type fileLister struct {
	mu    sync.Mutex
	cache map[string]fileCacheEntry
}

func newFileLister() *fileLister {
	return &fileLister{cache: map[string]fileCacheEntry{}}
}

// list returns relative file paths under root, cached for fileListTTL.
func (fl *fileLister) list(root string) []string {
	fl.mu.Lock()
	if e, ok := fl.cache[root]; ok && time.Since(e.at) < fileListTTL {
		fl.mu.Unlock()
		return e.files
	}
	fl.mu.Unlock() // release during the potentially slow scan

	files := gitListFiles(root)
	if files == nil {
		files = walkListFiles(root)
	}

	fl.mu.Lock()
	fl.cache[root] = fileCacheEntry{files: files, at: time.Now()}
	fl.mu.Unlock()
	return files
}

// gitListFiles returns tracked + untracked-unignored files relative to root,
// or nil when root is not inside a git work tree (or git is unavailable) so
// the caller falls back to walking. `-C root` makes the output relative to
// root even when root is a subdirectory of the repo.
func gitListFiles(root string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), gitListTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", root,
		"ls-files", "--cached", "--others", "--exclude-standard", "-z").Output()
	if err != nil {
		return nil
	}
	parts := strings.Split(string(out), "\x00")
	files := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" {
			continue
		}
		files = append(files, p)
		if len(files) >= maxFileList {
			break
		}
	}
	return files
}

// walkListFiles is the non-git fallback: bounded-depth walk skipping hidden
// entries and walkSkipDirs (mirrors path.go's hidden-skip convention; inside
// a git repo dotfiles ARE reachable via the gitListFiles path).
func walkListFiles(root string) []string {
	files := []string{}
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry: skip, not fatal
		}
		if p == root {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		if d.IsDir() {
			if walkSkipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			if strings.Count(rel, string(filepath.Separator)) >= walkMaxDepth {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		files = append(files, rel)
		if len(files) >= maxFileList {
			return fs.SkipAll
		}
		return nil
	})
	return files
}

// fileCandidates wraps the root's listing as Items for ranking alongside
// agents/mcp in the "@" branch.
func (e *Engine) fileCandidates(root string) []Item {
	names := e.files.list(root)
	items := make([]Item, 0, len(names))
	for _, n := range names {
		items = append(items, Item{
			Name:   n,
			Type:   "file",
			Icon:   "@",
			Source: "fs",
		})
	}
	return items
}
