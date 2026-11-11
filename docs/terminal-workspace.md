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

A production service template is in `scripts/cao-terminal.service.example`. Install/restart services only after operator approval. Ordinary Python installation/startup does not install the sidecar or change nginx. The separately operator-invoked **Fleet Add Machine** installer can install and enable the paired per-user CAO/terminal services from an explicitly validated release; see `examples/fleet/panel/README.md` for manifest selection, prerequisites and fresh-install-only safeguards. Existing nodes are not updated automatically. Standard CAO HTTP/WS proxy routing must also carry `/terminal/` including the public path prefix and WebSocket Upgrade headers.

## Viewer behavior and security

An authenticated browser POST to `/terminal/viewers` requires write/admin scope plus allowed Origin/peer. The server resolves `terminal_id` using exact `@cao_terminal_id` ownership and pins stable window/pane IDs. It issues a 10-minute HttpOnly, SameSite=Strict capability cookie scoped to one viewer path. CAO bearer credentials and the sidecar secret never appear in viewer URLs or forwarded browser headers. Expired viewers are reopened explicitly from CAO.

Assets, history and WebSocket traffic use that capability, revalidate the credential and current target identity, and never cache sensitive responses. WebSocket input is allowlisted; the restricted Go dispatcher also rechecks own tmux options and live pane ownership on every action/capture. Shared layout fitting, prefix-command interpretation, raw session/window/pane CRUD, rescue/global kill, unrestricted upstream uploads, federation, relay, TTS/push and deck editing are not available. A separate CAO-owned, bounded raster-image attachment API is described below. Direct program input remains intentionally powerful and requires write permission.

Same-origin iframe integration is UI composition, **not a security sandbox**. The pinned upstream frontend is trusted application code; review its changes like other CAO code. Read-only users retain CAO's existing output-only endpoints, not this interactive viewer.

A service/version mismatch or unsupported backend displays a clear fallback notice and opens the classic PTY terminal. The workspace stays in a loading state until its UI scripts report ready. Failed script downloads are retried at most three times, without re-executing loaded modules or resending input. Runtime failures or a 30-second initialization timeout offer explicit **Try again** / **Classic terminal** recovery instead of leaving a partially initialized viewer. Closing either viewer does not delete the agent. The optional service's failure does not stop tmux or workflow processes.

## Theme/mobile

The terminal has its **own workbench theme**: neutral charcoal (`#191B1C`), warm text (`#E6E4DF`), and a muted sage focus/active accent (`#A9C1B0`). The full viewer shell, key controls, composer and recovery states use terminal-owned styling—not the CAO dashboard theme or upstream multicolored keycaps. Single-pane viewers omit duplicate window/pane headers and layout/deck clutter; real multi-pane navigation remains available. Agent ANSI colors are untouched.

`design-tokens/tokens.json` (`workspace`) is the source of truth. Run `node design-tokens/gen.mjs`; do not hand-edit `workspace.generated.css`, `cao-tokens.css` or the generated config. Shell tokens are scoped to the terminal/fallback, and workspace mode ignores upstream runtime theme overrides. CAO page appearance, normal status colors and MCP App tokens are unchanged.

The terminal defaults to **16px on desktop / 14px on narrow layouts**; input is at least 16px on phones. **View** contains A−/size/A+/Reset with separate versioned desktop/mobile preferences (12–24px); the old shared preference is not copied into desktop. When Auto-fit is enabled, changing the text size recalculates terminal dimensions to match the available space. Upstream owns keyboard viewport sizing; the parent does not add a second keyboard offset. Soft-keyboard recovery uses one cancellable viewport sampler: short 120ms settlement checks plus a 400ms watchdog only during a visible, focused touch-editing/occlusion lifecycle. This catches a silent dismissal even after a long-open keyboard outlives the initial animation timers. Geometry/visibility/focus events restart measurement; unchanged samples publish no events, hidden/unfocused viewers stop polling after settlement, and teardown removes the timer/listeners. Semantic keyboard height pauses tmux sizing, while the CSS inset removes only the iframe bottom still occluded (not space already removed by parent layout). Width/offset/iframe geometry changes publish through the same viewport path even at zero keyboard height. Recovery does not blur/refocus the input, reset root/history scroll, send terminal input, or bypass focus/IME/zoom/sizing-ownership gates. Sub-25px toolbar/URL-bar noise is not treated as a keyboard. Device-specific native keyboard behavior still requires physical-device verification. Touch controls target 44px, soft-keyboard autofocus is avoided, browser zoom is available, and history stays still while reading. Classic terminal remains available for interaction that needs raw PTY fidelity.

