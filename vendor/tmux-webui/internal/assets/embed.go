package assets

import "embed"

//go:embed static templates sw.js manifest.json icon-192.svg icon-512.svg icon-192.png icon-512.png icon-maskable-512.png
var FS embed.FS
