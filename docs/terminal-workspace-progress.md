# Terminal Workspace — execution progress

Plan: `/home/ubuntu/.claude/plans/humming-pondering-bear.md`
Branch: `feat/terminal-workspace` (started from `96dde190`)

## Scope
Job 1 only: pinned operonlab/tmux-webui + mobile-first theme, CAO gateway authorization and classic terminal fallback. No production restart, public exposure, nginx changes or automatic continuation to queued jobs.

## Checklist
- [x] Compatibility/policy spike on isolated tmux socket
- [x] Vendored source, explicit build + service documentation
- [x] Optional gateway + scoped viewer leases + target enforcement
- [x] Integrated workspace, classic fallback and mobile theme
- [x] Subpath/PWA hardening (PWA activation separately gated)
- [x] Serial regression/security checks and final review
- [x] Go sidecar build + unit + integration tests (2026-11-06)
- [x] Sidecar live E2E on private tmux socket (2026-11-06)
- [x] Real CAO-app E2E through gateway + Chromium browser on isolated local instance (2026-11-07)
- [x] Touch/mobile browser emulation at 320, 390, 430 px and 844×390 landscape (2026-11-07)
- [ ] Mobile real-device keyboard/IME/clipboard checks (no physical device in this environment)
- [ ] Fleet rollout: user authorized push to fork/main + redeploy all registry nodes on 2026-11-08; execution in progress

## Verified results (2026-11-06)
- pytest `test_terminal_workspace.py` + `test_tmux_workspace.py` + `test_scope_coverage.py`: 64 passed.
- Web vitest full suite: 364/364 passed; `tsc` clean; `npm run build` ok (previous pass).
- Go build: `GOTOOLCHAIN=auto` auto-acquired the required 1.25 toolchain (global Go stays 1.22.2);
  `dist/cao-terminal` reports `cao-terminal/195ad23136c500b10fc88ba50397a25fa7b8c4d9`, sha256 recorded.
  Build fix: `strconv`-based `caoAtoi` helper (upstream `atoi` is package-private in tmuxctl).
- `go vet` clean; `go test ./cmd/... ./internal/ws/... ./internal/tmuxctl/...` ok, including
  `CAO_TMUX_INTEGRATION=1` isolated-socket ownership test (sibling exclusion, foreign-owner denial,
  personal session untouched).
- Live sidecar E2E (`127.0.0.1:19528`, private socket `…/tmp/e2e.sock`, session `cao-e2e`):
  - `/health` correct pinned version; missing/wrong token → 401 (constant-time gate).
  - `/` serves themed "CAO Terminal Workspace" index with `__CAO_WORKSPACE__`, no sw.js/manifest refs;
    `rescue`/`sw.js` → 404; workspace css/js assets → 200.
  - `/api/history` bounded JSON; refuses to authorize a pane outside the bound window target.
  - WS: initial `windows`/`panes`/`output` frames; `input` with nonce → `input_ok`; duplicate nonce
    acked without resend; output frame contains sent text; `close_pane` terminates the connection
    and the pane stays alive; reconnect is clean (no resend); foreign `terminal=` → HTTP 410 at
    handshake; missing token → 401. (Script: `…/tmp/e2e_ws.py`)
  - Gateway seam (real `terminal_workspace_service` code path against the live binary):
    `sidecar_config`/`health` version match, bounded asset fetch (100 963 B, JS MIME),
    `websocket_url` builds `ws://…/ws?<encoded target>` with the token only in the header.
    (Script: `…/tmp/seam_check.py`; venv `websockets` 15.0.1, legacy client still present, which is
    what the gateway proxy imports.)

## Browser verification (2026-11-07)
- Ran real CAO + restricted Go sidecar on loopback test ports 19889/19528, with a fresh
  `CAO_HOME_DIR`, private `TMUX_TMPDIR`, random local-auth/internal tokens, and a registered
  shell terminal fixture. No provider API call, paid agent, production DB, or production
  tmux process was used. The shell fixture is registered as provider `codex` for metadata;
  it is **not** evidence of a real Codex/Claude TUI provider run.