### Chrome iOS resize-content keyboard candidate (2026-11-10)

The native dummy report shows layout and visual heights shrinking together (742→430), so overlap alone reports no keyboard and Auto-fit can shrink the real grid. After dismissal the layout restores but document focus stays false; safe sizing remains paused at the smaller grid until interaction. Static dummy text can look normal despite this mismatch. A private real-tmux TUI replay confirms the path, not every live-device symptom.

The candidate retains a same-width pre-edit layout-height baseline during touch editing. A drop greater than 120px and 18% is treated as semantic keyboard occlusion; no CSS offset is added when layout already removed that space. It also measures intentional Direct/composer layout immediately through the existing enabled/focus/IME/zoom/topology/ownership gates, before native keyboard animation can overtake the usual debounce. No automatic blur/refocus, root/history reset, input or focus bypass is added. The demonstrated grid stays full-sized through closure even if focus remains false. Other genuine size changes under false focus still wait for authority to return.

A viewer opened with a keyboard already present, rotation during keyboard use, other substantial same-width layout changes and native lower-half scrolling remain limits requiring device acceptance. The candidate is not declared a confirmed Chrome iOS fix. The minimal runtime release contains only `gestures.js` and `cao-autofit.js`; it does not add diagnostic controls/modules to live viewers. The separately approved temporary dummy page is an independent immutable service. See `ios-keyboard-release-verification-20261110.md`.

### Navigation and TUI shortcuts

The four arrow buttons are directly visible, including on 320px layouts. **Keys** opens the explicit terminal-key field. Tap Ctrl/Alt/Shift once for one key, double-tap to lock, or choose **Clear modifiers**. Type one key in that field then **Send key**, or press a physical combination there. Ordinary typing, Shift capitalization, selection, clipboard and IME in the message composer remain text; armed virtual modifiers do not steal composer input. Interrupt always sends Ctrl+C independently of armed modifiers. Modifiers clear on target change/disconnection; uncertain keys are never replayed.

For a physical keyboard, choose **Direct keys** on the front toolbar, then click the terminal output. No need to open Keys: it stays visible on desktop, phones and short landscape layouts. Typing, arrows, Enter, Shift+P, Ctrl+P and other supported keys go straight to the selected terminal, without using the message box. On a touch layout, enabling Direct keys also focuses a hidden single-field input so the **native on-screen keyboard opens**; each typed character, Enter and Backspace are delivered to the terminal exactly once (keyboards that deliver text via input/composition events are mirrored; nothing is sent twice). While Direct keys is on, the separate message composer is hidden on desktop and mobile, freeing that row for terminal output; its unsent draft stays mounted and returns when the mode is turned off. After dismissing the phone keyboard, **tap the terminal** to open it again without toggling the mode. Scroll/drag, long-press selection and controls do not trigger keyboard focus. Turn **Direct keys** off to stop passthrough, close the keyboard and restore the composer. Other editable fields and keyboard activation of buttons/links remain normal. IME composition and Meta/OS shortcuts are not intercepted; Ctrl+W/T/N and F5/F11/F12 remain browser-owned. The mode is explicit and off when a viewer opens. Shift+P sends uppercase `P`; it invokes a TUI action only if that TUI binds it.

