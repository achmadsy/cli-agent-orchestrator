"""Mock-only competing callers, durable submission and late-read tests."""
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.services import quota_reset_store as store, provider_quota_reset as reset
from cli_agent_orchestrator.services.quota_support import QuotaCache, allowance, digest


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATABASE_FILE", tmp_path / "quota.db")


def service(monkeypatch, consume):
    context = {"provider": "codex", "account_key": "same-account", "credential": digest("test"), "account": "test", "clears": []}
    allowed = allowance("supported", "", remaining_count=1, can_reset=True)
    adapter = SimpleNamespace(credentials=lambda _: ("test", "test"), reset_context=lambda _: (context, allowed), consume=consume)
    monkeypatch.setattr(reset, "adapter", lambda _: adapter)
    monkeypatch.setattr(reset, "get_provider_profile", lambda _: SimpleNamespace(label="Synthetic", provider=SimpleNamespace(value="codex")))
    return adapter


def test_competing_workers_only_one_post(monkeypatch):
    calls = Mock(return_value=("succeeded", None))
    adapter = service(monkeypatch, calls)
    first, second = reset._preview("a", "owner"), reset._preview("b", "owner")
    barrier = threading.Barrier(2)
    original = adapter.reset_context
    adapter.reset_context = lambda profile: (barrier.wait(timeout=5), original(profile))[1]
    def confirm(profile, ident):
        try: return reset._confirm(profile, "owner", ident)["status"]
        except store.ResetConflict: return "conflict"
    # Production requests can race; the database gate, not a Python lock, wins.
    with ThreadPoolExecutor(max_workers=2) as workers:
        a = workers.submit(confirm, "a", first["intent_id"])
        b = workers.submit(confirm, "b", second["intent_id"])
        assert sorted([a.result(timeout=10), b.result(timeout=10)]) == ["conflict", "succeeded"]
    calls.assert_called_once()


def test_crash_after_submission_never_recreates_operation(monkeypatch):
    calls = Mock(return_value=("succeeded", None)); service(monkeypatch, calls)
    item = reset._preview("a", "owner")
    operation = store.read(item["intent_id"], "a", "owner")
    store.claim(operation)  # process exits here, provider outcome unknowable
    assert reset._confirm("a", "owner", item["intent_id"])["status"] == "submitted"
    with pytest.raises(store.ResetConflict): reset._preview("b", "owner")
    calls.assert_not_called()


def test_explicit_no_credit_rejection_allows_fresh_preview(monkeypatch):
    calls = Mock(return_value=("rejected", "No credits")); service(monkeypatch, calls)
    item = reset._preview("a", "owner")
    assert reset._confirm("a", "owner", item["intent_id"])["status"] == "rejected"
    assert reset._preview("a", "owner")["intent_id"] != item["intent_id"]


@pytest.mark.asyncio
async def test_disconnected_confirm_finishes_durable_record(monkeypatch):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    def consume(*args):
        entered.set(); release.wait(5)
        return "unknown", "Synthetic lost response"
    service(monkeypatch, consume)
    original = store.finish
    def finish(*args):
        original(*args); finished.set()
    monkeypatch.setattr(store, "finish", finish)
    item = reset._preview("a", "owner")
    task = asyncio.create_task(reset.confirm("a", "owner", item["intent_id"]))
    assert await asyncio.to_thread(entered.wait, 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    release.set()
    assert await asyncio.to_thread(finished.wait, 5)
    assert store.read(item["intent_id"], "a", "owner")["state"] == "unknown"


@pytest.mark.asyncio
async def test_late_read_failure_does_not_return_pre_reset_cache():
    cache = QuotaCache()
    await cache.get("a", lambda: {"status": "ok", "quotas": [{"old": True}]})
    entered, release = threading.Event(), threading.Event()
    def fail():
        entered.set(); release.wait(5); raise RuntimeError("synthetic")
    task = asyncio.create_task(cache.get("a", fail, force=True))
    assert await asyncio.to_thread(entered.wait, 5)
    with store.connect() as conn: conn.execute("UPDATE quota_reset_epoch SET value=value+1")
    release.set()
    assert (await task)["quotas"] == []
