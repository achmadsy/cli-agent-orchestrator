"""Local Codebase Memory adapter and deterministic fleet result merging."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from cli_agent_orchestrator.models.code_graph import (
    READ_TOOLS,
    CodeGraphCombinedResult,
    CodeGraphNodeError,
    CodeGraphNodeResult,
    CodeGraphProject,
    CodeGraphQuery,
)
from cli_agent_orchestrator.services.code_graph_identity import inspect_project

SUPPORTED_VERSION = "0.10.8"
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_CONCURRENCY = 2
_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)


def code_graph_enabled() -> bool:
    return os.getenv("CAO_CODEBASE_ENABLED", "false").strip().lower() == "true"


def node_id() -> str:
    return os.getenv("CAO_FLEET_NODE_ID", "local").strip() or "local"


def _binary() -> str:
    configured = os.getenv("CAO_CODEBASE_BINARY", "codebase-memory-mcp").strip()
    found = shutil.which(configured)
    if not found:
        raise RuntimeError("codebase-memory-mcp is not installed")
    return found


async def _invoke(tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    if tool not in READ_TOOLS:
        raise ValueError("unsupported or mutating Codebase Memory tool")
    payload = json.dumps(arguments, separators=(",", ":"))
    timeout = float(os.getenv("CAO_CODEBASE_QUERY_TIMEOUT", "30"))
    async with _semaphore:
        process = await asyncio.create_subprocess_exec(
            _binary(),
            "cli",
            "--json",
            tool,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "NO_COLOR": "1"},
        )
        try:
            stdout, _stderr = await asyncio.wait_for(
                process.communicate(payload.encode("utf-8")), timeout=timeout
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError("Codebase Memory query timed out")
    if process.returncode != 0:
        raise RuntimeError("Codebase Memory query failed")
    if len(stdout) > MAX_OUTPUT_BYTES:
        raise RuntimeError("Codebase Memory response exceeds 8 MiB")
    try:
        envelope = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Codebase Memory returned malformed JSON") from exc
    if envelope.get("isError"):
        raise RuntimeError("Codebase Memory rejected the query")
    result = envelope.get("structuredContent")
    if isinstance(result, dict):
        return result
    for item in envelope.get("content", []):
        if item.get("type") == "text":
            text = item.get("text", "")
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                # Some upstream read tools intentionally return their compact tree
                # rendering rather than structuredContent. Preserve it losslessly.
                if isinstance(text, str) and text:
                    return {"text": text}
                continue
            if isinstance(parsed, dict):
                return parsed
    raise RuntimeError("Codebase Memory response has no content")


async def binary_version() -> Optional[str]:
    try:
        process = await asyncio.create_subprocess_exec(
            _binary(), "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5)
    except (OSError, asyncio.TimeoutError, RuntimeError):
        return None
    text = (stdout + stderr).decode("utf-8", "replace")
    return SUPPORTED_VERSION if SUPPORTED_VERSION in text else text.strip()[:64] or None


async def discover_local_projects() -> List[CodeGraphProject]:
    result = await _invoke("list_projects", {})
    projects: List[CodeGraphProject] = []
    for item in result.get("projects", [])[:1000]:
        name, root = item.get("name"), item.get("root_path")
        if not isinstance(name, str) or not isinstance(root, str):
            continue
        project = await asyncio.to_thread(inspect_project, node_id(), name, root)
        project.indexed_at = datetime.now(timezone.utc)
        projects.append(project)
    return projects


def _normalize_result(result: Dict[str, Any], metadata: Optional[CodeGraphProject]) -> Dict[str, Any]:
    """Turn upstream columnar JSON into mergeable rows and logical names."""
    normalized = dict(result)
    columns, rows = normalized.get("cols"), normalized.get("rows")
    if isinstance(columns, list) and isinstance(rows, list):
        mapped = []
        for row in rows:
            if not isinstance(row, list):
                continue
            item = dict(zip(columns, row))
            if metadata and isinstance(item.get("qn"), str):
                native = item["qn"]
                item["native_qualified_name"] = native
                prefix = f"{metadata.native_project}."
                if native.startswith(prefix):
                    item["qualified_name"] = f"{metadata.logical_project}.{native[len(prefix):]}"
                else:
                    item["qualified_name"] = native
            if "file" in item and "file_path" not in item:
                item["file_path"] = item["file"]
            mapped.append(item)
        normalized["rows"] = mapped
    if metadata:
        normalized["logical_project"] = metadata.logical_project
        normalized["native_project"] = metadata.native_project
    return normalized


async def local_query(query: CodeGraphQuery) -> CodeGraphNodeResult:
    args = dict(query.arguments)
    project = query.project or args.get("project")
    if query.tool not in {"list_projects"} and project:
        args["project"] = project
    metadata: Optional[CodeGraphProject] = None
    if project:
        for candidate in await discover_local_projects():
            if project in {candidate.native_project, candidate.logical_project}:
                metadata = candidate
                args["project"] = candidate.native_project
                break
    result = _normalize_result(await _invoke(query.tool, args), metadata)
    return CodeGraphNodeResult(
        source_node=node_id(),
        logical_project=metadata.logical_project if metadata else None,
        native_project=metadata.native_project if metadata else project,
        branch=metadata.branch if metadata else None,
        head_sha=metadata.head_sha if metadata else None,
        dirty=metadata.dirty if metadata else False,
        indexed_at=metadata.indexed_at if metadata else None,
        result=result,
    )


def _variant_key(item: Dict[str, Any]) -> Optional[str]:
    for fields in (
        ("qualified_name", "file_path"),
        ("name", "file_path"),
        ("path",),
        ("file_path",),
    ):
        values = [item.get(field) for field in fields]
        if all(isinstance(value, str) and value for value in values):
            return "|".join(values)
    return None


def merge_results(
    tool: str,
    project: Optional[str],
    results: Iterable[CodeGraphNodeResult],
    errors: Iterable[CodeGraphNodeError] = (),
) -> CodeGraphCombinedResult:
    node_results = sorted(results, key=lambda value: value.source_node)
    node_errors = sorted(errors, key=lambda value: value.source_node)
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for node_result in node_results:
        payload = node_result.result
        candidates: List[Dict[str, Any]] = []
        if isinstance(payload, dict):
            for field in ("results", "nodes", "matches", "files", "rows"):
                value = payload.get(field)
                if isinstance(value, list):
                    candidates = [item for item in value if isinstance(item, dict)]
                    break
        for item in candidates:
            key = _variant_key(item)
            if key:
                grouped.setdefault(key, []).append(
                    {"source_node": node_result.source_node, "value": item}
                )
    variants = []
    for key, values in sorted(grouped.items()):
        signatures = {json.dumps(value["value"], sort_keys=True, default=str) for value in values}
        variants.append({"identity": key, "diverged": len(signatures) > 1, "variants": values})
    return CodeGraphCombinedResult(
        tool=tool,
        project=project,
        results=node_results,
        variants=variants,
        node_errors=node_errors,
        partial=bool(node_errors),
    )
