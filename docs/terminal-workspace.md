# Terminal workspace (opt-in, preview)

CAO integrates a pinned MIT-licensed [tmux-webui](https://github.com/operonlab/tmux-webui) source snapshot as an optional terminal workspace. CAO still owns agent identity, credentials, lifecycle and workflow state. Classic xterm/PT Y viewing is retained for herdr, legacy unmarked terminals and raw terminal interaction.

**Preview, default off.** Do not enable on a public node before the exact-target and real-mobile acceptance checks in `terminal-workspace-progress.md` are complete. This is not a generic proxy to an unrestricted tmux-webui instance.

## Build

Go **1.25+** is required by the pinned source's go.mod (the upstream README's older minimum is not authoritative). The build script uses Go's standard toolchain acquisition when allowed. It does not replace the system Go installation.

```sh
node design-tokens/gen.mjs
bash scripts/build-tmux-webui.sh
```

The optional binary/checksum are written under ignored `dist/`. No binary is downloaded at CAO startup and Python installations do not require Go. The build target is **`./cmd/cao-terminal`**, not upstream's unrestricted `cmd/tmux-webui`.

## Run explicitly, as the same user as CAO

Configure a strong random secret through your service environment/secret manager, with matching values in the sidecar and CAO environments. Never put a real value in a committed example, URL or command argument:

```text
CAO_TERMINAL_WORKSPACE=1
CAO_TERMINAL_URL=http://127.0.0.1:9528
CAO_TERMINAL_INTERNAL_TOKEN=<at least 32 random characters, same in both services>
```

The sidecar needs only `CAO_TERMINAL_INTERNAL_TOKEN`. Start it explicitly:

```sh
/path/to/cao-terminal --listen 127.0.0.1:9528 --socket /actual/tmux/socket \
  --config /path/to/repo/vendor/tmux-webui/cao-config.example.json
```

Determine the socket used by the active CAO tmux backend; do not guess or create a second server. An explicit socket is also supported for isolated tests. The binary refuses non-loopback listening. It does not create sessions or run the global upstream agent monitor.

A production service template is in `scripts/cao-terminal.service.example`. Install/restart services only after operator approval. Nothing in the implementation installs the template or changes nginx automatically. Standard CAO HTTP/WS proxy routing must also carry `/terminal/` including the public path prefix and WebSocket Upgrade headers.

## Viewer behavior and security

An authenticated browser POST to `/terminal/viewers` requires write/admin scope plus allowed Origin/peer. The server resolves `terminal_id` using exact `@cao_terminal_id` ownership and pins stable window/pane IDs. It issues a 10-minute HttpOnly, SameSite=Strict capability cookie scoped to one viewer path. CAO bearer credentials and the sidecar secret never appear in viewer URLs or forwarded browser headers. Expired viewers are reopened explicitly from CAO.

Assets, history and WebSocket traffic use that capability, revalidate the credential and current target identity, and never cache sensitive responses. WebSocket input is allowlisted; the restricted Go dispatcher also rechecks own tmux options and live pane ownership on every action/capture. Shared layout fitting, prefix-command interpretation, raw session/window/pane CRUD, rescue/global kill, uploads, federation, relay, TTS/push and deck editing are not available. Direct program input remains intentionally powerful and requires write permission.

Same-origin iframe integration is UI composition, **not a security sandbox**. The pinned upstream frontend is trusted application code; review its changes like other CAO code. Read-only users retain CAO's existing output-only endpoints, not this interactive viewer.

A service/version mismatch or unsupported backend displays a clear fallback notice and opens the classic PTY terminal. The workspace stays in a loading state until its UI scripts report ready. Failed script downloads are retried at most three times, without re-executing loaded modules or resending input. Runtime failures or a 30-second initialization timeout offer explicit **Try again** / **Classic terminal** recovery instead of leaving a partially initialized viewer. Closing either viewer does not delete the agent. The optional service's failure does not stop tmux or workflow processes.

## Theme/mobile

“CAO Quiet Workspace” uses scoped slate surfaces and a restrained blue focus accent. `design-tokens/tokens.json` is the source of truth. Run `node design-tokens/gen.mjs`; do not hand-edit `workspace.generated.css`, `cao-tokens.css` or the generated config. Normal status colors and MCP App tokens are unchanged.

The terminal defaults to 14px; input is 16px on phones. A−/A+ controls preserve terminal font preference. Upstream owns keyboard viewport sizing; the parent does not add a second keyboard offset. Touch controls target 44px, soft-keyboard autofocus is avoided, browser zoom is available, and history stays still while reading. Classic terminal remains available for interaction that needs raw PTY fidelity.

PWA/push is **not activated in this preview**. No worker is registered or served. The unsafe origin-wide cache deletion has been removed from the vendored worker; future install support still needs scoped manifest/auth/new-tab launch validation on real phones.

## Rollback

Disable `CAO_TERMINAL_WORKSPACE` in CAO's managed environment at an approved restart. Existing classic PTY paths remain intact. Stop only the optional sidecar if necessary; never restart or kill tmux as part of viewer rollback. No terminal rows, account homes or workflow journals are migrated.

## Verification

Run commands serially in the foreground. Baseline checks: token-generation parity, frontend tests/type-check/build, targeted pytest auth/Origin/scope/output/workspace suites, upstream Go tests, and isolated tmux tests. See the progress document for actual results and known gaps. Emulator screenshots cannot verify iOS/Android soft keyboard, clipboard, IME or PWA behavior; report those separately.
