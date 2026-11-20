"""Real index dates, Git drift and the browser-safe read-only projection."""

import asyncio
import os
import sqlite3
import subprocess
from datetime import datetime, timezone

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
from cli_agent_orchestrator.services import code_graph_coordinator as coordinator
from cli_agent_orchestrator.services import code_graph_gateway as gateway
from cli_agent_orchestrator.services import code_graph_indexer as indexer
from cli_agent_orchestrator.services import code_graph_metadata as metadata
from cli_agent_orchestrator.services import code_graph_registry as registry
from cli_agent_orchestrator.services import code_graph_service as service

STAMP = datetime(2026, 11, 18, 18, 37, 41, tzinfo=timezone.utc)


def _cache(tmp_path, monkeypatch):
    monkeypatch.setenv("CBM_CACHE_DIR", str(tmp_path))
    with sqlite3.connect(tmp_path / "repo.db") as db:
        db.executescript(
            "CREATE TABLE projects(name TEXT, indexed_at TEXT, root_path TEXT);"
            "CREATE TABLE nodes(project TEXT); CREATE TABLE edges(project TEXT);"
            "INSERT INTO projects VALUES('repo', '2026-11-18T18:37:41Z', '/work/repo');"
            "INSERT INTO nodes VALUES('repo'), ('repo'), ('repo::missed');"
            "INSERT INTO edges VALUES('repo'), ('repo::missed');"
        )


def test_index_metadata_reads_actual_date_and_excludes_shadow_project(tmp_path, monkeypatch):
    _cache(tmp_path, monkeypatch)
    assert metadata.read_index_metadata("repo") == {
        "indexed_at": STAMP,
        "node_count": 2,
        "edge_count": 1,
    }


def test_missing_or_invalid_database_is_unknown_without_creating_files(tmp_path, monkeypatch):
    monkeypatch.setenv("CBM_CACHE_DIR", str(tmp_path))
    for name in ("absent", "../outside", "/absolute", ".."):
        assert metadata.read_index_metadata(name) == {}
    assert list(tmp_path.iterdir()) == []
    (tmp_path / "broken.db").write_bytes(b"not a SQLite database")
    assert metadata.read_index_metadata("broken") == {}


@pytest.mark.asyncio
async def test_heartbeat_does_not_fabricate_an_index_date(tmp_path, monkeypatch):
    _cache(tmp_path, monkeypatch)

    async def roots():
        return [("repo", str(tmp_path)), ("missing", str(tmp_path))]

    monkeypatch.setattr(service, "list_local_roots", roots)
    projects = await service.discover_local_projects()
    assert projects[0].indexed_at == STAMP
    assert projects[0].node_count == 2
    assert projects[1].indexed_at is None


def _git(root, *args, **kwargs):
    return subprocess.run(
        ["git", "-C", str(root), *args], text=True, capture_output=True, check=True, **kwargs
    ).stdout.strip()


def test_freshness_detects_new_commit_and_reset_even_with_old_commit_dates(tmp_path):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.name", "Test")
    _git(tmp_path, "config", "user.email", "test@example.invalid")
    env = {
        **os.environ,
        "GIT_COMMITTER_DATE": "2026-11-18T10:00:00Z",
        "GIT_AUTHOR_DATE": "2026-11-18T10:00:00Z",
    }
    _git(tmp_path, "commit", "--allow-empty", "-qm", "first", env=env)
    first = _git(tmp_path, "rev-parse", "HEAD")
    stamp = datetime(2026, 11, 18, 10, 1, tzinfo=timezone.utc)
    assert metadata.index_freshness(str(tmp_path), first, stamp) == {
        "stale": False,
        "commits_since_index": 0,
    }
    env["GIT_COMMITTER_DATE"] = "2026-11-18T10:02:00Z"
    _git(tmp_path, "commit", "--allow-empty", "-qm", "second", env=env)
    second = _git(tmp_path, "rev-parse", "HEAD")
    assert metadata.index_freshness(str(tmp_path), second, stamp) == {
        "stale": True,
        "commits_since_index": 1,
    }
    # Reset backwards after an index of the second revision: dates alone miss it.
    indexed = datetime(2026, 11, 18, 10, 3, tzinfo=timezone.utc)
    env["GIT_COMMITTER_DATE"] = "2026-11-18T10:04:00Z"
    _git(tmp_path, "reset", "--hard", first, env=env)
    assert metadata.index_freshness(str(tmp_path), first, indexed) == {
        "stale": True,
        "commits_since_index": 0,
    }


