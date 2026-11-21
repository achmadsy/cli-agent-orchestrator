# Named-account quota and manual resets

The **Quota** page reads usage for CAO-managed named Claude Code and Codex CLI
accounts. A gateway API key does not expose the gateway's underlying accounts;
9router is a protocol reference, not an account database CAO imports.

## Usage

Claude session/weekly windows use upstream `utilization`; model-scoped weekly
entries use `limits[].percent`. Both mean percent **used**. For example, 75 used
is displayed as 25% remaining. Missing/malformed model windows are not invented.
Codex subscription windows come from the WHAM usage endpoint. API-key and unknown
credential formats are unavailable rather than treated as signed-in subscriptions.

Automatic reads cache for five minutes. **Refresh** requests a new snapshot but
respects the provider's rate-limit cooldown. Missing reset data is **Unknown**,
not zero. Automatic quota renewal timestamps are separate from manual resets.
Credentials remain in the selected private CLI home; CAO does not refresh/write
OAuth tokens. Expired credentials require the supported CLI sign-in flow.

## Manual reset

1. Review the remaining resets and **Details** (expiry, status, affected limits).
2. **Reset limits** obtains fresh provider eligibility without spending anything.
3. Confirm the named account and one-reset cost. **Cancel** spends nothing.
4. The server rechecks identity and eligibility, records one operation durably,
   and submits it once. Only the provider-reported applicable limits are reset.

Claude must supply an eligible, selected, usable-now, valid grant with positive
resets and no active cooldown. A positive count by itself is insufficient. Codex
requires fresh available credits and a direct named subscription OAuth identity.
Mutation routes require write/admin permission when CAO auth is enabled; existing
Origin/Host middleware also protects browser writes. No provider credentials or
client-selected grant/account/endpoint selectors are accepted from the browser.

An operation UUID, account gate and non-secret intent are stored in the existing
CAO SQLite database. Alias profiles share account protection. Duplicate confirms
never generate another provider POST. Read caches are fenced across submission.

**Outcome unknown** means CAO cannot prove whether the provider applied the reset.
Do not retry it. The account remains blocked for further resets across restart,
while usage and details reads remain available. **Check reset status** is a read,
not another consume attempt. A provider-side outcome check is required; there is
no force-retry/unblock button. A crash after recording submission is deliberately
fail-closed. This does not claim exactly-once delivery by the upstream provider.

A successful reset remains successful if the follow-up quota refresh fails.
Use **Refresh** later to update the display; do not spend another reset merely
because the refreshed numbers are unavailable.

## API

- `GET /agents/provider-profiles/quota/overview?force=true`
- `GET /agents/provider-profiles/{id}/quota?force=true`
- `GET /agents/provider-profiles/{id}/quota/reset` — allowance details
- `POST /agents/provider-profiles/{id}/quota/reset/preview` — no consume
- `POST /agents/provider-profiles/{id}/quota/reset/confirm` — `{ "intent_id": "…" }`
- `GET /agents/provider-profiles/{id}/quota/reset/operations/{operation_id}`

Preview intents expire after two minutes and are bound to the caller/profile and
account credentials. A submitted/unknown intent cannot be replayed to spend again.
The implementation is tested with synthetic credentials and mocked provider APIs;
tests do not consume real reset credits.
