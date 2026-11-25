# Agent history after reboot

Home and Agents include **Agent history**, separate from active sessions. CAO
keeps this archive in its existing SQLite database. A reboot can remove tmux
sessions without removing the archive. No process is resurrected automatically.

## What is retained

- Provider-neutral session/agent metadata and original CAO identity.
- The latest successful provider-filtered output capture, up to 65,536 UTF-8 bytes.
- Up to 100 Inbox entries, with up to 4,096 UTF-8 bytes per entry. Truncation is
  explicitly labeled. Archived pending messages are historical text, not a queue.
- Local-only launch restrictions, account selection and, when verified while
  alive, a native conversation reference. These private fields are not replicated.

A serial observer runs approximately every 15 seconds. Metadata is saved in the
terminal-creation transaction; Inbox and metadata are also saved before registry
removal. Normal teardown captures output before removing the runtime. The age
cleanup backfills the archive before deleting ordinary rows/recordings. Archive
records have **indefinite retention** and are not deleted by `RETENTION_DAYS`.
Back up CAO's database; disk loss is not equivalent to a runtime reboot.

An abrupt power loss can lose output since the last successful capture. The
archive is a bounded snapshot, not a complete transcript backup, filesystem
backup, or guarantee of resuming an interrupted command. Already-deleted data
cannot be reconstructed by enabling this feature.

## Central read-only replicas

Replication is opt-in because output and messages can contain private project
content. Use only a trusted coordinator. Existing installations remain local-only
until explicitly configured. Fleet installer payloads enable the sender for new
nodes using the operator's existing private shared connection file.

On a sending node:

```ini
CAO_FLEET_NODE_ID=workstation
CAO_HISTORY_SYNC_ENABLED=true
CAO_HISTORY_CONNECTION_FILE=/absolute/private/path/history-client.json
```

Use the existing strict version-1 `Connection` configuration (owner-only file,
private IP endpoints, separate local/central bearer credentials). Do not copy
credentials into history or public installer artifacts. `CAO_HISTORY_CONNECTION_FILE`
is history-only and takes precedence; the existing `CAO_SHARED_CONNECTION_FILE`
remains a compatible fallback without changing MCP configuration.

For least privilege, generate a distinct random ingest bearer per sending node.
On the coordinator set `CAO_HISTORY_CREDENTIALS_FILE` to an owner-only JSON file:

```json
{"version":1,"nodes":{"workstation":"<sha256-of-dedicated-ingest-bearer>"}}
```

Put only that dedicated bearer in the history Connection's `central_token`, never
the coordinator's admin bearer. This credential only permits the two replication
endpoints, is tied to its node name and direct IP, and cannot read history, resume
agents, or call ordinary APIs. The receiver stores only its SHA-256 hash. Use a
private owned regular file (0600, no symlinks or unsafe ancestors), generate the
bearer with a cryptographic RNG, and never print or commit it. Rotating/removing a
node's hash revokes its credential. Existing write/admin API bearers continue to
work for operator-controlled replication; read-only bearers remain forbidden.

On the coordinator, enable normal API bearer authentication and bind each node
name to its **direct** tailnet peer address:

```ini
CAO_HISTORY_PEERS={"workstation":"100.64.0.2"}
```

This mapping is an operator-maintained allowlist, not a caller-controlled
heartbeat. Shared bearer possession alone cannot claim another node name.
Replication rejects unauthenticated mode, public peers, forwarded/proxied traffic,
read-only tokens, unknown sources and peer/source mismatches. No live environment
configuration is changed merely by installing source code.

The sender uses bounded versioned snapshots and advances its durable cursor only
on a matching acknowledgement. A failed connection leaves local history queued
for a later serial retry. Duplicate or older snapshots do not overwrite newer
replicas. Cursors are bound to coordinator URL **and database origin**, so a new
coordinator database can receive a full replay. Only local history is exported;
replicas are not recursively forwarded. Coordinator Home/Agents lists them as
**Remote snapshot** with a last-synced timestamp, even when the source is offline.
A remote snapshot never supplies execution readiness, monitoring state, or a
message receiver. It does not claim that the remote process is currently dead.

API:

- `GET /agent-history?offset=0&limit=50` (maximum 100 per page).
- `GET /agent-history/{source}/{origin}/{terminal_id}` for read-only content.
- Internal private bearer routes: `GET /internal/agent-history/identity` and
  `POST /internal/agent-history/sync` (4 MiB streamed request limit).

## Explicit manual resume

**Resume conversation** is available locally only for verified Claude Code
references. History is supported for every provider; native resume for other CLIs
is not inferred or advertised. Remote replicas cannot be resumed on the
coordinator. Open the source node after it comes online.

Resume requires confirmation and write/admin access. It creates a new CAO runtime
with the pinned native conversation ID, the original existing working directory,
account and saved tool restrictions. There is **no initial task**, pending Inbox
transfer, or automatic retry. The predecessor Inbox link is read-only, preserving
original message IDs and owners. Saved snapshots also follow the new history
identity. Always inspect the conversation before giving new instructions.

The server refuses live or uncertain old runtime presence, changed/missing account
roots, replaced/symlinked transcript files, changed default-account resolution,
missing working directories, and live/unverified matching native processes. A
native-reference check cannot prevent a separate operator from racing an external
manual native launch; do not resume the same native conversation simultaneously
outside CAO. Ephemeral-profile recovery requires operator-managed handling.

A durable one-shot intent is written **before** launch. If the HTTP connection is
lost or launch outcome is uncertain, inspect sessions/history instead of clicking
retry. `launching` means uncertainty, not permission to launch again. No automatic
intent reset is provided. After successful resume the new terminal becomes the
native reference's successor; that successor can later be resumed after another
verified runtime loss. This never continues an in-flight command by itself.
