"""The shared viewer path must cover every registered CLI, not only Claude."""

from unittest.mock import MagicMock, patch

import pytest

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.providers.base import OutputExtractionRejected
from cli_agent_orchestrator.providers.manager import ProviderManager
from cli_agent_orchestrator.services import terminal_service as ts


@pytest.fixture(params=list(ProviderType), ids=lambda kind: kind.value)
def provider(request):
    kind = request.param
    klass = ProviderManager.provider_class(kind.value)
    kwargs = {"agent_profile": "developer"} if kind != ProviderType.MOCK_CLI else {}
    return klass("test-view", "session", "window", **kwargs)


def _metadata():
    return {"tmux_session": "session", "tmux_window": "window"}


def test_full_output_replays_previous_alternate_screen_turns_for_every_provider(provider, tmp_path):
    table = "| Service | " + "Original table data " * 18 + "|"
    raw = (
        "\x1b[?1049h\x1b[2J\x1b[HUser: first question\r\nAssistant: first answer\r\n"
        "\x1b[2J\x1b[HUser: second question\r\n" + table + "\r\nSecond answer"
    )
    (tmp_path / "test-view.log").write_text(raw)
    backend = MagicMock()
    backend.get_dimensions.return_value = (80, 24)
    backend.get_display_history.return_value = "Second answer only"
    with (
        patch.object(ts, "get_terminal_metadata", return_value=_metadata()),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(provider, "get_display_output", return_value=None),
        patch.object(
            provider, "filter_display_history", side_effect=lambda text: text
        ) as filter_history,
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "TERMINAL_LOG_DIR", tmp_path),
    ):
        result = ts.get_display_output("test-view", ts.OutputMode.FULL)
    assert result["source"] == "recording"
    assert "first question" in result["output"]
    assert "first answer" in result["output"]
    assert "Second answer" in result["output"]
    from cli_agent_orchestrator.utils.text import strip_terminal_escapes

    assert table in strip_terminal_escapes(result["output"])
    filter_history.assert_called_once()
    backend.get_display_history.assert_not_called()
    backend.send_keys.assert_not_called()
    backend.send_special_key.assert_not_called()


def test_last_response_receives_logical_not_terminal_wrapped_lines_for_every_provider(provider):
    table = "| Service | " + "Wide column " * 30 + "|"
    backend = MagicMock()
    backend.get_display_history.return_value = table
    with (
        patch.object(ts, "get_terminal_metadata", return_value=_metadata()),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(provider, "get_display_output", return_value=None),
        patch.object(provider, "extract_last_message_from_script", return_value=table) as extract,
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "get_output") as execution_output,
    ):
        result = ts.get_display_output("test-view", ts.OutputMode.LAST)
    assert result["output"] == table
    extract.assert_called_once_with(table)
    execution_output.assert_not_called()
    backend.send_keys.assert_not_called()


@pytest.mark.parametrize("use_recording", [False, True])
def test_full_history_applies_kimi_channel_filter_before_publishing(tmp_path, use_recording):
    from cli_agent_orchestrator.providers.kimi_cli import KimiCliProvider

    provider = KimiCliProvider("test-view", "session", "window")
    raw = (
        "💫 first question\r\n\x1b[38;5;244m• PRIVATE_REASONING\x1b[0m\r\n"
        "\x1b[38;5;253m• First public answer\x1b[0m\r\n"
        "💫 second question\r\n\x1b[38;5;244m• SECOND_PRIVATE\x1b[0m\r\n"
        "\x1b[38;5;253m• Second public answer\x1b[0m\r\n💫"
    )
    if use_recording:
        (tmp_path / "test-view.log").write_text(raw)
    backend = MagicMock()
    backend.get_dimensions.return_value = (220, 50)
    backend.get_display_history.return_value = raw
    with (
        patch.object(ts, "get_terminal_metadata", return_value=_metadata()),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "TERMINAL_LOG_DIR", tmp_path),
    ):
        result = ts.get_display_output("test-view", ts.OutputMode.FULL)
    assert "First public answer" in result["output"]
    assert "Second public answer" in result["output"]
    assert "PRIVATE" not in result["output"]


