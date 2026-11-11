# CAO Fleet Panel

A web control panel + live console for a CAO fleet. It is the `panel/` surface of the
[`examples/fleet`](../README.md) coordinator: a **stateless** FastAPI app that fans out
to every node's `cao-server` REST API and serves a browser SPA — a wall of live agent
screen previews. Click an agent tile to open that node's real terminal workbench
in a new tab, with the same theme, Direct keys, composer and recovery behavior as
**Open Terminal** inside the node UI. The panel resolves the clicked session's
first terminal; missing/unreachable targets show an error rather than another
agent. The separate legacy fleet console is no longer the default tile action.
Node frontends must be updated for automatic terminal deep links; older versions
land on their normal GUI. Machine-level **Open full GUI** still opens node home.

It adds no state and no core changes: each node stays a plain `cao-server`, and the
panel is just a client. Background and the execution-flow diagrams are in the
[fleet coordinator guide](../../../docs/fleet-coordinator.md).

## Requirements

- [`uv`](https://docs.astral.sh/uv/) (Python 3.10+).
- One or more CAO nodes reachable at `host:9889` — bring them up with
  [`../deploy/bootstrap.sh`](../deploy/bootstrap.sh).
- A registry (`../fleet.json`) listing those nodes (see below).

## Quickstart

```bash
cd examples/fleet
cp fleet.example.json fleet.json      # then edit: one entry per node
cd panel
uv sync
uv run fleet-panel                     # serves http://127.0.0.1:9888
```

The panel binds `127.0.0.1` by default. To reach it from another device, set
`CAO_PANEL_HOST` to the coordinator's private-network address **and** set a token
(see [Security](#security)):

```bash
CAO_PANEL_HOST=100.64.0.11 CAO_PANEL_TOKEN=$(openssl rand -hex 16) uv run fleet-panel
```

## The node registry

The panel reads the same `fleet.json` as the rest of `examples/fleet` — one registry
for the whole fleet. It resolves, in order: `$CAO_FLEET_CONFIG`, then `../fleet.json`,
then the packaged `../fleet.example.json` (placeholder nodes, so the panel still
starts on a fresh checkout). Format:

```json
{
  "port": 9889,
  "machines": [
    { "name": "node-a", "host": "100.64.0.11", "label": "coordinator",  "role": "central" },
    { "name": "node-b", "host": "100.64.0.12", "label": "worker-linux",  "role": "agent" }
  ]
}
```

`host` is any address the coordinator can reach the node at (Tailscale/WireGuard/VPN/LAN
IP or DNS name); `port` defaults to `9889`. `fleet.json` is git-ignored so your node
addresses stay local.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CAO_FLEET_CONFIG` | `../fleet.json` → `../fleet.example.json` | Path to the node registry. |
| `CAO_PANEL_HOST` | `127.0.0.1` | Address to bind the panel to. |
| `CAO_PANEL_PORT` | `9888` | Port to bind the panel to. |
| `CAO_PANEL_TOKEN` | _(unset)_ | Shared secret required on every request. Unset = no auth. |

## Security

The panel is a **control plane**: its routes launch agents, inject keystrokes
(including `^C`), and shut down sessions across every node. It reaches the nodes over
their `cao-server` REST API, which itself has **no per-request auth** — the private
network is the trust boundary (same posture as the [coordinator
guide](../../../docs/fleet-coordinator.md#transport-and-security)).

- **Loopback is safe; off-loopback is not, unless you add auth.** The moment you set
  `CAO_PANEL_HOST` to a network address, anyone who can reach the port has full
  agent/command execution across the fleet.
- **Set `CAO_PANEL_TOKEN` whenever the panel is not on loopback.** When set, every
  request (page, static assets, and API) must present it — as an HTTP Basic password
  (any username) so a browser prompts once, or as `Authorization: Bearer <token>` for
  scripts. Use a long random value.
- **Keep it on a private/VPN network regardless.** A token is a second layer, not a
  substitute for network isolation. Do not expose the panel — or a node's port — to
  the public internet. For real per-request auth in front of a node, use CAO's OAuth
  layer (`AUTH0_DOMAIN` / `CAO_AUTH_JWKS_URI`).

## Run as a service

[`systemd/fleet-panel.service.example`](systemd/fleet-panel.service.example) is a
ready-to-edit unit for running the panel on the coordinator.

## Guided Node Installation

When installing an Ubuntu or WSL2 machine through the Fleet panel over Tailscale SSH:
- The coordinator probes remote CPU architecture (`x86_64` / `aarch64`).
- It verifies and bundles the official pinned `codebase-memory-mcp 0.10.8` portable archive (`~/.cache/cao-fleet-cbm`, override via `CAO_CBM_CACHE_DIR`).
- Target nodes verify archive SHA-256 before extracting `~/.local/bin/codebase-memory-mcp`.
- Target nodes configure `CAO_CODEBASE_ENABLED=true`, `CAO_FLEET_NODE_ID`, `CAO_CODEBASE_API_URL`, and `CAO_MEMORY_API_URL`.
- Agents access Codebase Memory and shared CAO memory exclusively through `cao-mcp-server` tools. No raw `codebase-memory-mcp` registration is added to Claude Code.
- CAO and the restricted terminal ship as **one checksum-verified local release**: freshly built Python/frontend wheel, per-architecture sidecar and UI config. A stale standalone `CAO_FLEET_WHEEL` is no longer used. SHA-256 checks are integrity checks, not digital signatures.
- Set `CAO_FLEET_RELEASE` to an absolute `manifest.json` path, or configure the local `dist/fleet-node-active.json` pointer with `{"manifest":"/absolute/release/manifest.json"}`. Missing, damaged or unsupported-architecture releases fail closed before installation. Only architectures actually included in the validated manifest are offered; no old-binary fallback.
- Build from a reviewed private snapshot with `python3 -I scripts/build-fleet-node-release.py --source /absolute/snapshot --out /new/release --id unique-release-id --sidecar-amd64 /reviewed/cao-terminal`. Sidecars must be built from that same reviewed source with the restricted `./cmd/cao-terminal` target; test them before activating the release. Optional `--sidecar-arm64` requires a separately validated matching artifact. The builder does not activate services or publish artifacts.
- The guided installer requires an **already installed Python 3.12, 3.13 or 3.14** and selects it explicitly, without interpreter downloads. uv installs the paired wheel with Pillow 12.3.0 and checks native imports. Ubuntu, uv, tmux 3.3+, Tailscale and agent CLI prerequisites remain required.
- Fresh install only: existing CAO tool/data/config/services or incomplete-install markers are rejected. Updating an existing worker is a separate controlled operation; never reset its credentials through Add Machine.
- With the operator's Add Machine action, the installer creates/enables per-user `cao-server.service` and loopback-only `cao-terminal.service`. A fresh random internal secret is shared privately between the two; files use 0600 and private directories. The actual/default tmux socket is resolved without creating or killing sessions. CAO authentication/Origin/peer gates remain enabled.
- Registration/routing happens only after authenticated backend and sidecar protocol health plus anonymous sidecar denial. Failed fresh installs remove their created service/artifact files, retain data and an incomplete marker, and do not register. Dependency prerequisites already installed by the script are retained. Diagnose a failed install before a deliberate retry; do not delete data to force it through.
- Release activation on an existing coordinator requires a Fleet panel restart at an approved maintenance point with no active install jobs. It does not update existing nodes automatically or require restarting mainvps CAO/sidecar.
- Attachment HTTPS ingress is configured on the **coordinator's nginx**, not by installing nginx on workers. Deploy the root-owned `../deploy/cao-fleet-ingress.py` companion to `/usr/local/sbin/cao-fleet-ingress` and its exact snippet to `/etc/nginx/snippets/cao-fleet-attachments.conf`; include that snippet inside the shared Fleet HTTPS `location /`. It raises only `/terminal/v/<24 URL-safe characters>/attachments` to **10 MiB**, with a 30-second body timeout and explicit existing backend proxy handler. Other request limits, TLS, ACLs and the mainvps exact-host override remain unchanged.
- Add Machine checks `sudo -n cao-fleet-ingress --check-policy` before SSH mutation. After the existing routing sync, it requires `--verify-ingress <registered-name>` to prove a 2 MiB invalid-capability upload reaches CAO401JSON, >10 MiB stays413 and unrelated routes retain their ordinary limit. Only then is installation reported complete. A failed routing/ingress check reverts the newly added registry entry and reconciles routing; cleanup failure is reported explicitly, without deleting remote data/services.
- The ingress helper has no DNS API, downloads or worker service actions. `--apply` validates/reloads nginx with exact snippet rollback on failure; deploy/reload only with operator approval. The existing `/usr/local/sbin/cao-fleet-sync` DNS/routing helper is kept unchanged. `CAO_FLEET_INGRESS_COMMAND` can select a separately approved equivalent helper; its versioned completion markers are required.
- `../deploy/bootstrap.sh` is a separate upstream bootstrap path, not this pinned local installer. External/manual reverse proxies still need their own narrowly scoped upload policy; a wheel alone does not configure ingress.

## Tests

Hermetic — a fixture registry, mocked `cao-server` calls, no network or tmux:

```bash
# Backend (FastAPI + httpx MockTransport):
uv run python -m pytest

# Frontend (pure logic units, Node's built-in runner):
cd static && node --test test/*.test.js
```

These live under `panel/` with their own `pyproject.toml`, so the main repo's test run
does not pick them up; run them from here.