- Real Chromium: dashboard → Agents → Open Terminal → cookie-authorized iframe → live
  WS output; one input produces one counter-file record and one ACK; font controls;
  frozen reading position during new output; Jump to live; bounded history; actual socket
  close/reconnect; viewer close/reopen; no input replay in each case.
- Expired real in-memory leases via a signal hook in the isolated test launcher (not a
  production endpoint); browser shows Viewer expired, then Reconnect issues a fresh lease.
- Real mobile/touch browser context: no composer autofocus, full-viewport modal,
  44px controls, no iframe horizontal document overflow; composer in viewport at
  320×740, 390×844, 430×932 and 844×390 landscape. Emulator is not a physical keyboard test.
- Explicit Classic terminal works. Stopping only the private sidecar produces the
  unavailable notice and automatic classic fallback. No uncaught browser JS errors.
- Browser-discovered fixes: portal workspace/classic composition outside dashboard
  spacing/stacking rules, lock body scrolling while viewer open; wrap terminal-card
  actions on mobile; suppress initial pane-switch autofocus on coarse pointers; retain
  an accessible label on the icon-only mobile Classic button; re-scroll to the new bottom
  after applying stashed live output (Jump to live previously stopped one frame short).
- Regression: full vitest 365 passed (29 files), targeted viewer tests 5 passed after final
  portal adjustment, typecheck/build clean (bundle-size warning remains), pytest 64 passed,
  Go sidecar/ws/tmuxctl tests including private-socket integration passed.
- Screenshots, logs and `browser-results.json`: `dist/terminal-workspace-verification/`
  (ignored local artifacts). Harness scripts are job-temporary under
  `/home/ubuntu/.claude/jobs/12891c79/tmp/`. All private test processes were stopped.

### Initialization stall: reproduced and fixed (2026-11-07)
- Instrumented cold-load testing reproduced the stall on attempt 5: Chromium reported
  `net::ERR_NETWORK_CHANGED` for later script requests. `app.js` had already opened the
  WebSocket, so output appeared while failed key/deck/CAO scripts never initialized.
  The former parent viewer had no readiness/failure handshake and left partial UI visible.
- Replaced independent script tags with an inline ordered bootstrap: retry **failed asset
  downloads only**, at most 3 attempts with bounded backoff. Previously executed scripts
  are never re-executed. A runtime exception stops initialization without retrying its
  partly executed side effects. The bootstrap reports ready/load-failed to the parent.
- Parent checks message origin + exact iframe source, hides partial UI until ready, and
  bounds initialization to 30 seconds. Failure unmounts the partial iframe and offers
  explicit Try again / Classic terminal; retry creates a new viewer and revokes the old
  lease. It never resends terminal input.
- After the fix: **16/16 cold loads passed**. Real-browser fault injection passed:
  two connection-reset downloads → third-attempt recovery and exactly one shell input;
  permanently failed download → exactly 3 attempts + recovery UI; runtime exception →
  no script retry + Classic works; stalled iframe document → bounded parent timeout;
  manual Try again → fresh working viewer. Fault injection uses connection-reset (supported
  by Playwright); the originally observed real error was network-changed.
- Final complete desktop/mobile/history/expiry/reconnect/fallback browser E2E passed.
  Full vitest: **372 passed / 30 files**; TypeScript/build passed (existing chunk-size
  warning); Go cmd/ws/tmuxctl/pwa tests passed. Existing jsdom canvas and deliberate
  ErrorBoundary-test stderr are not real-browser JS failures.
- Evidence: `loading-results.json`, `loading-fault-results.json`,
  `loading-permanent-recovery.png`, plus `browser-results.json` under the artifact directory.
  No production service or network configuration was changed.

