"""Project lookup by name and background indexing when nothing matches."""

import asyncio
import json
import os
import subprocess

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.models.code_graph import (
    CodeGraphHeartbeat,
    CodeGraphNodeResult,
    CodeGraphProject,
    CodeGraphQuery,
)
from cli_agent_orchestrator.services import (
    code_graph_coordinator,
    code_graph_indexer,
    code_graph_registry,
    code_graph_service,
)
from cli_agent_orchestrator.services.code_graph_identity import (
    logical_project_id,
    normalize_project_name,
    path_slug,
    project_name_candidates,
)

# ── names ──────────────────────────────────────────────────────────────


def test_name_candidates_cover_folder_path_and_remote_forms():
    names = project_name_candidates(
        "/home/ubuntu/workspace/cao/cli-agent-orchestrator",
        ["github.com/achmadsy/cli-agent-orchestrator"],
    )
    assert names == {
        "cli-agent-orchestrator",
        "home-ubuntu-workspace-cao-cli-agent-orchestrator",
        "github.com/achmadsy/cli-agent-orchestrator",
        "achmadsy/cli-agent-orchestrator",
    }


def test_project_names_are_matched_case_insensitively():
    assert normalize_project_name(" Achmadsy/CLI-Agent-Orchestrator.git ") == (
        "achmadsy/cli-agent-orchestrator"
    )
    assert path_slug("/home/link/My_Repo") == "home-link-my-repo"


# ── registry lookup ────────────────────────────────────────────────────


@pytest.fixture
def registry_db(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'graph.db'}", connect_args={"check_same_thread": False}
    )
    database.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(
        code_graph_registry,
        "SessionLocal",
        sessionmaker(autocommit=False, autoflush=False, bind=engine),
    )
    try:
        yield
    finally:
        engine.dispose()


def _project(native: str, root: str, aliases: list[str], node: str) -> CodeGraphProject:
    return CodeGraphProject(
        native_project=native,
        root_path=root,
        logical_project=logical_project_id(aliases, node_id=node, native=native),
        display_name=aliases[0] if aliases else f"{node}/{native}",
        remote_aliases=aliases,
    )


def _register(node: str, *projects: CodeGraphProject) -> None:
    code_graph_registry.upsert_heartbeat(
        CodeGraphHeartbeat(node_id=node, projects=list(projects)), f"http://{node}:9889"
    )


def _logical(rows):
    return {row["logical_project"] for row in rows}


def test_exact_id_still_wins(registry_db):
    cao = _project(
        "home-ubuntu-cao",
        "/home/ubuntu/cao",
        ["github.com/achmadsy/cli-agent-orchestrator"],
        "mainvps",
    )
    _register("mainvps", cao)

    rows = code_graph_registry.find_bindings(cao.logical_project)

    assert _logical(rows) == {cao.logical_project}
    assert (
        code_graph_registry.find_bindings("home-ubuntu-cao")[0]["native_project"]
        == "home-ubuntu-cao"
    )


@pytest.mark.parametrize(
    "name",
    [
        "cli-agent-orchestrator",
        "CLI-Agent-Orchestrator",
        "achmadsy/cli-agent-orchestrator",
        "github.com/achmadsy/cli-agent-orchestrator",
        "home-ubuntu-workspace-cli-agent-orchestrator",
    ],
)
def test_short_names_find_the_repository(registry_db, name):
    cao = _project(
        "home-ubuntu-workspace-cli-agent-orchestrator",
        "/home/ubuntu/workspace/cli-agent-orchestrator",
        ["github.com/achmadsy/cli-agent-orchestrator"],
        "mainvps",
    )
    _register("mainvps", cao)

    assert _logical(code_graph_registry.find_bindings(name)) == {cao.logical_project}


def test_one_repository_cloned_on_two_machines_is_one_project(registry_db):
    on_main = _project("home-ubuntu-app", "/home/ubuntu/app", ["github.com/me/app"], "mainvps")
    on_pc = _project("home-link-src-app", "/home/link/src/app", ["github.com/me/app"], "link-pc")
    _register("mainvps", on_main)
    _register("link-pc", on_pc)

    rows = code_graph_registry.find_bindings("app")

    assert {row["node_id"] for row in rows} == {"mainvps", "link-pc"}
    assert len(_logical(rows)) == 1


