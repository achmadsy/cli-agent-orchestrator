"""Exercise real HTTP routing/auth with an isolated history database."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cli_agent_orchestrator.api import agent_history as routes
from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.services import agent_history_store as store
from test.conftest import mint_test_token


@pytest.fixture
def history_client(isolated_memory_db):
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app, client=("100.64.0.2", 1234)) as client:
        yield client


def test_history_read_survives_missing_runtime(history_client, tmp_path, monkeypatch):
    from cli_agent_orchestrator.services import agent_history

    database.create_terminal(
        "old", "cao-reboot", "developer", "codex", working_directory=str(tmp_path)
    )
    database.delete_terminal("old")
    monkeypatch.setattr(agent_history, "presence", lambda *_: "disconnected")
    response = history_client.get("/agent-history")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    item = response.json()["records"][0]
    assert item["runtime_state"] == "disconnected"
    assert item["resume_available"] is False
    assert "output" not in item
    detail = history_client.get(f'/agent-history/{item["source_node"]}/{item["origin"]}/old')
    assert detail.status_code == 200
    assert "private" not in detail.json()


def test_sync_source_binding_and_read_scope(history_client, rsa_keys, monkeypatch):
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from cli_agent_orchestrator.security import auth

    monkeypatch.setenv("AUTH0_DOMAIN", "test.local")
    monkeypatch.setenv("AUTH0_AUDIENCE", "cao://test")
    public_key = load_pem_private_key(rsa_keys[0], password=None).public_key()
    client = type(
        "Keys",
        (),
        {"get_signing_key_from_jwt": lambda self, token: type("Key", (), {"key": public_key})()},
    )()
    monkeypatch.setattr(auth.get_jwks_cache(), "get_client", lambda _: client)
    database.create_terminal("old", "cao-reboot", "developer", "codex")
    batch = {**store.export(), "source_node": "fixture"}
    read = {"Authorization": "Bearer " + mint_test_token(rsa_keys[0], scopes="cao:read")}
    write = {"Authorization": "Bearer " + mint_test_token(rsa_keys[0], scopes="cao:write")}
    assert history_client.get("/agent-history").status_code == 401
    assert (
        history_client.post("/internal/agent-history/sync", json=batch, headers=read).status_code
        == 403
    )
    assert (
        history_client.post("/internal/agent-history/sync", json=batch, headers=write).status_code
        == 403
    )
    monkeypatch.setenv("CAO_HISTORY_PEERS", '{"fixture":"100.64.0.2"}')
    result = history_client.post("/internal/agent-history/sync", json=batch, headers=write)
    assert result.status_code == 200
    assert result.json()["accepted"] is True
    batch["source_node"] = "forged"
    assert (
        history_client.post("/internal/agent-history/sync", json=batch, headers=write).status_code
        == 403
    )
    batch["source_node"] = "fixture"
    assert (
        history_client.post(
            "/internal/agent-history/sync",
            json=batch,
            headers={**write, "x-forwarded-for": "100.64.0.2"},
        ).status_code
        == 403
    )
    assert (
        history_client.post(
            "/agent-history/old/resume",
            json={"expected_version": 1, "confirm_no_task_replay": True},
            headers=read,
        ).status_code
        == 403
    )


def test_sync_requires_auth_and_bounds_body(history_client, monkeypatch):
    assert history_client.get("/internal/agent-history/identity").status_code == 503
    monkeypatch.setattr(routes, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(routes, "MAX_BODY", 32)
    headers = {"Authorization": "Bearer fixture-api-token"}
    assert (
        history_client.post(
            "/internal/agent-history/sync", content=b" " * 33, headers=headers
        ).status_code
        == 413
    )
    assert (
        history_client.post(
            "/internal/agent-history/sync", content=b"{}", headers=headers
        ).status_code
        == 422
    )


@pytest.fixture
def ingest_token(tmp_path, monkeypatch):
    import hashlib
    import json

    token = "fixture-history-ingest-token-123456789"
    path = tmp_path / "history-credentials.json"
    path.write_text(
        json.dumps({"version": 1, "nodes": {"fixture": hashlib.sha256(token.encode()).hexdigest()}})
    )
    path.chmod(0o600)
    monkeypatch.setenv("CAO_AUTH_LOCAL_TOKEN", "fixture-admin-token-987654321")
    monkeypatch.setenv("CAO_HISTORY_CREDENTIALS_FILE", str(path))
    monkeypatch.setenv("CAO_HISTORY_PEERS", '{"fixture":"100.64.0.2","other":"100.64.0.2"}')
    return token, path


def test_ingest_token_is_source_bound_and_not_general_api(history_client, ingest_token):
    token, _ = ingest_token
    headers = {"Authorization": "Bearer " + token}
    database.create_terminal("old", "cao-fixture", "developer", "codex")
    batch = {**store.export(), "source_node": "fixture"}
    assert (
        history_client.get("/internal/agent-history/identity", headers=headers).status_code == 200
    )
    assert (
        history_client.post("/internal/agent-history/sync", json=batch, headers=headers).status_code
        == 200
    )
    batch["source_node"] = "other"  # Same IP, different logical identity still forbidden.
    assert (
        history_client.post("/internal/agent-history/sync", json=batch, headers=headers).status_code
        == 403
    )
    assert history_client.get("/agent-history", headers=headers).status_code == 401
    assert (
        history_client.post(
            "/agent-history/old/resume",
            json={"expected_version": 1, "confirm_no_task_replay": True},
            headers=headers,
        ).status_code
        == 401
    )
    assert (
        history_client.get(
            "/internal/agent-history/identity", headers={**headers, "x-forwarded-for": "100.64.0.2"}
        ).status_code
        == 403
    )
    assert (
        history_client.get(
            "/internal/agent-history/identity",
            headers={"Authorization": "Bearer wrong-history-token"},
        ).status_code
        == 401
    )


def test_ingest_token_file_fail_closed(history_client, ingest_token, monkeypatch):
    token, path = ingest_token
    headers = {"Authorization": "Bearer " + token}
    path.chmod(0o644)
    assert (
        history_client.get("/internal/agent-history/identity", headers=headers).status_code == 503
    )
    path.chmod(0o600)
    monkeypatch.setenv("CAO_HISTORY_PEERS", '{"fixture":"100.64.0.3"}')
    assert (
        history_client.get("/internal/agent-history/identity", headers=headers).status_code == 403
    )


def test_resume_requires_explicit_confirmation(history_client):
    response = history_client.post(
        "/agent-history/old/resume", json={"expected_version": 1, "confirm_no_task_replay": False}
    )
    assert response.status_code == 422