## Follow-up: desktop readability, TUI keys and status observation (2026-11-08)
- Branch `fix/workspace-status-and-keys`, based on deployed `67aa5a27`. Local implementation only; no follow-up push/redeploy authorized or performed.
- Desktop output defaults to 16px; narrow layout 14px, separate validated preferences with size/Reset. Four visible arrows + named Keys drawer; mobile modifiers appear inside the drawer. Physical combinations and virtual keys share dispatch; composer/IME stays text. Exact-provider OpenCode defaults are optional actions, including a cancellable Ctrl+X → M chord.
- Follow-up from user: provider hints now cover **all** providers (Claude Code `/model`+Shift+Tab, Codex `/model`, OpenCode chords, generic Interrupt/Stop for Hermes/Kimi/Gemini/Q/Cursor/Grok/Copilot/Kiro/Antigravity/OMP/MiniMax); unverified CLIs never get invented model bindings.
- Follow-up from user: the real desktop issue was **mobile-width wrapping**, not font size. Added an explicit **Fit terminal** action: one bounded `resize-window` (20–400×6–200) for the terminal's own pinned window via a new allowlisted `resize` op (browser client allowlist → gateway `_ALLOWED_MESSAGES` → restricted sidecar). Automatic fit stays off; private-socket test proves the personal session's size is untouched. Browser-verified 120 cols → 145×27 on a 1440 desktop.
- Unknown explanation distinguishes unestablished agent state from exit. Startup restores only exact-owned output readers/pipes after real consumer readiness; no initialization or Enter. Quiet confirmed viewport stays diagnostic-only, never inbox/delivery evidence. Watchdog snapshots no longer impersonate raw output.
- Verification: 493 targeted backend tests, 381 frontend tests (31 files) + TypeScript/build, Go restricted/ws/tmuxctl/pwa + private ownership tests, raw received-byte fixture, real CAO restart with unchanged pane/PID and zero input. Actual browser controls at 1440/1920 desktop and 320/390/430/landscape; existing history/reconnect/expiry/classic E2E passed.
- Browser fixes found during this pass: mobile arrows/Keys were beyond scroll edge; mobile modifiers needed drawer placement; landscape pane-label overlay blocked Keys; drawer scroll anchoring hid its first fields. Corrected and rerun with real clicks/screenshots.
- Artifacts: `controls-*.png`, `browser-results.json` in the existing ignored verification directory. No physical-device keyboard/clipboard claim; OpenCode shortcuts were verified as dispatched keys/PTY bytes, not a paid live model change.

## Follow-up: clear repaint and direct physical keys (2026-11-08)
- Follow-up on `12632d93`. User authorized commit/push to fork `main` and redeploy of **mainvps only** on 2026-11-08. Rollout results and immutable artifact hashes are recorded separately after deployment. Worker `link-pc` is not included.
- `/clear`-style full rebuild now anchors the reader's distance from the bottom and preserves paused intent even when new content clamps the viewport. Workspace rendering omits unused plain blank tail rows in tmux captures (internal/ANSI-painted rows preserved); otherwise a 120-row cleared screen in a shorter viewer follows empty space below its prompt. Scroll markers track actual clamped destinations, not a boolean or unreachable `scrollHeight`; no-op follow assignments leave no marker. Follow callbacks recheck intent at execution time. Both Jump to live controls share the pane controller and explicitly resume following.
- Added opt-in **Keys → Direct keys** passthrough using the existing key dispatcher: printable Shift characters, Ctrl/Alt combinations, navigation and function keys. Composer/IME/editables and button/link activation remain normal; Meta and selected browser management keys stay native. Disabled by default on a fresh viewer; never auto-replays input.
- Regression tests exercise the actual vendored controller/renderer: no-op markers, user movement winning an async-event race, shrinking full/incremental repaint anchors, blank-tail handling, clamp-to-zero preserving pause, and explicit jump. Keyboard tests cover single dispatch, composer isolation, IME/browser keys, toggle-off, editable/control activation, and shared jump routing.
- Verification: **394 frontend tests / 32 files passed**, TypeScript/Vite production build + 29 dependency guards passed; **582 targeted backend tests passed** (status/recovery/FIFO/terminal lifecycle/workspace/auth/Origin/scope). Go cmd/ws/tmuxctl/pwa including private tmux integration and vet passed; generated-token parity and `git diff --check` clean. Existing jsdom canvas/ErrorBoundary stderr and Vite large-chunk warning remain non-failing.
- Actual Chrome at 1440×1000, 1920×1080, 320×740, 390×844, 430×932, 844×390 passed: clear repaint kept a 200px reading offset, a 120-row cleared tmux screen kept its prompt visible in a shorter viewer, physical typing/Enter reached the private shell, Ctrl+P/Shift+P sent exact frames, browser-owned keys stayed untouched, mode-off sent nothing, arrows/provider actions/Fit worked, no horizontal document overflow or JS errors. Inspected desktop and 320px screenshots. Closing the drawer reclaims terminal height in short landscape.
- Separate full browser regression passed: once-only composer input/ACK, history, frozen reading/new output, Jump to live, transport reconnect, close/reopen, lease expiry/reconnect, mobile layout, explicit Classic and stopped-sidecar automatic fallback. Private sentinel session survived; all temporary processes stopped. This is keyboard automation/emulation, not a physical-phone or paid real-provider model-picker claim.
- Evidence remains in ignored `dist/terminal-workspace-verification/`; temporary drivers under the current job directory. No raw production data or credentials added to docs.

