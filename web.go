package main

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// The React SPA, built by `npm run build` in ./frontend. Run that before
// `go build`; the Dockerfile does it in an earlier stage.
//
//go:embed all:frontend/dist
var distFS embed.FS

func spaHandler() http.Handler {
	dist, err := fs.Sub(distFS, "frontend/dist")
	if err != nil {
		panic(err)
	}
	index, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		panic("frontend/dist/index.html missing: build the frontend before compiling: " + err.Error())
	}
	files := http.FileServerFS(dist)
	startTime := time.Now()

	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		// always revalidate, so a new deployment's asset hashes are picked up
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, "index.html", startTime, bytes.NewReader(index))
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")

		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" || name == "." || name == "index.html" {
			serveIndex(w, r)
			return
		}
		if st, err := fs.Stat(dist, name); err != nil || st.IsDir() {
			// unknown extension-less paths get the SPA; missing files are 404s
			if path.Ext(name) == "" {
				serveIndex(w, r)
			} else {
				http.NotFound(w, r)
			}
			return
		}
		if strings.HasPrefix(name, "assets/") {
			// Vite content-hashes everything under assets/
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		files.ServeHTTP(w, r)
	})
}
