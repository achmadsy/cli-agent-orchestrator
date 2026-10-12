from cli_agent_orchestrator.models.code_graph import CodeGraphNodeResult


def test_code_graph_disabled_by_default(client):
    response = client.post(
        "/internal/code-graph/local/query",
        json={"tool": "list_projects", "arguments": {}},
    )
    assert response.status_code == 404


def test_forwarded_peer_is_not_trusted(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "true")
    response = client.post(
        "/internal/code-graph/local/query",
        json={"tool": "list_projects", "arguments": {}},
        headers={"X-Forwarded-For": "8.8.8.8"},
    )
    # TestClient's direct peer remains loopback. Forwarded headers are deliberately
    # ignored so a public reverse proxy cannot claim a Tailscale source address.
    assert response.status_code == 403


def test_local_query_never_fans_out(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "true")
    monkeypatch.setattr("cli_agent_orchestrator.api.main._require_private_code_graph_peer", lambda request: "127.0.0.1")

    async def fake_local(query):
        return CodeGraphNodeResult(source_node="node-a", result={"ok": True})

    monkeypatch.setattr(
        "cli_agent_orchestrator.services.code_graph_service.local_query", fake_local
    )
    response = client.post(
        "/internal/code-graph/local/query",
        json={"tool": "list_projects", "arguments": {}},
    )
    assert response.status_code == 200
    assert response.json()["source_node"] == "node-a"
