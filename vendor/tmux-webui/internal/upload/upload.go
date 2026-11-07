package upload

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

const defaultMaxBytes = 50 << 20 // 50 MB

// unsafeChars matches every character that is not a word char, hyphen, or dot.
// Mirrors the Python: re.sub(r"[^\w\-.]", "_", name)
var unsafeChars = regexp.MustCompile(`[^\w\-.]`)

// Handler is the upload handler bound to a destination directory.
type Handler struct {
	dir      string
	maxBytes int64
}

// New creates a Handler that writes files to dir.
// Pass maxBytes = 0 to use the 50 MB default.
func New(dir string, maxBytes int64) *Handler {
	if maxBytes <= 0 {
		maxBytes = defaultMaxBytes
	}
	return &Handler{dir: dir, maxBytes: maxBytes}
}

// HTTP returns an http.HandlerFunc for POST /api/upload.
// The request must be multipart/form-data with a "file" field.
func (h *Handler) HTTP() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Enforce size cap before reading anything.
		r.Body = http.MaxBytesReader(w, r.Body, h.maxBytes)

		if err := r.ParseMultipartForm(h.maxBytes); err != nil {
			// net/http sets the status to 413 when MaxBytesReader fires.
			if r.ContentLength > h.maxBytes {
				http.Error(w, "File too large (max 50MB)", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, fmt.Sprintf("bad request: %v", err), http.StatusBadRequest)
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "no file provided", http.StatusBadRequest)
			return
		}
		defer file.Close()

		// Sanitize: strip directory components, replace unsafe chars.
		name := filepath.Base(header.Filename)
		if name == "" || name == "." {
			http.Error(w, "invalid filename", http.StatusBadRequest)
			return
		}
		name = unsafeChars.ReplaceAllString(name, "_")
		safeName := fmt.Sprintf("%d_%s", time.Now().UnixMilli(), name)

		// Ensure destination directory exists.
		if err := os.MkdirAll(h.dir, 0o755); err != nil {
			http.Error(w, "server error: cannot create upload dir", http.StatusInternalServerError)
			return
		}

		dest := filepath.Join(h.dir, safeName)
		out, err := os.Create(dest)
		if err != nil {
			http.Error(w, "server error: cannot create file", http.StatusInternalServerError)
			return
		}
		defer out.Close()

		if _, err := io.Copy(out, file); err != nil {
			http.Error(w, "server error: write failed", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"path": dest})
	}
}