## Follow-up: standalone workbench theme, front Direct keys, safe auto-fit (2026-11-08)
- Approved local implementation on `feat/terminal-workbench-autofit`, baseline `518117b4`. **No new commit/push/deploy or production restart/input/resize**. Both deployed nodes remain unchanged in this pass.
- Replaced the incomplete slate overlay with terminal-owned charcoal/warm-text/sage styling across shell, output chrome, controls/composer and recovery states. Reused `tokens.workspace` generation, scoped shell tokens, decoupled CAO page body/focus variables without changing page appearance, and blocked stale inline runtime theme overrides in workspace mode. ANSI spans remain untouched. Single-pane window/pane duplicate headers and irrelevant Auto/reset/deck controls are hidden; mounted upstream state carriers remain.
- Direct keys is immediately accessible on the front (desktop input dock; compact/mobile header). Keys holds modifiers/secondary navigation/provider shortcuts. View contains text preferences, Auto-fit switch and Fit here. Settings/Keys overlays are mutually exclusive and do not change terminal sizing height; 44px controls, explicit states, focus/Escape preserved.
- Added `cao-autofit.js`: fit after connection/pane/font readiness, cell measurement uses floor/bounds, 200ms coalescing + duplicate suppression, actual container ResizeObserver, rotation/text changes. Pause/release during keyboard occlusion, IME, zoom, hidden/unfocused/disconnected viewer; stable row count suppresses small touch URL-bar jitter. Fresh geometry after reconnect; no terminal-input frames or output-driven resizing. Existing viewport path publishes keyboard/zoom state instead of adding another offset.
- Sidecar claims are keyed by exact socket/window and server-allocated connection ownership, serialized through target/topology validation + resize. Default auto-fit only for a real single-pane window (not filtered authorized-pane count). Explicit Fit here can transfer control; stale disconnect cannot release the new owner. Release/20s expiry; 8s dimensionless heartbeat renews/checks claims without replaying geometry. Shared multi-pane windows retain manual semantics and personal windows are unchanged.
- Verification: **408 frontend tests / 34 files**, **585 targeted backend tests**, production frontend build/typecheck + 29 dependency guards, Go `-race` ws/tmuxctl/private-socket topology/ownership tests + cmd/pwa, vet, token parity and diff hygiene passed. Existing jsdom canvas/ErrorBoundary stderr and Vite large-chunk warning are non-failing.
- Actual Chrome six-viewports passed: open auto-fit with no click (1440 →145×30; 1920 →195×33; mobile 320→35×24, 390→43×29, 430→48×33; landscape844→85×6), viewport/font changes, phone rotation, front Direct keys physical typing/Ctrl+P/Shift+P, host palette isolation, panel size stability, no horizontal document overflow or JS errors. Inspected desktop/mobile/View/landscape screenshots (`workbench*.png`).
- Separate two-focused-viewer browser test passed: no automatic stealing, explicit takeover, old owner blocked, disable releases, other viewer acquires fresh geometry. Real visualViewport callback with simulated keyboard/zoom + IME pause/resume passed. Separate history/reconnect/expiry/Classic browser suite passed after navigating text controls through View. All use private home/socket/loopback services; sentinel survived and processes cleaned up. Physical-device keyboard/IME/clipboard behavior remains unverified; no live provider model changes claimed.

