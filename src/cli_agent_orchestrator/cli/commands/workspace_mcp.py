"""CLI commands for workspace-backed MCP servers (Quick Tunnel instances)."""

import json
import os
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

import click

from cli_agent_orchestrator.services.workspace_mcp_service import get_workspace_mcp_service

DEFAULT_FLEET_PATH = Path(__file__).resolve().parents[4] / "examples" / "fleet" / "fleet.json"


def _resolve_node(node_name: str) -> tuple[str, int]:
    """Resolve machine name from fleet.json to (host, port)."""
    fleet_path = Path(os.environ.get("CAO_FLEET_CONFIG", str(DEFAULT_FLEET_PATH)))
    if not fleet_path.is_file():
        raise click.ClickException(f"Fleet configuration not found at {fleet_path}")
    try:
        cfg = json.loads(fleet_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise click.ClickException(f"Failed to parse fleet configuration: {exc}")
    port = int(cfg.get("port", 9889))
    nodes = {m["name"]: m for m in cfg.get("machines", [])}
    if node_name not in nodes:
        raise click.ClickException(
            f"Unknown fleet node '{node_name}'. Available: {', '.join(nodes.keys())}"
        )
    node = nodes[node_name]
    return node["host"], int(node.get("port", port))


def _remote_api_call(
    host: str, port: int, method: str, path: str, payload: Optional[dict] = None
) -> dict:
    """Send HTTP request to remote node's cao-server."""
    url = f"http://{host}:{port}/{path.lstrip('/')}"
    headers = {"Accept": "application/json"}
    # Remote-node bearer is explicitly separate from this node's
    # CAO_AUTH_LOCAL_TOKEN: never send a local credential to another host.
    # Matches the fleet panel's CAO_NODE_TOKEN convention.
    node_token = os.environ.get("CAO_NODE_TOKEN", "").strip()
    if node_token:
        headers["Authorization"] = f"Bearer {node_token}"
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=70) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("detail", body)
        except Exception:
            detail = body
        raise click.ClickException(f"Remote node error ({exc.code}): {detail}") from exc
    except URLError as exc:
        raise click.ClickException(
            f"Failed to connect to node at {host}:{port}: {exc.reason}"
        ) from exc


@click.group(name="workspace-mcp")
def workspace_mcp():
    """Manage folder-backed workspace MCP instances (Quick Tunnel)."""


@workspace_mcp.command(name="start")
@click.argument("folder", type=str)
@click.option(
    "--agentic/--no-agentic", default=True, help="Enable agentic execution and git write sandbox"
)
@click.option("-n", "--node", "node_name", default=None, help="Target a specific fleet node")
def start_cmd(folder: str, agentic: bool, node_name: Optional[str]):
    """Start a workspace MCP server backing FOLDER."""
    if node_name:
        host, port = _resolve_node(node_name)
        click.echo(f"Dispatching workspace-mcp on node '{node_name}' ({host}:{port})...")
        res = _remote_api_call(
            host,
            port,
            "POST",
            "workspace-mcp",
            {"folder_path": folder, "agentic": agentic},
        )
        click.echo(f"Instance started on {node_name}: {res.get('id')}")
        click.echo(f"  Status:         {res.get('status')}")
        click.echo(f"  Folder:         {res.get('folder_path')}")
        click.echo(f"  Tunnel URL:     {res.get('tunnel_url')}")
        click.echo(f"  Local Port:     {res.get('port')}")
        click.echo(f"  Admin Password: {res.get('admin_password')}")
        return

    service = get_workspace_mcp_service()
    click.echo(f"Starting workspace MCP instance for '{folder}' (agentic={agentic})...")
    try:
        instance = service.start_instance(folder, agentic=agentic, timeout_s=60)
    except Exception as exc:
        raise click.ClickException(str(exc))

    click.echo(f"Instance successfully started: {instance.id}")
    click.echo(f"  Status:         {instance.status}")
    click.echo(f"  Folder:         {instance.folder_path}")
    click.echo(f"  Tunnel URL:     {instance.tunnel_url}")
    click.echo(f"  Local Port:     {instance.port}")
    click.echo(f"  Tmux Socket:    {instance.tmux_socket}")
    click.echo(f"  Tmux Session:   {instance.tmux_session}")
    click.echo(f"  Admin Password: {instance.admin_password}")
    click.echo("")
    click.echo(f"Attach:  tmux -L {instance.tmux_socket} attach -t {instance.tmux_session}")
    click.echo(f"Stop:    cao workspace-mcp stop {instance.id}")