def test_expired_reflog_uses_newer_commits_and_missing_git_is_unknown(tmp_path, monkeypatch):
    class OldReflog:
        returncode = 0
        stdout = "wrong-first-sha"
        stderr = "warning: log only goes back to yesterday"

    monkeypatch.setattr(metadata.subprocess, "run", lambda *a, **k: OldReflog())
    monkeypatch.setattr(metadata, "_git", lambda *a: "2")
    assert metadata.index_freshness(str(tmp_path), "head", STAMP) == {
        "stale": True,
        "commits_since_index": 2,
    }
    assert metadata.index_freshness(str(tmp_path), None, STAMP) == {}


@pytest.fixture
def registry_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'cao.db'}")
    database.Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(registry, "SessionLocal", sessionmaker(bind=engine))
    yield
    engine.dispose()


@pytest.mark.asyncio
async def test_overview_hides_paths_and_legacy_heartbeat_dates(registry_db, monkeypatch):
    monkeypatch.delenv("CAO_CODEBASE_API_URL", raising=False)
    modern = CodeGraphProject(
        native_project="repo",
        root_path="/private/root",
        logical_project="logical",
        display_name="example/repo",
        indexed_at=STAMP,
        node_count=2,
        edge_count=1,
        stale=True,
        commits_since_index=3,
    )
    registry.upsert_heartbeat(
        CodeGraphHeartbeat(node_id="new", projects=[modern]), "http://private:9889"
    )
    registry.upsert_heartbeat(
        CodeGraphHeartbeat(
            node_id="old",
            projects=[modern.model_copy(update={"node_count": None, "edge_count": None})],
        ),
        "http://old:9889",
    )

    async def no_refresh():
        return None

    monkeypatch.setattr(coordinator, "refresh_local_registry", no_refresh)
    data = await gateway.code_graph_overview()
    rows = {row["node_id"]: row for row in data["projects"]}
    assert rows["new"]["indexed_at"] == STAMP
    assert rows["new"]["commits_since_index"] == 3
    assert rows["old"]["indexed_at"] is None
    assert "root_path" not in str(data) and "base_url" not in str(data)
    assert "/private" not in str(data)


@pytest.mark.asyncio
async def test_symbol_search_is_read_only_and_returns_only_relative_paths(monkeypatch):
    monkeypatch.delenv("CAO_CODEBASE_API_URL", raising=False)
    calls = []

    async def query(body, *, allow_index=False):
        calls.append((body, allow_index))
        return service.merge_results(
            "search_graph",
            "logical",
            [
                CodeGraphNodeResult(
                    source_node="node",
                    result={
                        "rows": [
                            {
                                "qualified_name": "logical.run",
                                "file_path": "src/run.py",
                                "lines": "2-4",
                                "label": "Function",
                            },
                            {"qualified_name": "private", "file_path": "/private/root/file.py"},
                            {"qualified_name": "escape", "file_path": "../private/file.py"},
                            {"qualified_name": "windows", "file_path": "C:\\private\\file.py"},
                        ]
                    },
                )
            ],
        )

    monkeypatch.setattr(coordinator, "federated_query", query)
    data = await gateway.search_code_graph({"project": "logical", "query": "run"})
    assert calls[0][0].tool == "search_graph" and calls[0][1] is False
    assert [m["file_path"] for m in data["matches"]] == ["src/run.py"]


@pytest.mark.asyncio
async def test_remote_browser_search_does_not_use_writer_internal_query(monkeypatch):
    monkeypatch.setenv("CAO_CODEBASE_API_URL", "http://coordinator:9889")
    calls = []
    monkeypatch.setattr(gateway, "_request", lambda *args: calls.append(args) or {"matches": []})
    await gateway.search_code_graph({"project": "logical", "query": "run"})
    assert calls[0][1] == "/code-graph/search"


