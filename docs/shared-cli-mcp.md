# Shared CAO MCP for CLI harnesses

## Identity and routing

One `cao-mcp-server` serves two client surfaces:

- `cao-shared-mcp`: three memory tools and eleven read-only codebase tools for
  manual CLI use. No orchestration/plugin resources are advertised or callable.
- `cao-shared-mcp --full`: preserves CAO's per-terminal orchestration surface.

Both route knowledge through the same hosted CAO. The launcher validates the
operator-owned connection **before** importing the server. It refuses symlinks,
unsafe owners/link counts, non-private files, duplicate keys, public/nonliteral
endpoints, redirects and proxy environment forwarding. The local bearer is sent
only to the node-local API for genuine terminal metadata. The central bearer is
sent only to its pinned central origin. Project files cannot override either.

Connection file: `~/.config/cao/mcp-client.json`, owned by the operator, mode 0600:

```json
{
  "version": 1,
  "central_url": "http://100.64.0.10:9889",
  "local_url": "http://127.0.0.1:9889",
  "central_token": "OPERATOR_PROVISIONED_CENTRAL_CREDENTIAL",
  "local_token": "OPERATOR_PROVISIONED_LOCAL_CREDENTIAL"
}
```

The addresses above are illustrative private IPs. Provision real credentials
privately; never commit the file, paste it into transcripts, place tokens in
URLs/argv, or assume a worker token is accepted by the coordinator. No automatic
credential transfer from a supervisor to a worker is part of this contract.

Run `cao-shared-mcp --check` for metadata/tool-surface proof only. Add
`--worker-proof` to require the coordinator's `InternalMemoryContext.project_id`
contract for cross-node project memory. This check never recalls, stores or
forgets production memories and never triggers indexing.

## Harness configuration

The transactional helper is
`cli_agent_orchestrator.services.harness_mcp_integration`. Its read-only
`prepare`/bounded inventory precedes `apply`; exact private backups, quarantine
moves and a content-free receipt support `rollback`. Refuse unfamiliar memory
entries rather than guessing ownership. Receipt scope is explicit, not a claim
that every repository or editor on the machine was searched.

| CLI | User configuration | Verification caveat |
|---|---|---|
| Claude Code | `~/.claude.json`, Claude settings/hooks | Existing resumed sessions need reload; do not kill them. |
| Codex | `~/.codex/config.toml` | `mcp list --json` proves config parsing, not connectivity. |
| OpenCode v2 | XDG `opencode/opencode.json[c]`, `mcp.servers` | Query the intended location after initialization; reload affects all locations. |
| Hermes | `~/.hermes/config.yaml`, `mcp_servers` | The installed Hermes must include its optional MCP SDK. |
| Mimo | XDG `mimocode/mimocode.jsonc`, `mcp` | SDK schema alone is not a runtime-connection test. |
| Strix | `~/.strix/mcp-servers.json`, named stdio array | Do not start a security scan to test an MCP loader. |
| Kiro CLI | CLI agent profiles only | Missing executable means unavailable, not verified; IDE settings are excluded. |

Use an absolute stable launcher path. Do not distribute a token into each CLI
config, add wildcard grants, or silently approve all MCP servers. Keep shared
`~/.agents/skills` sources intact; exclusions are CLI-specific. Preserve unrelated
providers, hooks, permissions, gateway settings and native histories.

Always report separately: **config migrated**, **loader verified**, and
**current running session reloaded**. A file edit is not evidence that an already
running process changed its tool surface.

## Fresh Fleet install

The replacement release carries the checksum-pinned `cao_shared_cli_v1` helper,
identical to the reviewed wheel module. Historical standalone-adapter manifests
remain readable for rollback but are rejected by the replacement payload.

Before Add Machine, the operator must provision the target's private connection
file. Preflight checks file safety, selected-node identity, central authentication,
memory enablement and project-identity API support before package/service writes.
If a needed parser or credential is unavailable, provisioning fails clearly.
Harness executables are not installed/upgraded/started; absent CLIs are skipped.
The node-local CBM engine remains behind CAO federation, never registered directly
with an agent. Configuration/quarantine receipts participate in rollback.

A new wheel/bundle is immutable and distinct from the active release. Publishing
candidate payload source and changing the release pointer happen only while
Fleet has no active jobs and under separately approved Fleet activation. Backend,
restricted-terminal/nginx services and tmux are not restarted by that activation.

## Spawn Agent folder explorer

The working-directory Browse button lists folders on the serving CAO node,
not files on the browser device. It uses the authenticated read-only browse API.
Choosing a folder only fills the form. Navigation, filters, breadcrumbs and
pagination never spawn an agent or start a workspace tunnel. Hidden/sensitive
system destinations remain unavailable, and over-large directories fail with an
explicit message rather than silently truncating choices.

Frontend/backend deployment is separate from building/testing the chooser and
requires its own restart approval when applicable. The restricted terminal theme
and sidecar are not redesigned by this feature.
