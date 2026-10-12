from pathlib import Path

import pytest

from cli_agent_orchestrator.services.code_graph_identity import (
    logical_project_id,
    normalize_git_remote,
    relative_repo_path,
)


def test_remote_forms_share_identity():
    expected = "github.com/owner/repo"
    assert normalize_git_remote("https://github.com/Owner/Repo.git") == expected
    assert normalize_git_remote("git@github.com:Owner/Repo.git") == expected
    assert normalize_git_remote("ssh://git@github.com/Owner/Repo.git") == expected
    assert logical_project_id([expected], node_id="a", native="x") == logical_project_id(
        ["git@github.com:owner/repo.git"], node_id="b", native="y"
    )


def test_non_git_projects_remain_node_qualified():
    assert logical_project_id([], node_id="a", native="same") != logical_project_id(
        [], node_id="b", native="same"
    )


def test_relative_path_rejects_escape(tmp_path: Path):
    root = tmp_path / "repo"
    root.mkdir()
    inside = root / "src" / "app.py"
    inside.parent.mkdir()
    inside.write_text("")
    assert relative_repo_path(str(root), str(inside)) == "src/app.py"
    with pytest.raises(ValueError):
        relative_repo_path(str(root), str(tmp_path / "outside.py"))
