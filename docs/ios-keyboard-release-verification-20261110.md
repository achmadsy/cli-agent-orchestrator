# Minimal Chrome iOS keyboard candidate release — 2026-11-10

## Scope and approval

The user explicitly selected **Deploy kandidat mainvps** after being told that only the sidecar would restart, existing viewers might disconnect/reopen, and native acceptance remained pending. No backend, Fleet, nginx, diagnostic service or tmux restart/change; no production key/input/paste/mouse/resize, DB inspection, worker contact, commit or push.

The candidate deployment stage is `/home/ubuntu/.claude/jobs/12891c79/tmp/ios-keyboard-deploy-stage`, built from the 2,063-file captured production checkout baseline. It intentionally excludes the investigation stage's diagnostic bootstrap, CSS/UI/module, read-only diagnostic accessor and publication scripts. The separately published fixed-expiry dummy service remains unchanged.

## Native evidence and fix rationale

The user says the dummy page looks fine. Its explicit report nevertheless shows a real numeric mismatch: host layout/visual heights both shrink 742→430 while keyboardHeight remains0, grid shrinks to11, then full height restores while focus remainsfalse and fit stayspaused at11 for more than20 seconds. Static dummy text does not depend on grid size. Header-control interaction later restores focus and sizing. This is evidence from the dummy, not proof of the live viewer's complete root cause; width stays430 and root offsets/inset remain0 throughout that record.

A private actual tmux TUI reproduces that ordering: baseline open rows11/measured11; closed rows11/measured26 with false focus; restored focus rows26. The candidate:

1. `gestures.js` retains a same-width pre-edit host layout-height baseline. A substantial touch/editing layout reduction (>120px and >18%, scale1) becomes semantic keyboard occlusion even if visual and layout viewports shrink together. Local CSS inset compensates only actual visual overlap, not space already removed by layout.
2. `cao-autofit.js` immediately measures intentional Direct/composer layout through the existing gated fit path instead of letting a 200ms debounce lose the race to keyboard opening (~100ms in the native report). All focus/visibility/IME/zoom/topology/enabled/font/ownership/ACK gates remain; no takeover or stale sizing replay is added.

Semantic inference alone preserved24 instead of measured26; a strict real-grid test failed before the intentional-layout timing correction. Final private replay keeps real grid26 while keyboard is open and after close with false focus, then resumes ordinary ownership at true focus. Both normal and alternate-screen fixtures pass. No sizing/acquisition occurs during false focus, no automatic blur/refocus/root reset/history mutation/provider input is added.

## Exact-package verification

All commands serial foreground, explicit Bash timeout600000. One isolated E2E harness at a time owns temporary services/private DB/unique tmux socket/browser and cleans up. No production data/terminal used.

- **484 frontend tests passed,44 files** in this minimal release (investigation-only seven recorder tests are intentionally absent).
- **29 dependency guards passed**; TypeScript/Vite build passed; existing Canvas/ErrorBoundary test logs and >500kB chunk warning remain.
- Restricted Go tests/vet/build passed with `-p1`: cmd/cao-terminal, internal/server, internal/tmuxctl, internal/ws, internal/assets.
- Minimal-binary source-sequence replay passed for both normal and alternate-screen actual tmux fixtures, exact rows26, false-focus sizing denial, no old history filler. Driver reads existing status UI, not a diagnostic accessor.
- Four-layout shell/normal/alternate TUI recovery passed at320×740,390×844,430×932,844×390: real Chromium parent/iframe focus, native touch swipes, **simulated keyboard geometry**, full cols/rows and stable deliberate reader.
- Sizing ownership/manual takeover/release/keyboard/zoom/IME regression passed.
- Lifecycle/history/reconnect/no-replay/expiry/responsive/Classic/unavailable-sidecar regression passed.
- Previous investigation stage full frontend491 passed; this is not the exact-package count and is not used in place of the minimal484 run.
- Backend/security369 tests passed earlier in investigation before JS refinements; no backend source/dependency change in this release. Not rerun for the minimal JS-only overlay.

Release freeze includes exact-source hashes and a source diff, the tested binary, private browser drivers and preserved attachment-file hashes. Deployment must verify prior binary/source identity, back up exact files, replace the sidecar only, verify served assets and protected nginx/diagnostic identities, then promote only the reviewed source/test/docs. Verification in production must block terminal writes/resize before transmission and mask terminal content in any screenshot.

## Open acceptance / limits

**Candidate, not a confirmed Chrome iOS fix.** Need the user to refresh/reopen the real terminal after rollout and test keyboard open/close without a header tap. The lower-half native scroll symptom and horizontal-fit complaint are not established by the dummy report. Real false-focus size/font/orientation changes still await focus authority by design.

Inference needs a usable pre-edit baseline. Opening with keyboard already present, rotation changing width with keyboard open, or other large same-width touch-editing layout changes remain ambiguity/limits. No universal native keyboard API is claimed. The keyboard-open view keeps the full grid and existing live-grid cursor positioning/scrolling instead of resizing the real TUI smaller.

No changes to existing attachment proof/limits, no-submit image insertion, auth/Origin/exact-target security, history reader intent, fonts or Classic fallback. No diagnostic UI is added to live workbenches. The separate original dummy service still has its original48h deadline and assets; this release does not update or extend it.

Status at freeze: verified minimal candidate, explicitly approved for mainvps-only sidecar rollout; actual deployment report records outcome separately.
