"""Fleet Codebase Memory registry stored in CAO's existing SQLite database."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import Boolean, Column, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from cli_agent_orchestrator.clients.database import Base, SessionLocal, UTCDateTime, _utcnow
from cli_agent_orchestrator.models.code_graph import CodeGraphHeartbeat
from cli_agent_orchestrator.services.code_graph_identity import (
    normalize_project_name,
    project_name_candidates,
)


class CodeGraphNodeModel(Base):
    __tablename__ = "code_graph_nodes"

    node_id = Column(String, primary_key=True)
    base_url = Column(String, nullable=False)
    cbm_version = Column(String, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    last_seen_at = Column(UTCDateTime, nullable=False, default=_utcnow)


class CodeGraphProjectModel(Base):
    __tablename__ = "code_graph_projects"

    binding_id = Column(String, primary_key=True)
    node_id = Column(String, nullable=False, index=True)
    logical_project = Column(String, nullable=False, index=True)
    native_project = Column(String, nullable=False)
    display_name = Column(String, nullable=False)
    root_path = Column(Text, nullable=False)
    remote_aliases_json = Column(Text, nullable=False, default="[]")
    branch = Column(String, nullable=True)
    head_sha = Column(String, nullable=True)
    dirty = Column(Boolean, nullable=False, default=False)
    indexed_at = Column(UTCDateTime, nullable=True)
    node_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    edge_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    stale: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    commits_since_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    available = Column(Boolean, nullable=False, default=True)
    last_seen_at = Column(UTCDateTime, nullable=False, default=_utcnow)


def upsert_heartbeat(heartbeat: CodeGraphHeartbeat, base_url: str) -> None:
    import json

    now = datetime.now(timezone.utc)
    with SessionLocal.begin() as db:
        node = db.get(CodeGraphNodeModel, heartbeat.node_id)
        if node is None:
            node = CodeGraphNodeModel(node_id=heartbeat.node_id, base_url=base_url)
            db.add(node)
        node.base_url = base_url
        node.cbm_version = heartbeat.cbm_version
        node.enabled = True
        node.last_seen_at = now
        seen: set[str] = set()
        for project in heartbeat.projects:
            binding_id = f"{heartbeat.node_id}:{project.native_project}"
            seen.add(binding_id)
            aliases = set(project.remote_aliases)
            overlapping_groups: set[str] = set()
            if aliases:
                for existing in db.query(CodeGraphProjectModel).all():
                    if aliases.intersection(json.loads(existing.remote_aliases_json or "[]")):
                        overlapping_groups.add(existing.logical_project)
            logical_project = (
                min(overlapping_groups) if overlapping_groups else project.logical_project
            )
            # Any shared normalized remote means one logical repository. Collapse
            # previously independent groups transactionally when a bridge appears.
            if len(overlapping_groups) > 1:
                db.query(CodeGraphProjectModel).filter(
                    CodeGraphProjectModel.logical_project.in_(overlapping_groups)
                ).update({"logical_project": logical_project}, synchronize_session=False)
            row = db.get(CodeGraphProjectModel, binding_id)
            if row is None:
                row = CodeGraphProjectModel(binding_id=binding_id, node_id=heartbeat.node_id)
                db.add(row)
            row.logical_project = logical_project
            row.native_project = project.native_project
            row.display_name = project.display_name
            row.root_path = project.root_path
            row.remote_aliases_json = json.dumps(project.remote_aliases)
            row.branch = project.branch
            row.head_sha = project.head_sha
            row.dirty = project.dirty
            row.indexed_at = project.indexed_at
            row.node_count = project.node_count
            row.edge_count = project.edge_count
            row.stale = project.stale
            row.commits_since_index = project.commits_since_index
            row.available = project.available
            row.last_seen_at = now
        for row in db.query(CodeGraphProjectModel).filter(
            CodeGraphProjectModel.node_id == heartbeat.node_id
        ):
            if row.binding_id not in seen:
                row.available = False


def list_bindings(
    logical_project: Optional[str] = None, *, max_age_seconds: int = 180
) -> List[Dict[str, Any]]:
    import json

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
    with SessionLocal() as db:
        query = db.query(CodeGraphProjectModel, CodeGraphNodeModel).join(
            CodeGraphNodeModel, CodeGraphNodeModel.node_id == CodeGraphProjectModel.node_id
        )
        if logical_project:
            query = query.filter(
                (CodeGraphProjectModel.logical_project == logical_project)
                | (CodeGraphProjectModel.native_project == logical_project)
            )
        rows = []
        for project, node in query.all():
            rows.append(
                {
                    "node_id": node.node_id,
                    "base_url": node.base_url,
                    "online": bool(node.enabled and node.last_seen_at >= cutoff),
                    "cbm_version": node.cbm_version,
                    "logical_project": project.logical_project,
                    "native_project": project.native_project,
                    "display_name": project.display_name,
                    "root_path": project.root_path,
                    "remote_aliases": json.loads(project.remote_aliases_json or "[]"),
                    "branch": project.branch,
                    "head_sha": project.head_sha,
                    "dirty": bool(project.dirty),
                    "indexed_at": project.indexed_at,
                    "node_count": project.node_count,
                    "edge_count": project.edge_count,
                    "stale": project.stale,
                    "commits_since_index": project.commits_since_index,
                    "available": bool(project.available),
                }
            )
        return rows


def find_bindings(
    project: str, working_directory: Optional[str] = None, *, max_age_seconds: int = 180
) -> List[Dict[str, Any]]:
    """Bindings for ``project``, matched by ID first, then by name.

    An exact logical or native project ID wins. Otherwise the name is compared,
    case-insensitively, with each project's folder name, path-derived name and
    Git remotes (host/owner/repo, owner/repo or repo). When a name matches more
    than one repository and ``working_directory`` lies inside one of them, only
    that repository's bindings are returned; otherwise all matches are.
    """
    exact = list_bindings(project, max_age_seconds=max_age_seconds)
    if exact:
        return exact
    key = normalize_project_name(project)
    if not key:
        return []
    matches = [
        row
        for row in list_bindings(max_age_seconds=max_age_seconds)
        if key == row["native_project"].lower()
        or key in project_name_candidates(row["root_path"], row["remote_aliases"])
    ]
    if working_directory and len({row["logical_project"] for row in matches}) > 1:
        directory = working_directory.rstrip("/")
        own = {
            row["logical_project"]
            for row in matches
            if directory == row["root_path"].rstrip("/")
            or directory.startswith(row["root_path"].rstrip("/") + "/")
        }
        if own:
            matches = [row for row in matches if row["logical_project"] in own]
    return matches


def list_nodes(
    *, max_age_seconds: int = 180, include_last_seen: bool = False
) -> List[Dict[str, Any]]:
    """Every registered node, optionally with its last reported snapshot time."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
    with SessionLocal() as db:
        return [
            {
                "node_id": node.node_id,
                "base_url": node.base_url,
                "online": bool(node.enabled and node.last_seen_at >= cutoff),
                **({"last_seen_at": node.last_seen_at} if include_last_seen else {}),
            }
            for node in db.query(CodeGraphNodeModel).all()
        ]
