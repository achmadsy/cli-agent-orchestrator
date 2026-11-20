"""Fast graph reads saved topology without running or persisting an audit."""

import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from cli_agent_orchestrator.clients.database import (
    Base,
    MemoryMetadataModel,
    MemoryRelationshipModel,
)
from cli_agent_orchestrator.graph.cache import GraphViewCache
from cli_agent_orchestrator.graph.models import EdgeType
from cli_agent_orchestrator.graph.providers import memory as provider_module
from cli_agent_orchestrator.graph.providers.memory import MemoryGraphProvider
from cli_agent_orchestrator.services import memory_relationship_service, settings_service, wiki_lint
from cli_agent_orchestrator.services.memory_service import MemoryService
from cli_agent_orchestrator.services.vault.binding import (
    NativeBinding,
    VaultBinding,
    VaultConfigUnavailableError,
)
from cli_agent_orchestrator.services.vault.config import FolderMapping


@pytest.fixture
def world(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'db.sqlite3'}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    svc = MemoryService(base_dir=tmp_path / "memory", db_engine=engine)
    monkeypatch.setattr(memory_relationship_service, "SessionLocal", sessions)
    monkeypatch.setattr(settings_service, "is_memory_enabled", lambda: True)
    forbidden = AsyncMock(side_effect=AssertionError("full audit must not run"))
    monkeypatch.setattr(wiki_lint, "run_lint", forbidden)
    provider = MemoryGraphProvider(
        memory_service=svc,
        lint_enabled=lambda: True,
        binding_resolver=lambda s, sid: NativeBinding(s, sid),
    )
    yield svc, sessions, provider, forbidden
    engine.dispose()


