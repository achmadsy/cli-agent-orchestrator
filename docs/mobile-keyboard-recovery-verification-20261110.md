# Mobile keyboard recovery — local verification 2026-11-10

## Status and scope

**Implemented/tested in staging, NOT deployed.** Production remains on the 2026-11-10 approved attachment release. No production terminal read/input/resize, database inspection, nginx/service/config change, worker contact, commit or push for this work.

Stage: `/home/ubuntu/.claude/jobs/12891c79/tmp/mobile-recovery-stage`, fresh snapshot of the full current dirty checkout (2,061 tracked/nonignored files), including the deployed attachment repair. `.recovery-baseline.json` records original SHA256.

## Reported behavior

After Direct keys opens the mobile keyboard and the user hides it:
- TUI sizing does not recover until tapping the top header.
- Plain-terminal lower-half scrolling acts as though keyboard space remains; output is pushed toward the middle. Before Direct keys, scrolling is fine.

## Confirmed reproducible gaps

Five initial regression tests failed on the old code:
1. After six seconds with the keyboard open, silently restoring visual viewport height leaves `--kb-height` at 340px. The original 120/350/800ms check chain had already ended, with no later event to restart it.
2. Actual viewport producer → auto-fit path remains paused in that state, without an extra header/focus/resize event.
3. Zero-keyboard width/offset changes are not published, because old deduplication considered only keyboard height/scale.
4. An iframe already shortened by parent layout gets its height reduced by the full keyboard height again.
5. Visibility restoration does not resample stale geometry.

These are reproducible source defects consistent with the reported symptoms. They are not proof of every native Android/iOS event ordering. No real phone or real provider process was accessed.

## Minimal fix

Only runtime source change: `vendor/tmux-webui/internal/assets/static/js/gestures.js` keyboard-tracking section.

- One cancellable timer and teardown owner replace branching settle timeouts.
- Short 120ms geometry settlement plus a 400ms watchdog while a visible/focused touch editable/occlusion lifecycle remains active. Silent dismissal after a long-open keyboard is therefore sampled, not inferred from time elapsed. It never declares an unchanged open keyboard closed.
- Hidden views stop; truly unfocused views stop after short settlement. Focus/visibility/resize/orientation and visual-viewport scroll/resize restart measurement. No perpetual polling on nonediting pages; unchanged samples dispatch no events.
- Semantic keyboard height still pauses real tmux sizing. CSS `--kb-height` removes only the portion of the iframe's bottom still occluded, not parent-layout space already removed.
- Width/height/offset/iframe geometry changes publish through existing `cao:viewport` even if keyboard height stays zero. Existing auto-fit current measurement/close grace and ownership rules are reused unchanged.
- Direct input focus, composition, drafts, selection, root page scrolling and history position are not programmatically reset. No blur/refocus workaround, automatic keyboard opening, synthetic terminal key/mouse/input, auth weakening, provider-specific classifier or second parent keyboard offset.
- Existing same-origin assumption is unchanged. Missing VisualViewport retains existing fallback behavior.

Test changes: new `web/src/test/workspace-viewport-recovery.test.js` elapsed-clock/iframe integration tests; old keyboard test fixture now models a visible document and supports listener removal. Documentation updated.

## Verification

All foreground, serial, explicit 600000ms Bash timeout. Test processes are owned/cleaned by a single private foreground harness, with private CAO home/database and tmux socket. No paid model/provider calls.

- **477 frontend tests, 44 files passed.** Full suite includes existing jsdom canvas-not-implemented and intentional ErrorBoundary fixture stderr, no failures.
- **29 dependency guards passed**; TypeScript/Vite build passed. Existing >500kB chunk warning remains.
- **369 backend/security tests passed**, including private tmux opt-in and deployed attachment filesystem/auth/Origin/scope regressions.
- Restricted Go tmuxctl/ws/server tests, vet, build passed (`-p 1`). No Go runtime source change.
- **New private real-browser recovery acceptance passed** at 320×740, 390×844, 430×932 and 844×390:
  - Does not override `Document.hasFocus`; actual parent/iframe focus relationship is exercised.
  - Direct keys real focused input; keyboard geometry shrunk for >5 seconds, then restored with no close event, blur or header tap.
  - Zero stale keyboard inset, footer/full terminal bounds restored, sizing frames use measured current columns **and rows**.
  - Plain-shell native CDP touch gestures start in upper and lower halves, both before Direct and after dismissal. Deliberate history remains frozen even while new private shell output arrives; no midpoint snap/new root pan.
  - Normal and alternate full-screen fixtures regain full measured grid; no old shell history filler. Recovery itself sends no key/input/paste/mouse frames.
  - Root scrolling under a fixed landscape dialog may already be nonzero from dashboard navigation. Test preserves the initial parent root position, rather than incorrectly forcing all roots to zero.
  - Short landscape may require several native swipes to reach the history boundary through current grid rows; test checks progress without a synthetic scrollTop assignment.
- **Existing browser sizing regression passed**: two-viewer ownership, explicit takeover, release/acquisition, keyboard/zoom/IME pause/resume.
- **Lifecycle browser regression passed**: history/read stability, close/reopen, reconnect, expiry/no replay, Classic fallback, stopped sidecar.
- **Five-size fidelity acceptance passed** (1440 desktop plus four mobile sizes): native text clipboard, normal/alternate TUI keyboard cycles, exact image bytes/private path/no Enter, preserved composer draft.
- Mobile normal-TUI screenshot inspected: grid fills available area, header retained, footer at bottom, no phantom keyboard gap.

Private browser drivers/harness: `/home/ubuntu/.claude/jobs/12891c79/tmp/browser_mobile_recovery.cjs`, `run_browser_fidelity.py`, `browser_sizing.cjs`, `browser_fidelity_regression.cjs`, `browser_fidelity_acceptance.cjs`. Set `VERIFY_REPO` explicitly; harness default points to an older staging tree.

## Remaining limits

Native soft keyboards are not available in desktop headless Chromium. Keyboard geometry/event omissions are simulated while actual focus, rendering, tmux geometry, browser UI and native touch scrolling are exercised. Physical Android/iOS keyboard dismissal, unusual viewport resize-content modes, caret-panning behavior and device browser bugs still need on-device confirmation; not claimed solved universally. The sampler does not guess a keyboard from a layout viewport that shrinks identically with its visual viewport.

No automatic production rollout authorization was inferred. After approval, this should need only exact source promotion plus replacing/restarting the restricted sidecar; backend, nginx, DB, Fleet and worker do not need changes. Recheck current hashes before any approved deployment, back up exact source/binary/deploy metadata, preserve tmux identities/PIDs/geometry, and verify live assets without terminal input or resize.
