"""Stable project identity without writing metadata into repositories."""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional
from urllib.parse import urlparse

from cli_agent_orchestrator.models.code_graph import CodeGraphProject

_REMOTE_SCP = re.compile(r"^(?:[^@/]+@)?([^:/]+):(.+)$")


def normalize_git_remote(value: str) -> str:
    """Return a host/path identity for common HTTPS, SSH and SCP Git remotes."""
    raw = value.strip()
    if not raw:
        raise ValueError("empty Git remote")
    match = _REMOTE_SCP.match(raw) if "://" not in raw else None
    if match:
        host, path = match.groups()
    else:
        parsed = urlparse(raw if "://" in raw else f"https://{raw}")
        host = parsed.hostname or ""
        path = parsed.path
    path = path.strip("/")
    if path.lower().endswith(".git"):
        path = path[:-4]
    if not host or not path or any(ord(ch) < 32 for ch in host + path):
        raise ValueError("invalid Git remote")
    return f"{host.lower()}/{path.lower()}"


def logical_project_id(remote_aliases: Iterable[str], *, node_id: str, native: str) -> str:
    aliases = sorted({normalize_git_remote(item) for item in remote_aliases if item.strip()})
    seed = aliases[0] if aliases else f"node:{node_id}:{native}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]
    slug = re.sub(r"[^a-z0-9]+", "-", seed.lower()).strip("-")[-80:] or "project"
    return f"{slug}-{digest}"


def normalize_project_name(value: str) -> str:
    """Lowercase a project name the way a person might type it."""
    name = value.strip().strip("/").lower()
    if name.endswith(".git"):
        name = name[:-4]
    return name


def path_slug(root_path: str) -> str:
    """The name Codebase Memory derives from a path, e.g. home-me-repo."""
    return re.sub(r"[^a-z0-9]+", "-", str(root_path).lower()).strip("-")


def project_name_candidates(root_path: str, remote_aliases: Iterable[str]) -> set[str]:
    """Names that identify a repository besides its generated ID.

    The folder name, the path-derived name, and for each Git remote the full
    host/path, the path without the host (owner/repo) and the last segment
    (repo). All lowercased.
    """
    names: set[str] = set()
    folder = PurePosixPath(root_path).name.lower()
    if folder:
        names.add(folder)
    slug = path_slug(root_path)
    if slug:
        names.add(slug)
    for alias in remote_aliases:
        try:
            normalized = normalize_git_remote(alias)
        except ValueError:
            continue
        parts = normalized.split("/")
        names.add(normalized)
        names.add("/".join(parts[1:]))
        names.add(parts[-1])
    return names


def git_toplevel(path: str) -> Optional[str]:
    """Return the root of the Git work tree containing ``path``, if any."""
    return _git(Path(path), "rev-parse", "--show-toplevel")


def relative_repo_path(root: str, path: str) -> str:
    base = Path(root).resolve()
    candidate = Path(path)
    resolved = candidate.resolve() if candidate.is_absolute() else (base / candidate).resolve()
    try:
        rel = resolved.relative_to(base)
    except ValueError as exc:
        raise ValueError("path escapes indexed repository") from exc
    result = PurePosixPath(rel.as_posix())
    if ".." in result.parts or any(ord(ch) < 32 for ch in str(result)):
        raise ValueError("unsafe repository-relative path")
    return str(result)


def _git(root: Path, *args: str) -> Optional[str]:
    try:
        run = subprocess.run(
            ["git", "-C", str(root), *args],
            text=True,
            capture_output=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return run.stdout.strip() if run.returncode == 0 else None


def inspect_project(node_id: str, native_project: str, root_path: str) -> CodeGraphProject:
    """Inspect one indexed root using read-only Git commands."""
    root = Path(root_path).expanduser().resolve()
    remotes_output = _git(root, "remote", "-v") or ""
    aliases: set[str] = set()
    for line in remotes_output.splitlines():
        fields = line.split()
        if len(fields) >= 2:
            try:
                aliases.add(normalize_git_remote(fields[1]))
            except ValueError:
                pass
    branch = _git(root, "branch", "--show-current") or _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    head = _git(root, "rev-parse", "HEAD")
    status = _git(root, "status", "--porcelain", "--untracked-files=normal")
    logical = logical_project_id(aliases, node_id=node_id, native=native_project)
    display = sorted(aliases)[0] if aliases else f"{node_id}/{native_project}"
    return CodeGraphProject(
        native_project=native_project,
        root_path=str(root),
        logical_project=logical,
        display_name=display,
        remote_aliases=sorted(aliases),
        branch=branch,
        head_sha=head,
        dirty=bool(status),
        available=root.is_dir(),
    )
