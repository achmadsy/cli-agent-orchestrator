"""Display output must not depend on the TUI viewport or terminal width."""

import json
from unittest.mock import patch

import pytest

from cli_agent_orchestrator.providers import claude_transcript as ct
from cli_agent_orchestrator.providers.claude_code import ClaudeCodeProvider

SID = "04d3aa60-6778-422c-b259-e3cb73e42fc5"


@pytest.fixture
def transcript(tmp_path):
    config = tmp_path / ".claude"
    sessions = config / "sessions"
    sessions.mkdir(parents=True)
    (sessions / "123.json").write_text(
        json.dumps({"pid": 123, "sessionId": SID, "cwd": "/workspace"})
    )
    project = config / "projects" / "-workspace"
    project.mkdir(parents=True)
    path = project / f"{SID}.jsonl"
    provider = ClaudeCodeProvider("t1", "s", "w")
    provider._config_dir = config
    with patch.object(ct, "_process_terminal_id", return_value="t1"):
        yield provider, path, sessions


def _record(kind, uuid, parent, content, **extra):
    return {
        "type": kind,
        "uuid": uuid,
        "parentUuid": parent,
        "sessionId": SID,
        "message": {"role": kind, "content": content},
        **extra,
    }


def _save(path, *rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))


def test_original_wide_table_and_all_turns_survive_a_clipped_viewport(transcript):
    provider, path, _ = transcript
    table = "| Source | " + "Wide column " * 30 + "|\n| BMKG | Free |"
    _save(
        path,
        _record("user", "u1", None, "First question"),
        _record("assistant", "a1", "u1", [{"type": "text", "text": "First answer"}]),
        _record("user", "u2", "a1", "Compare the sources"),
        _record("assistant", "a2", "u2", [{"type": "text", "text": table}]),
    )
    last = provider.get_display_output("last")
    full = provider.get_display_output("full")
    assert last["output"] == table
    assert last["source"] == "transcript"
    assert (
        full["output"]
        == f"User:\nFirst question\n\nAssistant:\nFirst answer\n\nUser:\nCompare the sources\n\nAssistant:\n{table}"
    )
    assert full["truncated"] is False


def test_never_publishes_thinking_tools_or_injected_context(transcript):
    provider, path, _ = transcript
    _save(
        path,
        _record("user", "u1", None, "Question"),
        _record(
            "assistant",
            "a1",
            "u1",
            [
                {"type": "thinking", "thinking": "PRIVATE REASONING"},
                {"type": "tool_use", "name": "Bash", "input": {"command": "SECRET"}},
            ],
        ),
        _record("user", "r1", "a1", [{"type": "tool_result", "content": "SECRET TOOL RESULT"}]),
        _record("user", "m1", "r1", "INJECTED CONTEXT", isMeta=True),
        _record("assistant", "a2", "m1", [{"type": "text", "text": "Public answer"}]),
    )
    assert provider.get_display_output("last")["output"] == "Public answer"
    assert (
        provider.get_display_output("full")["output"]
        == "User:\nQuestion\n\nAssistant:\nPublic answer"
    )


def test_follows_active_branch_and_does_not_repeat_stream_snapshots(transcript):
    provider, path, _ = transcript
    _save(
        path,
        _record("user", "u1", None, "Question"),
        _record("assistant", "a1", "u1", [{"type": "text", "text": "Abandoned"}]),
        _record("assistant", "a2", "u1", [{"type": "text", "text": "Part"}]),
        _record("assistant", "a2", "u1", [{"type": "text", "text": "Complete answer"}]),
    )
    assert provider.get_display_output("last")["output"] == "Complete answer"
    assert "Abandoned" not in provider.get_display_output("full")["output"]


def test_pending_turn_does_not_show_previous_answer_as_latest(transcript):
    provider, path, _ = transcript
    _save(
        path,
        _record("user", "u1", None, "First"),
        _record("assistant", "a1", "u1", [{"type": "text", "text": "Old answer"}]),
        _record("user", "u2", "a1", "New question"),
    )
    assert provider.get_display_output("last")["output"] == ""


def test_incomplete_append_does_not_break_read(transcript):
    provider, path, _ = transcript
    _save(path, _record("assistant", "a1", None, [{"type": "text", "text": "Answer"}]))
    with path.open("a") as handle:
        handle.write('{"type":"assistant"')
    assert provider.get_display_output("last")["output"] == "Answer"


def test_does_not_guess_session_from_same_working_directory(transcript):
    provider, path, _ = transcript
    _save(path, _record("assistant", "a1", None, [{"type": "text", "text": "Other session"}]))
    with patch.object(ct, "_process_terminal_id", return_value="other-terminal"):
        assert provider.get_display_output("full") is None


@pytest.mark.parametrize("sid", ["../../outside", "", "not-a-uuid"])
def test_rejects_untrusted_session_paths(transcript, sid):
    provider, _, sessions = transcript
    (sessions / "123.json").write_text(
        json.dumps({"pid": 123, "sessionId": sid, "cwd": "/workspace"})
    )
    assert provider.get_display_output("full") is None


def test_rejects_transcript_symlink_outside_own_config(transcript, tmp_path):
    provider, path, _ = transcript
    outside = tmp_path / "outside.jsonl"
    _save(outside, _record("assistant", "a1", None, [{"type": "text", "text": "Outside"}]))
    path.symlink_to(outside)
    assert provider.get_display_output("full") is None


def test_reports_bounded_output_instead_of_claiming_complete_history(transcript):
    provider, path, _ = transcript
    _save(path, _record("assistant", "a1", None, [{"type": "text", "text": "x" * 200}]))
    with patch.object(ct, "MAX_DISPLAY_CHARS", 80):
        result = provider.get_display_output("full")
    assert len(result["output"]) <= 80
    assert result["truncated"] is True
