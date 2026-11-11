"""Gateway contracts without a real sidecar, tmux server or provider process."""
import asyncio
import time
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cli_agent_orchestrator.api import terminal_workspace as routes
from cli_agent_orchestrator.services import terminal_workspace_service as service

TARGET = {"session": "cao-test", "terminal": "abcdef12", "window_id": "@1", "pane_id": "%2", "mode": "pane", "socket": "/tmp/test-socket"}


@pytest.fixture
def workspace(monkeypatch):
    for name in ("AUTH0_DOMAIN", "CAO_AUTH_JWKS_URI", "CAO_AUTH_LOCAL_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(routes, "WS_ALLOWED_CLIENTS", ["127.0.0.1"])
    monkeypatch.setattr(service, "_viewers", {})
    monkeypatch.setattr(service, "health", AsyncMock())
    monkeypatch.setattr(service, "resolve_target", lambda _: TARGET.copy())
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app, base_url="http://localhost", client=("127.0.0.1", 1234))


def launch(client):
    return client.post("/terminal/viewers", json={"terminal_id": "abcdef12"}, headers={"Origin": "http://localhost"})


def test_launch_cookie_is_bounded_and_url_not_a_credential(workspace):
    response = launch(workspace)
    assert response.status_code == 200
    data = response.json()
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert f'Path={data["url"]}' in cookie
    assert "token" not in data["url"]
    assert workspace.get(data["url"] + "api/sessions").json() == [{"name": "cao-test", "windows": 1, "attached": 0}]
    anonymous = TestClient(workspace.app, base_url="http://localhost", client=("127.0.0.1", 3333))
    assert anonymous.get(data["url"] + "api/sessions").status_code == 401


def test_launch_cookie_honors_strip_proxy_prefix(workspace):
    response = workspace.post('/terminal/viewers', json={'terminal_id': 'abcdef12', 'base_path': '/cao'}, headers={'Origin': 'http://localhost'})
    assert response.status_code == 200
    assert response.json()['url'].startswith('/cao/terminal/v/')
    assert 'Path=/cao/terminal/v/' in response.headers['set-cookie']
    invalid = workspace.post('/terminal/viewers', json={'terminal_id': 'abcdef12', 'base_path': '//evil.example'}, headers={'Origin': 'http://localhost'})
    assert invalid.status_code == 422


def test_reject_foreign_origin_missing_origin_and_public_unauthenticated_peer(workspace):
    for origin in (None, "https://evil.example"):
        response = workspace.post("/terminal/viewers", json={"terminal_id": "abcdef12"}, headers={"Origin": origin} if origin else {})
        assert response.status_code == 403
    public = TestClient(workspace.app, base_url="http://localhost", client=("203.0.113.4", 3333))
    assert launch(public).status_code == 403


def test_reject_missing_bearer_and_read_scope(workspace, monkeypatch):
    monkeypatch.setenv("CAO_AUTH_LOCAL_TOKEN", "private")
    assert launch(workspace).status_code == 401
    monkeypatch.setattr("cli_agent_orchestrator.security.auth.extract_scopes_from_token", lambda _: ["cao:read"])
    assert workspace.post("/terminal/viewers", json={"terminal_id": "abcdef12"}, headers={"Origin": "http://localhost", "Authorization": "Bearer private"}).status_code == 403


@pytest.mark.parametrize("path", ["rescue", "api/rescue/kill-server", "api/upload", "api/agents", "api/notification/vapid-key", "sw.js", "manifest.json", "static/../server.go"])
def test_unknown_surfaces_do_not_reach_sidecar(workspace, monkeypatch, path):
    fetch = AsyncMock()
    monkeypatch.setattr(service, "fetch", fetch)
    url = launch(workspace).json()["url"]
    assert workspace.get(url + path).status_code in (401, 404)
    fetch.assert_not_called()


def test_cookie_for_other_viewer_does_not_authorize(workspace):
    one = launch(workspace).json()
    two = launch(workspace).json()
    anonymous = TestClient(workspace.app, base_url="http://localhost", client=("127.0.0.1", 3333))
    other_secret = service._viewers[two["viewer_id"]].secret
    assert anonymous.get(one["url"] + "api/sessions", headers={"Cookie": f"{service.COOKIE_NAME}={other_secret}"}).status_code == 401


