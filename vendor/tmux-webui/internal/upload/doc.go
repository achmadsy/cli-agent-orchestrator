// Package upload provides the multipart file upload handler for tmux-webui.
//
// # Overview
//
// Handler wraps a destination directory and a maximum file size.
// The HTTP() method returns an http.HandlerFunc that:
//
//  1. Enforces the size cap via http.MaxBytesReader (returns 413 if exceeded).
//  2. Parses the "file" field from a multipart/form-data body.
//  3. Sanitizes the filename: strips directory components, replaces any
//     character that is not \w, -, or . with an underscore (mirrors the
//     Python re.sub(r"[^\w\-.]", "_", name) one-liner).
//  4. Prefixes the sanitized name with a Unix millisecond timestamp to avoid
//     collisions (e.g. "1715000000000_report.pdf").
//  5. Streams the upload to disk with io.Copy and returns
//     {"path": "<full destination path>"} on success.
//
// # Wire-up (server.go)
//
//	uploadH := upload.New(cfg.UploadDir, 50<<20)
//	mux.HandleFunc("POST /api/upload", uploadH.HTTP())
package upload
