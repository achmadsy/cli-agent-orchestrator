import pytest

from cli_agent_orchestrator.models.code_graph import (
    CodeGraphNodeError,
    CodeGraphNodeResult,
    CodeGraphQuery,
)
from cli_agent_orchestrator.services.code_graph_service import merge_results


def test_mutating_tool_is_rejected():
    with pytest.raises(ValueError):
        CodeGraphQuery(tool="delete_project", project="x")


def test_merge_preserves_divergent_machine_variants():
    first = CodeGraphNodeResult(
        source_node="main", result={"results": [{"qualified_name": "p.f", "file_path": "x.py", "signature": "f()"}]}
    )
    second = CodeGraphNodeResult(
        source_node="link", result={"results": [{"qualified_name": "p.f", "file_path": "x.py", "signature": "f(x)"}]}
    )
    merged = merge_results(
        "search_graph", "project", [first, second], [CodeGraphNodeError(source_node="off", error="timeout")]
    )
    assert merged.partial is True
    assert merged.variants[0]["diverged"] is True
    assert {item["source_node"] for item in merged.variants[0]["variants"]} == {"main", "link"}
    assert "local working-tree source" in merged.guidance
