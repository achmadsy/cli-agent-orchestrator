"""The viewer has an additive read-only API, separate from raw execution output."""

from unittest.mock import MagicMock, patch

import pytest

from cli_agent_orchestrator.providers.claude_code import ClaudeCodeProvider
from cli_agent_orchestrator.services import terminal_service as ts


@pytest.mark.parametrize("mode", ["last", "full"])
def test_display_output_endpoint_passes_mode_and_provenance(client, mode):
    result = {"output": "original table", "mode": mode, "source": "transcript", "truncated": False}
    with patch.object(ts, "get_display_output", return_value=result) as read:
        response = client.get(f"/terminals/abcd1234/display-output?mode={mode}")
    assert response.status_code == 200
    assert response.json() == result
    read.assert_called_once_with("abcd1234", ts.OutputMode(mode))


def test_display_output_rejects_invalid_mode(client):
    with patch.object(ts, "get_display_output") as read:
        response = client.get("/terminals/abcd1234/display-output?mode=anything")
    assert response.status_code == 422
    read.assert_not_called()


@pytest.mark.parametrize("scopes,expected", [(["cao:metrics"], 403), (["cao:read"], 200)])
def test_display_output_enforces_read_scope(client, monkeypatch, scopes, expected):
    from cli_agent_orchestrator.api.main import app
    from cli_agent_orchestrator.security import auth

    async def current_scopes():
        return scopes

    monkeypatch.setenv("CAO_AUTH_JWKS_URI", "https://idp.example/jwks")
    app.dependency_overrides[auth.get_current_scopes] = current_scopes
    try:
        with patch.object(ts, "get_display_output", return_value={"output": "public"}) as read:
            response = client.get("/terminals/abcd1234/display-output")
        assert response.status_code == expected
        if expected == 403:
            read.assert_not_called()
    finally:
        app.dependency_overrides.pop(auth.get_current_scopes, None)


def test_display_output_missing_terminal_is_404(client):
    with patch.object(ts, "get_display_output", side_effect=ValueError("Terminal not found")):
        assert client.get("/terminals/abcd1234/display-output").status_code == 404


def test_display_output_uses_transcript_without_screen_capture():
    provider = ClaudeCodeProvider("t1", "s", "w")
    result = {"output": "original text", "mode": "full", "source": "transcript", "truncated": False}
    with (
        patch.object(ts, "get_terminal_metadata", return_value={"provider": "claude_code"}),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(provider, "get_display_output", return_value=result),
        patch.object(ts, "get_screen") as screen,
        patch.object(ts, "get_output") as raw,
    ):
        assert ts.get_display_output("t1", ts.OutputMode.FULL) == result
    screen.assert_not_called()
    raw.assert_not_called()


@pytest.mark.parametrize("empty_limited_tail", [False, True])
def test_replay_budget_fallback_keeps_provider_privacy_filter_and_explains_limit(
    empty_limited_tail,
):
    from cli_agent_orchestrator.providers.kimi_cli import KimiCliProvider
    from cli_agent_orchestrator.services.terminal_recording import ReplayLimitExceeded

    provider = KimiCliProvider("t1", "s", "w")
    backend = MagicMock()
    backend.get_dimensions.return_value = (80, 24)
    backend.get_display_history.return_value = (
        "💫 question\n\x1b[38;5;244m• PRIVATE\x1b[0m\n" "\x1b[38;5;253m• Public answer\x1b[0m\n💫"
    )
    with (
        patch.object(
            ts, "get_terminal_metadata", return_value={"tmux_session": "s", "tmux_window": "w"}
        ),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(ts, "get_backend", return_value=backend),
        patch(
            "cli_agent_orchestrator.services.terminal_recording.read_recording",
            side_effect=None if empty_limited_tail else ReplayLimitExceeded(),
            return_value={"output": "", "truncated": True, "limited_reason": "replay_budget"},
        ),
    ):
        result = ts.get_display_output("t1", ts.OutputMode.FULL)
    assert result["source"] == "scrollback"
    assert result["limited_reason"] == "replay_budget"
    assert result["truncated"] is True
    assert "Public answer" in result["output"]
    assert "PRIVATE" not in result["output"]


@pytest.mark.parametrize("mode,source", [("full", "scrollback"), ("last", "rendered_response")])
def test_display_output_labels_rendered_fallback(mode, source):
    backend = MagicMock()
    backend.get_display_history.return_value = "rendered text"
    backend.get_dimensions.return_value = (80, 24)
    with (
        patch.object(
            ts,
            "get_terminal_metadata",
            return_value={
                "provider": "unsupported",
                "tmux_session": "s",
                "tmux_window": "w",
            },
        ),
        patch.object(ts.provider_manager, "get_provider", return_value=None),
        patch.object(ts, "get_backend", return_value=backend),
        patch(
            "cli_agent_orchestrator.services.terminal_recording.read_recording", return_value=None
        ),
        patch.object(ts, "get_output", return_value="rendered text") as output,
    ):
        result = ts.get_display_output("t1", ts.OutputMode(mode))
    assert result == {"output": "rendered text", "mode": mode, "source": source, "truncated": True}
    if mode == "full":
        output.assert_not_called()
    else:
        output.assert_called_once_with("t1", ts.OutputMode.LAST)
    backend.get_display_history.assert_called_once_with("s", "w")