def test_ambiguous_name_prefers_the_callers_repository(registry_db):
    mine = _project("home-a-app", "/home/a/app", ["github.com/x/app"], "mainvps")
    other = _project("home-b-app", "/home/b/app", ["github.com/y/app"], "mainvps")
    _register("mainvps", mine, other)

    assert _logical(code_graph_registry.find_bindings("app")) == {
        mine.logical_project,
        other.logical_project,
    }
    assert _logical(code_graph_registry.find_bindings("app", "/home/a/app/src")) == {
        mine.logical_project
    }
    # A directory outside both keeps every match.
    assert len(_logical(code_graph_registry.find_bindings("app", "/home/c"))) == 2
    # A sibling folder with the same prefix is not inside /home/a/app.
    assert len(_logical(code_graph_registry.find_bindings("app", "/home/a/app2"))) == 2


def test_unknown_name_matches_nothing(registry_db):
    _register("mainvps", _project("home-a-app", "/home/a/app", ["github.com/x/app"], "mainvps"))

    assert code_graph_registry.find_bindings("cli-agent-orchestrator") == []


def test_list_nodes_includes_nodes_without_projects(registry_db):
    _register("link-pc")

    assert code_graph_registry.list_nodes() == [
        {"node_id": "link-pc", "base_url": "http://link-pc:9889", "online": True}
    ]


# ── paging ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_local_roots_follow_every_list_projects_page(monkeypatch):
    seen = []

    async def fake_invoke(tool, arguments):
        seen.append((tool, arguments))
        if arguments["offset"] == 0:
            return {"projects": [{"name": "a", "root_path": "/a"}], "has_more": True}
        return {"projects": [{"name": "b", "root_path": "/b"}, {"name": 3}], "has_more": False}

    monkeypatch.setattr(code_graph_service, "_invoke", fake_invoke)

    assert await code_graph_service.list_local_roots() == [("a", "/a"), ("b", "/b")]
    assert seen == [
        ("list_projects", {"offset": 0, "limit": 100}),
        ("list_projects", {"offset": 1, "limit": 100}),
    ]


# ── indexer ────────────────────────────────────────────────────────────


@pytest.fixture
def indexer(monkeypatch):
    code_graph_indexer._reset_for_tests()
    monkeypatch.delenv("CAO_CODEBASE_AUTO_INDEX", raising=False)
    monkeypatch.delenv("CAO_CODEBASE_INDEX_RETRY_SECONDS", raising=False)
    monkeypatch.setenv("CAO_FLEET_NODE_ID", "mainvps")
    roots: list = []

    async def fake_roots():
        return list(roots)

    async def no_publish():
        return None

    monkeypatch.setattr(code_graph_service, "list_local_roots", fake_roots)
    monkeypatch.setattr(code_graph_indexer, "_publish", no_publish)
    monkeypatch.setattr(code_graph_indexer, "RETRY_PAUSE_SECONDS", 0)
    yield roots
    code_graph_indexer._reset_for_tests()


def _git_repo(path, remote="git@github.com:Owner/My-Repo.git"):
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    if remote:
        subprocess.run(["git", "-C", str(path), "remote", "add", "origin", remote], check=True)
    return os.path.realpath(path)


def _blocking_index(monkeypatch, result=True):
    release = asyncio.Event()
    calls = []

    async def fake_run(root):
        calls.append(root)
        await release.wait()
        return result

    monkeypatch.setattr(code_graph_indexer, "_run_index", fake_run)
    return release, calls


@pytest.mark.asyncio
async def test_matching_name_starts_one_background_job(tmp_path, monkeypatch, indexer):
    root = _git_repo(tmp_path / "My-Repo")
    os.mkdir(os.path.join(root, "src"))
    release, calls = _blocking_index(monkeypatch)

    first = await code_graph_indexer.ensure_indexed("my-repo", os.path.join(root, "src"))
    second = await code_graph_indexer.ensure_indexed("owner/my-repo", root)

    assert first == {"status": "started", "root_path": root}
    assert second == {"status": "running", "root_path": root}
    release.set()
    await code_graph_indexer._jobs[root]
    assert calls == [root]

    indexer.append(("x", root))
    assert (await code_graph_indexer.ensure_indexed("my-repo", root))["status"] == "already_indexed"


@pytest.mark.asyncio
async def test_concurrent_misses_start_a_single_job(tmp_path, monkeypatch, indexer):
    root = _git_repo(tmp_path / "My-Repo")
    release, calls = _blocking_index(monkeypatch)

    outcomes = await asyncio.gather(
        *(code_graph_indexer.ensure_indexed("my-repo", root) for _ in range(5))
    )

    assert sorted(item["status"] for item in outcomes) == ["running"] * 4 + ["started"]
    release.set()
    await code_graph_indexer._jobs[root]
    assert calls == [root]


