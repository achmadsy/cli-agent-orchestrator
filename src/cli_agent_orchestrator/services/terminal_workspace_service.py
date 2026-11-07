"""Optional loopback sidecar and short-lived, exact-target viewer capabilities.

Nothing is started, downloaded or installed on import. The operator explicitly
runs the reviewed cao-terminal binary; an unavailable sidecar keeps classic PTY
viewing available. Browser cookies never contain CAO or upstream credentials.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import hmac
import ipaddress
import os
import secrets
import time
from typing import Any
from urllib.parse import urlencode, urlsplit

import requests

from cli_agent_orchestrator.backends.registry import get_backend
from cli_agent_orchestrator.backends.tmux_backend import TmuxBackend
from cli_agent_orchestrator.clients.database import get_terminal_metadata
from cli_agent_orchestrator.security.auth import (
    SCOPE_ADMIN, SCOPE_WRITE, extract_scopes_from_token, is_auth_enabled,
)

VERSION = "cao-terminal/195ad23136c500b10fc88ba50397a25fa7b8c4d9"
LEASE_SECONDS = 600
MAX_VIEWERS = 128
MAX_RESPONSE_BYTES = 1024 * 1024
COOKIE_NAME = "cao_terminal_viewer"


class WorkspaceUnavailable(ValueError):
    """Optional service or target is not eligible for the workspace."""


def sidecar_config() -> tuple[str, str]:
    if os.getenv("CAO_TERMINAL_WORKSPACE", "").lower() not in {"1", "true", "on"}:
        raise WorkspaceUnavailable("Terminal workspace is disabled; use classic terminal")
    url = os.getenv("CAO_TERMINAL_URL", "http://127.0.0.1:9528").rstrip("/")
    parsed = urlsplit(url)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
        port = parsed.port
    except ValueError:
        loopback, port = False, None
    if (parsed.scheme != "http" or not loopback or not port or parsed.username
            or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise WorkspaceUnavailable("Terminal sidecar must use a numeric loopback HTTP URL")
    token = os.getenv("CAO_TERMINAL_INTERNAL_TOKEN", "")
    if len(token) < 32:
        raise WorkspaceUnavailable("Terminal sidecar internal token is not configured")
    return url, token


def _get(path: str, query: dict[str, str] | None = None) -> tuple[bytes, str]:
    """Bounded GET, no redirects, ambient proxy env, or forwarded browser headers."""
    base, token = sidecar_config()
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.get(
                base + path, params=query,
                headers={"X-CAO-Terminal-Token": token}, timeout=(2, 10),
                allow_redirects=False, stream=True,
            ) as response:
                if response.status_code != 200:
                    raise WorkspaceUnavailable("Terminal sidecar or target is unavailable")
                chunks, size = [], 0
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise WorkspaceUnavailable("Terminal response exceeded the safety limit")
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get("Content-Type", "application/octet-stream")
    except requests.RequestException as exc:
        raise WorkspaceUnavailable("Terminal sidecar is unavailable; use classic terminal") from exc


async def health() -> None:
    import json
    body, _ = await asyncio.to_thread(_get, "/health")
    try:
        valid = json.loads(body).get("version") == VERSION
    except (ValueError, AttributeError):
        valid = False
    if not valid:
        raise WorkspaceUnavailable("Terminal sidecar version is incompatible")


def resolve_target(terminal_id: str) -> dict[str, str]:
    metadata = get_terminal_metadata(terminal_id)
    if not metadata:
        raise WorkspaceUnavailable("Terminal no longer exists")
    backend = get_backend()
    if not isinstance(backend, TmuxBackend):
        raise WorkspaceUnavailable("This backend uses the classic terminal")
    try:
        return backend.resolve_workspace_target(terminal_id, metadata["tmux_session"])
    except (ValueError, KeyError, RuntimeError) as exc:
        raise WorkspaceUnavailable("Exact terminal ownership is unavailable; use classic terminal") from exc


@dataclass
class Viewer:
    id: str
    secret: str = field(repr=False)
    terminal_id: str
    target: dict[str, str]
    expires: float
    bearer: str | None = field(default=None, repr=False)
    auth_enabled: bool = False
    connections: int = 0

    def query(self) -> dict[str, str]:
        # Socket identity travels server-to-server only, never to the browser.
        return dict(self.target)

    async def validate(self) -> None:
        if self.expires <= time.monotonic() or self.auth_enabled != is_auth_enabled():
            raise WorkspaceUnavailable("Viewer expired; reopen the terminal")
        if self.auth_enabled:
            try:
                scopes = await asyncio.to_thread(extract_scopes_from_token, self.bearer or "")
            except Exception as exc:
                raise WorkspaceUnavailable("Viewer authentication expired") from exc
            if not {SCOPE_WRITE, SCOPE_ADMIN}.intersection(scopes):
                raise WorkspaceUnavailable("Viewer requires write access")
        current = await asyncio.to_thread(resolve_target, self.terminal_id)
        if current != self.target:
            raise WorkspaceUnavailable("Terminal identity changed; reopen the terminal")


_viewers: dict[str, Viewer] = {}


def create_viewer(terminal_id: str, target: dict[str, str], bearer: str | None) -> Viewer:
    now = time.monotonic()
    for key, item in list(_viewers.items()):
        if item.expires <= now:
            del _viewers[key]
    if len(_viewers) >= MAX_VIEWERS:
        raise WorkspaceUnavailable("Too many open viewers; close a viewer and retry")
    viewer = Viewer(secrets.token_urlsafe(18), secrets.token_urlsafe(32), terminal_id,
                    target, now + LEASE_SECONDS, bearer, is_auth_enabled())
    _viewers[viewer.id] = viewer
    return viewer


def lookup(viewer_id: str, cookie: str | None) -> Viewer:
    viewer = _viewers.get(viewer_id)
    if viewer is None or not cookie or not hmac.compare_digest(cookie, viewer.secret):
        raise WorkspaceUnavailable("Viewer authorization required; reopen from CAO")
    return viewer


def websocket_url(viewer: Viewer) -> tuple[str, dict[str, str]]:
    base, token = sidecar_config()
    return "ws" + base[4:] + "/ws?" + urlencode(viewer.query()), {"X-CAO-Terminal-Token": token}


async def fetch(path: str, query: dict[str, str] | None = None) -> tuple[bytes, str]:
    return await asyncio.to_thread(_get, path, query)
