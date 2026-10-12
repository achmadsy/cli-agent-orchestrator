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


def _request(
    base_url: str, path: str, body: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
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


async def query_code_graph(query: CodeGraphQuery) -> Dict[str, Any]:
    base_url = remote_code_graph_url()
    if base_url:
        return await asyncio.to_thread(
            _request, base_url, "/internal/code-graph/query", query.model_dump(exclude_none=True)
        )
    from cli_agent_orchestrator.services.code_graph_coordinator import federated_query

    return (await federated_query(query)).model_dump(mode="json")


async def publish_heartbeat(body: Dict[str, Any]) -> Dict[str, Any]:
    base_url = remote_code_graph_url()
    if not base_url:
        raise RuntimeError("CAO_CODEBASE_API_URL is not configured")
    return await asyncio.to_thread(_request, base_url, "/internal/code-graph/heartbeat", body)


async def list_code_graph_projects() -> Dict[str, Any]:
    base_url = remote_code_graph_url()
    if base_url:
        return await asyncio.to_thread(_request, base_url, "/internal/code-graph/projects")
    from cli_agent_orchestrator.services.code_graph_coordinator import refresh_local_registry
    from cli_agent_orchestrator.services.code_graph_registry import list_bindings

    await refresh_local_registry()
    return {"projects": list_bindings()}
