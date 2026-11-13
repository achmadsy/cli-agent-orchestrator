"""Shared client tests: synthetic endpoints/files, never production contents."""
import asyncio
import json
import os
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from cli_agent_orchestrator.mcp_server import shared_client as client
from cli_agent_orchestrator.mcp_server.shared import build_server
from cli_agent_orchestrator.mcp_server import server
from cli_agent_orchestrator.services import memory_gateway
from cli_agent_orchestrator.services.memory_service import MemoryService


@pytest.fixture(autouse=True)
def isolated_client(monkeypatch):
    monkeypatch.setattr(client, "_connection", None)
    monkeypatch.delenv("CAO_TERMINAL_ID", raising=False)


@pytest.fixture
def connection():
    return client.Connection("http://127.0.0.1:9889", "http://127.0.0.1:9889",
                             "central-test-token", "local-test-token-1")


def config(tmp_path):
    path = tmp_path / "client.json"
    path.write_text(json.dumps({"version": 1, "central_url": "http://100.64.0.1:9889",
                              "local_url": "http://127.0.0.1:9889",
                              "central_token": "central-test-token", "local_token": "local-test-token-1"}))
    path.chmod(0o600)
    return path


def test_private_connection_and_secret_repr(tmp_path):
    value = client.Connection.load(config(tmp_path))
    assert value.central_url == "http://100.64.0.1:9889"
    assert "test-token" not in repr(value)


@pytest.mark.parametrize("kind", ["mode", "symlink", "hardlink", "fifo", "duplicate", "oversize"])
def test_unsafe_config(tmp_path, kind):
    path = config(tmp_path)
    if kind == "mode": path.chmod(0o644)
    if kind == "symlink":
        path.rename(tmp_path / "other")
        path.symlink_to(tmp_path / "other")
    if kind == "hardlink": os.link(path, tmp_path / "link")
    if kind == "fifo":
        path.unlink()
        os.mkfifo(path)
    if kind == "duplicate": path.write_text('{"version":1,"version":1}')
    if kind == "oversize": path.write_bytes(b"x" * (client.MAX_CONFIG_BYTES + 1))
    with pytest.raises((ValueError, OSError)):
        client.Connection.load(path)


@pytest.mark.parametrize("url", ["http://example.com:9889", "http://8.8.8.8:9889", "http://127.0.0.1",
    "http://a:b@127.0.0.1:9889", "http://127.0.0.1:9889/path", "http://127.0.0.1:9889?token=x",
    "file:///tmp/cao", "http://0.0.0.0:9889", "http://169.254.169.254:80"])
def test_endpoint_refusal(url):
    with pytest.raises(ValueError): client.endpoint(url)


@pytest.mark.asyncio
async def test_only_knowledge_tools_are_callable():
    mcp = build_server()
    tools = await mcp.list_tools()
    assert {tool.name for tool in tools} == client.TOOL_NAMES
    assert await mcp.get_tool("send_message") is None
    assert await build_server(full=True).get_tool("send_message")


def test_manual_context_does_not_touch_local_db(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with patch("cli_agent_orchestrator.services.memory_service._record_alias_safe", side_effect=AssertionError("database write")):
        ctx = client.context(None)
    assert ctx["cwd"] == str(tmp_path)
    assert "session_name" not in ctx and "terminal_id" not in ctx
    assert len(ctx["project_id"]) == 12
    assert MemoryService().resolve_scope_id("project", ctx) == ctx["project_id"]
    with pytest.raises(ValueError, match="genuine"):
        client.validate_scope("session", ctx)


def test_real_context_uses_only_local_auth(connection, monkeypatch, tmp_path):
    client.configure(connection)
    monkeypatch.setenv("CAO_TERMINAL_ID", "abcd1234")
    with patch.object(client.Connection, "request", side_effect=[
        {"id": "abcd1234", "session_name": "real-session", "provider": "codex"},
        {"working_directory": str(tmp_path)}
    ]) as request:
        ctx = client.terminal_context()
    assert ctx["session_name"] == "real-session"
    assert all(call.kwargs["local"] for call in request.call_args_list)


def test_redirect_refused_and_tokens_do_not_cross_endpoints(connection):
    response = Mock(status_code=302)
    response.iter_content.return_value = [b'{}']
    with patch.object(client.requests, "Session") as constructor:
        session = constructor.return_value.__enter__.return_value
        session.request.return_value = response
        with pytest.raises(RuntimeError, match="HTTP 302"):
            connection.request("GET", "/health")
        assert session.trust_env is False
        assert session.request.call_args.kwargs["allow_redirects"] is False
        assert session.request.call_args.kwargs["headers"] == {"Authorization": "Bearer central-test-token"}
        with pytest.raises(RuntimeError): connection.request("GET", "/health", local=True)
        assert session.request.call_args.kwargs["headers"] == {"Authorization": "Bearer local-test-token-1"}
    response.close.assert_called()


@pytest.mark.asyncio
async def test_recall_shared_ignores_local_setting_and_never_local_store(connection, monkeypatch, tmp_path):
    client.configure(connection)
    monkeypatch.chdir(tmp_path)
    with (patch.object(client.Connection, "request", side_effect=[{"enabled": True}, {"memories": []}]) as request,
          patch("cli_agent_orchestrator.services.settings_service.is_memory_enabled", return_value=False),
          patch.object(memory_gateway, "MemoryService", side_effect=AssertionError("local store")),
          patch("cli_agent_orchestrator.services.memory_service.MemoryService.recall", side_effect=AssertionError("local store"))):
        result = await server.memory_recall(query="synthetic", scope="project", memory_type=None, limit=1,
                                            search_mode="hybrid", sort_by="recency", include_related=False)
    assert result == {"success": True, "memories": []}
    assert request.call_args.args[1] == "/internal/memory/recall"
    assert request.call_args.kwargs["body"]["terminal_context"]["cwd"] == str(tmp_path)


@pytest.mark.asyncio
async def test_auth_failure_no_fallback(connection, monkeypatch, tmp_path):
    client.configure(connection)
    monkeypatch.chdir(tmp_path)
    with (patch.object(client.Connection, "request", side_effect=RuntimeError("HTTP 401")),
          patch.object(memory_gateway, "MemoryService", side_effect=AssertionError("local store"))):
        result = await server.memory_forget(key="synthetic", scope="project")
    assert result["success"] is False and "401" in result["error"]


@pytest.mark.asyncio
async def test_shared_codebase_goes_directly_to_coordinator(connection, monkeypatch, tmp_path):
    client.configure(connection)
    monkeypatch.chdir(tmp_path)
    with (patch.object(client.Connection, "request", return_value={"results": []}) as request,
          patch.object(server.mcp_utils, "post_body_json", side_effect=AssertionError("local API"))):
        assert await server.codebase_status("fixture") == {"results": []}
    assert request.call_args.args == ("POST", "/internal/code-graph/query")
    assert request.call_args.kwargs["body"]["working_directory"] == str(tmp_path)


def test_worker_fails_closed_on_old_project_contract():
    connection = client.Connection("http://100.64.0.1:9889", "http://127.0.0.1:9889", "central-test-token", "local-test-token-1")
    client.configure(connection)
    with patch.object(client.Connection, "request", return_value={}):
        with pytest.raises(RuntimeError, match="project-identity API"):
            client.require_project_contract({"project_id": "fixture"}, "project")
