import pytest

from cli_agent_orchestrator.mcp_server import server


@pytest.mark.asyncio
async def test_search_graph_uses_http_boundary(monkeypatch):
    seen = {}

    def fake_post(path, body, timeout=None):
        seen.update(path=path, body=body, timeout=timeout)
        return {"tool": "search_graph", "results": []}

    monkeypatch.setattr(server.mcp_utils, "post_body_json", fake_post)
    monkeypatch.setattr(server, "_get_terminal_context_from_env", lambda: {"cwd": "/repo"})
    result = await server.codebase_search_graph("logical-project", "update settings", 12)
    assert result["tool"] == "search_graph"
    assert seen["path"] == "/internal/code-graph/query"
    assert seen["body"]["working_directory"] == "/repo"
    assert seen["body"]["arguments"] == {"query": "update settings", "limit": 12, "format": "json"}


@pytest.mark.asyncio
async def test_codebase_tools_are_registered_on_single_server():
    names = {name for name in ("codebase_search_graph", "codebase_get_code_snippet", "codebase_query_graph") if await server.mcp.get_tool(name)}
    assert names == {"codebase_search_graph", "codebase_get_code_snippet", "codebase_query_graph"}
