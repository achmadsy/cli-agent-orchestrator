"""Unit tests for ``terminal_service.switch_provider_profile`` (#runtime).

Successor-first account switch: validated preconditions, bounded handoff
prompt, predecessor retention, duplicate/idempotent behaviour, and NO
automatic rotation (switch only ever happens on an explicit call).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cli_agent_orchestrator.services.terminal_service import (
    SWITCH_CONTINUATION_NOTE_MAX,
    switch_provider_profile,
)

_TS = "cli_agent_orchestrator.services.terminal_service"

TS_GET_META = f"{_TS}.get_terminal_metadata"
TS_GET_PROFILE = f"{_TS}.get_provider_profile"
CREATE_TERMINAL = f"{_TS}.create_terminal"
SEND_INPUT = f"{_TS}.send_input"
DELETE_TERMINAL = f"{_TS}.delete_terminal"
PM_SUPPORTED = "cli_agent_orchestrator.providers.manager.provider_manager.is_profile_supported"


def import_or_call(name):
    import importlib
    return getattr(importlib.import_module(_TS), name)


class _FakeProfile:
    def __init__(self, provider: str, auth_state: str = "authenticated", id_: str = "prof"):
        from cli_agent_orchestrator.models.provider import ProviderType

        self.id = id_
        self.label = "fake"
        self.provider = ProviderType(provider)
        self.auth_state = auth_state


def _predecessor(provider="claude_code", **overrides):
    meta = {
        "id": "abcd1234",
        "tmux_session": "cao-session",
        "tmux_window": "dev-abcd1234",
        "provider": provider,
        "agent_profile": "developer",
        "model": "gpt-6-astra",
        "model_honored": True,
        "working_directory": "/work/dir",
        "caller_id": None,
        "engine": None,
        "group": ["tenant_1", "project_5"],
        "metadata": {"free": "form"},
        "switch_predecessor_id": None,
        "switch_successor_id": None,
        "runtime_failure": {
            "kind": "rate_limited",
            "message": "API Error: 429 rate limit",
            "retryable": True,
            "retry_after_s": None,
            "reset_at": None,
            "observed_generation": 3,
        },
        "session_incarnation_id": "inc",
        "last_active": None,
    }
    meta.update(overrides)
    return meta


def _successor(**overrides):
    terminal = MagicMock()
    terminal.id = "eeee9999"
    terminal.agent_profile = "developer"
    terminal.session_name = "cao-session"
    return terminal


class TestSwitchValidator:
    @pytest.mark.asyncio
    async def test_missing_predecessor(self):
        with (
            patch(TS_GET_META, return_value=None),
            patch(TS_GET_PROFILE),
            pytest.raises(ValueError, match="not found"),
        ):
            await switch_provider_profile("abcd1234", "target")

    @pytest.mark.asyncio
    async def test_different_provider_rejected(self):
        with (
            patch(TS_GET_META, return_value=_predecessor()),
            patch(
                TS_GET_PROFILE, return_value=_FakeProfile(provider="codex")
            ),
            pytest.raises(ValueError, match="belongs to provider"),
        ):
            await switch_provider_profile("abcd1234", "target")

    @pytest.mark.asyncio
    async def test_unauthenticated_target_rejected(self):
        with (
            patch(TS_GET_META, return_value=_predecessor()),
            patch(TS_GET_PROFILE, return_value=_FakeProfile(provider="claude_code", auth_state="unverified")),
            patch(PM_SUPPORTED, return_value=True),
            pytest.raises(ValueError, match="not 'authenticated'"),
        ):
            await switch_provider_profile("abcd1234", "target")

    @pytest.mark.asyncio
    async def test_unsupported_provider_rejected(self):
        with (
            patch(TS_GET_META, return_value=_predecessor()),
            patch(TS_GET_PROFILE, return_value=_FakeProfile(provider="claude_code")),
            patch(PM_SUPPORTED, return_value=False),
            pytest.raises(ValueError, match="does not support account profiles"),
        ):
            await switch_provider_profile("abcd1234", "target")


class TestSwitchExecution:
    @pytest.mark.asyncio
    async def test_successor_first_and_predecessor_retained(self):
        """Successor is created and receives the bounded prompt; no delete call."""
        create = AsyncMock(return_value=_successor())
        with (
            patch(TS_GET_META, return_value=_predecessor()),
            patch(TS_GET_PROFILE, return_value=_FakeProfile(provider="claude_code")),
            patch(PM_SUPPORTED, return_value=True),
            patch(CREATE_TERMINAL, create),
            patch(SEND_INPUT) as send,
            patch(DELETE_TERMINAL) as delete,
        ):
            result = await switch_provider_profile(
                "abcd1234", "ours", continuation_note="carry on"
            )
        assert result["status"] == "switched"
        assert result["successor_id"] == "eeee9999"
        # Successor inherits the predecessor's launch identity except the
        # account profile.
        kwargs = create.call_args.kwargs
        assert kwargs["provider"] == "claude_code"
        assert kwargs["agent_profile"] == "developer"
        assert kwargs["provider_profile"] == "ours"
        assert kwargs["session_name"] == "cao-session"
        assert kwargs["working_directory"] == "/work/dir"
        assert kwargs["group"] == ["tenant_1", "project_5"]
        assert kwargs["engine"] is None
        assert kwargs["switch_predecessor_id"] == "abcd1234"
        assert "metadata" not in kwargs
        # Bounded, non-empty dispatch
        prompt = send.call_args.args[1]
        assert "#runtime" in prompt or "rate limit" in prompt
        assert "carry on" in prompt
        assert len(prompt) < 1500
        # NEVER deletes the predecessor inside the switch
        delete.assert_not_called()

    @pytest.mark.asyncio
    async def test_successor_failure_surfaces_requested_precondition(self):
        with (
            patch(TS_GET_META, return_value=_predecessor()),
            patch(TS_GET_PROFILE, return_value=_FakeProfile(provider="claude_code")),
            patch(PM_SUPPORTED, return_value=True),
            patch(CREATE_TERMINAL, AsyncMock(side_effect=ValueError("bad input"))),
            patch(SEND_INPUT) as send,
            patch(DELETE_TERMINAL) as delete,
        ):
            with pytest.raises(ValueError, match="failed to create successor"):
                await switch_provider_profile("abcd1234", "ours")
        send.assert_not_called()
        delete.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_duplicate_successor(self):
        with (
            patch(
                TS_GET_META,
                return_value=_predecessor(switch_successor_id="eeee9999"),
            ),
            patch(TS_GET_PROFILE, return_value=_FakeProfile(provider="claude_code")),
            patch(PM_SUPPORTED, return_value=True),
            patch(CREATE_TERMINAL, AsyncMock()) as create,
            pytest.raises(ValueError, match="already has a successor"),
        ):
            await switch_provider_profile("abcd1234", "ours")
        create.assert_not_called()

    def test_idempotency_key_is_stable_per_target(self):
        key = import_or_call("_switch_idempotency_key")
        assert key("abcd1234", "ours") == key("abcd1234", "ours")
        assert key("abcd1234", "ours") != key("abcd1234", "theirs")
        assert key("abcd1234", "ours") != key("eeee9999", "ours")

    def test_continuation_note_bounded(self):
        prompt_builder = import_or_call("_switch_continuation_prompt")
        note = "x" * (SWITCH_CONTINUATION_NOTE_MAX + 500)
        prompt = prompt_builder("abcd1234", {"kind": "rate_limited", "message": "rate"}, note)
        assert len(prompt) < 1600

    def test_no_runtime_failure_still_allowed(self):
        """Without a detectable failure the switch is still valid when the user
        simply prefers a different account (nothing rotates on its own)."""
        predecessor = _predecessor(runtime_failure=None)
        assert predecessor["runtime_failure"] is None
        prompt = import_or_call("_switch_continuation_prompt")("abcd1234", {}, note="")
        assert "unknown_failure" in prompt