@pytest.mark.asyncio
async def test_stale_queries_queue_refresh_but_read_only_queries_do_not(monkeypatch):
    binding = {
        "node_id": "local",
        "logical_project": "logical",
        "native_project": "native",
        "root_path": "/work/repo",
        "online": True,
        "available": True,
        "stale": True,
    }
    calls = []

    async def refresh():
        pass

    async def ensure(project, root):
        calls.append((project, root))
        return {"status": "started"}

    async def local(query):
        return CodeGraphNodeResult(source_node="local", result={"rows": []})

    monkeypatch.setattr(coordinator, "refresh_local_registry", refresh)
    monkeypatch.setattr(coordinator, "find_bindings", lambda *a: [binding])
    monkeypatch.setattr(coordinator, "ensure_indexed", ensure)
    monkeypatch.setattr(coordinator, "local_query", local)
    monkeypatch.setattr(coordinator, "node_id", lambda: "local")
    query = CodeGraphQuery(tool="search_graph", project="logical")
    assert (await coordinator.federated_query(query)).indexing == []
    assert calls == []
    result = await coordinator.federated_query(query, allow_index=True)
    assert result.results and result.indexing == [{"source_node": "local", "status": "started"}]
    assert calls == [("native", "/work/repo")]
    binding["stale"] = False
    await coordinator.federated_query(query, allow_index=True)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_existing_stale_index_uses_job_and_cooldown_guards(tmp_path, monkeypatch):
    root = str(tmp_path / "repo")
    os.mkdir(root)
    _git(root, "init", "-q")
    monkeypatch.delenv("CAO_CODEBASE_AUTO_INDEX", raising=False)
    monkeypatch.setenv("CAO_CODEBASE_INDEX_RETRY_SECONDS", "600")
    release = asyncio.Event()
    runs = []

    async def roots():
        return [("custom-native-id", root)]

    async def run(path, *, native_project=None):
        runs.append((path, native_project))
        await release.wait()
        return True

    async def publish():
        pass

    monkeypatch.setattr(service, "list_local_roots", roots)
    monkeypatch.setattr(metadata, "read_index_metadata", lambda *a: {"indexed_at": STAMP})
    monkeypatch.setattr(metadata, "index_freshness", lambda *a: {"stale": True})
    monkeypatch.setattr(indexer, "_run_index", run)
    monkeypatch.setattr(indexer, "_publish", publish)
    indexer._reset_for_tests()
    try:
        assert (await indexer.ensure_indexed("custom-native-id", root))["status"] == "started"
        assert (await indexer.ensure_indexed("custom-native-id", root))["status"] == "running"
        release.set()
        await asyncio.gather(*indexer._jobs.values())
        assert runs == [(root, "custom-native-id")]
        assert (await indexer.ensure_indexed("custom-native-id", root))["status"] == "retry_later"
        monkeypatch.setattr(metadata, "index_freshness", lambda *a: {"stale": False})
        assert (await indexer.ensure_indexed("custom-native-id", root))[
            "status"
        ] == "already_indexed"
    finally:
        indexer._reset_for_tests()


@pytest.mark.asyncio
async def test_reindex_payload_preserves_custom_native_name(monkeypatch):
    seen = []

    class Process:
        returncode = 0

        async def communicate(self, payload):
            import json

            seen.append(json.loads(payload))
            return b'{"isError":false}', b""

    async def spawn(*args, **kwargs):
        return Process()

    monkeypatch.setattr(service, "_binary", lambda: "unused-test-binary")
    monkeypatch.setattr(indexer.asyncio, "create_subprocess_exec", spawn)
    assert await indexer._run_index("/work/repo", native_project="custom-native-id")
    assert seen == [{"repo_path": "/work/repo", "mode": "full", "name": "custom-native-id"}]


@pytest.mark.asyncio
async def test_stale_remote_index_is_refreshed_only_on_its_own_node(monkeypatch):
    binding = {
        "node_id": "remote",
        "logical_project": "logical",
        "native_project": "custom-id",
        "root_path": "/remote/repo",
        "base_url": "http://remote:9889",
        "online": True,
        "available": True,
        "stale": True,
    }
    calls = []

    async def refresh():
        pass

    def remote_index(url, request):
        calls.append((url, request.project, request.working_directory))
        return {"status": "started"}

    def remote_query(url, request):
        return CodeGraphNodeResult(source_node="remote", result={"rows": []}).model_dump()

    monkeypatch.setattr(coordinator, "refresh_local_registry", refresh)
    monkeypatch.setattr(coordinator, "find_bindings", lambda *a: [binding])
    monkeypatch.setattr(coordinator, "_remote_index", remote_index)
    monkeypatch.setattr(coordinator, "_remote_query", remote_query)
    monkeypatch.setattr(coordinator, "node_id", lambda: "local")
    combined = await coordinator.federated_query(
        CodeGraphQuery(tool="search_graph", project="logical"), allow_index=True
    )
    assert calls == [("http://remote:9889", "custom-id", "/remote/repo")]
    assert combined.indexing == [{"source_node": "remote", "status": "started"}]
    binding["online"] = False
    combined = await coordinator.federated_query(
        CodeGraphQuery(tool="search_graph", project="logical"), allow_index=True
    )
    assert len(calls) == 1 and combined.partial is True


def test_registry_metadata_migration_is_additive_and_idempotent(tmp_path, monkeypatch):
    from cli_agent_orchestrator import constants

    path = tmp_path / "old.db"
    monkeypatch.setattr(constants, "DATABASE_FILE", path)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE code_graph_projects(binding_id TEXT, root_path TEXT)")
        db.execute("INSERT INTO code_graph_projects VALUES('node:repo', '/original')")
    database._migrate_code_graph_metadata()
    database._migrate_code_graph_metadata()
    with sqlite3.connect(path) as db:
        columns = {r[1] for r in db.execute("PRAGMA table_info(code_graph_projects)")}
        assert {"node_count", "edge_count", "stale", "commits_since_index"} <= columns
        assert db.execute("SELECT root_path, node_count FROM code_graph_projects").fetchone() == (
            "/original",
            None,
        )
