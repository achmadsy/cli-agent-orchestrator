from unittest.mock import AsyncMock

import pytest

from cli_agent_orchestrator.api.main import app
from cli_agent_orchestrator.security.auth import get_current_scopes, SCOPE_READ, SCOPE_WRITE
from cli_agent_orchestrator.services import provider_quota_reset as reset

BASE = "/agents/provider-profiles/test/quota/reset"


@pytest.fixture(autouse=True)
def cleanup(monkeypatch):
    monkeypatch.setenv("CAO_AUTH_LOCAL_TOKEN", "synthetic-test-only")
    yield
    app.dependency_overrides.pop(get_current_scopes, None)


def test_read_only_cannot_preview_or_confirm(client, monkeypatch):
    app.dependency_overrides[get_current_scopes] = lambda: [SCOPE_READ]
    preview = AsyncMock(); monkeypatch.setattr(reset, "preview", preview)
    assert client.post(BASE + "/preview").status_code == 403
    assert client.post(BASE + "/confirm", json={"intent_id": "a" * 32}).status_code == 403
    preview.assert_not_called()


def test_cross_origin_blocked_before_preview(client, monkeypatch):
    app.dependency_overrides[get_current_scopes] = lambda: [SCOPE_WRITE]
    preview = AsyncMock(); monkeypatch.setattr(reset, "preview", preview)
    response = client.post(BASE + "/preview", headers={"Origin": "https://not-approved.example"})
    assert response.status_code == 403
    preview.assert_not_called()


def test_confirm_validates_closed_body_and_unknown_status(client, monkeypatch):
    app.dependency_overrides[get_current_scopes] = lambda: [SCOPE_WRITE]
    confirm = AsyncMock(return_value={"operation_id": "a" * 32, "status": "unknown", "reason": "Do not retry", "quota_refresh": "not_attempted"})
    monkeypatch.setattr(reset, "confirm", confirm)
    assert client.post(BASE + "/confirm", json={"intent_id": "a" * 32, "grant_id": "client-choice"}).status_code == 422
    response = client.post(BASE + "/confirm", json={"intent_id": "a" * 32})
    assert response.status_code == 202
    confirm.assert_awaited_once()
    assert confirm.call_args.args[0] == "test"


def test_force_quota_read_and_write_visibility(client, monkeypatch):
    from cli_agent_orchestrator.services import provider_quota
    app.dependency_overrides[get_current_scopes] = lambda: [SCOPE_READ]
    read = AsyncMock(return_value={"profile_id": "test", "status": "ok", "quotas": [], "stale": False})
    monkeypatch.setattr(provider_quota, "get_provider_quota", read)
    response = client.get("/agents/provider-profiles/test/quota?force=true")
    assert response.status_code == 200
    assert response.json()["can_manage_resets"] is False
    read.assert_awaited_once_with("test", force=True)
