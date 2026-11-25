"""An active native API retry must never be execution-completion evidence."""

import pytest

from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.providers.claude_code import ClaudeCodeProvider

RAIL = "─" * 80


def frame(retry="✻ API error · retrying in 1s · attempt 1/10"):
    return [
        "● Verifying stable release ordering and saving evidence",
        "  ⎿ $ python3 -I -c ...",
        retry,
        RAIL,
        "❯ ",
        RAIL,
        "  ⏵⏵ bypass permissions on · esc to interrupt",
    ]


@pytest.mark.parametrize("glyph", ["✶", "✢", "✽", "✻", "✳", "·", "*"])
@pytest.mark.parametrize(
    "retry",
    ["retrying in 1s · attempt 1/10", "retrying… · attempt 2/10", "retrying in 35s · attempt 4/10"],
)
def test_active_retry_is_processing_in_real_screen_shape(glyph, retry):
    provider = ClaudeCodeProvider("fixture", "fixture-session", "fixture-window")
    rows = frame(f"{glyph} API error · {retry}")
    assert provider.get_status_from_screen(rows) == TerminalStatus.PROCESSING
    assert provider.get_status("\n".join(rows)) == TerminalStatus.PROCESSING


def test_retry_no_longer_visible_does_not_pin_completed_turn():
    provider = ClaudeCodeProvider("fixture", "fixture-session", "fixture-window")
    assert provider.get_status_from_screen(frame()) == TerminalStatus.PROCESSING
    done = ["● Final report saved.", "✻ Worked for 65s", RAIL, "❯ ", RAIL]
    assert provider.get_status_from_screen(done) == TerminalStatus.COMPLETED
    assert provider.get_status("\n".join(done)) == TerminalStatus.COMPLETED


@pytest.mark.parametrize(
    "quoted",
    [
        "● The error was: API error · retrying in 1s · attempt 1/10",
        "> ✻ API error · retrying in 1s · attempt 1/10",
        "* API errors may involve retrying requests.",
    ],
)
def test_prose_about_retry_does_not_block_completed(quoted):
    provider = ClaudeCodeProvider("fixture", "fixture-session", "fixture-window")
    rows = [quoted, "● Final report", RAIL, "❯ ", RAIL]
    assert provider.get_status_from_screen(rows) == TerminalStatus.COMPLETED


def test_retry_does_not_hide_live_question():
    provider = ClaudeCodeProvider("fixture", "fixture-session", "fixture-window")
    rows = frame() + [
        "Question?",
        "❯ 1. Continue",
        "  2. Stop",
        "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ]
    assert provider.get_status_from_screen(rows) == TerminalStatus.WAITING_USER_ANSWER
    assert provider.get_status("\n".join(rows)) == TerminalStatus.WAITING_USER_ANSWER


def test_stale_retry_before_new_final_response_does_not_pin_raw_status():
    provider = ClaudeCodeProvider("fixture", "fixture-session", "fixture-window")
    raw = "\n".join(frame() + ["● Final report", "✻ Worked for 65s", RAIL, "❯ ", RAIL])
    assert provider.get_status(raw) == TerminalStatus.COMPLETED
