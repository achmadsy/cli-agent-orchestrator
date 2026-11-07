// Package pwa serves the static frontend bundle (index.html, sw.js, manifest,
// icons, /static/*) from the embedded asset FS.
//
// index.html carries two Jinja directives: "{{ git_hash }}" (cache-busting
// query string, used several times) and "{{ ui_config_json }}" (the opaque UI
// config blob). We substitute both at startup once and reuse the rendered bytes
// per request.
package pwa

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"

	"github.com/operonlab/tmux-webui/internal/assets"
	"github.com/operonlab/tmux-webui/internal/buildinfo"
)

// IndexHandler serves "/" with {{ git_hash }} and {{ ui_config_json }} replaced.
//
// uiConfig is the opaque config.UI blob delivered to the frontend as
// window.__UI_CONFIG__; nil/empty emits the JS literal null. It must already be
// valid JSON (config.Load fails loud otherwise). "</" is escaped to "<\/" so a
// "</script>" appearing inside the blob cannot break out of the inline <script>.
func IndexHandler(uiConfig json.RawMessage) http.Handler {
	raw, err := fs.ReadFile(assets.FS, "templates/index.html")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "index.html missing from embed FS: "+err.Error(), http.StatusInternalServerError)
		})
	}
	uiJSON := "null"
	if len(uiConfig) > 0 {
		uiJSON = string(uiConfig)
	}
	// Script-tag breakout guard: "<\/" is an equivalent JSON/JS escape for "</".
	uiJSON = strings.ReplaceAll(uiJSON, "</", "<\\/")
	// git_hash first (on the template), then inject the blob — so a blob that
	// happens to contain "{{ git_hash }}" is never re-substituted.
	rendered := strings.ReplaceAll(string(raw), "{{ git_hash }}", buildinfo.GitHash)
	rendered = strings.ReplaceAll(rendered, "{{ ui_config_json }}", uiJSON)
	body := []byte(rendered)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(body)
	})
}

// SwjsHandler serves "/sw.js" with __GIT_HASH__ replaced.
// Cache-Control: no-cache so iOS Safari notices SW updates.
func SwjsHandler() http.Handler {
	raw, err := fs.ReadFile(assets.FS, "sw.js")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "sw.js missing: "+err.Error(), http.StatusInternalServerError)
		})
	}
	body := bytes.ReplaceAll(raw, []byte("__GIT_HASH__"), []byte(buildinfo.GitHash))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	})
}

// RescueHandler serves the standalone /rescue console (templates/rescue.html,
// self-contained by design — it must work while tmux and the main app don't).
func RescueHandler() http.Handler {
	raw, err := fs.ReadFile(assets.FS, "templates/rescue.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err != nil {
			http.Error(w, "rescue.html missing from embed FS: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(raw)
	})
}

// AssetFile serves a single embedded file with the given Content-Type.
func AssetFile(filename, contentType string) http.Handler {
	raw, err := fs.ReadFile(assets.FS, filename)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err != nil {
			http.Error(w, filename+" missing: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write(raw)
	})
}

// StaticFS serves "/static/..." from the embedded `static/` subtree.
func StaticFS() http.Handler {
	sub, err := fs.Sub(assets.FS, "static")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "static FS unavailable: "+err.Error(), http.StatusInternalServerError)
		})
	}
	return http.StripPrefix("/static/", http.FileServer(http.FS(sub)))
}