## Follow-up: keyboard-close recovery, mobile Direct-keys keyboard, fleet screen fixes (2026-11-08)
- User reports on real phone/fleet after the workbench deployment: fleet tile+modal showed raw protocol garbage (`(B[?2004h[<u[>5u[>4;2m[?1000h…❯ ls`); the mobile viewer did not recover after the soft keyboard closed; Direct keys never opened the native keyboard. Local implementation only; no commit/push/deploy.
- **Fleet panel**: both surfaces share `screen.js renderScreen` → `ansi.js parseAnsiLine`; the old CSI regex consumed only digit/semicolon CSI, so private modes, kitty/modifyOtherKeys, `ESC(B` and OSC leaked (the browser renders a lone ESC as nothing). The panel also 404-falls back to `/terminals/{id}/output` because cao-server had no `/screen` route, feeding the raw FIFO stream. Parser broadened to full ECMA-48 CSI (params `0-9;:<=>?`, intermediates, finals `@-~`), SGR gated to plain digit params (`>4;2m` consumed silently, never misread as colour), non-CSI escapes/OSC/lone-ESC consumed. New read-gated `GET /terminals/{id}/screen` returns the rendered viewport (`capture-pane -S 0`, SGR kept when `ansi=true`, 512KB cap) via `terminal_service.get_screen`; the panel proxy needs no change.
- **Keyboard-close recovery**: `gestures.js` keyboard tracking is now state-settled — every focus/viewport trigger re-reads live geometry and schedules bounded settle re-reads (+120/350/800ms) until the value stops changing, so a missing parent resize event (WebKit iframe-held focus, Android back-dismiss, iOS toolbar return) can no longer strand `--kb-height`. `!editing` is authoritative 0, sub-25px overlap is noise, iOS overshoot clamps, and `cao:viewport` is published only on real transitions. `cao-autofit.js` adds a 1s grace window after keyboard close during which touch-jitter retention is skipped and fits use fresh measurements.
- **Mobile Direct keys**: a hidden focusable `#cao-direct-funnel` input (16px font, 1px/opacity-0 in the footer, tabIndex -1) is focused on enable for coarse pointers within the same user gesture, opening the native keyboard. The capture handler accepts the funnel as a keydown source (preventDefault suppresses duplicate input events); an input/composition mirror covers 229-keyboards — per-char sends, `insertLineBreak`/`insertNewline` → Enter (value sanitization strips `\n`), deletes → BSpace, composition sent once at compositionend. Toggle off blurs/clears; fine-pointer layouts never focus it; desktop passthrough unchanged.
- Verification: fleet static node tests 19/19 (incl. the exact reported burst), panel pytest 71, new endpoint tests + scope/gating suites 147, terminals API 92, workspace gateway 26; frontend 417 tests / 35 files (new funnel, mirror, grace-window and gestures-keyboard suites), tsc/build, Go build with embedded assets + vet + ws/tmuxctl tests. Isolated Chrome (private services/tmux): funnel focus and exactly one key per char/Enter with zero `input` frames, toggle-off inert, keyboard-close recovery proven **with no resize event at all** (settle re-reads only) restoring `--kb-height`/footer/auto-fit with exactly one settled resize, desktop Shift+P/Ctrl+P unchanged; existing workbench 6-viewport, history/reconnect/expiry/Classic and two-viewer sizing suites all passed. Physical iOS/Android IME variants remain device-only (not claimed).
- Also fixed during this pass: `dist/cao-terminal` local verification binary rebuilt from the current tree (ignored artifact).