@pytest.mark.asyncio
async def test_failed_job_waits_before_retrying(tmp_path, monkeypatch, indexer):
    root = _git_repo(tmp_path / "My-Repo")
    release, calls = _blocking_index(monkeypatch, result=False)

    await code_graph_indexer.ensure_indexed("my-repo", root)
    release.set()
    await code_graph_indexer._jobs[root]

    later = await code_graph_indexer.ensure_indexed("my-repo", root)
    assert later["status"] == "retry_later"
    assert 0 < later["retry_after_seconds"] <= 601

    monkeypatch.setenv("CAO_CODEBASE_INDEX_RETRY_SECONDS", "0")
    assert (await code_graph_indexer.ensure_indexed("my-repo", root))["status"] == "started"
    await code_graph_indexer._jobs[root]
    # Each job tries twice before giving up.
    assert calls == [root] * 4


@pytest.mark.asyncio
async def test_job_retries_a_failed_run_once(tmp_path, monkeypatch, indexer):
    root = _git_repo(tmp_path / "My-Repo")
    results = iter([False, True])
    published = []

    async def flaky_run(path):
        return next(results)

    async def publish():
        published.append(True)

    monkeypatch.setattr(code_graph_indexer, "_run_index", flaky_run)
    monkeypatch.setattr(code_graph_indexer, "_publish", publish)

    await code_graph_indexer.ensure_indexed("my-repo", root)
    await code_graph_indexer._jobs[root]

    assert published == [True]


@pytest.mark.asyncio
async def test_job_that_fails_twice_logs_a_warning(tmp_path, monkeypatch, indexer, caplog):
    root = _git_repo(tmp_path / "My-Repo")
    release, calls = _blocking_index(monkeypatch, result=False)
    release.set()

    with caplog.at_level("WARNING", logger=code_graph_indexer.__name__):
        await code_graph_indexer.ensure_indexed("my-repo", root)
        await code_graph_indexer._jobs[root]

    assert calls == [root, root]
    assert f"Codebase Memory indexing failed for {root}" in caplog.text


@pytest.mark.asyncio
async def test_pending_jobs_are_capped(tmp_path, monkeypatch, indexer):
    release, _calls = _blocking_index(monkeypatch)
    roots = [_git_repo(tmp_path / f"repo{i}", remote=None) for i in range(5)]

    statuses = [
        (await code_graph_indexer.ensure_indexed(f"repo{i}", root))["status"]
        for i, root in enumerate(roots)
    ]

    assert statuses == ["started"] * 4 + ["busy"]
    release.set()
    await asyncio.gather(*code_graph_indexer._jobs.values())


@pytest.mark.asyncio
async def test_jobs_run_one_at_a_time(tmp_path, monkeypatch, indexer):
    running = 0
    peak = 0

    async def fake_run(root):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1
        return True

    monkeypatch.setattr(code_graph_indexer, "_run_index", fake_run)
    for i in range(3):
        root = _git_repo(tmp_path / f"repo{i}", remote=None)
        assert (await code_graph_indexer.ensure_indexed(f"repo{i}", root))["status"] == "started"

    await asyncio.gather(*code_graph_indexer._jobs.values())
    assert peak == 1


@pytest.mark.asyncio
async def test_other_names_and_places_are_not_indexed(tmp_path, monkeypatch, indexer):
    _release, calls = _blocking_index(monkeypatch)
    root = _git_repo(tmp_path / "My-Repo")
    plain = tmp_path / "plain"
    plain.mkdir()

    assert (await code_graph_indexer.ensure_indexed("other", root))["status"] == "name_mismatch"
    assert (await code_graph_indexer.ensure_indexed("plain", str(plain)))[
        "status"
    ] == "not_a_repository"
    assert (await code_graph_indexer.ensure_indexed("my-repo", str(tmp_path / "gone")))[
        "status"
    ] == "not_here"
    assert (await code_graph_indexer.ensure_indexed("my-repo", "My-Repo"))["status"] == "not_here"
    assert (await code_graph_indexer.ensure_indexed("etc", "/etc"))["status"] == "not_allowed"
    monkeypatch.setenv("HOME", root)
    assert (await code_graph_indexer.ensure_indexed("my-repo", root))["status"] == "not_allowed"
    monkeypatch.setenv("CAO_CODEBASE_AUTO_INDEX", "false")
    assert (await code_graph_indexer.ensure_indexed("my-repo", root))["status"] == "disabled"
    assert calls == []


