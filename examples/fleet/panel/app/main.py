"""CAO Fleet Panel — FastAPI aggregate + control API, serves the static UI."""
import asyncio
import hmac
import json
import os
import re
import subprocess
from urllib.parse import quote

import httpx
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import auth, client, config, installer

app = FastAPI(title="CAO Fleet Panel")
_login_throttler = auth.LoginThrottler()
_AUTH_CACHE_HEADERS = {"Cache-Control": "no-store, no-cache", "Pragma": "no-cache"}
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

_STATIC = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")

# cao-server session names / terminal ids are interpolated into upstream request
# paths; keep them to a safe charset so a crafted value can't traverse to another
# endpoint on the (already-trusted) node.
_SAFE_SEGMENT = re.compile(r"\A[A-Za-z0-9._-]+\Z")


def _safe_segment(value, kind):
    if not _SAFE_SEGMENT.match(value or ""):
        raise HTTPException(status_code=400, detail=f"invalid {kind}")
    return value


def _bearer_ok(header):
    """True when Authorization carries the configured automation token."""
    if not config.PANEL_TOKEN or not header:
        return False
    scheme, _, presented = header.partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(
        presented.strip(), config.PANEL_TOKEN
    )


def _browser_session(request):
    return auth.decode_session(
        config.PANEL_SESSION_SECRET,
        request.cookies.get(auth.COOKIE_NAME),
    )


def _auth_response(detail="authentication required", status_code=401, headers=None):
    response_headers = dict(_AUTH_CACHE_HEADERS)
    response_headers.update(headers or {})
    return JSONResponse({"detail": detail}, status_code=status_code, headers=response_headers)


def _public_path(path):
    return path == "/" or path.startswith("/static/") or path.startswith("/api/auth/")


@app.middleware("http")
async def _require_auth(request: Request, call_next):
    request.state.auth_kind = None
    request.state.panel_session = None
    if _bearer_ok(request.headers.get("authorization")):
        request.state.auth_kind = "bearer"
    else:
        session = _browser_session(request)
        if session is not None:
            request.state.auth_kind = "cookie"
            request.state.panel_session = session

    auth_configured = bool(config.PANEL_PASSWORD or config.PANEL_TOKEN)
    if auth_configured and not _public_path(request.url.path) and request.state.auth_kind is None:
        return _auth_response()

    if (
        request.state.auth_kind == "cookie"
        and request.method not in _SAFE_METHODS
        and request.url.path != "/api/auth/login"
    ):
        presented = request.headers.get("x-csrf-token")
        expected = request.state.panel_session.csrf
        if not presented or not hmac.compare_digest(presented, expected):
            return _auth_response("CSRF validation failed", status_code=403)

    response = await call_next(request)
    if request.url.path.startswith("/api/auth/"):
        response.headers.update(_AUTH_CACHE_HEADERS)
    return response


@app.post("/api/auth/login")
async def login(request: Request, body: dict = Body(default_factory=dict)):
    if not config.PANEL_PASSWORD or not config.PANEL_SESSION_SECRET:
        return _auth_response("browser login is not configured", status_code=503)
    client_ip = request.client.host if request.client else "unknown"
    if _login_throttler.is_blocked(client_ip):
        return _auth_response(
            "too many login attempts",
            status_code=429,
            headers={"Retry-After": str(_login_throttler.window_seconds)},
        )
    user_ok = auth.verify_username(config.PANEL_USER, body.get("username"))
    password_ok = auth.verify_password(config.PANEL_PASSWORD, body.get("password"))
    if not (user_ok and password_ok):
        _login_throttler.record_failure(client_ip)
        return _auth_response("invalid username or password")
    _login_throttler.reset(client_ip)
    raw, session = auth.create_session(
        config.PANEL_SESSION_SECRET,
        config.PANEL_USER,
        config.PANEL_SESSION_TTL,
    )
    response = JSONResponse(
        {"authenticated": True, "user": session.user, "csrf_token": session.csrf},
        headers=_AUTH_CACHE_HEADERS,
    )
    response.set_cookie(
        auth.COOKIE_NAME,
        raw,
        max_age=config.PANEL_SESSION_TTL,
        path="/",
        secure=True,
        httponly=True,
        samesite="strict",
    )
    return response


@app.get("/api/auth/status")
async def auth_status(request: Request):
    session = request.state.panel_session
    if session is None:
        return _auth_response()
    return JSONResponse(
        {"authenticated": True, "user": session.user, "csrf_token": session.csrf},
        headers=_AUTH_CACHE_HEADERS,
    )


@app.post("/api/auth/logout")
async def logout(request: Request):
    if request.state.auth_kind != "cookie":
        return _auth_response()
    response = JSONResponse({"authenticated": False}, headers=_AUTH_CACHE_HEADERS)
    response.delete_cookie(
        auth.COOKIE_NAME,
        path="/",
        secure=True,
        httponly=True,
        samesite="strict",
    )
    return response