def test_full_kimi_replaced_turn_with_same_header_keeps_answers_not_reasoning(tmp_path):
    from cli_agent_orchestrator.providers.kimi_cli import KimiCliProvider

    provider = KimiCliProvider("test-view", "session", "window")
    raw = "\x1b[?1049h"
    for question, answer in [
        ("first question", "First public answer"),
        ("second question", "Second public answer"),
    ]:
        raw += (
            "\x1b[?25l\x1b[HCLI header\r\n"
            f"💫 {question}\r\n\x1b[38;5;244m• PRIVATE_REASONING\x1b[0m\r\n"
            f"\x1b[38;5;253m• {answer}\x1b[0m\r\n💫\x1b[J\x1b[?25h"
        )
    (tmp_path / "test-view.log").write_text(raw)
    backend = MagicMock()
    backend.get_dimensions.return_value = (80, 24)
    with (
        patch.object(ts, "get_terminal_metadata", return_value=_metadata()),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "TERMINAL_LOG_DIR", tmp_path),
    ):
        result = ts.get_display_output("test-view", ts.OutputMode.FULL)
    assert "First public answer" in result["output"]
    assert "Second public answer" in result["output"]
    assert "PRIVATE" not in result["output"]
    backend.send_keys.assert_not_called()


def test_full_kimi_history_does_not_publish_unowned_leading_recording_tail():
    from cli_agent_orchestrator.providers.kimi_cli import KimiCliProvider

    provider = KimiCliProvider("test-view", "session", "window")
    history = (
        "UNOWNED_PRIVATE_CONTINUATION\n💫\n"
        "💫 next question\n\x1b[38;5;253m• Public answer\x1b[0m\n💫"
    )
    output = provider.filter_display_history(history)
    assert "Public answer" in output
    assert "PRIVATE" not in output


@pytest.mark.parametrize(
    "history,private",
    [
        (
            "UNOWNED_PRIVATE_CONTINUATION\n\x1b[38;5;253m• Public answer\x1b[0m\n💫",
            "UNOWNED_PRIVATE_CONTINUATION",
        ),
        (
            "💫 question\n\x1b[38;5;244m• PRIVATE_REASONING\nPRIVATE_CONTINUATION\x1b[0m\n\x1b[38;5;253m• Public answer\x1b[0m\n💫",
            "PRIVATE",
        ),
    ],
)
def test_full_kimi_history_excludes_ambiguous_prefix_and_inherited_reasoning(history, private):
    from cli_agent_orchestrator.providers.kimi_cli import KimiCliProvider

    output = KimiCliProvider("test-view", "session", "window").filter_display_history(history)
    assert "Public answer" in output
    assert private not in output


def test_last_response_retains_kimi_styling_until_real_extraction():
    from cli_agent_orchestrator.providers.kimi_cli import KimiCliProvider

    provider = KimiCliProvider("test-view", "session", "window")
    backend = MagicMock()
    backend.get_display_history.return_value = (
        "💫 question\n\x1b[38;5;244m• PRIVATE_REASONING\x1b[0m\n"
        "\x1b[38;5;253m• Public answer\x1b[0m\n💫"
    )
    with (
        patch.object(ts, "get_terminal_metadata", return_value=_metadata()),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(ts, "get_backend", return_value=backend),
    ):
        result = ts.get_display_output("test-view", ts.OutputMode.LAST)
    assert "Public answer" in result["output"]
    assert "PRIVATE" not in result["output"]


def test_deliberate_private_output_rejection_is_never_bypassed(provider):
    backend = MagicMock()
    backend.get_display_history.return_value = "private content"
    with (
        patch.object(ts, "get_terminal_metadata", return_value=_metadata()),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(provider, "get_display_output", return_value=None),
        patch.object(
            provider,
            "extract_last_message_from_script",
            side_effect=OutputExtractionRejected("private"),
        ),
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "get_output") as fallback,
    ):
        with pytest.raises(OutputExtractionRejected):
            ts.get_display_output("test-view", ts.OutputMode.LAST)
    fallback.assert_not_called()