def test_expired_deleted_and_changed_targets_fail_closed(workspace, monkeypatch):
    data = launch(workspace).json()
    viewer = service._viewers[data["viewer_id"]]
    viewer.expires = time.monotonic() - 1
    assert workspace.get(data["url"] + "api/sessions").status_code == 401
    viewer.expires = time.monotonic() + 60
    monkeypatch.setattr(service, "resolve_target", lambda _: {**TARGET, "pane_id": "%9"})
    assert workspace.get(data["url"] + "api/sessions").status_code == 401


def test_history_query_cannot_replace_bound_target(workspace, monkeypatch):
    fetch = AsyncMock(return_value=(b'{"content":"safe"}', "application/json"))
    monkeypatch.setattr(service, "fetch", fetch)
    data = launch(workspace).json()
    response = workspace.get(data["url"] + "api/history?session=personal&terminal=wrong&pane=%252&lines=5000")
    assert response.status_code == 200
    assert fetch.call_args.args[1]["session"] == "cao-test"
    assert fetch.call_args.args[1]["terminal"] == "abcdef12"


@pytest.mark.parametrize('asset', ['mono-regular.ttf', 'mono-bold.ttf', 'mono-italic.ttf', 'mono-bold-italic.ttf', 'powerline.otf', 'fontawesome.otf', 'LICENSE-DejaVu.txt', 'LICENSE-Powerline.txt', 'LICENSE-FontAwesome.txt', 'README.md', 'provenance.json'])
def test_only_exact_bundled_fonts_and_notices_are_served(workspace, monkeypatch, asset):
    fetch = AsyncMock(return_value=(b'fixture', 'application/octet-stream'))
    monkeypatch.setattr(service, 'fetch', fetch)
    url = launch(workspace).json()['url']
    assert workspace.get(url + 'static/fonts/' + asset).status_code == 200
    fetch.assert_awaited_once_with('/static/fonts/' + asset, None)
    fetch.reset_mock()
    assert workspace.get(url + 'static/fonts/arbitrary.otf').status_code == 404
    assert workspace.get(url + 'static/fonts/meslo-regular.ttf').status_code == 404
    fetch.assert_not_awaited()


def test_changed_history_coordinates_reach_browser_as_conflict(workspace, monkeypatch):
    monkeypatch.setattr(service, "fetch", AsyncMock(side_effect=service.HistoryChanged("History changed")))
    url = launch(workspace).json()["url"]
    assert workspace.get(url + "api/history?pane=%252").status_code == 409


@pytest.mark.parametrize("payload", ['{"type":"close_pane"}', '{"type":"link_join"}', '{"type":"resize_pane"}', '[]', '{"type":"input","text":"' + 'x'*65536 + '"}'])
def test_ws_message_allowlist(payload):
    with pytest.raises(ValueError):
        routes._validate_frame(payload)


@pytest.mark.parametrize("payload", [
    '{"type":"resize","pane":"%2","cols":180,"rows":48,"auto":true,"resize_seq":1}',
    '{"type":"resize","pane":"%2","release":true,"resize_seq":2}',
    '{"type":"resize","pane":"%2","auto":true,"resize_seq":3}',
    '{"type":"resize","pane":"%2","cols":180,"rows":48,"takeover":true}',
])
def test_ws_resize_frame_is_forwarded(payload):
    frame = routes._validate_frame(payload)
    assert frame["type"] == "resize" and frame["pane"] == "%2"


def test_sidecar_endpoint_rejects_arbitrary_hosts(monkeypatch):
    monkeypatch.setenv("CAO_TERMINAL_WORKSPACE", "1")
    monkeypatch.setenv("CAO_TERMINAL_INTERNAL_TOKEN", "x"*32)
    for url in ("http://evil.example:80", "http://127.0.0.1:80/path", "http://user:pass@127.0.0.1:80", "https://127.0.0.1:80"):
        monkeypatch.setenv("CAO_TERMINAL_URL", url)
        with pytest.raises(service.WorkspaceUnavailable): service.sidecar_config()


def test_expired_leases_are_reclaimed(monkeypatch):
    monkeypatch.setattr(service, "_viewers", {})
    viewer = service.create_viewer("abcdef12", TARGET, None)
    viewer.expires = 0
    service.create_viewer("abcdef12", TARGET, None)
    assert viewer.id not in service._viewers