@pytest.mark.asyncio
async def test_index_job_calls_index_repository(tmp_path, monkeypatch):
    fake = tmp_path / "fake-cbm"
    fake.write_text(
        "#!/bin/sh\n"
        'echo "$@" > "$CAPTURE.args"\n'
        'cat > "$CAPTURE.stdin"\n'
        'if [ -n "$FAIL" ]; then echo \'{"isError": true}\'; else echo \'{"content": []}\'; fi\n'
    )
    fake.chmod(0o755)
    capture = tmp_path / "capture"
    monkeypatch.setenv("CAO_CODEBASE_BINARY", str(fake))
    monkeypatch.setenv("CAPTURE", str(capture))
    monkeypatch.setenv("CAO_CODEBASE_INDEX_MODE", "fast")

    assert await code_graph_indexer._run_index("/home/me/repo") is True
    assert (tmp_path / "capture.args").read_text().split() == ["cli", "--json", "index_repository"]
    assert json.loads((tmp_path / "capture.stdin").read_text()) == {
        "repo_path": "/home/me/repo",
        "mode": "fast",
    }

    monkeypatch.setenv("FAIL", "1")
    assert await code_graph_indexer._run_index("/home/me/repo") is False


@pytest.mark.asyncio
async def test_index_failure_logs_the_indexer_error_line(tmp_path, monkeypatch, caplog):
    fake = tmp_path / "fake-cbm"
    fake.write_text(
        "#!/bin/sh\n"
        "cat > /dev/null\n"
        "echo 'level=info msg=mem.init budget_mb=1' >&2\n"
        "echo 'level=warn msg=daemon.private_dir_group_writable_ancestor mode=0775' >&2\n"
        "echo 'codebase-memory-mcp: CBM could not start because of a cache conflict' >&2\n"
        "echo 'level=warn msg=daemon.private_dir_group_writable_ancestor mode=0775' >&2\n"
        "echo 'hint: this command started a temporary CBM daemon.' >&2\n"
        "exit 1\n"
    )
    fake.chmod(0o755)
    monkeypatch.setenv("CAO_CODEBASE_BINARY", str(fake))

    with caplog.at_level("WARNING", logger=code_graph_indexer.__name__):
        assert await code_graph_indexer._run_index("/home/me/repo") is False

    assert "exit code 1" in caplog.text
    assert "CBM could not start because of a cache conflict" in caplog.text
    assert "hint:" not in caplog.text and "mem.init" not in caplog.text


@pytest.mark.asyncio
async def test_index_failure_logs_the_indexer_reply(tmp_path, monkeypatch, caplog):
    # What Codebase Memory 0.10.8 prints when files change during a full index.
    reply = {
        "content": [{"type": "text", "text": '{"status":"error"}'}],
        "structuredContent": {"status": "error", "hint": "Pipeline failed. Check repo_path."},
        "isError": True,
    }
    (tmp_path / "reply.json").write_text(json.dumps(reply))
    fake = tmp_path / "fake-cbm"
    fake.write_text(f"#!/bin/sh\ncat > /dev/null\ncat '{tmp_path / 'reply.json'}'\nexit 1\n")
    fake.chmod(0o755)
    monkeypatch.setenv("CAO_CODEBASE_BINARY", str(fake))

    with caplog.at_level("WARNING", logger=code_graph_indexer.__name__):
        assert await code_graph_indexer._run_index("/home/me/repo") is False

    assert "exit code 1): Pipeline failed. Check repo_path." in caplog.text


# ── coordinator ────────────────────────────────────────────────────────


@pytest.fixture
def coordinator(monkeypatch):
    calls = {"local_query": [], "ensure": [], "remote_index": []}

    async def no_refresh():
        return None

    async def fake_local_query(query):
        calls["local_query"].append(query)
        return CodeGraphNodeResult(source_node="mainvps", result={"results": []})

    async def fake_ensure(project, working_directory):
        calls["ensure"].append((project, working_directory))
        return {"status": "started", "root_path": working_directory}

    def fake_remote_index(base_url, request):
        calls["remote_index"].append(base_url)
        return {"status": "not_here"}

    monkeypatch.setattr(code_graph_coordinator, "refresh_local_registry", no_refresh)
    monkeypatch.setattr(code_graph_coordinator, "local_query", fake_local_query)
    monkeypatch.setattr(code_graph_coordinator, "ensure_indexed", fake_ensure)
    monkeypatch.setattr(code_graph_coordinator, "_remote_index", fake_remote_index)
    monkeypatch.setattr(code_graph_coordinator, "node_id", lambda: "mainvps")
    monkeypatch.setattr(
        code_graph_coordinator,
        "list_nodes",
        lambda: [
            {"node_id": "mainvps", "base_url": "http://127.0.0.1:9889", "online": True},
            {"node_id": "link-pc", "base_url": "http://100.86.119.44:9889", "online": True},
            {"node_id": "old-box", "base_url": "http://100.64.0.9:9889", "online": False},
        ],
    )
    return calls