@workspace_mcp.command(name="list")
@click.option("-n", "--node", "node_name", default=None, help="Target a specific fleet node")
@click.option("--json", "as_json", is_flag=True, help="Print output as JSON")
def list_cmd(node_name: Optional[str], as_json: bool):
    """List tracked workspace MCP instances."""
    if node_name:
        host, port = _resolve_node(node_name)
        rows = _remote_api_call(host, port, "GET", "workspace-mcp")
    else:
        service = get_workspace_mcp_service()
        instances = service.list_instances()
        rows = [inst.model_dump() for inst in instances]

    if as_json:
        click.echo(json.dumps(rows, indent=2))
        return

    if not rows:
        click.echo("No workspace MCP instances running.")
        return

    header = f"{'ID':<16} {'STATUS':<10} {'PORT':<6} {'FOLDER':<32} {'TUNNEL URL'}"
    click.echo(header)
    click.echo("-" * len(header))
    for row in rows:
        folder = row.get("folder_path", "")
        if len(folder) > 30:
            folder = "..." + folder[-27:]
        url = row.get("tunnel_url") or "-"
        click.echo(
            f"{row.get('id', ''):<16} {row.get('status', ''):<10} {str(row.get('port', '')):<6} {folder:<32} {url}"
        )


@workspace_mcp.command(name="status")
@click.argument("instance_id", type=str)
@click.option("-n", "--node", "node_name", default=None, help="Target a specific fleet node")
def status_cmd(instance_id: str, node_name: Optional[str]):
    """Show detailed status of a workspace MCP instance."""
    if node_name:
        if "/" in instance_id:
            raise click.ClickException("Remote status requires an instance ID; run list first")
        host, port = _resolve_node(node_name)
        row = _remote_api_call(host, port, "GET", f"workspace-mcp/{quote(instance_id, safe='')}")
    else:
        service = get_workspace_mcp_service()
        instance = service.get_instance(instance_id)
        if not instance:
            raise click.ClickException(f"Instance not found: {instance_id}")
        row = instance.model_dump()

    click.echo(f"Instance:       {row.get('id')}")
    click.echo(f"Status:         {row.get('status')}")
    click.echo(f"Folder:         {row.get('folder_path')}")
    click.echo(f"Agentic:        {row.get('agentic')}")
    click.echo(f"Port:           {row.get('port')}")
    click.echo(f"Tunnel URL:     {row.get('tunnel_url') or '-'}")
    click.echo(f"Admin Password: {row.get('admin_password') or '-'}")
    click.echo(f"Tmux Socket:    {row.get('tmux_socket')}")
    click.echo(f"Tmux Session:   {row.get('tmux_session')}")
    click.echo(f"Created:        {row.get('created_at')}")
    if row.get("error"):
        click.echo(f"Error:          {row.get('error')}")


@workspace_mcp.command(name="stop")
@click.argument("instance_id", type=str)
@click.option("-n", "--node", "node_name", default=None, help="Target a specific fleet node")
def stop_cmd(instance_id: str, node_name: Optional[str]):
    """Stop and unregister a workspace MCP instance."""
    if node_name:
        if "/" in instance_id:
            raise click.ClickException("Remote stop requires an instance ID; run list first")
        host, port = _resolve_node(node_name)
        res = _remote_api_call(host, port, "DELETE", f"workspace-mcp/{quote(instance_id, safe='')}")
        click.echo(f"Stopped instance {res.get('id')} on node {node_name}.")
        return

    service = get_workspace_mcp_service()
    instance = service.stop_instance(instance_id)
    if not instance:
        raise click.ClickException(f"Instance not found: {instance_id}")
    click.echo(f"Stopped instance {instance.id} (folder: {instance.folder_path}).")