Every provider gets a contextual group in the drawer, not just one CLI: **Claude Code** (type `/model`, Shift+Tab plan/auto), **Codex** (type `/model`), **OpenCode** (Ctrl+P palette, Ctrl+X then M, F2/Shift+F2), and safe generic Interrupt/Stop keys for the rest (Hermes, Kimi, Gemini, Q, Cursor, Grok, Copilot, Kiro, Antigravity, OMP, MiniMax). Only bindings each TUI itself documents are offered; providers without a verified model command keep generic keys so nothing is guessed. `/model` buttons type the command and press Enter exactly like the composer — the picker itself stays in the real TUI. Custom bindings may differ; for a custom Shift+P, arm Shift, enter `p` in the key field and choose Send key. Terminal protocols may encode Ctrl+Shift+letter identically to Ctrl+letter; tests verify actual bytes rather than promising distinct chords the PTY cannot represent.

### Opening from the fleet panel

Fleet tiles remain read-only previews. Activating a tile opens the node's actual terminal workbench in a new tab, using the same `TerminalView`/viewer-launch path as **Open Terminal** inside that node; it no longer opens the separate legacy fleet console. The panel resolves the clicked session's first terminal, redirects only to its registered HTTPS node hostname, and keeps the node token in the existing fragment-only authentication flow. The node checks that the exact terminal still belongs to the requested session before opening it. Missing/unreachable targets show an error instead of opening a different agent. Machine-level **Open full GUI** still opens the normal node home page. Nodes with older frontend assets cannot auto-open these terminal links until updated.

### Reading after a clear

The restricted v2 viewer renders the **active tmux grid**, including blank rows, separately from history. Cursor-aware live positioning keeps a cleared prompt visible without using earlier shell output as filler when a mobile keyboard closes. Alternate-screen apps never display normal-buffer history. Normal-buffer TUIs receive the same screen-only live behavior; no process/provider-name classifier or special toggle is required.

History loads only after deliberate upward wheel/touch/PageUp intent, not viewport growth or programmatic scroll. Intentional readers remain frozen while new live snapshots arrive; **Jump to live** resumes the latest active screen. Buffer transitions, reconnects and incompatible geometry cancel stale requests. History pages come from a bounded immutable capture (at most 5,000 history lines / 512 KiB; 16 snapshots, two-minute expiry), preventing gap/overlap when equal-size rows are evicted at tmux's history limit. An expired or changed boundary restarts at live rather than combining incompatible pages.

### Clipboard and images (local fidelity staging)

**Copy/Paste** are compact controls beside Keys. Native Ctrl/Cmd+V and context-menu paste are retained; selecting output and Ctrl/Cmd+C copies plain text, while Ctrl+C without selection remains Interrupt. Composer paste edits its draft. Direct paste sends one bounded bulk operation without Enter, using tmux's paste buffer and nonce ACK. A delivery timeout is uncertain and never automatically replayed.

For side-by-side TUI panels, ordinary browser selection follows entire terminal rows and can include a neighboring panel. Use **Select area** beside Copy, then drag a rectangle on desktop (or use **Alt+left-drag** directly). On touch screens, enable Select area and tap two opposite corners; scrolling between corners stays local. **Copy**, native copy, and Ctrl/Cmd+C copy only that rectangle as plain text. Escape or the active Select area toggle cancels locally, without sending a key to the TUI. Successful copy clears the area; clipboard failure retains it for retry. Internal spaces and blank rows are preserved, trailing ASCII padding is removed, and graphemes crossing the horizontal edge are excluded intact. No provider/output detection or automatic panel-boundary guessing is used. Ordinary native selection remains the default.

Area selection freezes the rendered text against live repaint/anchoring and pauses automatic/manual fitting. Target/connection, font, screen epoch/buffer or grid-geometry changes invalidate the area. Selection does not send terminal clicks, scrolling, keys or input. Clipboard access still needs browser permission and a user gesture. Chromium layout/physical touch acceptance must be verified separately from JSDOM tests, which supply simulated glyph geometry.

Direct text is limited to 60,000 UTF-8 bytes. Escape/NUL/unsupported controls are rejected. Multiline/tab text requires a preview and confirmed bracketed-paste support at dispatch; otherwise **Use composer** is offered. tmux 3.4 does not expose the required mode format, so it conservatively uses that fallback. Choosing Send from the composer remains an explicit submit, not a no-submit paste.

