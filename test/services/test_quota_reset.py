from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.services import claude_quota as claude, codex_quota as codex
from cli_agent_orchestrator.services import provider_quota_reset as reset, quota_reset_store as store
from cli_agent_orchestrator.services.provider_profile_store import ProviderProfileError
from cli_agent_orchestrator.services.quota_support import QuotaCache, allowance, private_json


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATABASE_FILE", tmp_path / "quota.db")
    # A test can only use an explicitly mocked transport.
    monkeypatch.setattr(claude.requests, "get", Mock(side_effect=AssertionError("Unmocked network")))
    monkeypatch.setattr(claude.requests, "post", Mock(side_effect=AssertionError("Unmocked network")))
    claude._cache_store = QuotaCache()
    codex._cache_store = QuotaCache()


@pytest.mark.parametrize("value,remaining", [(0, 100), (75, 25), (100, 0), (-5, 100), (120, 0)])
def test_scoped_percent(value, remaining):
    rows = claude.normalize_claude_usage({"limits": [{"kind": "weekly_scoped", "percent": value,
                "utilization": 99, "scope": {"model": {"display_name": "Fable"}}}]})
    assert rows[0]["remaining"] == remaining


@pytest.mark.parametrize("value", [None, "75", True, float("nan"), float("inf"), {}, []])
def test_bad_scoped_percent_is_not_zero(value):
    assert claude.normalize_claude_usage({"limits": [{"kind": "weekly_scoped", "percent": value,
                "scope": {"model": {"display_name": "Fable"}}}]}) == []


def grant(**changes):
    return {"id": "grant_1", "resets_left": 2, "resets_total": 3, "usable_now": True,
            "starts_at": "2030-01-01T00:00:00Z", "ends_at": "2030-12-01T00:00:00Z",
            "clears": ["five_hour", "seven_day"], **changes}


def block(item=None, **changes):
    return {"eligible": True, "next_grant_id": "grant_1", "grants": [item or grant()], **changes}


NOW = datetime(2030, 6, 1, tzinfo=timezone.utc)


@pytest.mark.parametrize("changes,reason", [({"paused": True}, "Paused"), ({"usable_now": False}, "usable now"),
    ({"ends_at": "2030-01-01Z"}, "Expired"), ({"starts_at": "2031-01-01T00:00:00Z"}, "Not started"),
    ({"resets_left": 0}, "No resets"), ({"ends_at": None}, "unavailable"), ({"clears": []}, "unavailable")])
def test_grant_eligibility(changes, reason):
    value = claude.parse_reset_allowance(block(grant(**changes)), now=NOW)
    assert not value["can_reset"]
    assert reason.lower() in value["disabled_reason"].lower()


def test_count_is_not_usable_count():
    result = claude.parse_reset_allowance(block(grant(usable_now=False)), now=NOW)
    assert result["remaining_count"] == 2
    assert not result["can_reset"]
    assert claude.parse_reset_allowance(None)["remaining_count"] is None
    assert claude.parse_reset_allowance({"eligible": False})["status"] == "unsupported"
    assert not claude.parse_reset_allowance(block(cooldown_until="2030-07-01T00:00:00Z"), now=NOW)["can_reset"]
    assert claude.parse_reset_allowance(block(), now=NOW)["can_reset"]


def test_codex_windows_and_unknown_credits():
    rows = codex.normalize_codex_usage({"rate_limit": {"primary_window": {"used_percent": 75, "reset_at": 1893456000}},
        "rate_limits_by_limit_id": {"review": {"secondary": {"percent_used": 20}}}})
    assert rows[0]["remaining"] == 25
    assert rows[1]["name"] == "Review Weekly"
    assert codex.parse_credits({})["remaining_count"] is None
    assert codex.parse_credits({"available_count": 0})["remaining_count"] == 0
    assert codex.parse_credits({"available_count": 2})["can_reset"]


