#!/usr/bin/env bash
# Explicit opt-in build. Never invoked during CAO startup or Python installation.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist/cao-terminal}"
mkdir -p -- "$(dirname -- "$OUT")"
# Run from our scripts directory, not a downloaded source working directory.
# -C selects the reviewed vendored Go module. Go may acquire its declared 1.25
# toolchain through the standard Go module checksum-verified mechanism.
GOTOOLCHAIN=auto CGO_ENABLED=0 go -C "$ROOT/vendor/tmux-webui" build -trimpath -o "$OUT" ./cmd/cao-terminal
"$OUT" --version
sha256sum "$OUT" > "$OUT.sha256"
printf 'Built optional CAO terminal sidecar: %s\n' "$OUT"
