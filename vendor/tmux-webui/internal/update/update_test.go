package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
)

// makeTarGz builds a gzip'd tarball containing a single file.
func makeTarGz(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body))}); err != nil {
		t.Fatalf("write tar header: %v", err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatalf("write tar body: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buf.Bytes()
}

// releaseServer stands in for GitHub Releases: it serves the release JSON at
// /releases/latest and each named asset under /download/<name>. Asset URLs
// point back at the server so Apply's whole flow runs with no real network.
func releaseServer(t *testing.T, assets map[string][]byte) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		rel := ghRelease{TagName: "v9.9.9"}
		for name := range assets {
			rel.Assets = append(rel.Assets, ghAsset{
				Name:               name,
				BrowserDownloadURL: srv.URL + "/download/" + name,
			})
		}
		_ = json.NewEncoder(w).Encode(rel)
	})
	mux.HandleFunc("/download/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/download/")
		body, ok := assets[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	old := ghReleasesURL
	ghReleasesURL = srv.URL + "/releases/latest"
	t.Cleanup(func() { ghReleasesURL = old })
	return srv
}

func tarName() string {
	return fmt.Sprintf("tmux-webui_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
}

func TestApply_ChecksumMissing(t *testing.T) {
	tar := makeTarGz(t, "tmux-webui", []byte("fake binary"))
	releaseServer(t, map[string][]byte{
		tarName(): tar, // note: no .sha256 asset
	})

	err := Apply()
	if err == nil {
		t.Fatal("expected error when checksum asset is absent, got nil")
	}
	if !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("expected checksum-related error, got %v", err)
	}
}

func TestApply_ChecksumMismatch(t *testing.T) {
	tar := makeTarGz(t, "tmux-webui", []byte("fake binary"))
	// A checksum that will not match sha256(tar).
	releaseServer(t, map[string][]byte{
		tarName():             tar,
		tarName() + ".sha256": []byte("deadbeef  " + tarName() + "\n"),
	})

	err := Apply()
	if err == nil {
		t.Fatal("expected error on checksum mismatch, got nil")
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch error, got %v", err)
	}
}

func TestApply_ChecksumMatchReachesExtract(t *testing.T) {
	// A correct checksum must pass verification; the flow then proceeds to
	// extraction (which fails here because the tarball has no tmux-webui
	// entry), proving a matching checksum is NOT what aborted the update.
	tar := makeTarGz(t, "not-the-binary", []byte("payload"))
	sum := fmt.Sprintf("%x", sha256.Sum256(tar))
	releaseServer(t, map[string][]byte{
		tarName():             tar,
		tarName() + ".sha256": []byte(sum + "  " + tarName() + "\n"),
	})

	err := Apply()
	if err == nil {
		t.Fatal("expected extract error, got nil")
	}
	if strings.Contains(err.Error(), "checksum") {
		t.Fatalf("checksum should have verified; got %v", err)
	}
	if !strings.Contains(err.Error(), "extract binary") {
		t.Fatalf("expected extract-binary error after checksum passes, got %v", err)
	}
}

func TestApply_DownloadSizeCap(t *testing.T) {
	tar := makeTarGz(t, "tmux-webui", make([]byte, 1024))
	releaseServer(t, map[string][]byte{
		tarName():             tar,
		tarName() + ".sha256": []byte("deadbeef  " + tarName() + "\n"),
	})

	old := maxDownloadBytes
	maxDownloadBytes = 10
	t.Cleanup(func() { maxDownloadBytes = old })

	err := Apply()
	if err == nil {
		t.Fatal("expected size-cap error on oversized download, got nil")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected download-size-cap error, got %v", err)
	}
}

func TestExtractBinary_SizeCap(t *testing.T) {
	tar := makeTarGz(t, "tmux-webui", make([]byte, 1024))
	_, err := extractBinary(tar, 10)
	if err == nil {
		t.Fatal("expected size-cap error on oversized decompression, got nil")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected decompression-size-cap error, got %v", err)
	}
}

func TestExtractBinary_OK(t *testing.T) {
	payload := []byte("hello binary")
	tar := makeTarGz(t, "tmux-webui", payload)
	got, err := extractBinary(tar, maxDecompressedBytes)
	if err != nil {
		t.Fatalf("extractBinary: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("extractBinary: got %q want %q", got, payload)
	}
}