def _binding(node, logical, native):
    return {
        "node_id": node,
        "base_url": f"http://{node}:9889",
        "online": True,
        "logical_project": logical,
        "native_project": native,
        "available": True,
    }


@pytest.mark.asyncio
async def test_miss_asks_online_nodes_to_index(monkeypatch, coordinator):
    monkeypatch.setattr(code_graph_coordinator, "find_bindings", lambda project, wd: [])
    query = CodeGraphQuery(
        tool="search_graph", project="cli-agent-orchestrator", working_directory="/home/ubuntu/cao"
    )

    combined = await code_graph_coordinator.federated_query(query, allow_index=True)

    assert combined.results == [] and combined.partial is False
    assert combined.indexing == [
        {"source_node": "mainvps", "status": "started", "root_path": "/home/ubuntu/cao"}
    ]
    assert coordinator["ensure"] == [("cli-agent-orchestrator", "/home/ubuntu/cao")]
    # link-pc is asked but doesn't have the folder; the offline node is skipped.
    assert coordinator["remote_index"] == ["http://100.86.119.44:9889"]


@pytest.mark.asyncio
async def test_miss_without_permission_or_directory_only_queries(monkeypatch, coordinator):
    monkeypatch.setattr(code_graph_coordinator, "find_bindings", lambda project, wd: [])

    read_only = await code_graph_coordinator.federated_query(
        CodeGraphQuery(tool="search_graph", project="x", working_directory="/home/me/x")
    )
    no_directory = await code_graph_coordinator.federated_query(
        CodeGraphQuery(tool="search_graph", project="x"), allow_index=True
    )

    assert read_only.indexing == [] and no_directory.indexing == []
    assert coordinator["ensure"] == [] and coordinator["remote_index"] == []


@pytest.mark.asyncio
async def test_name_match_queries_the_native_project(monkeypatch, coordinator):
    monkeypatch.setattr(
        code_graph_coordinator,
        "find_bindings",
        lambda project, wd: [_binding("mainvps", "github-com-me-cao-1234", "home-ubuntu-cao")],
    )

    combined = await code_graph_coordinator.federated_query(
        CodeGraphQuery(tool="search_graph", project="cao", working_directory="/home/ubuntu/cao"),
        allow_index=True,
    )

    assert [query.project for query in coordinator["local_query"]] == ["home-ubuntu-cao"]
    assert combined.results[0].logical_project == "github-com-me-cao-1234"
    assert coordinator["ensure"] == []


@pytest.mark.asyncio
async def test_status_without_project_queries_each_node_once(monkeypatch, coordinator):
    monkeypatch.setattr(
        code_graph_coordinator,
        "list_bindings",
        lambda: [
            _binding("mainvps", "a-1", "home-a"),
            _binding("mainvps", "b-2", "home-b"),
        ],
    )

    await code_graph_coordinator.federated_query(CodeGraphQuery(tool="index_status"))

    assert len(coordinator["local_query"]) == 1


@pytest.mark.parametrize("status", [404, 405])
def test_remote_index_treats_a_missing_route_as_unsupported(monkeypatch, status):
    class Response:
        status_code = status

        def raise_for_status(self):
            raise AssertionError("a missing route must not raise")

    monkeypatch.setattr(code_graph_coordinator.requests, "post", lambda *a, **k: Response())
    request = code_graph_coordinator.CodeGraphIndexRequest(project="x", working_directory="/x")

    assert code_graph_coordinator._remote_index("http://old:9889", request) == {
        "status": "unsupported"
    }


@pytest.mark.asyncio
async def test_older_node_without_index_route_is_reported(monkeypatch, coordinator):
    monkeypatch.setattr(code_graph_coordinator, "find_bindings", lambda project, wd: [])
    monkeypatch.setattr(
        code_graph_coordinator, "_remote_index", lambda base_url, request: {"status": "unsupported"}
    )

    async def not_here(project, working_directory):
        return {"status": "not_here"}

    monkeypatch.setattr(code_graph_coordinator, "ensure_indexed", not_here)

    combined = await code_graph_coordinator.federated_query(
        CodeGraphQuery(tool="search_graph", project="x", working_directory="/home/link/x"),
        allow_index=True,
    )

    assert combined.indexing == [{"source_node": "link-pc", "status": "unsupported"}]