Native image paste/drop and **Attach** transfer actual PNG/JPEG/WebP bytes to the current node. Preview and explicitly choose **Insert path** to add a private local file path to the draft or Direct input, without Enter. The active app must support local images; this does not promise a provider-native image chip. Async completion is bound to pane, viewer connection and input mode. Failed uploads offer an explicit retry, never input replay.

Uploads require the live viewer capability, same-origin Origin, peer/auth/write policy, exact target and same-user access to the **same private attachment directory**. Linux validation resolves the fixed storage path through the exact pane PID's `/proc/PID/root`, rejects symlink components, compares device/inode against both the local path and open store handle, and rechecks process start time/pane PID. Different mount namespaces may share that exact directory; namespace/UID/root equality alone is not proof. Missing or denied inspection, another UID, replacement or a different directory fails closed with a specific error. The server streams at most 10 MiB/image, decodes at most 25 MP off the event loop, rejects MIME mismatch/animation/SVG/malformed/bomb data, and allows two inflight uploads. Limits: four pending, 40 MiB per viewer, 256 MiB globally. Storage is private (directory 0700/files 0600), generated paths only, no public download or arbitrary path API. Pending files expire with the viewer or after ten minutes; confirmed paths are retained 24 hours, even after closing the viewer. Reattach missing/expired files. Backend restart retains confirmed files and reclaims recognized crash leftovers. This in-process store requires the supported single-process backend deployment.

#### Reverse-proxy upload boundary

The raw upload route is `/terminal/v/<24-character viewer ID>/attachments` (no multipart overhead). Its ingress limit must admit the existing **10 MiB** raw body; keep other routes and hosts at their current limits. A default nginx 1 MiB limit produces an HTML 413 before CAO receives even a valid image. The UI preserves safe bounded CAO JSON errors and distinguishes proxy rejection without displaying proxy HTML.

Do not raise the shared server/global limit. Mainvps retains its existing **exact-host HTTPS server** override. Registered workers use the shared Fleet regex vhost with `cao-fleet-attachments.conf` included inside `location /`: only the exact 24-character attachment-path regex sets `client_max_body_size 10m` / `client_body_timeout 30s`, with explicit `proxy_pass $cao_fleet_backend` (syntax checks alone do not detect a missing handler). TLS, Cloudflare/loopback ACL, upstream mapping, WebSocket/proxy settings, ordinary limits and the mainvps override remain unchanged. Add Machine checks the root-owned nginx-only companion before remote installation and verifies actual host ingress after routing sync, failing registration on a missing/broken policy. This is a **central proxy** policy, not a worker nginx installation or a wheel-side setting. See `examples/fleet/panel/README.md`.

Before an approved rollout, compare the active vhost hash, back up exact files, validate the complete candidate configuration, then apply/reload only with operator consent. Content-free preflight: an invalid viewer with a generated 2 MiB body should reach CAO and return 401 JSON, while >10 MiB stays 413; use no cookie, image, transcript or terminal input. This is ingress evidence, not authorized-upload acceptance. A private nginx + CAO + sidecar browser test must additionally upload a valid >1 MiB raster through the real capability/filesystem gates, compare exact stored bytes, and verify explicit insertion without Enter. Physical iOS/Android clipboard behavior still requires device testing.

### Zsh and latency (local fidelity staging)

The browser preserves server zsh/theme/TERM settings. ANSI base/indexed colors share a palette; common colon truecolor forms, resets and private-sequence filtering are covered. Shared fixed-cell metrics invalidate on font/size load. The uncertain composite Meslo bundle was removed. Pinned **DejaVu Sans Mono** regular/bold/oblique/bold-oblique and separate unchanged **PowerlineSymbols / Font Awesome** fonts have complete companion licenses, source URLs and SHA256 in `static/fonts/`. Supported symbols occupy one base-font cell without changing copied text. This covers basic Powerline/git icons, **not all Nerd Font glyphs**; custom theme icons outside the documented ranges depend on browser fallback. No server font/framework installation or user dotfile change is made.

