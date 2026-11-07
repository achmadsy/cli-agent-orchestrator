# tmux-webui vendored source

- Upstream: https://github.com/operonlab/tmux-webui
- Revision: `195ad23136c500b10fc88ba50397a25fa7b8c4d9`
- License: MIT (see LICENSE)
- Included: cmd/, internal/, go.mod, go.sum, LICENSE. Upstream installer, CI and documentation assets are intentionally not shipped/executed.
- Actual build requirement: Go 1.25+ (go.mod, not the older README requirement).

## CAO patches

CAO adds an explicitly restricted `cmd/cao-terminal` entrypoint. It exposes only embedded assets, the workspace WebSocket and bounded target history; it does not start upstream's global monitor, rescue, update, federation or upload surfaces. The ordinary upstream executable is not the supported CAO sidecar.

The workspace connection policy binds stable pane/window identities to a CAO terminal id and rechecks ownership on each operation/capture. Shared layout fitting and the prefix command FSM are disabled in CAO mode. Mobile theme/keyboard/accessibility and prefix-aware asset changes remain localized under internal/assets. The index uses an inline ordered script bootstrap with bounded failed-download retries and a ready/failure handshake to the CAO parent; it never retries modules that have started executing or replays terminal input.

The optional binary is built explicitly by scripts/build-tmux-webui.sh. No network fetch happens at CAO startup. Rebase patches against a reviewed upstream revision, update the pin, run Go tests + CAO contract/security tests, then regenerate the binary/checksum. Never silently substitute an unpatched upstream release binary.
