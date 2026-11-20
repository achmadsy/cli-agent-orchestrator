"""Authenticated browser access must not inherit internal index permissions."""

from pathlib import Path
from types import SimpleNamespace

from cli_agent_orchestrator.services import code_graph_gateway as gateway


def test_browser_overview_does_not_require_private_peer(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "true")

    async def overview():
        return {"projects": [], "nodes": [{"node_id": "node", "online": True}]}

    monkeypatch.setattr(gateway, "code_graph_overview", overview)
    response = client.get("/code-graph/projects", headers={"X-Forwarded-Proto": "https"})
    assert response.status_code == 200
    assert response.json()["nodes"][0]["node_id"] == "node"


def test_browser_search_validates_and_only_passes_symbol_parameters(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "true")
    calls = []

    async def search(body):
        calls.append(body)
        return {"matches": [], "partial": False, "node_errors": []}

    monkeypatch.setattr(gateway, "search_code_graph", search)
    response = client.post(
        "/code-graph/search",
        json={
            "project": "repo",
            "query": "run",
            "tool": "query_graph",
            "allow_index": True,
        },
    )
    assert response.status_code == 200
    assert calls == [{"project": "repo", "query": "run", "limit": 50}]
    assert (
        client.post("/code-graph/search", json={"project": "repo", "query": ""}).status_code == 422
    )
    assert (
        client.post(
            "/code-graph/search", json={"project": "repo", "query": "run", "limit": 101}
        ).status_code
        == 422
    )


def test_browser_endpoints_obey_feature_gate(client, monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_ENABLED", "false")
    assert client.get("/code-graph/projects").status_code == 404
    assert (
        client.post("/code-graph/search", json={"project": "repo", "query": "run"}).status_code
        == 404
    )


def test_memory_project_choices_are_counted_outside_list_filters(client, monkeypatch):
    from cli_agent_orchestrator.api import main

    calls = []

    async def recall(**kwargs):
        calls.append(kwargs)
        return [SimpleNamespace(project=p) for p in ("small", "large", "large", "large")]

    monkeypatch.setattr(main, "_require_memory_enabled", lambda: None)
    monkeypatch.setattr(
        main,
        "_get_memory_service",
        lambda: SimpleNamespace(base_dir=Path("/unused"), recall=recall),
    )
    monkeypatch.setattr(main, "_memory_scope_id", lambda memory, base: memory.project)
    response = client.get("/memory/projects")
    assert response.status_code == 200
    assert response.json() == [
        {"scope_id": "large", "memory_count": 3},
        {"scope_id": "small", "memory_count": 1},
    ]
    assert calls[0]["scope"] == "project" and calls[0]["scan_all"] is True
