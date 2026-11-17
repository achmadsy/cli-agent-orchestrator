"""Tests for quota-ranked provider account selection."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from cli_agent_orchestrator.services.account_selector import (
    quota_score,
    rank_quota_results,
    select_provider_profile,
)

LIST = "cli_agent_orchestrator.services.provider_profile_store.list_provider_profiles"
QUOTA = "cli_agent_orchestrator.services.provider_quota.get_provider_quota"


def _profile(profile_id, auth_state="authenticated"):
    return SimpleNamespace(id=profile_id, auth_state=auth_state)


def _quota(profile_id, *remaining, status="ok", stale=False):
    return {
        "profile_id": profile_id,
        "status": status,
        "stale": stale,
        "quotas": [{"key": f"k{i}", "remaining": value} for i, value in enumerate(remaining)],
    }


def _run(coro):
    return asyncio.run(coro)


class TestScoring:
    def test_score_is_lowest_remaining_row(self):
        assert quota_score(_quota("a", 80.0, 12.5)) == 12.5

    @pytest.mark.parametrize("status", ["reauth_required", "error", "unavailable", "rate_limited"])
    def test_non_ok_status_has_no_score(self, status):
        assert quota_score(_quota("a", 90.0, status=status)) is None

    def test_rows_without_numeric_remaining_are_ignored(self):
        result = {"status": "ok", "quotas": [{"remaining": "lots"}, {"remaining": True}, "x"]}
        assert quota_score(result) is None

    def test_rank_desc_and_fresh_beats_stale_on_tie(self):
        results = [
            _quota("low", 10.0),
            _quota("stale-high", 70.0, stale=True),
            _quota("fresh-high", 70.0),
            _quota("broken", 99.0, status="error"),
        ]
        assert rank_quota_results(results) == "fresh-high"

    def test_rank_returns_none_without_usable_data(self):
        assert rank_quota_results([_quota("a", status="unavailable")]) is None


class TestSelectProviderProfile:
    def test_zero_accounts_returns_none(self):
        """Release baseline: no CLI accounts configured yet."""
        with patch(LIST, return_value=[]):
            assert _run(select_provider_profile("claude_code")) is None

    def test_provider_without_quota_support_returns_none(self):
        with patch(LIST) as listing:
            assert _run(select_provider_profile("codex")) is None
        listing.assert_not_called()

    def test_unknown_provider_returns_none(self):
        assert _run(select_provider_profile("not-a-provider")) is None

    def test_only_authenticated_accounts_are_queried(self):
        queried = []

        async def fake_quota(profile_id):
            queried.append(profile_id)
            return _quota(profile_id, 50.0)

        profiles = [_profile("work"), _profile("old", "expired"), _profile("new", "unknown")]
        with patch(LIST, return_value=profiles), patch(QUOTA, side_effect=fake_quota):
            assert _run(select_provider_profile("claude_code")) == "work"
        assert queried == ["work"]

    def test_picks_highest_remaining(self):
        data = {"a": _quota("a", 20.0), "b": _quota("b", 75.0, 60.0), "c": _quota("c", 90.0, 5.0)}

        async def fake_quota(profile_id):
            return data[profile_id]

        with (
            patch(LIST, return_value=[_profile(p) for p in data]),
            patch(QUOTA, side_effect=fake_quota),
        ):
            assert _run(select_provider_profile("claude_code")) == "b"

    def test_quota_exception_skips_that_account(self):
        async def fake_quota(profile_id):
            if profile_id == "bad":
                raise RuntimeError("token unreadable")
            return _quota(profile_id, 40.0)

        with (
            patch(LIST, return_value=[_profile("bad"), _profile("good")]),
            patch(QUOTA, side_effect=fake_quota),
        ):
            assert _run(select_provider_profile("claude_code")) == "good"

    def test_timeout_returns_none(self):
        async def slow_quota(profile_id):
            await asyncio.sleep(1)
            return _quota(profile_id, 90.0)

        with patch(LIST, return_value=[_profile("a")]), patch(QUOTA, side_effect=slow_quota):
            assert _run(select_provider_profile("claude_code", timeout=0.05)) is None

    def test_store_failure_returns_none(self):
        with patch(LIST, side_effect=RuntimeError("db locked")):
            assert _run(select_provider_profile("claude_code")) is None
