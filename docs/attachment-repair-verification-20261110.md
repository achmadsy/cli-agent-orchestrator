# Attachment repair — local verification, 2026-11-10

## Status / boundary

**Staged and verified, NOT deployed.** No production source, installed package, nginx configuration, services or worker were changed. No commit/push. No production DB, terminal output, input or resize was used. The existing 2026-11-09 fidelity release remains active until separately approved rollout.

Stage: `/home/ubuntu/.claude/jobs/12891c79/tmp/attachment-repair-stage`.
Real repo: `/home/ubuntu/workspace/cao/cli-agent-orchestrator` (not its parent).

## Confirmed causes

1. Mobile HTTP 413: active shared nginx vhost has no body-size override; invalid-viewer generated 2 KiB POST returns CAO 401 JSON, 2 MiB returns nginx 413 HTML. No user image or authenticated upload used for diagnosis.
2. Desktop 409: backend and pinned pane have the same UID, but different mount namespaces. Exact tmux PID query succeeds. Previous namespace-equality gate rejected this even though the same private fixture directory is visible across both roots.

## Repair

- Replace namespace equality with direct fixed-directory proof: same-UID exact pane PID, pinned `/proc/PID` dirfd, process starttime and pane-PID recheck; no-follow component walk through its root; private directory device/inode must match local path **and the open store handle**. Recheck before publication and confirmation. Missing/denied inspection, different UID/storage, symlink or replacement still fails closed.
- PID query limited to 3 seconds and 128 output bytes, rejecting any stderr or nonpositive/non-numeric result. Only the tmux query process is killed on timeout; never the tmux server.
- Specific safe 409 categories replace the conflated namespace message.
- Browser preserves bounded string JSON detail, distinguishes HTML proxy 413, never displays raw proxy HTML; explicit retry/cancel, path insertion and no-submit behavior retained.
- Existing API tests now execute the real directory proof: only the synthetic tmux PID query is replaced. Separate private tmux and browser tests use the full gate without replacement.
- No changes to 10 MiB/image, 25 MP, allowed formats, quotas, private permissions, capability/Origin/live WRITE/ADMIN checks, exact target or no-input-replay rules.

## Proposed production proxy change — separate approval required

Add only:
- `/etc/nginx/sites-available/cao-mainvps-attachments.conf`
- matching enabled symlink under `/etc/nginx/sites-enabled/`.

Do not edit the shared `cao-fleet-nodes` vhost or upstream map. Candidate is derived byte-for-byte from its HTTPS server except:

```diff
-    server_name ~^cao-[a-z0-9-]+\.zlink\.my\.id$;
+    server_name cao-mainvps-claude.zlink.my.id;

     location / {
+        # Viewer IDs are 18 random bytes encoded as 24 URL-safe characters.
+        # Only raw image POST bodies need the existing CAO 10 MiB allowance.
+        location ~ "^/terminal/v/[A-Za-z0-9_-]{24}/attachments$" {
+            client_max_body_size 10m;
+            client_body_timeout 30s;
+            # Explicit handler; remaining proxy settings inherit from location /.
+            proxy_pass $cao_fleet_backend;
+        }
         proxy_pass $cao_fleet_backend;
```

Full candidate and active-source SHA256 are under `dist/attachment-repair/`. TLS, existing Cloudflare/loopback ACL, upstream routing, forwarded headers, WebSocket settings, request buffering, cache/security headers remain unchanged. Exact mainvps hostname wins over regex; worker still uses the unmodified regex server. This creates a deliberate duplicate HTTPS server block, so future shared-vhost edits must reconcile the exact-host override.

Private nginx config uses the same generated server with test-only loopback listen, no TLS, localhost Host preservation and private backend. Private regex fallback simulates worker routing without contacting it. Initial syntax-only-valid candidate returned 404 until nested `proxy_pass` was explicitly added: behavioral acceptance now covers it.

## Verification results

All foreground and serial; private harness owns and cleans up its service/browser/tmux processes.

- **369 backend/security tests passed**, including private tmux opt-in. Covers Origin/peer/capability/scope, attachment decoder/quotas/lifecycle, process unavailable/change, directory mismatch/replacement, symlink, denied inspection, nondumpable same-user child, bounded tmux query and exact own tmux identity. No skips in final run. Existing framework deprecation warnings remain.
- **466 frontend tests / 43 files passed**. Full suite emits existing jsdom canvas-not-implemented and intentional ErrorBoundary fixture messages; none are failing tests.
- **29 dependency guards passed**. TypeScript/Vite production build passed; existing large-chunk warning remains.
- Go tmuxctl/ws/server tests, restricted entrypoint vet and build passed.
- Private nginx syntax check and actual HTTP route selection passed: generated 2 MiB invalid-viewer mainvps-like route reaches CAO 401 JSON; >10 MiB returns nginx 413; unrelated route and simulated worker host retain 1 MiB boundary.
- Real desktop 1440×1000 and touch/mobile-emulated 390×844 browser uploads through nginx + CAO + sidecar + actual filesystem gate passed:
  - PNG picker: **9,943,634 bytes** (valid decoded random raster, not padding).
  - Native Chromium image clipboard: **1,476,448 received bytes** (>1 MiB after clipboard encoding).
  - Exact stored bytes compared; preview sends no input; Insert path sends one paste, no Enter.
  - Proxied HTML 413 shows guidance; insert stays disabled; cancel works.
  - Direct CAO HTTP chunked stream with no Content-Length above 10 MiB returns JSON 413 independently of nginx.
- Private lifecycle/history/reconnect/expiry/Classic fallback browser regression passed, no uncertain replay.
- Private two-viewer sizing ownership/manual transfer/release, keyboard/zoom/IME pause/resume passed.
- Five-size fidelity browser regression passed at 1440×1000, 320×740, 390×844, 430×932 and 844×390: native text clipboard, normal/alternate TUI keyboard cycles, image bytes/no-submit and composer draft.
- Read-only observed-namespace proof: backend mount context matches probe; new exact private temporary fixture directory proved identical through actual pane root despite different mount namespace. No production attachment root creation, user image or terminal input.
- Mobile attachment screenshot inspected; controls remain visible, no horizontal overflow.

## Limits / rollout steps not yet executed

- Unprivileged `unshare` fixture unavailable (uid_map denied). Did not bypass privileges. Different-namespace positive evidence instead came from the allowed read-only actual-pane temporary-fixture proof. Synthetic alternate-root dirfd fixture proves wrong-directory resolution; no claim of isolated namespace-creation coverage.
- No physical Android/iOS Safari native clipboard/keyboard test. Chromium mobile emulation is not device proof.
- No real provider call or provider-native image-chip/consumption proof.
- No production upload acceptance, nginx full-config root syntax test, reload or backend/sidecar restart yet.
- Before approved rollout: verify baseline/current hashes and mainvps identity, back up exact source/runtime/binary/proxy files (not DB), validate full candidate nginx configuration, deploy only changed Python files and rebuilt sidecar, enable exact-host override, reload nginx if test passes, and guarded no-input/public invalid-viewer preflight. Preserve tmux processes/identities/geometry and Fleet/worker. Explicit rollback restores exact files/config, never tmux or DB.
