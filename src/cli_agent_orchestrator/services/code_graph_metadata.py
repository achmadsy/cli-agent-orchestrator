"""Read-only metadata from the pinned Codebase Memory 0.10.8 cache.

The registry heartbeat is not an index timestamp. Missing/locked databases
produce unknown metadata, never a fabricated current timestamp.
"""

from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from cli_agent_orchestrator.services.code_graph_identity import _git


def read_index_metadata(native_project: str) -> Dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", native_project) or native_project in {".", ".."}:
        return {}
    cache = Path(os.getenv("CBM_CACHE_DIR") or Path.home() / ".cache" / "codebase-memory-mcp")
    path = cache.expanduser() / f"{native_project}.db"
    try:
        # mode=ro prevents an absent index from being created by a status read.
        with closing(
            sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.25)
        ) as db:
            deadline = time.monotonic() + 2
            db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
            db.execute("BEGIN")  # timestamp and counts from one consistent snapshot
            row = db.execute(
                "SELECT indexed_at FROM projects WHERE name = ?", (native_project,)
            ).fetchone()
            if not row or not row[0]:
                return {}
            stamp = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            result: Dict[str, Any] = {"indexed_at": stamp}
            for table, field in (("nodes", "node_count"), ("edges", "edge_count")):
                result[field] = db.execute(
                    f"SELECT count(*) FROM {table} WHERE project = ?", (native_project,)
                ).fetchone()[0]
            return result
    except (OSError, sqlite3.Error, ValueError, TypeError):
        return {}


def index_freshness(
    root: str, head: Optional[str], indexed_at: Optional[datetime]
) -> Dict[str, Any]:
    if not head or not indexed_at:
        return {}
    stamp = indexed_at.astimezone(timezone.utc).isoformat()
    base = None
    try:
        # Reflog sees checkouts/resets too, unlike comparing commit dates alone.
        run = subprocess.run(
            ["git", "-C", root, "rev-parse", "--verify", f"HEAD@{{{stamp}}}"],
            text=True,
            capture_output=True,
            timeout=3,
            check=False,
        )
        # Git returns success AND a warning when the requested time predates
        # the reflog. That SHA is not trustworthy as the indexed revision.
        if run.returncode == 0 and not run.stderr.strip():
            base = run.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    if base:
        count = _git(Path(root), "rev-list", "--count", f"{base}..{head}")
        return {
            "stale": base != head,
            "commits_since_index": int(count) if count and count.isdigit() else None,
        }
    # Legacy indexes / expired reflogs: best effort, based on newer commits.
    count = _git(Path(root), "rev-list", "--count", f"--since={stamp}", head)
    if count and count.isdigit():
        return {"stale": int(count) > 0, "commits_since_index": int(count)}
    return {}
