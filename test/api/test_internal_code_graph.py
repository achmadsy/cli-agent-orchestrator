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


def test_local_index_route_checks_this_node_only(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "true")
    monkeypatch.setattr("cli_agent_orchestrator.api.main._require_private_code_graph_peer", lambda request: "127.0.0.1")
    seen = []

    async def fake_ensure(project, working_directory):
        seen.append((project, working_directory))
        return {"status": "started", "root_path": working_directory}

    monkeypatch.setattr(
        "cli_agent_orchestrator.services.code_graph_indexer.ensure_indexed", fake_ensure
    )
    response = client.post(
        "/internal/code-graph/local/index",
        json={"project": "cao", "working_directory": "/home/me/cao"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "started", "root_path": "/home/me/cao"}
    assert seen == [("cao", "/home/me/cao")]


def test_local_index_route_rejects_a_missing_directory(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "true")
    monkeypatch.setattr("cli_agent_orchestrator.api.main._require_private_code_graph_peer", lambda request: "127.0.0.1")
    response = client.post("/internal/code-graph/local/index", json={"project": "cao"})
    assert response.status_code == 422


def test_query_route_allows_indexing_for_a_writer(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "true")
    monkeypatch.setattr("cli_agent_orchestrator.api.main._require_private_code_graph_peer", lambda request: "127.0.0.1")
    seen = {}

    async def fake_query(query, *, allow_index=False):
        seen.update(project=query.project, allow_index=allow_index)
        return {"tool": query.tool, "results": [], "indexing": []}

    monkeypatch.setattr(
        "cli_agent_orchestrator.services.code_graph_gateway.query_code_graph", fake_query
    )
    response = client.post(
        "/internal/code-graph/query",
        json={"tool": "search_graph", "project": "cao", "working_directory": "/home/me/cao"},
    )
    assert response.status_code == 200
    # Auth is off in tests, so the caller holds every scope.
    assert seen == {"project": "cao", "allow_index": True}


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
