"""Authenticated history-only API; replicas cannot become execution targets."""

import asyncio
import ipaddress
import json
import os

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from cli_agent_orchestrator.security.auth import (
    SCOPE_ADMIN,
    SCOPE_READ,
    SCOPE_WRITE,
    is_auth_enabled,
    require_any_scope,
)
from cli_agent_orchestrator.services import agent_history as service
from cli_agent_orchestrator.services import agent_history_store as store

router = APIRouter()
read_scope = require_any_scope(SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN)
write_scope = require_any_scope(SCOPE_WRITE, SCOPE_ADMIN)
MAX_BODY = 4 * 1024 * 1024


def private_peer(request):
    """Direct loopback/tailnet only; forwarded browser traffic is never a peer."""
    try:
        address = ipaddress.ip_address(request.client.host)
    except (ValueError, AttributeError):
        raise HTTPException(403, "Direct private peer required")
    if not (address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")) or any(
        request.headers.get(key)
        for key in (
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "cf-ray",
            "cf-connecting-ip",
        )
    ):
        raise HTTPException(403, "Direct private peer required")
    if not is_auth_enabled():
        raise HTTPException(503, "History replication requires bearer authentication")
    return str(address)


def bound_source(peer, source):
    # Explicit operator configuration, independent of mutable heartbeat metadata.
    # A shared bearer alone does NOT authorize claiming another node's identity.
    try:
        peers = json.loads(os.getenv("CAO_HISTORY_PEERS", "{}"))
        expected = peers.get(source) if isinstance(peers, dict) else None
        if not isinstance(expected, str) or str(ipaddress.ip_address(expected)) != peer:
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(403, "History source is not bound to this peer")


@router.get("/agent-history")
async def listing(
    response: Response,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    _scopes=Depends(read_scope),
):
    response.headers["Cache-Control"] = "no-store"
    return await asyncio.to_thread(service.listing, offset, limit)


@router.get("/agent-history/{source}/{origin}/{terminal_id}")
async def detail(
    source: str, origin: str, terminal_id: str, response: Response, _scopes=Depends(read_scope)
):
    response.headers["Cache-Control"] = "no-store"
    found = await asyncio.to_thread(service.detail, source, origin, terminal_id)
    if found is None:
        raise HTTPException(404, "History not found")
    return found


class ResumeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(gt=0)
    confirm_no_task_replay: bool


@router.post("/agent-history/{terminal_id}/resume")
async def resume(
    terminal_id: str,
    body: ResumeRequest,
    request: Request,
    response: Response,
    _scopes=Depends(write_scope),
):
    response.headers["Cache-Control"] = "no-store"
    if not body.confirm_no_task_replay:
        raise HTTPException(422, "Explicit no-replay confirmation required")
    try:
        return await service.resume(
            terminal_id, body.expected_version, getattr(request.app.state, "plugin_registry", None)
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        # Launch may already have happened; never invite an automatic retry.
        raise HTTPException(
            409,
            "Resume outcome uncertain. Inspect sessions and history; do not retry automatically.",
        ) from exc


@router.get("/internal/agent-history/identity")
async def identity(request: Request, response: Response, _scopes=Depends(write_scope)):
    private_peer(request)
    response.headers["Cache-Control"] = "no-store"
    return {"origin": await asyncio.to_thread(store.origin)}


@router.post("/internal/agent-history/sync")
async def sync(request: Request, response: Response, _scopes=Depends(write_scope)):
    peer = private_peer(request)
    response.headers["Cache-Control"] = "no-store"
    # Stream bound BEFORE JSON/Pydantic allocation, including chunked requests.
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_BODY:
            raise HTTPException(413, "History batch exceeds byte limit")
        raw.extend(chunk)
    from cli_agent_orchestrator.models.agent_history import HistoryBatch

    try:
        batch = HistoryBatch.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(422, "Invalid history batch") from exc
    bound_source(peer, batch.source_node)
    return await asyncio.to_thread(store.accept, batch.source_node, batch)
