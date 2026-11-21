"""Real parser verification through the UI service (no live CLI processes)."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cli_agent_orchestrator.providers.manager import ProviderManager
from cli_agent_orchestrator.services import terminal_service as ts

_FIXTURES = Path(__file__).parents[1] / "providers" / "fixtures"


@pytest.mark.parametrize(
    "kind,fixture,expected",
    [
        ("kiro_cli", "kiro_cli_completed_output.txt", "comprehensive response"),
        ("codex", "codex_completed_output.txt", "All tests now pass."),
        ("kimi_cli", "kimi_code_0431_03_final_answer.txt", "A0-FIXTURE-DONE."),
        ("opencode_cli", "opencode_cli_completed.txt", "Hello there, friend!"),
        ("cursor_cli", "cursor_cli_completed_output.txt", "comprehensive response"),
        ("antigravity_cli", "agy_completed.txt", "PONG"),
        ("omp", "omp_completed.txt", "RAW_FIXTURE"),
        ("grok_cli", "grok_cli_completed.txt", "print(42)"),
        ("mcode", "minimax_code_completed.txt", "All focused checks pass."),
        # These providers keep their extraction fixtures inline in unit tests.
        ("claude_code", None, "that spans multiple lines"),
        ("copilot_cli", None, "Completed task successfully."),
        ("hermes", None, "OK"),
    ],
)
def test_last_response_uses_actual_provider_parser(kind, fixture, expected, tmp_path):
    if fixture:
        history = (_FIXTURES / fixture).read_text()
    elif kind == "claude_code":
        history = "Initial content\n⏺ Here is the response message\nthat spans multiple lines\n> "
    elif kind == "copilot_cli":
        history = "assistant: Completed task successfully."
    else:
        # Use the existing Hermes inline capture, not a parser stub.
        from test.providers.test_hermes_provider_unit import HERMES_COMPLETED_OUTPUT

        history = HERMES_COMPLETED_OUTPUT
    provider = ProviderManager.provider_class(kind)(
        "test-view", "session", "window", agent_profile="developer"
    )
    backend = MagicMock()
    backend.get_display_history.return_value = history
    with (
        patch.object(
            ts,
            "get_terminal_metadata",
            return_value={"tmux_session": "session", "tmux_window": "window"},
        ),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(provider, "get_display_output", return_value=None),
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "get_output") as raw_fallback,
    ):
        result = ts.get_display_output("test-view", ts.OutputMode.LAST)
    assert expected in result["output"]
    assert result["source"] == "rendered_response"
    raw_fallback.assert_not_called()
    backend.send_keys.assert_not_called()

    # The real provider parser must retain a wide table's logical rows too,
    # not merely receive the joined string through a mocked extractor.
    table = "| Service | " + "wide data " * 35 + "|\n| A | B |"
    if kind == "opencode_cli":
        # Remove the actual sidebar to simulate a pane wide enough to emit
        # the table. Inserting 350 cells into its 140-column left pane would
        # create an impossible fixture, not recoverable original text.
        history = "\n".join(line[:140].rstrip() for line in history.split("\n"))
    before, separator, after = history.rpartition(expected)
    assert separator  # Replace the answer, not an earlier echo quoting it.
    table_history = before + table + after
    assert table_history != history
    backend.get_display_history.return_value = table_history
    with (
        patch.object(
            ts,
            "get_terminal_metadata",
            return_value={"tmux_session": "session", "tmux_window": "window"},
        ),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(provider, "get_display_output", return_value=None),
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "get_output") as fallback,
    ):
        table_result = ts.get_display_output("test-view", ts.OutputMode.LAST)
    assert table in table_result["output"]
    fallback.assert_not_called()

    # FULL takes a different route: replay the recording and apply the actual
    # provider's publication filter. No extraction/filter mock is used here.
    # Capture fixtures use LF-separated rows; a terminal's emitted newline is
    # CRLF. Feeding LF-only captures as a raw recording would deliberately
    # leave the cursor in its previous column and manufacture staircase text.
    raw_recording = table_history.replace("\r\n", "\n").replace("\n", "\r\n")
    (tmp_path / "test-view.log").write_text(raw_recording)
    backend.get_dimensions.return_value = (500, 100)
    with (
        patch.object(
            ts,
            "get_terminal_metadata",
            return_value={"tmux_session": "session", "tmux_window": "window"},
        ),
        patch.object(ts.provider_manager, "get_provider", return_value=provider),
        patch.object(provider, "get_display_output", return_value=None),
        patch.object(ts, "get_backend", return_value=backend),
        patch.object(ts, "TERMINAL_LOG_DIR", tmp_path),
    ):
        full_result = ts.get_display_output("test-view", ts.OutputMode.FULL)
    from cli_agent_orchestrator.utils.text import strip_terminal_escapes

    assert table in strip_terminal_escapes(full_result["output"])
    assert full_result["source"] == "recording"