def test_private_file_permissions_symlink_and_shape(tmp_path):
    path = tmp_path / "auth.json"
    path.write_text('{"tokens": {}}'); path.chmod(0o600)
    assert private_json(path) == {"tokens": {}}
    path.chmod(0o644)
    with pytest.raises(ProviderProfileError): private_json(path)
    path.chmod(0o600)
    link = tmp_path / "link"; link.symlink_to(path)
    with pytest.raises(ProviderProfileError): private_json(link)
    path.write_text('[]')
    with pytest.raises(ProviderProfileError): private_json(path)


def test_codex_credentials_are_named_oauth_only(tmp_path, monkeypatch):
    monkeypatch.setattr(codex, "get_provider_profile", lambda _: SimpleNamespace(provider=codex.ProviderType.CODEX))
    monkeypatch.setattr(codex, "profile_home", lambda *_: tmp_path)
    path = tmp_path / "auth.json"
    path.write_text(json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": "test-token", "account_id": "acct-test"}})); path.chmod(0o600)
    assert codex.credentials("test") == ("test-token", "acct-test")
    path.write_text('{"OPENAI_API_KEY":"not-oauth"}')
    with pytest.raises(ProviderProfileError): codex.credentials("test")


def configured(monkeypatch, *, outcome=("succeeded", None)):
    context = {"provider": "codex", "account_key": "test-account-hash", "credential": __import__('hashlib').sha256(b'test-token').hexdigest(), "account": "acct", "clears": []}
    allowed = allowance("supported", "", remaining_count=2, can_reset=True)
    service = SimpleNamespace(reset_context=Mock(return_value=(context, allowed)), consume=Mock(return_value=outcome), credentials=Mock(return_value=("test-token", "acct")))
    monkeypatch.setattr(reset, "adapter", lambda _: service)
    monkeypatch.setattr(reset, "get_provider_profile", lambda _: SimpleNamespace(label="Test account", provider=codex.ProviderType.CODEX))
    return service


def test_confirm_replay_and_sibling_intents(monkeypatch):
    service = configured(monkeypatch)
    first = reset._preview("one", "owner")
    sibling = reset._preview("alias", "owner")
    result = reset._confirm("one", "owner", first["intent_id"])
    assert result["status"] == "succeeded"
    assert reset._confirm("one", "owner", first["intent_id"])["status"] == "succeeded"
    with pytest.raises(store.ResetConflict): reset._confirm("alias", "owner", sibling["intent_id"])
    service.consume.assert_called_once()
    assert service.consume.call_args.args[2]


def test_unknown_is_durable_and_blocks_alias(monkeypatch):
    service = configured(monkeypatch)
    service.consume.side_effect = TimeoutError("test-secret must not escape")
    item = reset._preview("one", "owner")
    result = reset._confirm("one", "owner", item["intent_id"])
    assert result["status"] == "unknown"
    assert "test-secret" not in json.dumps(result)
    store.migrate()  # restart-equivalent persistence check
    with pytest.raises(store.ResetConflict): reset._preview("alias", "owner")
    assert reset._confirm("one", "owner", item["intent_id"])["status"] == "unknown"
    service.consume.assert_called_once()


def test_owner_expiry_and_changed_credentials(monkeypatch):
    service = configured(monkeypatch)
    item = reset._preview("one", "owner")
    with pytest.raises(store.ResetConflict): reset._confirm("one", "other", item["intent_id"])
    context, allowed = service.reset_context.return_value
    service.reset_context.return_value = ({**context, "credential": "changed"}, allowed)
    with pytest.raises(store.ResetConflict): reset._confirm("one", "owner", item["intent_id"])
    service.consume.assert_not_called()
    assert reset._confirm("one", "owner", item["intent_id"])["status"] == "rejected"
    fresh = reset._preview("one", "owner")
    with store.connect() as conn: conn.execute("UPDATE quota_reset_operation SET expires=0")
    with pytest.raises(store.ResetConflict): reset._confirm("one", "owner", fresh["intent_id"])


def test_persistence_failure_prevents_post(monkeypatch):
    service = configured(monkeypatch)
    item = reset._preview("one", "owner")
    monkeypatch.setattr(store, "claim", Mock(side_effect=sqlite3.OperationalError("disk full")))
    with pytest.raises(sqlite3.OperationalError): reset._confirm("one", "owner", item["intent_id"])
    service.consume.assert_not_called()


@pytest.mark.asyncio
async def test_cache_fences_late_reads_and_cooldown(monkeypatch):
    cache = QuotaCache()
    started, release = __import__('threading').Event(), __import__('threading').Event()
    def fetch():
        started.set(); release.wait(3)
        return {"status": "ok", "quotas": []}
    task = asyncio.create_task(cache.get("test", fetch))
    await asyncio.to_thread(started.wait, 3)
    with store.connect() as conn: conn.execute("UPDATE quota_reset_epoch SET value=value+1")
    release.set()
    assert (await task)["status"] == "refresh_required"
    calls = Mock(return_value={"status": "rate_limited", "quotas": []})
    await cache.get("limited", calls)
    await cache.get("limited", calls, force=True)
    calls.assert_called_once()


@pytest.mark.parametrize("provider,payload,expected", [
    ("codex", {"code": "reset", "windows_reset": 2}, "succeeded"),
    ("codex", {"code": "no_credit"}, "rejected"),
    ("codex", {"code": "unrecognized"}, "unknown"),
    ("claude", {"result": "reset"}, "succeeded"),
    ("claude", {"result": "unrecognized"}, "unknown"),
])
def test_fixed_provider_consume_contract(monkeypatch, provider, payload, expected):
    transport = Mock(return_value=SimpleNamespace(ok=True, json=lambda: payload))
    monkeypatch.setattr(claude.requests, "post", transport)
    request_id = "00000000-0000-4000-8000-000000000001"
    context = {"credential": __import__('hashlib').sha256(b'test-token').hexdigest(),
               "account": "acct-test", "organization": "org-test", "grant": "grant-test"}
    if provider == "codex":
        monkeypatch.setattr(codex, "credentials", lambda _: ("test-token", "acct-test"))
        result = codex.consume("test", context, request_id)
        assert transport.call_args.args[0] == "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"
        assert transport.call_args.kwargs["json"] == {"redeem_request_id": request_id}
        assert transport.call_args.kwargs["headers"]["ChatGPT-Account-ID"] == "acct-test"
    else:
        monkeypatch.setattr(claude, "_read_access_token", lambda _: "test-token")
        result = claude.consume("test", context, request_id)
        assert transport.call_args.args[0] == "https://api.anthropic.com/api/organizations/org-test/reset_rate_limits"
        assert transport.call_args.kwargs["json"] == {"program": "cedar_ember", "grant_id": "grant-test", "request_id": request_id}
    assert result[0] == expected
    assert transport.call_args.kwargs["allow_redirects"] is False
    transport.assert_called_once()


def test_duplicate_grants_and_expired_codex_details_fail_closed():
    assert not claude.parse_reset_allowance(block(grants=[grant(), grant()]), now=NOW)["can_reset"]
    assert not codex.parse_credits({"available_count": 1, "credits": [{"status": "available", "expires_at": "2020-01-01T00:00:00Z"}]}, detailed=True)["can_reset"]


@pytest.mark.asyncio
async def test_success_survives_refresh_failure(monkeypatch):
    configured(monkeypatch)
    from cli_agent_orchestrator.services import provider_quota
    async def fail(*args, **kwargs): raise RuntimeError("refresh failed")
    monkeypatch.setattr(provider_quota, "get_provider_quota", fail)
    item = await reset.preview("one", "owner")
    result = await reset.confirm("one", "owner", item["intent_id"])
    assert result["status"] == "succeeded" and result["quota_refresh"] == "failed"