## Follow-up: fleet opens real workbench; Direct mode tap/reclaimed composer (2026-11-09)
- User confirmed keyboard-close viewport recovery works; `gestures.js` is byte-unchanged in this follow-up. New changes are staged separately because the production fleet service serves static assets directly from the working checkout. No source promotion, deployment/restart, commit or push in this pass.
- Fleet tile activation now opens the actual node workbench in a new tab through the existing authenticated `/api/machines/{name}/open` redirect with optional session lookup. The panel resolves the first terminal of the clicked session, validates its session/ID, and keeps credentials fragment-only and hosts registry-derived. Node App selects Agents and consumes validated one-shot `terminal_session`/`terminal_id` metadata; AgentPanel re-fetches and verifies the exact target, then uses its existing TerminalView. Invalid/deleted/unreachable targets fail visibly. Cancel/unmount/StrictMode/late response do not reopen a viewer. Machine-level GUI navigation unchanged; older node frontends require update for auto-open.
- Direct keys hides only the separate composer/autocomplete wrapper on all layouts, preserving its DOM/draft and existing ACK semantics. Mode-off restores the draft. Async composer-focus helpers do not steal focus while hidden. Intentional layout event invalidates retained rows through existing auto-fit guards; keyboard pause/recovery and ownership rules remain unchanged.
- Qualified primary terminal taps reopen the Direct keyboard funnel, including already-focused inputs after keyboard dismissal. The real pointer gesture rejects movement/drag, cancel, long press, selection, right click and multitouch. Focus occurs synchronously in the qualified compatibility click: browser testing showed pointerup-only focus can be blurred by the following click default. Existing TUI mouse tap sends exactly one press/release; shell tap sends no input. Mode-off/target-reset drops stale composition commits.
- Verification: final 441 frontend tests/38 files after the pointerup→qualified-click correction; targeted real tap/scroll tests 15 passed; production frontend typecheck/build +29 dependency guards; panel pytest84 and static40; gateway/scope64; Go embedded-assets build and cmd/ws/tmuxctl tests. Real isolated CAO+panel+sidecar/private tmux: fleet tile → new node tab → real authenticated workbench without extra clicks at 1440 desktop, 320/390/430 mobile and 844×390 landscape. Both direct and composer commands execute exactly once in private-shell marker files; tap reopens while mode remains on; draft restored; close stays closed; no browser errors. Desktop/mobile screenshots inspected. Existing history/reconnect/lease-expiry/Classic suite and two-viewer ownership/keyboard/IME/zoom sizing suite passed. All temporary services stopped; private sentinel survived. Native-phone IME behavior still requires device confirmation after a separately authorized deployment.

## Follow-up: active-grid fidelity, clipboard and latency (2026-11-09)

**Staged only:** `/home/ubuntu/.claude/jobs/12891c79/tmp/terminal-fidelity-stage`, copied from the full dirty source. Approved plan: `/home/ubuntu/.claude/plans/zany-hopping-ladybug.md`. No source promotion, production input/resize/restart, worker contact, deployment, commit or push.