Captures are serialized and coalesced: early input capture, approximately 80 ms active polling and 400 ms idle backoff. Exact target/auth validation is not cached or skipped; read-only ownership queries are batched. Local Chromium measurements (not network guarantees): previous/current immediate echo p50/p95 327/683 → 93–104/200–227 ms; native automated key-to-fixture paint 324/442 → 102/165 ms. First idle output after two seconds (10 samples) measured 311/527 → 170/185 ms. The p95 below-150 ms aim is not met. Content-free private tracing measured idle/burst/100-lines-per-second output at 2.6/9.0/10.1 captures per second, capture p95 10.6/14.4/5.1 ms, and maximum one concurrent capture. A 104-key burst retained order but took 3.9 seconds to drain; per-operation validation remains costly under that artificial load. Single-viewer test results are not multi-viewer capacity guarantees. No speculative local echo or uncertain-input replay is used.

### Auto-fit: match the actual viewer, not a mobile/PC label

For an eligible **single-pane** terminal, Auto-fit starts on by default. After connection/layout/font readiness, it measures available cells and fits once. Settled viewer resize, rotation and text-size changes remeasure with 200ms debounce; unchanged dimensions do nothing. It does not resize on output/scroll ticks. **View → Auto-fit** turns it off without restoring/changing dimensions; **Fit here** is the explicit manual fallback.

Fitting changes the real pinned tmux **window** (20–400 cols, 6–200 rows), not just CSS. The restricted sidecar gives one live connection a short sizing claim keyed by socket/window. Another viewer reports **Auto-fit paused · another viewer controls size** rather than fighting. **Fit here** explicitly transfers control. Claims release on disconnect, hidden/unfocused viewer, disable, close/expiry and have a 20-second crash timeout; eligible viewers renew/check claims every 8 seconds without replaying old dimensions. Native attached tmux clients may still constrain the real screen; CAO does not change global tmux sizing options or continually fight that policy.

Automatic fitting pauses during soft-keyboard occlusion, IME composition and pinch zoom. Small touch browser-toolbar height jitter and temporary View/Keys overlays do not change real terminal geometry. Closing the keyboard or settling rotation resumes from current dimensions; for about a second after a keyboard closes, fits use fresh measurements instead of retained rows, because the toolbar/URL bar is still settling. The same viewport/keyboard path is reused; there is no second keyboard offset.

Real window topology is checked before automatic resizing, including siblings hidden by authorization. Shared/multi-pane windows remain **manual fit only**, labelled as affecting the whole window. Unrelated windows/sessions are never resized. Invalid/zero/too-small viewports are skipped, not forced into minimum geometry. Closing the viewer or choosing Classic stops its observers/timers and releases its sizing claim; no key/input/provider initialization is sent by auto-fit.

### Unknown and restart observation

**Unknown means the agent state has not been established, not that the process exited.** Open its badge for a content-free explanation. After CAO restarts, eligible exactly owned tmux panes regain reader/watchdog/pipe observation, without provider initialization, Enter, conversation resume or any other input. Existing unverified pipes are left untouched; legacy unmarked targets fail closed.

A quiet viewport can be shown as a separate, twice-confirmed observation, but it is **not** automation readiness, completion or delivery evidence. The authoritative status remains unknown until recognizable fresh output arrives. Rendered watchdog captures use a distinct snapshot topic, never raw output generations/logs. Native event-inbox backends keep their existing recovery path.

PWA/push is **not activated in this preview**. No worker is registered or served. The unsafe origin-wide cache deletion has been removed from the vendored worker; future install support still needs scoped manifest/auth/new-tab launch validation on real phones.

## Rollback

Disable `CAO_TERMINAL_WORKSPACE` in CAO's managed environment at an approved restart. Existing classic PTY paths remain intact. Stop only the optional sidecar if necessary; never restart or kill tmux as part of viewer rollback. No terminal rows, account homes or workflow journals are migrated.

## Verification

Run commands serially in the foreground. Baseline checks: token-generation parity, frontend tests/type-check/build, targeted pytest auth/Origin/scope/output/workspace suites, upstream Go tests, and isolated tmux tests. See the progress document for actual results and known gaps. Emulator screenshots cannot verify iOS/Android soft keyboard, clipboard, IME or PWA behavior; report those separately.
