"""Explicit workflow quota-recovery account override tests."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from cli_agent_orchestrator.clients.database import (
    _migrate_workflow_run,
    _migrate_workflow_run_event,
    _migrate_workflow_run_seq,
    _migrate_workflow_run_step,
)
from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.models.provider_profile import ProviderProfile
from cli_agent_orchestrator.services import script_runner, workflow_journal

RUN = "quota-run"
STEP = "review"
TS = "2026-10-17T00:00:00Z"


@pytest.fixture(autouse=True)
def _journal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "cli_agent_orchestrator.constants.DATABASE_FILE",
        tmp_path / "workflow.db",
        raising=True,
    )
    workflow_journal._event_migrated_paths.clear()
    _migrate_workflow_run()
    _migrate_workflow_run_step()
    _migrate_workflow_run_event()
    _migrate_workflow_run_seq()
    workflow_journal.insert_run(
        RUN,
        "review",
        "{}",
        "{}",
        "failed",
        TS,
        tier="script",
    )
    workflow_journal.insert_steps(
        RUN,
        [(STEP, "failed")],
        TS,
        effective_providers={STEP: "claude_code"},
        effective_provider_profiles={STEP: "claude-old"},
    )
    workflow_journal.append_event(
        RUN,
        1,
        "step.attempt.failed",
        event_schema_version=1,
        ts=TS,
        step_id=STEP,
        state="failed",
        provider="claude_code",
        error_kind="runtime_failure",
        runtime_failure={
            "kind": "quota_exhausted",
            "message": "usage limit reached",
            "retryable": True,
            "retry_after_s": None,
            "reset_at": None,
            "observed_generation": 2,
        },
    )
    workflow_journal.persist_high_water(RUN, 1)
    yield
    workflow_journal._event_migrated_paths.clear()


def _profile(profile_id: str = "claude-new", *, provider: str = "claude_code", auth: str = "authenticated") -> ProviderProfile:
    return ProviderProfile(
        id=profile_id,
        label="New account",
        provider=ProviderType(provider),
        login_method="isolated_home",
        settings={},
        is_default=False,
        auth_state=auth,
        created_at=TS,
        updated_at=TS,
    )


def test_validate_accepts_authenticated_same_provider_quota_override():
    with (
        patch(
            "cli_agent_orchestrator.services.provider_profile_store.get_provider_profile",
            return_value=_profile(),
        ),
        patch(
            "cli_agent_orchestrator.providers.manager.provider_manager.is_profile_supported",
            return_value=True,
        ),
    ):
        result = script_runner._validate_provider_profile_overrides(
            RUN, {STEP: "claude-new"}
        )
    assert result == {STEP: ("claude-new", "claude_code")}


@pytest.mark.parametrize(
    ("profile", "supported", "match"),
    [
        (_profile(provider="codex"), True, "belongs to 'codex'"),
        (_profile(auth="expired"), True, "not 'authenticated'"),
        (_profile(), False, "does not support account profiles"),
    ],
)
def test_validate_rejects_invalid_target(profile, supported, match):
    with (
        patch(
            "cli_agent_orchestrator.services.provider_profile_store.get_provider_profile",
            return_value=profile,
        ),
        patch(
            "cli_agent_orchestrator.providers.manager.provider_manager.is_profile_supported",
            return_value=supported,
        ),
        pytest.raises(ValueError, match=match),
    ):
        script_runner._validate_provider_profile_overrides(RUN, {STEP: profile.id})


def test_validate_rejects_non_quota_failure():
    workflow_journal.append_event(
        RUN,
        2,
        "step.attempt.failed",
        event_schema_version=1,
        ts=TS,
        step_id=STEP,
        state="failed",
        error_kind="runtime_failure",
        runtime_failure={"kind": "auth_expired"},
    )
    with pytest.raises(ValueError, match="no structured quota/rate-limit failure"):
        script_runner._validate_provider_profile_overrides(RUN, {STEP: "claude-new"})


def test_apply_updates_profile_authorizes_one_rerun_and_journals_event():
    script_runner._apply_provider_profile_overrides(
        RUN, {STEP: ("claude-new", "claude_code")}
    )

    step = workflow_journal.get_step(RUN, STEP)
    assert step is not None
    assert step.effective_provider_profile == "claude-new"
    assert step.state == "rerun_authorized"

    events = workflow_journal.read_events(RUN)
    event = events[-1]
    assert event.event_type == "step.provider_profile.overridden"
    assert event.step_id == STEP
    assert event.provider == "claude_code"
    assert "claude-new" in (event.reason or "")
    assert event.runtime_failure_json is None
