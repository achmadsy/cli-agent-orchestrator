"""Same-origin terminal workspace gateway. Deny-by-default; not a public proxy."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import ipaddress
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket
from pydantic import BaseModel, Field
from websockets.legacy.client import connect

from cli_agent_orchestrator.constants import WS_ALLOWED_CLIENTS, is_ws_origin_allowed
from cli_agent_orchestrator.security.auth import (
    SCOPE_ADMIN, SCOPE_WRITE, _extract_bearer, is_auth_enabled, require_any_scope,
)
from cli_agent_orchestrator.services import terminal_workspace_service as service

router = APIRouter(prefix="/terminal", tags=["terminal-workspace"])
write_access = require_any_scope(SCOPE_WRITE, SCOPE_ADMIN)
_ASSET = re.compile(r"^static/(?:css|js)/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.(?:css|js)$")
_ALLOWED_MESSAGES = {"input", "key", "mouse", "focus", "fit", "fit_enable", "fit_disable",
                     "switch_window", "refresh_panes", "autocomplete", "pong"}


class LaunchRequest(BaseModel):
    terminal_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    base_path: str = Field(default="", max_length=200, pattern=r"^(?:/[A-Za-z0-9_-]+)*$")


def _peer_allowed(connection: Request | WebSocket) -> bool:
    peer = connection.client.host if connection.client else None
    if not peer or ("*" not in WS_ALLOWED_CLIENTS and peer not in WS_ALLOWED_CLIENTS):
        return False
    if not is_auth_enabled():
        try:
            return ipaddress.ip_address(peer).is_loopback
        except ValueError:
            return False
    return True


def _request_gate(request: Request | WebSocket) -> None:
    if not _peer_allowed(request):
        raise HTTPException(403, "Terminal workspace access is restricted")
    origin = request.headers.get("origin")
    # Browser-facing leases require Origin on launch/WS. Assets can be loaded
    # without it but are protected by their HttpOnly capability cookie.
    if origin and not is_ws_origin_allowed(origin, request.headers.get("host"), request.scope.get("scheme")):
        raise HTTPException(403, "Terminal workspace Origin is not allowed")


@router.post("/viewers", dependencies=[Depends(write_access)])
async def launch(body: LaunchRequest, request: Request, response: Response):
    _request_gate(request)
    if not request.headers.get("origin"):
        raise HTTPException(403, "Viewer launch requires a same-origin browser request")
    try:
        await service.health()
        target = await asyncio.to_thread(service.resolve_target, body.terminal_id)
        viewer = service.create_viewer(body.terminal_id, target, _extract_bearer(request.headers.get("authorization")))
        await viewer.validate()
    except service.WorkspaceUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    # Vite BASE supports strip-prefix proxies without ASGI root_path. The body
    # may select a validated local prefix only; it never selects an upstream URL.
    prefix = request.scope.get("root_path", "").rstrip("/") or body.base_path
    path = f"{prefix}/terminal/v/{viewer.id}/"
    response.set_cookie(service.COOKIE_NAME, viewer.secret, max_age=service.LEASE_SECONDS,
                        path=path, httponly=True, secure=request.url.scheme == "https", samesite="strict")
    response.headers["Cache-Control"] = "no-store"
    return {"url": path, "viewer_id": viewer.id, "expires_in": service.LEASE_SECONDS}


async def _viewer(viewer_id: str, request: Request | WebSocket) -> service.Viewer:
    _request_gate(request)
    try:
        viewer = service.lookup(viewer_id, request.cookies.get(service.COOKIE_NAME))
        await viewer.validate()
        return viewer
    except service.WorkspaceUnavailable as exc:
        raise HTTPException(401, str(exc)) from exc


@router.delete("/viewers/{viewer_id}", dependencies=[Depends(write_access)])
async def revoke(viewer_id: str, request: Request):
    _request_gate(request)
    # Authenticated CAO callers already have administrative terminal control.
    service._viewers.pop(viewer_id, None)
    return Response(status_code=204)


@router.get("/v/{viewer_id}/{path:path}")
async def view(viewer_id: str, path: str, request: Request):
    viewer = await _viewer(viewer_id, request)
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
               "Referrer-Policy": "no-referrer"}
    if path == "api/sessions":
        return Response(json.dumps([{"name": viewer.target["session"], "windows": 1, "attached": 0}]),
                        media_type="application/json", headers=headers)
    if path == "api/deck":
        # Deck writes/editor and upstream global agent inventory stay disabled.
        deck = {"panels": [{"title": "Terminal keys", "source": "static", "buttons": [
            {"label": "Escape", "action": {"type": "key", "payload": "Escape"}},
            {"label": "Tab", "action": {"type": "key", "payload": "Tab"}},
            {"label": "Enter", "action": {"type": "key", "payload": "Enter"}},
            {"label": "Interrupt", "confirm": True, "action": {"type": "key", "payload": "C-c"}},
        ]}]}
        return Response(json.dumps(deck), media_type="application/json", headers=headers)
    if path == "health":
        await service.health()
        return Response('{"status":"ok"}', media_type="application/json", headers=headers)
    query = None
    if path == "api/history":
        query = viewer.query()
        for key in ("pane", "lines", "offset"):
            if key in request.query_params:
                query[key] = request.query_params[key]
    elif path and not _ASSET.fullmatch(path):
        # No upstream CRUD/upload/rescue/link/notification/PWA bypass surfaces.
        raise HTTPException(404, "Not found")
    try:
        payload, content_type = await service.fetch("/" + path, query)
    except service.WorkspaceUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    return Response(payload, headers={**headers, "Content-Type": content_type})


def _validate_frame(raw: str) -> dict:
    if len(raw.encode("utf-8")) > 65536:
        raise ValueError("frame limit")
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("type") not in _ALLOWED_MESSAGES:
        raise ValueError("message not allowed")
    return value


@router.websocket("/v/{viewer_id}/ws")
async def socket(websocket: WebSocket, viewer_id: str):
    try:
        if not websocket.headers.get("origin"):
            raise HTTPException(403, "Origin required")
        viewer = await _viewer(viewer_id, websocket)
        if viewer.connections >= 2:
            raise HTTPException(429, "Viewer connection limit")
        url, headers = service.websocket_url(viewer)
    except (HTTPException, service.WorkspaceUnavailable):
        await websocket.close(code=4403, reason="Viewer authorization expired or unavailable")
        return
    viewer.connections += 1
    try:
        # No Origin forwarded: upstream is reached by this authenticated native
        # client. The browser Origin was validated independently above.
        async with connect(url, extra_headers=headers, max_size=service.MAX_RESPONSE_BYTES,
                           open_timeout=3, close_timeout=2, ping_interval=20) as upstream:
            await websocket.accept()

            async def browser_to_sidecar():
                while True:
                    raw = await websocket.receive_text()
                    _validate_frame(raw)
                    await viewer.validate()  # target/auth checked on EVERY browser operation
                    await upstream.send(raw)

            async def sidecar_to_browser():
                while True:
                    raw = await asyncio.wait_for(upstream.recv(), timeout=30)
                    await viewer.validate()  # covers expiry/deletion even on output-only connections
                    if not isinstance(raw, str):
                        raise ValueError("unexpected sidecar frame")
                    await websocket.send_text(raw)

            tasks = [asyncio.create_task(browser_to_sidecar()), asyncio.create_task(sidecar_to_browser())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except Exception:
        with suppress(Exception):
            await websocket.close(code=4401, reason="Viewer closed; reopen from CAO or use classic terminal")
    finally:
        viewer.connections -= 1
