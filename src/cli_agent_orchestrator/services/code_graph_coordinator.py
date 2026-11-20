"""Read-time fleet fan-out for one virtual Codebase Memory graph."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

import requests

from cli_agent_orchestrator.models.code_graph import (
    CodeGraphCombinedResult,
    CodeGraphHeartbeat,
    CodeGraphIndexRequest,
    CodeGraphNodeError,
    CodeGraphNodeResult,
    CodeGraphQuery,
)
from cli_agent_orchestrator.security.auth import get_local_bearer
from cli_agent_orchestrator.services.code_graph_indexer import ensure_indexed
from cli_agent_orchestrator.services.code_graph_registry import (
    find_bindings,
    list_bindings,
    list_nodes,
    upsert_heartbeat,
)
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
        node_id=node_id(),
        cbm_version=await binary_version(),
        projects=await discover_local_projects(),
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


def _remote_index(base_url: str, request: CodeGraphIndexRequest) -> Dict[str, Any]:
    headers = elastic_worker_gateway_headers()
    token = get_local_bearer()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.post(
        f"{base_url.rstrip('/')}/internal/code-graph/local/index",
        json=request.model_dump(),
        headers=headers or None,
        timeout=20,
    )
    if response.status_code in (404, 405):
        # A node running an older CAO has no index route. It answers 405
        # rather than 404: an unknown POST path gets 405 on CAO because a
        # GET route matches every path.
        return {"status": "unsupported"}
    response.raise_for_status()
    payload: Dict[str, Any] = response.json()
    return payload


async def request_indexing(project: str, working_directory: str) -> List[Dict[str, Any]]:
    """Ask every online node to index the caller's repository if it has it.

    The coordinator can't tell which machine ``working_directory`` is on, so
    each node checks for itself and only the one holding a matching Git
    repository starts a job. Nodes that don't have it answer ``not_here``.
    """
    request = CodeGraphIndexRequest(project=project, working_directory=working_directory)
    local = node_id()
    nodes = {item["node_id"]: item for item in list_nodes()}
    nodes.setdefault(local, {"node_id": local, "base_url": "", "online": True})
    outcomes: List[Dict[str, Any]] = []

    async def run(node: Dict[str, Any]) -> None:
        try:
            if node["node_id"] == local:
                outcome = await ensure_indexed(project, working_directory)
            else:
                outcome = await asyncio.to_thread(_remote_index, node["base_url"], request)
        except Exception as exc:
            outcome = {"status": "error", "error": type(exc).__name__}
        outcomes.append({"source_node": node["node_id"], **outcome})

    await asyncio.gather(
        *(run(node) for node in nodes.values() if node["node_id"] == local or node["online"])
    )
    # Callers only need to hear from nodes that found the repository.
    return sorted(
        (item for item in outcomes if item.get("status") != "not_here"),
        key=lambda item: item["source_node"],
    )


async def federated_query(
    query: CodeGraphQuery, *, allow_index: bool = False
) -> CodeGraphCombinedResult:
    await refresh_local_registry()
    if query.project:
        bindings = find_bindings(query.project, query.working_directory)
    else:
        bindings = list_bindings()
    if query.source_node:
        bindings = [item for item in bindings if item["node_id"] == query.source_node]
    # With a project: one binding per node and repository, because a name can
    # match several repositories (an exact ID maps to one). Without a project:
    # one binding per node, as before, so a bare status call doesn't query
    # every repository on every node.
    deduped: Dict[Any, Dict[str, Any]] = {}
    for binding in bindings:
        if binding["available"]:
            key = (
                (binding["node_id"], binding["logical_project"])
                if query.project
                else binding["node_id"]
            )
            deduped.setdefault(key, binding)
    if not deduped and query.project and query.working_directory and allow_index:
        miss_indexing = await request_indexing(query.project, query.working_directory)
        combined = merge_results(query.tool, query.project, [], [])
        combined.indexing = miss_indexing
        return combined
    results: List[CodeGraphNodeResult] = []
    errors: List[CodeGraphNodeError] = []
    indexing: List[Dict[str, Any]] = []

    async def run(binding: Dict[str, Any]) -> None:
        if allow_index and query.project and binding.get("stale") is True and binding["online"]:
            try:
                if binding["node_id"] == node_id():
                    outcome = await ensure_indexed(binding["native_project"], binding["root_path"])
                else:
                    outcome = await asyncio.to_thread(
                        _remote_index,
                        binding["base_url"],
                        CodeGraphIndexRequest(
                            project=binding["native_project"],
                            working_directory=binding["root_path"],
                        ),
                    )
                indexing.append({"source_node": binding["node_id"], **outcome})
            except Exception as exc:
                indexing.append(
                    {
                        "source_node": binding["node_id"],
                        "status": "error",
                        "error": type(exc).__name__,
                    }
                )
        local_request = query.model_copy(
            update={"project": binding["native_project"], "source_node": None}
        )
        try:
            if binding["node_id"] == node_id():
                result = await local_query(local_request)
            elif not binding["online"]:
                raise RuntimeError("node heartbeat is stale")
            else:
                payload = await asyncio.to_thread(_remote_query, binding["base_url"], local_request)
                result = CodeGraphNodeResult.model_validate(payload)
            result.logical_project = binding["logical_project"]
            results.append(result)
        except Exception as exc:
            errors.append(CodeGraphNodeError(source_node=binding["node_id"], error=str(exc)[:300]))

    await asyncio.gather(*(run(binding) for binding in deduped.values()))
    combined = merge_results(query.tool, query.project, results, errors)
    combined.indexing = sorted(indexing, key=lambda item: item["source_node"])
    return combined
