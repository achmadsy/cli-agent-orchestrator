"""Local/remote gateway for the federated Codebase Memory coordinator."""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, Optional

import requests

from cli_agent_orchestrator.models.code_graph import CodeGraphQuery
from cli_agent_orchestrator.security.auth import get_local_bearer
from cli_agent_orchestrator.services.elastic_worker_gateway import elastic_worker_gateway_headers


def remote_code_graph_url() -> Optional[str]:
    value = os.getenv("CAO_CODEBASE_API_URL", "").strip()
    return value.rstrip("/") if value else None


def _headers() -> Dict[str, str]:
    headers = elastic_worker_gateway_headers()
    token = get_local_bearer()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _request(base_url: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    connection_file = os.environ.get("CAO_SHARED_CONNECTION_FILE")
    if connection_file:
        from pathlib import Path

        from cli_agent_orchestrator.mcp_server.shared_client import Connection

        connection = Connection.load(Path(connection_file))
        if base_url.rstrip("/") != connection.central_url:
            raise RuntimeError("Codebase endpoint does not match approved CAO connection")
        return connection.request("POST" if body is not None else "GET", path, body=body)
    kwargs: Dict[str, Any] = {
        "headers": _headers() or None,
        "timeout": float(os.getenv("CAO_CODEBASE_HTTP_TIMEOUT", "35")),
    }
    if body is not None:
        kwargs["json"] = body
        response = requests.post(f"{base_url.rstrip('/')}{path}", **kwargs)
    else:
        response = requests.get(f"{base_url.rstrip('/')}{path}", **kwargs)
    response.raise_for_status()
    payload: Dict[str, Any] = response.json()
    return payload


async def query_code_graph(query: CodeGraphQuery, *, allow_index: bool = False) -> Dict[str, Any]:
    """Run a graph query here, or forward it to the configured coordinator.

    ``allow_index`` lets a query start background indexing of a missing or
    stale repository index. A forwarded query is
    decided by the coordinator, which checks the forwarding credential itself.
    """
    base_url = remote_code_graph_url()
    if base_url:
        return await asyncio.to_thread(
            _request, base_url, "/internal/code-graph/query", query.model_dump(exclude_none=True)
        )
    from cli_agent_orchestrator.services.code_graph_coordinator import federated_query

    return (await federated_query(query, allow_index=allow_index)).model_dump(mode="json")


async def publish_heartbeat(body: Dict[str, Any]) -> Dict[str, Any]:
    base_url = remote_code_graph_url()
    if not base_url:
        raise RuntimeError("CAO_CODEBASE_API_URL is not configured")
    return await asyncio.to_thread(_request, base_url, "/internal/code-graph/heartbeat", body)


async def code_graph_overview() -> Dict[str, Any]:
    """Browser-safe projection; old nodes' heartbeat dates are not index dates."""
    base_url = remote_code_graph_url()
    if base_url:
        return await asyncio.to_thread(_request, base_url, "/code-graph/projects")
    payload = await list_code_graph_projects()
    from cli_agent_orchestrator.services.code_graph_registry import list_nodes

    fields = (
        "node_id",
        "online",
        "cbm_version",
        "logical_project",
        "native_project",
        "display_name",
        "branch",
        "head_sha",
        "dirty",
        "available",
        "indexed_at",
        "node_count",
        "edge_count",
        "stale",
        "commits_since_index",
    )
    projects = []
    for binding in payload["projects"]:
        row = {key: binding.get(key) for key in fields}
        if row["node_count"] is None:
            row["indexed_at"] = None
        projects.append(row)
    return {
        "projects": projects,
        "nodes": [{"node_id": n["node_id"], "online": n["online"]} for n in list_nodes()],
    }


async def search_code_graph(body: Dict[str, Any]) -> Dict[str, Any]:
    """Only symbol search, never indexing, even through a writer's gateway token."""
    base_url = remote_code_graph_url()
    if base_url:
        return await asyncio.to_thread(_request, base_url, "/code-graph/search", body)
    from pathlib import PurePosixPath, PureWindowsPath

    from cli_agent_orchestrator.services.code_graph_coordinator import federated_query

    combined = await federated_query(
        CodeGraphQuery(
            tool="search_graph",
            project=body["project"],
            source_node=body.get("source_node"),
            arguments={"query": body["query"], "limit": body.get("limit", 50), "format": "json"},
        ),
        allow_index=False,
    )
    matches = []
    for result in combined.results:
        payload = result.result
        if not isinstance(payload, dict):
            continue
        for row in payload.get("rows", []):
            if not isinstance(row, dict):
                continue
            path = str(row.get("file_path") or row.get("file") or "")
            if (
                PurePosixPath(path).is_absolute()
                or PureWindowsPath(path).is_absolute()
                or ".." in PurePosixPath(path).parts
            ):
                continue
            matches.append(
                {
                    "source_node": result.source_node,
                    "branch": result.branch,
                    "qualified_name": row.get("qualified_name") or row.get("qn") or row.get("name"),
                    "kind": row.get("label"),
                    "file_path": path,
                    "lines": str(row.get("lines") or ""),
                }
            )
    return {
        "matches": matches,
        "partial": combined.partial,
        "node_errors": [
            {"source_node": e.source_node, "error": "Symbol search unavailable on this node"}
            for e in combined.node_errors
        ],
    }


async def list_code_graph_projects() -> Dict[str, Any]:
    base_url = remote_code_graph_url()
    if base_url:
        return await asyncio.to_thread(_request, base_url, "/internal/code-graph/projects")
    from cli_agent_orchestrator.services.code_graph_coordinator import refresh_local_registry
    from cli_agent_orchestrator.services.code_graph_registry import list_bindings

    await refresh_local_registry()
    return {"projects": list_bindings()}