def _machine_or_404(name):
    for m in config.load_machines():
        if m["name"] == name:
            return m
    raise HTTPException(status_code=404, detail=f"unknown machine '{name}'")


@app.get("/api/machines/{name}/open")
async def open_machine(name: str):
    machine = _machine_or_404(name)
    if not config.NODE_TOKEN:
        raise HTTPException(status_code=503, detail="node access token is not configured")
    location = f"https://{config.public_hostname(machine['name'])}/#token={quote(config.NODE_TOKEN, safe='')}"
    return RedirectResponse(
        location,
        status_code=303,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.get("/api/admin/tailscale-peers")
async def tailscale_peers():
    try:
        result = subprocess.run(
            ["tailscale", "status", "--json"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        status = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail=f"tailscale status unavailable: {type(exc).__name__}")
    registered_hosts = {machine["host"] for machine in config.load_machines()}
    peers = []
    for peer in (status.get("Peer") or {}).values():
        addresses = peer.get("TailscaleIPs") or []
        ipv4 = next((address for address in addresses if ":" not in address), None)
        if not peer.get("Online") or not ipv4 or peer.get("OS") not in (None, "linux"):
            continue
        try:
            host = config.validate_host(ipv4)
        except ValueError:
            continue
        if host in registered_hosts:
            continue
        peers.append({
            "name": str(peer.get("DNSName") or peer.get("HostName") or host).split(".", 1)[0].lower(),
            "host": host,
            "os": peer.get("OS") or "linux",
        })
    return {"peers": sorted(peers, key=lambda peer: peer["name"])}


def _sync_fleet():
    try:
        subprocess.run(
            ["sudo", "-n", config.SYNC_COMMAND],
            check=True,
            capture_output=True,
            text=True,
            timeout=90,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(f"fleet routing sync failed: {type(exc).__name__}") from exc


@app.post("/api/admin/machines/install")
async def install_machine(body: dict = Body(default_factory=dict)):
    peer_name = config.validate_name(body.get("peer"))
    peers = (await tailscale_peers())["peers"]
    peer = next((item for item in peers if item["name"] == peer_name), None)
    if peer is None:
        raise HTTPException(status_code=400, detail="selected peer is not online in this tailnet")
    try:
        job = installer.start_job(
            machine=body.get("name") or peer_name,
            peer=peer_name,
            user=body.get("user"),
            host=peer["host"],
            token=config.NODE_TOKEN,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return JSONResponse(job.public(), status_code=202, headers={"Cache-Control": "no-store"})


@app.get("/api/admin/jobs")
async def jobs():
    return {"jobs": installer.list_jobs()}


@app.get("/api/admin/jobs/{job_id}")
async def job_detail(job_id: str):
    job = installer.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown installation job")
    return JSONResponse(job.public(), headers={"Cache-Control": "no-store"})


@app.post("/api/admin/machines/register")
async def register_machine(body: dict = Body(default_factory=dict)):
    try:
        candidate = {
            "name": config.validate_name(body.get("name")),
            "host": config.validate_host(body.get("host")),
            "port": int(body.get("port", 9889)),
            "label": body.get("label"),
            "os": body.get("os", "linux"),
            "role": body.get("role", "agent"),
        }
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    base = config.base_url(candidate)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            await client.health(c, base)
            await client.list_sessions(c, base)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"node validation failed: {type(exc).__name__}")
    try:
        machine = config.add_machine(candidate)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    try:
        _sync_fleet()
    except RuntimeError as exc:
        config.remove_machine(machine["name"])
        try:
            _sync_fleet()
        except RuntimeError:
            pass
        raise HTTPException(status_code=502, detail=str(exc))
    return {"machine": machine, "hostname": config.public_hostname(machine["name"])}


@app.delete("/api/admin/machines/{name}")
async def unregister_machine(name: str):
    try:
        removed = config.remove_machine(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"unknown machine '{name}'")
    try:
        _sync_fleet()
    except RuntimeError as exc:
        config.add_machine(removed)
        try:
            _sync_fleet()
        except RuntimeError:
            pass
        raise HTTPException(status_code=502, detail=str(exc))
    return {"removed": name, "uninstalled": False}


@app.get("/api/fleet")
async def fleet():
    machines = config.load_machines()

    async def probe(m):
        base = config.base_url(m)
        entry = {
            "name": m["name"], "label": m["label"], "host": m["host"],
            "role": m.get("role"), "online": False, "claude": None, "sessions": [],
        }
        async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
            try:
                h = await client.health(c, base)
                entry["online"] = True
                entry["claude"] = (h.get("components") or {}).get("claude")
                entry["sessions"] = await client.list_sessions(c, base)
            except Exception as exc:  # offline / unreachable — isolate
                entry["error"] = type(exc).__name__
        return entry

    return {"machines": await asyncio.gather(*[probe(m) for m in machines])}


@app.post("/api/machines/{name}/launch")
async def launch(name: str, body: dict = Body(default_factory=dict)):
    m = _machine_or_404(name)
    base = config.base_url(m)
    agent = body.get("agent_profile") or "developer"
    provider = body.get("provider") or "claude_code"
    wd = body.get("working_directory")
    task = body.get("task")
    session_name = body.get("session_name") or ("fleet-panel-" + os.urandom(3).hex())
    _safe_segment(session_name, "session_name")
    async with client.async_client(client.LAUNCH_TIMEOUT, config.NODE_TOKEN) as c:
        try:
            term = await client.launch(c, base, agent, provider, session_name, wd)
        except httpx.HTTPStatusError as exc:
            detail = (exc.response.text or "").strip() or str(exc)
            raise HTTPException(status_code=502, detail=f"{name} launch failed: {detail}")
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name} launch failed: {type(exc).__name__}: {exc}")
        tid = term.get("id")
        # cao-server prefixes caller-provided names with "cao-". Return the
        # canonical value so subsequent detail and shutdown routes address the
        # session that was actually created.
        session_name = term.get("session_name") or session_name
        task_sent = False
        if task and tid:
            try:
                await client.send_message(c, base, tid, task)
                task_sent = True
            except httpx.HTTPError:
                task_sent = False
    return {"machine": name, "session_name": session_name, "terminal_id": tid, "task_sent": task_sent}


@app.get("/api/machines/{name}/sessions/{session_name}")
async def session_detail(name: str, session_name: str):
    _safe_segment(session_name, "session_name")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.get_session(c, base, session_name)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.post("/api/machines/{name}/sessions/{session_name}/send")
async def send(name: str, session_name: str, body: dict = Body(default_factory=dict)):
    _safe_segment(session_name, "session_name")
    msg = body.get("message")
    if not msg:
        raise HTTPException(status_code=400, detail="message required")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            detail = await client.get_session(c, base, session_name)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")
        terminals = detail.get("terminals") or []
        if not terminals:
            raise HTTPException(status_code=404, detail="no terminals in session")
        tid = terminals[0]["id"]
        try:
            await client.send_message(c, base, tid, msg)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")
    return {"machine": name, "session_name": session_name, "terminal_id": tid, "sent": True}


@app.post("/api/machines/{name}/sessions/{session_name}/shutdown")
async def shutdown(name: str, session_name: str):
    _safe_segment(session_name, "session_name")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.shutdown(c, base, session_name)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.get("/api/machines/{name}/terminals/{terminal_id}/output")
async def terminal_output(name: str, terminal_id: str, mode: str = "last"):
    _safe_segment(terminal_id, "terminal_id")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.terminal_output(c, base, terminal_id, mode)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.get("/api/machines/{name}/terminals/{terminal_id}/screen")
async def terminal_screen(name: str, terminal_id: str, ansi: bool = True):
    _safe_segment(terminal_id, "terminal_id")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.get_screen(c, base, terminal_id, ansi=ansi)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                # node has no /screen endpoint yet — degrade to plain-text tail
                out = await client.terminal_output(c, base, terminal_id, "full")
                return {"screen": out.get("output", ""), "ansi": False, "fallback": True}
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.post("/api/machines/{name}/terminals/{terminal_id}/key")
async def terminal_key(name: str, terminal_id: str, body: dict = Body(default_factory=dict)):
    _safe_segment(terminal_id, "terminal_id")
    key = body.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="key required")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.send_key(c, base, terminal_id, key)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.post("/api/machines/{name}/terminals/{terminal_id}/input")
async def terminal_input(name: str, terminal_id: str, body: dict = Body(default_factory=dict)):
    _safe_segment(terminal_id, "terminal_id")
    text = body.get("text")
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.send_input(c, base, terminal_id, text)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.get("/api/machines/{name}/providers")
async def machine_providers(name: str):
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.list_providers(c, base)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.get("/api/machines/{name}/profiles")
async def machine_profiles(name: str):
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.list_profiles(c, base)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


@app.get("/api/machines/{name}/terminals/{terminal_id}/working-directory")
async def terminal_wd(name: str, terminal_id: str):
    _safe_segment(terminal_id, "terminal_id")
    m = _machine_or_404(name)
    base = config.base_url(m)
    async with client.async_client(client.TIMEOUT, config.NODE_TOKEN) as c:
        try:
            return await client.working_directory(c, base, terminal_id)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"{name}: {exc}")


app.mount("/static", StaticFiles(directory=_STATIC), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(_STATIC, "index.html"))


def run():
    import uvicorn
    uvicorn.run(app, host=config.PANEL_HOST, port=config.PANEL_PORT)
