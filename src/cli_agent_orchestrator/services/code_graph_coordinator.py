"""Read-time fleet fan-out for one virtual Codebase Memory graph."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

import requests

from cli_agent_orchestrator.models.code_graph import (
    CodeGraphCombinedResult,
    CodeGraphHeartbeat,
    CodeGraphNodeError,
    CodeGraphNodeResult,
    CodeGraphQuery,
)
from cli_agent_orchestrator.security.auth import get_local_bearer
from cli_agent_orchestrator.services.code_graph_registry import list_bindings, upsert_heartbeat
from cli_agent_orchestrator.services.code_graph_service import (
    binary_version,
    discover_local_projects,
    local_query,
    merge_results,
    node_id,
)
from cli_agent_orchestrator.services.elastic_worker_gateway import elastic_worker_gateway_headers


async def refresh_local_registry(base_url: str = "http://127.0.0.1:9889") -> CodeGraphHeartbeat:
    heartbeat = CodeGraphHeartbeat(
        node_id=node_id(), cbm_version=await binary_version(), projects=await discover_local_projects()
    )
    await asyncio.to_thread(upsert_heartbeat, heartbeat, base_url)
    return heartbeat


def _remote_query(base_url: str, query: CodeGraphQuery) -> Dict[str, Any]:
    headers = elastic_worker_gateway_headers()
    token = get_local_bearer()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.post(
        f"{base_url.rstrip('/')}/internal/code-graph/local/query",
        json=query.model_dump(exclude_none=True),
        headers=headers or None,
        timeout=35,
    )
    response.raise_for_status()
    payload: Dict[str, Any] = response.json()
    return payload


async def federated_query(query: CodeGraphQuery) -> CodeGraphCombinedResult:
    await refresh_local_registry()
    bindings = list_bindings(query.project)
    if query.source_node:
        bindings = [item for item in bindings if item["node_id"] == query.source_node]
    deduped: Dict[str, Dict[str, Any]] = {}
    for binding in bindings:
        if binding["available"]:
            deduped.setdefault(binding["node_id"], binding)
    results: List[CodeGraphNodeResult] = []
    errors: List[CodeGraphNodeError] = []

    async def run(binding: Dict[str, Any]) -> None:
        local_request = query.model_copy(
            update={"project": binding["native_project"], "source_node": None}
        )
        try:
            if binding["node_id"] == node_id():
                result = await local_query(local_request)
            elif not binding["online"]:
                raise RuntimeError("node heartbeat is stale")
            else:
                payload = await asyncio.to_thread(
                    _remote_query, binding["base_url"], local_request
                )
                result = CodeGraphNodeResult.model_validate(payload)
            result.logical_project = binding["logical_project"]
            results.append(result)
        except Exception as exc:
            errors.append(
                CodeGraphNodeError(source_node=binding["node_id"], error=str(exc)[:300])
            )

    await asyncio.gather(*(run(binding) for binding in deduped.values()))
    return merge_results(query.tool, query.project, results, errors)
