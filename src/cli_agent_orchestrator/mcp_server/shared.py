"""Stdio entrypoint for the operator-configured shared CAO MCP client."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from cli_agent_orchestrator.mcp_server import shared_client


def build_server(*, full: bool = False):
    from cli_agent_orchestrator.mcp_server import server
    if full:
        return server.mcp
    # Register a new surface rather than hiding tools on the full server: unknown
    # tools cannot be invoked by guessing their names. No resources/plugins leak.
    from fastmcp import FastMCP
    result = FastMCP(
        "cao-mcp-server",
        instructions=("Shared CAO-hosted memory and Fleet codebase tools. Manual CLI "
                      "launches use their working directory; session/agent memory "
                      "needs a genuine CAO terminal. No standalone/local-store fallback."),
    )
    for name in sorted(shared_client.TOOL_NAMES):
        result.tool(getattr(server, name))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", type=Path,
                        default=Path.home() / ".config/cao/mcp-client.json")
    parser.add_argument("--full", action="store_true", help="CAO-spawned orchestration surface")
    parser.add_argument("--check", action="store_true", help="Metadata/tool-surface proof only")
    parser.add_argument("--worker-proof", action="store_true", help="Also require cross-node project identity support")
    args = parser.parse_args()
    connection = shared_client.Connection.load(args.connection)
    shared_client.configure(connection, full=args.full)
    proof = connection.check()
    if args.worker_proof:
        shared_client.require_project_contract({}, 'project')
    if args.full:
        # Legacy orchestration HTTP helpers must use only the operator-approved
        # node-local endpoint/bearer, never an inherited project override.
        import os
        from urllib.parse import urlsplit
        local = urlsplit(connection.local_url)
        if local.scheme != 'http':
            raise ValueError('Full CAO orchestration requires an HTTP private local API')
        host = local.hostname or ''
        os.environ['CAO_API_HOST'] = '[' + host + ']' if ':' in host else host
        os.environ['CAO_API_PORT'] = str(local.port)
        os.environ['CAO_AUTH_LOCAL_TOKEN'] = connection.local_token
    mcp = build_server(full=args.full)
    if args.check:
        async def verify():
            names = {tool.name for tool in await mcp.list_tools()}
            if not shared_client.TOOL_NAMES.issubset(names):
                raise RuntimeError('Shared CAO tool surface is incomplete')
            if not args.full and names != shared_client.TOOL_NAMES:
                raise RuntimeError('Unexpected tools in shared knowledge surface')
        asyncio.run(verify())
        print(json.dumps({"proof": "CAO_SHARED_CLI_READY_V1", **proof,
                          "server": "cao-mcp-server", "tools": sorted(shared_client.TOOL_NAMES)}))
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