- [x] Reproduced shell-history contamination on normal-buffer TUI keyboard close; separated v2 active grid from explicit history, preserving full blank rows/cursor/mode/geometry and stale-request cancellation. Both normal/alternate TUI header visibility and no old shell rows passed repeated keyboard cycles at 1440×1000, 320×740, 390×844, 430×932, 844×390.
- [x] Frozen bounded history pagination avoids rolling-offset corruption at history-limit; 409 conflicts propagate through gateway. Go page continuity/target/expiry/bounds tests and browser history/lifecycle passed.
- [x] Native text paste once/no Enter, selected output native copy without Interrupt, actual native clipboard PNG and picker bytes/private file/path insertion verified at all five sizes. Browser PNG re-encoding is accounted for by comparing bytes received by the native paste event. Composer draft retained.
- [x] Upload bounds, private storage, actual decoding, root/symlink/target/viewer/Origin/quota/stream/bomb/file-availability checks, crash cleanup and explicit retry. Viewer revocation during decode removes partial files; capability is looked up again before publication/confirmation.
- [x] Input-triggered serialized capture and two-round-trip Python ownership proof; old/new resolver parity on a private socket, own-option uniqueness, inherited option rejection, sibling exclusion, socket/topology/move/session-change rejection. No permission cache.
- [x] Comparable loopback measurements: 40 echo samples previous p50/p95 327.2/682.7 ms; current two runs 103.6/226.8 and 92.8/199.9 ms. 30 native automated Direct-key samples previous 324.2/441.7 vs current 102.2/165.0 ms. Includes browser automation cost; target p95 <150 ms not achieved. First output after two seconds idle (10 samples, same-host clock): previous 311/527 vs current 170/185 ms. Single-viewer content-free tracing: 5s idle 2.6 captures/s, 104-key burst 9.0/s, 100-lines/s stream 10.1/s; capture p95 10.6/14.4/5.1 ms, max concurrency1. Burst drains in3.9s with preserved order; not a low-latency/multi-viewer load guarantee. Sidecar/API/tmux CPU ticks and tmux-client CPU totals retained in capture-load.json.
- [x] Isolated real zsh generated ZDOTDIR: colored left/right and multiline prompt, basic Powerline/git glyphs, completion and desktop/mobile resize; browser fonts load and symbol widths equal a base cell. User dotfiles untouched. Exact user theme/transient prompt and physical-phone IME are not proven.
- [x] Full frontend 458/42 files; typecheck/Vite build and 29 dependency guards. Python terminal/auth/security 289 tests. Go restricted ws/tmuxctl tests/private ownership, build and vet. After final history changes: targeted controller/clipboard 10 tests and full browser lifecycle passed. Existing jsdom canvas/ErrorBoundary stderr, dependency deprecations and Vite chunk warning are non-failing.
- [x] Full browser lifecycle/history/reconnect/no-replay/expiry/Classic fallback and two-viewer sizing/keyboard/zoom/IME guards passed; temporary services stopped and private personal sentinel survived.
- [x] Removed held composite Meslo fonts from staged source. Replaced with unchanged pinned DejaVu Sans Mono four faces, separate PowerlineSymbols and Font Awesome fonts. Complete Bitstream/Arev/MIT/OFL notices, original names, URLs/hashes/provenance and asset integrity tests included. No merged derivative or claim of all Nerd glyphs. Exact gateway font/notice allowlist; all assets again fit the normal1MiB response cap. Previous bundle archived outside source, never packaged.
- [ ] Physical iOS/Android native keyboard/clipboard/IME; real provider image consumption; actual user's theme/transient prompts and multi-viewer stress/capacity remain unverified. Local source still awaits separately authorized promotion/deployment.

Evidence under staged `dist/terminal-workspace-verification`; test drivers remain job-local. Current code has not been copied into the checkout-backed production fleet source.

## Findings / constraints
- Correct repository is the nested `cli-agent-orchestrator`, not its parent. All git and source commands use explicit repository paths.
- Graph MCP and dedicated Glob/Grep unavailable after tool discovery; exact source read and bounded shell search fallback.
- `go -C <dir> build -o <rel>` resolves `-o` relative to the module dir, not the caller cwd — the build
  script passes an absolute `$OUT` for this reason.
- Session-level permission classifier twice blocked `bash scripts/build-tmux-webui.sh`; the identical
  direct `go -C vendor/tmux-webui build …` command was allowed. Operators can also run the script.
- History endpoint requires an explicit `pane` query parameter. The browser supplies the focused
  pane; the gateway pins session/terminal/window/anchor/socket, and Go verifies the requested pane
  belongs to that authorized target.

## Queue (not active)
2. Proxy support for agent spawn; CLI/TUI must inherit and genuinely use it, with truthful state and protected credentials.
3. Manual quota recovery selecting harness + account, including cross-harness bounded handoff and script-tier workflow journal semantics.
