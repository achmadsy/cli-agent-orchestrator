"""Background Codebase Memory indexing for a repository nobody indexed yet.

When a graph query names a project that no node has indexed, the coordinator
asks each node to index the caller's repository. A node starts a job only if
the caller's working directory is inside a Git work tree on that node and the
requested name matches that repository's folder name, path-derived name or a
Git remote (full host/path, owner/repo, or repo). The query itself returns at
once with empty results, as before; the next query after the job finishes finds
the new index.

Guards: one job per repository, one job running at a time, at most
``MAX_PENDING_JOBS`` waiting, a retry delay after each attempt, and no blocked
system paths or the home directory itself.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, Optional, Tuple

from cli_agent_orchestrator.services.code_graph_identity import (
    git_toplevel,
    inspect_project,
    normalize_project_name,
    path_slug,
    project_name_candidates,
)
from cli_agent_orchestrator.utils.path_validation import resolve_and_validate_path

logger = logging.getLogger(__name__)

MAX_PENDING_JOBS = 4
INDEX_MODES = frozenset({"full", "moderate", "fast"})

_jobs: Dict[str, "asyncio.Task[None]"] = {}
_finished_at: Dict[str, float] = {}
_slot_state: Optional[Tuple[asyncio.AbstractEventLoop, asyncio.Semaphore]] = None


def auto_index_enabled() -> bool:
    return os.getenv("CAO_CODEBASE_AUTO_INDEX", "true").strip().lower() != "false"


def _retry_seconds() -> float:
    return float(os.getenv("CAO_CODEBASE_INDEX_RETRY_SECONDS", "600"))


def _timeout_seconds() -> float:
    return float(os.getenv("CAO_CODEBASE_INDEX_TIMEOUT", "900"))


def _index_mode() -> str:
    mode = os.getenv("CAO_CODEBASE_INDEX_MODE", "full").strip().lower()
    return mode if mode in INDEX_MODES else "full"


def _slot() -> asyncio.Semaphore:
    """One indexing job at a time, separate from the query concurrency limit."""
    global _slot_state
    loop = asyncio.get_running_loop()
    if _slot_state is None or _slot_state[0] is not loop:
        _slot_state = (loop, asyncio.Semaphore(1))
    return _slot_state[1]


def _reset_for_tests() -> None:
    global _slot_state
    _jobs.clear()
    _finished_at.clear()
    _slot_state = None


async def ensure_indexed(project: str, working_directory: str) -> Dict[str, Any]:
    """Start indexing the caller's repository on this node if the name matches.

    Returns a dict with ``status``: ``disabled``, ``not_here``, ``not_allowed``,
    ``not_a_repository``, ``name_mismatch``, ``already_indexed``, ``running``,
    ``retry_later``, ``busy`` or ``started``.
    """
    from cli_agent_orchestrator.services.code_graph_service import list_local_roots, node_id

    if not auto_index_enabled():
        return {"status": "disabled"}
    # A relative or "~" path would resolve against this server's cwd or home,
    # not the caller's; the MCP server always sends an absolute directory.
    if not os.path.isabs(working_directory) or not os.path.isdir(working_directory):
        return {"status": "not_here"}
    try:
        directory = resolve_and_validate_path(working_directory, description="Working directory")
    except ValueError:
        return {"status": "not_allowed"}

    toplevel = await asyncio.to_thread(git_toplevel, directory)
    if not toplevel:
        return {"status": "not_a_repository"}
    try:
        root = resolve_and_validate_path(toplevel, description="Repository")
    except ValueError:
        return {"status": "not_allowed"}
    if root == os.path.realpath(os.path.expanduser("~")):
        return {"status": "not_allowed"}

    identity = await asyncio.to_thread(inspect_project, node_id(), path_slug(root), root)
    names = project_name_candidates(root, identity.remote_aliases)
    if normalize_project_name(project) not in names and project != identity.logical_project:
        return {"status": "name_mismatch", "root_path": root}

    try:
        indexed_roots = await list_local_roots()
    except Exception:
        indexed_roots = []
    if any(os.path.realpath(path) == root for _name, path in indexed_roots):
        return {"status": "already_indexed", "root_path": root}

    # No await from here to create_task, so two concurrent misses for the same
    # repository cannot both start a job.
    job = _jobs.get(root)
    if job is not None and not job.done():
        return {"status": "running", "root_path": root}
    finished = _finished_at.get(root)
    if finished is not None:
        wait = _retry_seconds() - (time.monotonic() - finished)
        if wait > 0:
            return {
                "status": "retry_later",
                "root_path": root,
                "retry_after_seconds": int(wait) + 1,
            }
    if sum(1 for item in _jobs.values() if not item.done()) >= MAX_PENDING_JOBS:
        return {"status": "busy"}
    _jobs[root] = asyncio.create_task(_index(root))
    logger.info("Codebase Memory indexing queued for %s", root)
    return {"status": "started", "root_path": root}


async def _index(root: str) -> None:
    ok = False
    try:
        async with _slot():
            started = time.monotonic()
            ok = await _run_index(root)
            logger.info(
                "Codebase Memory indexing %s for %s after %.1fs",
                "finished" if ok else "failed",
                root,
                time.monotonic() - started,
            )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.warning("Codebase Memory indexing failed for %s (%s)", root, type(exc).__name__)
    finally:
        # Success or failure, wait before indexing the same repository again,
        # so a lookup that keeps missing can't re-index it on every query.
        _finished_at[root] = time.monotonic()
    if ok:
        await _publish()


async def _run_index(root: str) -> bool:
    from cli_agent_orchestrator.services.code_graph_service import _binary

    payload = json.dumps({"repo_path": root, "mode": _index_mode()}).encode("utf-8")
    process = await asyncio.create_subprocess_exec(
        _binary(),
        "cli",
        "--json",
        "index_repository",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "NO_COLOR": "1"},
    )
    try:
        stdout, _stderr = await asyncio.wait_for(
            process.communicate(payload), timeout=_timeout_seconds()
        )
    except (asyncio.TimeoutError, asyncio.CancelledError):
        process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        return False
    try:
        envelope = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(envelope, dict) and not envelope.get("isError")


async def _publish() -> None:
    """Refresh this node's registry, and the coordinator's if one is set."""
    try:
        from cli_agent_orchestrator.services.code_graph_coordinator import refresh_local_registry
        from cli_agent_orchestrator.services.code_graph_gateway import (
            publish_heartbeat,
            remote_code_graph_url,
        )

        heartbeat = await refresh_local_registry()
        if remote_code_graph_url():
            await publish_heartbeat(heartbeat.model_dump(mode="json"))
    except Exception as exc:
        logger.warning("Code graph registry refresh after indexing failed (%s)", type(exc).__name__)
