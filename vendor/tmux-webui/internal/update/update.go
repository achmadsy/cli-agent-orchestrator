// Package update implements self-update via GitHub Releases using minio/selfupdate.
package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/minio/selfupdate"
)

// ghReleasesURL is a var (not const) so tests can point it at an httptest server.
var ghReleasesURL = "https://api.github.com/repos/operonlab/tmux-webui/releases/latest"

// Size caps guard against OOM from a malicious or corrupt release asset. They
// are vars so tests can shrink them to trigger the cap without a huge fixture.
var (
	maxDownloadBytes     int64 = 200 << 20 // 200MB compressed tarball
	maxDecompressedBytes int64 = 500 << 20 // 500MB extracted binary
	maxChecksumBytes     int64 = 1 << 20   // sha256 line is tiny; bound it anyway
)

type ghRelease struct {
	TagName string    `json:"tag_name"`
	Assets  []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// LatestVersion fetches the latest release tag from GitHub without downloading.
func LatestVersion() (string, error) {
	rel, err := fetchRelease()
	if err != nil {
		return "", err
	}
	return strings.TrimPrefix(rel.TagName, "v"), nil
}

// Apply downloads the release binary for the current OS/arch and replaces the running binary.
func Apply() error {
	rel, err := fetchRelease()
	if err != nil {
		return err
	}

	tarName := fmt.Sprintf("tmux-webui_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	checksumName := tarName + ".sha256"

	tarURL, checksumURL := "", ""
	for _, a := range rel.Assets {
		switch a.Name {
		case tarName:
			tarURL = a.BrowserDownloadURL
		case checksumName:
			checksumURL = a.BrowserDownloadURL
		}
	}
	if tarURL == "" {
		return fmt.Errorf("no release asset found for %s/%s (looking for %s)", runtime.GOOS, runtime.GOARCH, tarName)
	}
	// Checksum is mandatory: a missing .sha256 asset aborts before we download
	// anything, so an unverifiable release is never applied.
	if checksumURL == "" {
		return fmt.Errorf("no checksum asset %s in release — refusing update (checksum verification is mandatory)", checksumName)
	}

	fmt.Printf("Downloading %s ...\n", tarURL)
	tarData, err := httpGet(tarURL, maxDownloadBytes)
	if err != nil {
		return fmt.Errorf("download tarball: %w", err)
	}

	// Verify checksum (mandatory): a fetch error, empty file, or mismatch aborts.
	// ponytail: sha256-from-same-release only; real signing needs release
	// infra (cosign/minisign) — do before promoting update as a trusted path.
	checksumData, err := httpGet(checksumURL, maxChecksumBytes)
	if err != nil {
		return fmt.Errorf("download checksum: %w", err)
	}
	fields := strings.Fields(string(checksumData))
	if len(fields) == 0 {
		return fmt.Errorf("checksum asset %s is empty", checksumName)
	}
	expected := fields[0]
	actual := fmt.Sprintf("%x", sha256.Sum256(tarData))
	if actual != expected {
		return fmt.Errorf("checksum mismatch: got %s, expected %s", actual, expected)
	}
	fmt.Println("Checksum verified.")

	// Extract binary from tarball.
	binary, err := extractBinary(tarData, maxDecompressedBytes)
	if err != nil {
		return fmt.Errorf("extract binary: %w", err)
	}

	fmt.Println("Applying update...")
	if err := selfupdate.Apply(bytes.NewReader(binary), selfupdate.Options{}); err != nil {
		return fmt.Errorf("selfupdate apply: %w", err)
	}
	fmt.Printf("Updated to %s. Restart tmux-webui to use the new version.\n", rel.TagName)
	return nil
}

func fetchRelease() (*ghRelease, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest("GET", ghReleasesURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	req.Header.Set("User-Agent", "tmux-webui-updater")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}

	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("parse release JSON: %w", err)
	}
	return &rel, nil
}

func httpGet(url string, limit int64) ([]byte, error) {
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	// Read one extra byte past the cap so an oversized body is detectable
	// instead of silently truncated.
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("download from %s exceeds %d bytes", url, limit)
	}
	return data, nil
}

func extractBinary(tarData []byte, maxBytes int64) ([]byte, error) {
	gr, err := gzip.NewReader(bytes.NewReader(tarData))
	if err != nil {
		return nil, err
	}
	defer gr.Close()

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		// The binary is named "tmux-webui" (no extension) inside the tarball.
		if hdr.Name == "tmux-webui" || strings.HasSuffix(hdr.Name, "/tmux-webui") {
			// LimitReader guards against a decompression bomb; read one extra
			// byte past the cap so overflow is detectable, not truncated.
			data, err := io.ReadAll(io.LimitReader(tr, maxBytes+1))
			if err != nil {
				return nil, err
			}
			if int64(len(data)) > maxBytes {
				return nil, fmt.Errorf("decompressed binary exceeds %d bytes", maxBytes)
			}
			return data, nil
		}
	}
	return nil, fmt.Errorf("tmux-webui binary not found in tarball")
}