def seed(svc, sessions, scope, scope_id, keys, *, orphan=None, related=None):
    index = svc.get_index_path(scope, scope_id)
    index.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Memory Index", "", f"## {scope}", ""]
    for key in keys:
        path = svc.get_wiki_path(scope, scope_id, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# " + key + "\n\nprivate article body\n")
        lines.append(
            f"- [{key}]({scope}/{key}.md) — type:project tags:t ~10tok updated:2026-11-20T00:00:00Z"
        )
        with sessions.begin() as db:
            db.add(
                MemoryMetadataModel(
                    key=key,
                    scope=scope,
                    scope_id=scope_id,
                    memory_type="project",
                    file_path=str(path),
                    related_keys=(related or {}).get(key),
                )
            )
    index.write_text("\n".join(lines) + "\n")
    if orphan:
        path = svc.get_wiki_path(scope, scope_id, orphan)
        path.write_text("private orphan body")


def edge(sessions, scope, scope_id, source, target, type_="relates_to", status="active"):
    import uuid

    with sessions.begin() as db:
        db.add(
            MemoryRelationshipModel(
                id=str(uuid.uuid4()),
                scope=scope,
                scope_id=scope_id or "",
                source_key=source,
                target_key=target,
                type=type_,
                status=status,
                origin="wiki_lint" if type_ == "contradiction" else "user",
            )
        )


@pytest.mark.asyncio
async def test_snapshot_preserves_flags_and_durable_edges_without_bodies_or_writes(
    world, monkeypatch
):
    svc, sessions, provider, lint = world
    sources = [f"source-{i}" for i in range(6)]
    seed(
        svc,
        sessions,
        "project",
        "one",
        ["hub", *sources],
        orphan="orphan",
        related={key: "hub" for key in sources},
    )
    seed(svc, sessions, "project", "two", ["hub", "private-other"])
    edge(sessions, "project", "one", "source-0", "hub", "contradiction")
    edge(sessions, "project", "one", "source-1", "hub", "supersedes")
    edge(sessions, "project", "one", "source-2", "outside")
    edge(sessions, "project", "one", "source-3", "hub", status="rejected")
    original_read = Path.read_text

    def no_bodies(path, *args, **kwargs):
        if path.suffix == ".md" and path.name != "index.md":
            raise AssertionError("article body must not be loaded")
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", no_bodies)
    statements = []

    def capture(_conn, _cursor, statement, *_args):
        statements.append(statement)

    event.listen(sessions.kw["bind"], "before_cursor_execute", capture)
    view = await provider.project(scope="project", scope_id="one", mode="snapshot")
    event.remove(sessions.kw["bind"], "before_cursor_execute", capture)
    lint.assert_not_called()
    assert {n.id for n in view.nodes} == {"hub", "orphan", *sources}
    assert next(n for n in view.nodes if n.id == "hub").attrs["is_hub"] is True
    assert next(n for n in view.nodes if n.id == "orphan").attrs["is_orphan"] is True
    assert {e.type for e in view.edges} == {EdgeType.CONTRADICTION, EdgeType.SUPERSEDES}
    assert view.meta["projection_mode"] == "snapshot" and view.meta["audit_ran"] is False
    assert view.meta["relationship_source"] == "saved" and view.meta["cached"] is False
    assert not any(
        s.lstrip().upper().startswith(("UPDATE", "INSERT", "DELETE")) for s in statements
    )
    other = await provider.project(scope="project", scope_id="two", mode="snapshot")
    assert not next(n for n in other.nodes if n.id == "hub").attrs.get("is_hub")


@pytest.mark.asyncio
async def test_snapshot_reflects_relationship_curation_and_deleted_memory_immediately(world):
    svc, sessions, provider, _ = world
    seed(svc, sessions, "global", None, ["first", "second"])
    edge(sessions, "global", None, "first", "second")
    assert len((await provider.project(scope="global", mode="snapshot")).edges) == 1
    with sessions.begin() as db:
        db.query(MemoryRelationshipModel).update({"status": "rejected"})
    assert (await provider.project(scope="global", mode="snapshot")).edges == []
    svc.get_wiki_path("global", None, "second").unlink()
    index = svc.get_index_path("global", None)
    index.write_text(
        "\n".join(line for line in index.read_text().splitlines() if "[second]" not in line)
    )
    with sessions.begin() as db:
        db.query(MemoryMetadataModel).filter_by(key="second").delete()
    assert [n.id for n in (await provider.project(scope="global", mode="snapshot")).nodes] == [
        "first"
    ]


@pytest.mark.asyncio
async def test_snapshot_lint_switch_and_binding_revocation_are_checked_per_request(world):
    svc, sessions, provider, lint = world
    seed(svc, sessions, "global", None, ["first"], orphan="orphan")
    enabled = {"value": True}
    provider._lint_enabled = lambda: enabled["value"]
    assert len((await provider.project(scope="global", mode="snapshot")).nodes) == 2
    enabled["value"] = False
    view = await provider.project(scope="global", mode="snapshot")
    assert [n.id for n in view.nodes] == ["first"]
    assert view.meta["lint_enabled"] is False
    provider._binding_resolver = lambda *_: VaultBinding(
        scope="global",
        scope_id=None,
        vault_id="v",
        root=str(svc.base_dir),
        mapping=FolderMapping(folder="Mapped", scope="global", index=False),
    )
    view = await provider.project(scope="global", mode="snapshot")
    assert view.nodes == [] and view.meta["boundary_cause"] == "not_indexable"

    def revoked(*args):
        raise VaultConfigUnavailableError("unavailable")

    provider._binding_resolver = revoked
    view = await provider.project(scope="global", mode="snapshot")
    assert view.nodes == [] and view.meta["boundary_cause"] == "vault_config_unavailable"
    lint.assert_not_called()


@pytest.mark.asyncio
async def test_snapshot_is_fast_cold_warm_and_after_full_cache_reset(world, monkeypatch):
    svc, sessions, provider, _ = world
    seed(svc, sessions, "global", None, ["first", "second"])
    edge(sessions, "global", None, "first", "second", "contradiction")

    async def forbidden(*args, **kwargs):
        raise AssertionError("snapshot must not enter full-audit cache")

    cache = GraphViewCache()
    monkeypatch.setattr(cache, "get_or_build", forbidden)
    monkeypatch.setattr(provider_module, "_CACHE", cache)
    timings = []
    for _ in range(3):
        cache.clear()
        started = time.perf_counter()
        view = await provider.project(scope="global", mode="snapshot")
        timings.append(time.perf_counter() - started)
        assert len(view.edges) == 1
    assert max(timings) < 1.0, timings


@pytest.mark.asyncio
async def test_snapshot_rejects_unrecognized_mode(world):
    _, _, provider, _ = world
    with pytest.raises(ValueError, match="mode"):
        await provider.project(scope="global", mode="unknown")


def test_snapshot_api_display_export_parity_and_secret_gate(world, monkeypatch):
    from fastapi.testclient import TestClient

    from cli_agent_orchestrator.api import main as api_main
    from cli_agent_orchestrator.graph.sinks import base as sinks_base
    from cli_agent_orchestrator.plugins import PluginRegistry
    from cli_agent_orchestrator.security import auth

    svc, sessions, provider, lint = world
    seed(svc, sessions, "global", None, ["first", "second"])
    edge(sessions, "global", None, "first", "second", "contradiction")
    monkeypatch.setattr(api_main, "get_provider", lambda _: provider)
    monkeypatch.setenv("CAO_AUTH_JWKS_URI", "https://idp.example/jwks")
    api_main.app.state.plugin_registry = PluginRegistry()
    scopes = [auth.SCOPE_READ]

    async def admitted():
        return scopes

    spy = MagicMock()

    @sinks_base.register_sink("snapshot-test-sink")
    class SnapshotSink(sinks_base.GraphSink):
        def export(self, view, dest, **options):
            spy(view=view)
            return []

    api_main.app.dependency_overrides[auth.get_current_scopes] = admitted
    try:
        client = TestClient(api_main.app, headers={"Host": "localhost"})
        try:
            url = "/graph/memory?scope=global&mode=snapshot"
            shown = client.get(url)
            assert shown.status_code == 200
            body = {"sink": "snapshot-test-sink", "dest": "snapshot"}
            export_url = "/graph/memory/export?scope=global&mode=snapshot"
            assert client.post(export_url, json=body).status_code == 403
            scopes[:] = [auth.SCOPE_WRITE]
            assert client.post(export_url, json=body).status_code == 200
            exported = spy.call_args.kwargs["view"].to_dict()
            assert exported["nodes"] == shown.json()["nodes"]
            assert exported["edges"] == shown.json()["edges"]
            assert exported["meta"]["audit_ran"] is False
            assert client.get("/graph/memory?mode=unknown").status_code == 400
            assert client.get("/graph/memory?scope=session&mode=snapshot").status_code == 400
            assert client.get("/graph/memory?scope=agent&mode=snapshot").status_code == 400
            spy.reset_mock()
            secret_key = "AKIA" + "A" * 16
            seed(svc, sessions, "global", None, [secret_key])
            rejected = client.post(export_url, json=body)
            assert rejected.status_code == 422
            assert secret_key not in rejected.text
            spy.assert_not_called()
        finally:
            client.close()
    finally:
        api_main.app.dependency_overrides.pop(auth.get_current_scopes, None)
    lint.assert_not_called()
