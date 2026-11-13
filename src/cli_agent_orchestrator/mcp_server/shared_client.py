"""Operator-configured, HTTP-only CAO knowledge client.

No database, shell configuration, project endpoint overrides, redirects or proxy
credentials are involved. The stdio launcher installs this state before importing
server modules; legacy/per-terminal servers do not install it.
"""
from __future__ import annotations

import ipaddress
import json
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import requests

TOOL_NAMES = frozenset({
    "memory_store", "memory_recall", "memory_forget", "codebase_projects",
    "codebase_status", "codebase_get_graph_schema", "codebase_get_architecture",
    "codebase_search_graph", "codebase_search_code", "codebase_trace_path",
    "codebase_get_code_snippet", "codebase_check_index_coverage",
    "codebase_detect_changes", "codebase_query_graph",
})
MAX_CONFIG_BYTES = 16384


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate configuration key")
        result[key] = value
    return result


def private_file(path: Path) -> bytes:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("CAO connection file requires an absolute path")
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()):
            raise ValueError("Unsafe CAO connection directory")
        from cli_agent_orchestrator.services.harness_mcp_integration import private_group
        sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
        unsafe_write = info.st_mode & 0o002 or (info.st_mode & 0o020 and not private_group(info.st_gid))
        if unsafe_write and not sticky_root:
            raise ValueError("Writable CAO connection ancestor")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077
                or info.st_size > MAX_CONFIG_BYTES):
            raise ValueError("CAO connection file must be private, owned and regular")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(MAX_CONFIG_BYTES + 1)
        after = os.fstat(fd)
        identity = lambda item: (item.st_dev, item.st_ino, item.st_uid, item.st_mode,
                                 item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if len(data) > MAX_CONFIG_BYTES or identity(after) != identity(info):
            raise ValueError("CAO connection file changed during read")
        return data
    finally:
        os.close(fd)


def endpoint(value: str) -> str:
    """Only explicit IP origins on loopback/private networks are accepted."""
    if not isinstance(value, str):
        raise ValueError("CAO endpoint must be a private IP origin")
    if any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise ValueError("Invalid CAO endpoint characters")
    parsed = urlsplit(value)
    try:
        address = ipaddress.ip_address(parsed.hostname or "")
        networks = ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7")
        allowed = address.is_loopback or any(address in ipaddress.ip_network(net) for net in networks)
        port = parsed.port
    except ValueError:
        raise ValueError("CAO endpoint must be a private IP origin") from None
    if (parsed.scheme not in ("http", "https") or not allowed
            or address.is_unspecified or address.is_multicast or address.is_link_local
            or not port or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("CAO endpoint must be a private IP origin with an explicit port")
    return value.rstrip("/")


def bearer(value: str) -> str:
    if not isinstance(value, str) or not 16 <= len(value) <= 4096 or any(c.isspace() for c in value):
        raise ValueError("A private CAO bearer credential is required")
    if not value.isascii() or any(ord(char) < 33 or ord(char) == 127 for char in value):
        raise ValueError("Invalid CAO bearer credential")
    return value


@dataclass(frozen=True)
class Connection:
    central_url: str
    local_url: str
    central_token: str = field(repr=False)
    local_token: str = field(repr=False)

    @classmethod
    def load(cls, path: Path) -> "Connection":
        value = json.loads(private_file(path), object_pairs_hook=unique_object)
        if (not isinstance(value, dict) or value.get("version") != 1
                or set(value) != {"version", "central_url", "central_token", "local_url", "local_token"}):
            raise ValueError("Unsupported CAO client connection schema")
        return cls(endpoint(value["central_url"]), endpoint(value["local_url"]),
                   bearer(value["central_token"]), bearer(value["local_token"]))

    def request(self, method: str, path: str, *, local=False, body=None, timeout=40):
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("CAO request requires an internal path")
        base = self.local_url if local else self.central_url
        token = self.local_token if local else self.central_token
        try:
            with requests.Session() as session:
                session.trust_env = False
                response = session.request(
                    method, base + path, json=body,
                    headers={"Authorization": "Bearer " + token},
                    timeout=timeout, allow_redirects=False, stream=True,
                )
                try:
                    chunks = []
                    size = 0
                    for chunk in response.iter_content(65536):
                        size += len(chunk)
                        if size > 8 * 1024 * 1024:
                            raise RuntimeError("CAO response exceeds client limit")
                        chunks.append(chunk)
                    payload = json.loads(b"".join(chunks))
                    if response.status_code != 200:
                        from cli_agent_orchestrator.models.memory_contracts import MemoryPartialWriteError
                        if isinstance(payload, dict) and payload.get("error_kind") == MemoryPartialWriteError.error_kind:
                            partial = payload.get("partial_write", {})
                            if (isinstance(partial, dict)
                                    and all(isinstance(partial.get(k), str) for k in ("key", "scope", "file_path"))
                                    and (partial.get("scope_id") is None or isinstance(partial["scope_id"], str))):
                                raise MemoryPartialWriteError(**{k: partial.get(k) for k in ("key", "scope", "scope_id", "file_path")})
                        # Never echo server bodies, request headers or a credentialed URL.
                        raise RuntimeError(f"CAO {'local' if local else 'central'} request failed (HTTP {response.status_code})")
                    if not isinstance(payload, (dict, list)):
                        raise RuntimeError("Invalid CAO response")
                    return payload
                finally:
                    response.close()
        except requests.RequestException:
            raise RuntimeError("CAO endpoint unavailable; no local storage fallback") from None

    def check(self) -> dict:
        """Metadata only. Never recall/store/delete memories as a connectivity test."""
        health = self.request("GET", "/health")
        settings = self.request("GET", "/settings/memory")
        if health.get("status") != "ok" or settings.get("enabled") is not True:
            raise RuntimeError("Hosted CAO memory is not enabled/healthy")
        graph = self.request("GET", "/internal/code-graph/projects")
        if not isinstance(graph, (dict, list)):
            raise RuntimeError("Hosted CAO codebase coordinator is unavailable")
        return {"central_health": "ok", "memory_enabled": True, "codebase_route": "cao"}


_connection: Connection | None = None
_full_surface = False


def configure(connection: Connection, *, full: bool = False) -> None:
    global _connection, _full_surface
    _connection = connection
    _full_surface = full


def full_surface() -> bool:
    return _full_surface


def current() -> Connection | None:
    return _connection


def context(terminal_context: dict | None) -> dict:
    """Real terminal metadata or manual cwd, never fabricated session identity."""
    result = dict(terminal_context or {})
    if terminal_context and not result.get('cwd'):
        raise ValueError('CAO terminal working directory is unavailable; refusing a guessed project context')
    cwd = Path(result.get("cwd") or Path.cwd()).resolve(strict=True)
    if not cwd.is_dir():
        raise ValueError("Working directory is unavailable")
    result["cwd"] = str(cwd)
    # Resolve remotely located repositories on the client, without recording aliases
    # in a client-local database. Reuse CAO's pure git normalization and fallback.
    from cli_agent_orchestrator.utils.project_identity import (
        git_remote_identity, normalize_git_remote,
    )
    import hashlib
    remote = git_remote_identity(cwd)
    if remote:
        project_id = normalize_git_remote(remote)
        if len(project_id) > 128:
            project_id = 'git-' + hashlib.sha256(project_id.encode()).hexdigest()[:32]
    else:
        project_id = hashlib.sha256(str(cwd).encode()).hexdigest()[:12]
    result["project_id"] = project_id
    return result


def terminal_context() -> dict:
    connection = current()
    if connection is None:
        raise RuntimeError("CAO shared client is not configured")
    terminal_id = os.environ.get("CAO_TERMINAL_ID", "").strip()
    if not terminal_id:
        return context(None)
    import re
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", terminal_id):
        raise ValueError("Invalid CAO terminal identity")
    meta = connection.request("GET", f"/terminals/{terminal_id}", local=True)
    if meta.get("id") != terminal_id:
        raise ValueError("CAO terminal identity mismatch")
    wd = connection.request("GET", f"/terminals/{terminal_id}/working-directory", local=True)
    return context({"terminal_id": meta["id"], "session_name": meta.get("session_name"),
                    "provider": meta.get("provider"), "agent_profile": meta.get("agent_profile"),
                    "allowed_tools": meta.get("allowed_tools"),
                    "ephemeral": meta.get("ephemeral", False), "cwd": wd.get("working_directory")})


def validate_scope(scope: str | None, ctx: dict) -> None:
    required = {"session": "session_name", "agent": "agent_profile"}.get(scope)
    if required and not ctx.get(required):
        raise ValueError(f"{scope} scope requires a genuine CAO terminal {required}; use project/global for a manual CLI")


def require_memory() -> None:
    connection = current()
    if connection is None:
        raise RuntimeError("CAO shared client is not configured")
    settings = connection.request("GET", "/settings/memory")
    if settings.get("enabled") is not True:
        from cli_agent_orchestrator.models.memory_contracts import MemoryDisabledError
        raise MemoryDisabledError("Hosted CAO memory is disabled")


def require_project_contract(ctx: dict, scope: str | None) -> None:
    connection = current()
    if connection and connection.local_url != connection.central_url and scope in (None, "project"):
        schema = connection.request("GET", "/openapi.json")
        fields = schema.get("components", {}).get("schemas", {}).get("InternalMemoryContext", {}).get("properties", {})
        if "project_id" not in fields:
            raise RuntimeError("Central CAO needs the shared project-identity API before worker project memory can be used")
