"""Provider-neutral output replay: history, redraws and wide logical lines."""

import pytest

from cli_agent_orchestrator.services import terminal_recording as recording


def test_replay_keeps_old_turns_when_alternate_screen_is_cleared():
    raw = (
        "\x1b[?1049h\x1b[2J\x1b[H"
        "User: first question\r\nAssistant: first answer\r\n"
        "\x1b[2J\x1b[HUser: second question\r\nAssistant: second answer"
    )
    result = recording.render_recording(raw, columns=80, rows=24)
    assert "first question" in result["output"]
    assert "first answer" in result["output"]
    assert "second question" in result["output"]
    assert "second answer" in result["output"]
    assert "\x1b" not in result["output"]


def test_replay_preserves_long_table_line_across_terminal_soft_wraps():
    table = "| BMKG | " + "wide data " * 30 + "|"
    result = recording.render_recording(table + "\r\nDone", columns=40, rows=8)
    assert table in result["output"]
    assert result["output"].endswith("Done")


def test_replay_keeps_scrolled_rows_and_does_not_duplicate_spinner_redraws():
    raw = "first\r\nsecond\r\nthird\r\nfourth\r\n"
    raw += "\rWorking 1\r\x1b[2KWorking 2\r\x1b[2KFinal answer"
    result = recording.render_recording(raw, columns=80, rows=3)
    assert "first" in result["output"]
    assert "fourth" in result["output"]
    assert "Final answer" in result["output"]
    assert "Working 1" not in result["output"]
    assert "Working 2" not in result["output"]


def test_repeated_full_repaints_do_not_repeat_identical_frames():
    raw = "\x1b[2J\x1b[HSame answer\r\nDone" * 5
    result = recording.render_recording(raw, columns=80, rows=24)
    assert result["output"].count("Same answer") == 1


def test_alternate_screen_repaints_replace_progress_instead_of_archiving_every_frame():
    raw = "\x1b[?1049h"
    for number in range(30):
        raw += "\x1b[?25l\x1b[HUser: question\r\n" f"Answer progress {number}\r\n\x1b[J\x1b[?25h"
    result = recording.render_recording(raw, columns=80, rows=3)
    assert result["output"].count("User: question") == 1
    assert "Answer progress 29" in result["output"]
    assert "Answer progress 28" not in result["output"]


def test_alternate_redraw_scrolling_does_not_duplicate_the_viewport():
    frame = "User: question\r\nAnswer line 1\r\nAnswer line 2\r\nAnswer line 3"
    raw = "\x1b[?1049h" + ("\x1b[?25l\x1b[H" + frame + "\x1b[?25h") * 15
    result = recording.render_recording(raw, columns=80, rows=3)
    assert result["output"].count("Answer line 1") == 1
    assert result["output"].count("Answer line 3") == 1


def test_alternate_screen_retains_replaced_turn_without_clear_screen():
    raw = (
        "\x1b[?1049h\x1b[?25l\x1b[HUser: first question\r\nFirst answer\x1b[?25h"
        "\x1b[?25l\x1b[HUser: second question\r\nSecond answer\x1b[J\x1b[?25h"
    )
    result = recording.render_recording(raw, columns=80, rows=24)
    assert "First answer" in result["output"]
    assert "Second answer" in result["output"]


@pytest.mark.parametrize("ansi", [False, True])
@pytest.mark.parametrize(
    "prefix", ["User: ", "You ", "❯ ", "› ", "» ", "> ", "💫 ", "✨ ", "  ┃  "]
)
def test_same_header_does_not_hide_replaced_user_turn(ansi, prefix):
    raw = "\x1b[?1049h"
    for question, answer in [
        ("first question", "First answer"),
        ("second question", "Second answer"),
    ]:
        raw += (
            "\x1b[?25l\x1b[HCLI session header\r\n" f"{prefix}{question}\r\n{answer}\x1b[J\x1b[?25h"
        )
    result = recording.render_recording(raw, columns=80, rows=24, ansi=ansi)
    assert "First answer" in result["output"]
    assert "Second answer" in result["output"]


def test_opencode_persistent_composer_does_not_hide_the_changed_echo():
    raw = "\x1b[?1049h"
    for question, answer in [
        ("first question", "First answer"),
        ("second question", "Second answer"),
    ]:
        raw += (
            "\x1b[?25l\x1b[HCLI header\r\n"
            f"  ┃  {question}\r\n\r\n     {answer}\r\n"
            "     ▣  Build · Model · 3.0s\r\n\r\n"
            "  ┃  Build · Model\r\n  ╹━━━━━━━━━━━━━━━━━━━━\r\n"
            "context 10%\x1b[J\x1b[?25h"
        )
    result = recording.render_recording(raw, columns=80, rows=24)
    assert "First answer" in result["output"]
    assert "Second answer" in result["output"]


def test_prompt_echo_is_built_from_logical_not_physical_rows():
    # The first physical row is identical; only the wrapped tail differs.
    raw = "\x1b[?1049h"
    prefix = "User: " + "same prefix " * 5
    for suffix, answer in [
        ("first question", "First answer"),
        ("second question", "Second answer"),
    ]:
        raw += (
            "\x1b[?25l\x1b[HCLI session header\r\n" f"{prefix}{suffix}\r\n{answer}\x1b[J\x1b[?25h"
        )
    result = recording.render_recording(raw, columns=40, rows=24)
    assert "First answer" in result["output"]
    assert "Second answer" in result["output"]


def test_same_header_streaming_answer_is_not_archived_on_each_redraw():
    raw = "\x1b[?1049h"
    for number in range(30):
        raw += (
            "\x1b[?25l\x1b[HCLI session header\r\nUser: same question\r\n"
            f"Answer progress {number}\x1b[J\x1b[?25h"
        )
    result = recording.render_recording(raw, columns=80, rows=24)
    assert result["output"].count("User: same question") == 1
    assert "Answer progress 29" in result["output"]
    assert "Answer progress 28" not in result["output"]


def test_clearing_a_wrapped_row_removes_its_wrap_ownership():
    raw = "a" * 80 + "\x1b[H\x1b[2JShort\r\nNext"
    result = recording.render_recording(raw, columns=40, rows=8)
    assert "Short\nNext" in result["output"]


def test_device_queries_are_passive_and_never_crash():
    raw = "\x1b[?6n\x1b[?1;2c\x1b[6n\x1b[18tVisible output"
    assert "Visible output" in recording.render_recording(raw, columns=80, rows=24)["output"]


def test_recording_read_is_bounded_and_reports_truncation(tmp_path, monkeypatch):
    path = tmp_path / "t1.log"
    path.write_text("old " * 100 + "\r\nnewest answer")
    monkeypatch.setattr(recording, "MAX_RECORDING_BYTES", 100)
    result = recording.read_recording(path, columns=80, rows=24)
    assert result["truncated"] is True
    assert "newest answer" in result["output"]


def test_replay_retains_reasoning_and_answer_sgr_until_provider_filtering():
    raw = "\x1b[38;5;244m● PRIVATE\x1b[0m\r\n\x1b[38;5;253m● PUBLIC\x1b[0m"
    result = recording.render_recording(raw, columns=80, rows=24, ansi=True)
    assert "\x1b[38;5;244m● PRIVATE" in result["output"]
    assert "\x1b[38;5;253m● PUBLIC" in result["output"]


def test_recording_read_preserves_carriage_return_overwrite_not_universal_newlines(tmp_path):
    path = tmp_path / "carriage-return.log"
    path.write_bytes(b"Working 1\r\x1b[2KFinal answer\r\nNext row")
    first = recording.read_recording(path, columns=80, rows=24)
    second = recording.read_recording(path, columns=80, rows=24)
    assert first == second
    assert first["output"] == "Final answer\nNext row"
    assert "Working 1" not in first["output"]


def test_read_cache_invalidates_after_append(tmp_path):
    path = tmp_path / "cached.log"
    path.write_text("First answer")
    first = recording.read_recording(path)
    first["output"] = "caller cannot mutate cached result"
    assert recording.read_recording(path)["output"] == "First answer"
    with path.open("a") as handle:
        handle.write("\r\nSecond answer")
    assert "Second answer" in recording.read_recording(path)["output"]


def test_missing_recording_returns_none(tmp_path):
    assert recording.read_recording(tmp_path / "missing.log", columns=80, rows=24) is None


@pytest.mark.parametrize("ansi", [False, True])
@pytest.mark.parametrize("columns,rows", [(20, 3), (40, 8)])
def test_ascii_fast_path_matches_reference_pyte_semantics(monkeypatch, ansi, columns, rows):
    # Compare complete replay results, including styles and wrap ownership.
    raw = (
        "\x1b[?1049h\x1b[?25l\x1b[HCLI header\r\nUser: question\r\n"
        "\x1b[38;5;244mPRIVATE\x1b[0m\r\n"
        "\x1b[38;5;253m" + "public table data " * 16 + "\x1b[0m\r\n"
        "Unicode 界 é\r\n\x1b[?25h"
        "\x1b[?7l" + "no wrap " * 15 + "\r\n\x1b[?7h"
        "\x1b[4hINSERT\x1b[4l\x1b(0lqqk\x1b(B\r\n"
        "\x1b[H\x1b[2KFinal replacement\x1b[?1049l"
    )
    actual = recording.render_recording(raw, columns=columns, rows=rows, ansi=ansi)

    def reference_draw(self, data):
        self._drawing = True
        try:
            recording.pyte.Screen.draw(self, data)
        finally:
            self._drawing = False

    monkeypatch.setattr(recording._RecordingScreen, "draw", reference_draw)
    expected = recording.render_recording(raw, columns=columns, rows=rows, ansi=ansi)
    assert actual == expected


@pytest.mark.parametrize("chunk_chars", [1, 7, 61])
def test_time_budget_chunking_does_not_change_escape_or_unicode_semantics(monkeypatch, chunk_chars):
    raw = (
        "\x1b[?1049h\x1b[?25l\x1b[HUser: question\r\n"
        "\x1b[38;5;244m● PRIVATE\x1b[0m\r\n"
        "\x1b[38;5;253m● PUBLIC 界 é\x1b[0m\r\n"
        + "long table " * 16
        + "\x1b[?25h\x1b]0;ignored title\x07"
    )
    expected = recording.render_recording(raw, columns=40, rows=8, ansi=True)
    monkeypatch.setattr(recording, "_REPLAY_CHUNK_CHARS", chunk_chars)
    assert recording.render_recording(raw, columns=40, rows=8, ansi=True) == expected


def test_render_time_limit_discards_prefix_instead_of_returning_partial_output(monkeypatch):
    ticks = iter([0.0, 0.0, 5.0])
    monkeypatch.setattr(recording, "monotonic", lambda: next(ticks))
    with pytest.raises(recording.ReplayLimitExceeded):
        recording.render_recording("old prefix " * 2000 + "latest answer")


def test_replay_budget_includes_final_frame_rendering(monkeypatch):
    ticks = iter([0.0, 0.0, 0.0, 5.0])
    monkeypatch.setattr(recording, "monotonic", lambda: next(ticks))
    with pytest.raises(recording.ReplayLimitExceeded):
        recording.render_recording("Visible answer")


def test_read_time_limit_retries_smaller_recent_tail_and_labels_it(tmp_path, monkeypatch):
    path = tmp_path / "limited.log"
    path.write_bytes(b"OLD_PREFIX" + b" " * 300 + b"\r\nLATEST_ANSWER")
    monkeypatch.setattr(recording, "REPLAY_TAIL_BYTES", 80)
    original = recording.render_recording
    calls = []

    def first_attempt_times_out(raw, **kwargs):
        calls.append(raw)
        if len(calls) == 1:
            raise recording.ReplayLimitExceeded()
        return original(raw, **kwargs)

    monkeypatch.setattr(recording, "render_recording", first_attempt_times_out)
    result = recording.read_recording(path)
    assert "LATEST_ANSWER" in result["output"]
    assert "OLD_PREFIX" not in result["output"]
    assert result["truncated"] is True
    assert result["limited_reason"] == "replay_budget"
    assert len(calls) == 2
    assert len(calls[-1].encode()) == 80
    assert recording.read_recording(path) == result
    assert len(calls) == 2  # unchanged limited tail is cached too


def test_read_does_not_retry_or_publish_prefix_when_even_small_log_times_out(tmp_path, monkeypatch):
    path = tmp_path / "small-limit.log"
    path.write_bytes(b"old prefix\r\nlatest answer")

    def always_times_out(raw, **kwargs):
        raise recording.ReplayLimitExceeded()

    monkeypatch.setattr(recording, "render_recording", always_times_out)
    with pytest.raises(recording.ReplayLimitExceeded):
        recording.read_recording(path)


def test_output_limit_is_visible(monkeypatch):
    monkeypatch.setattr(recording, "MAX_OUTPUT_CHARS", 80)
    result = recording.render_recording("a" * 200, columns=40, rows=8)
    assert result["truncated"] is True
    assert len(result["output"]) <= 80


@pytest.mark.parametrize("columns,rows", [(0, 0), (1_000_000, 1_000_000)])
def test_untrusted_geometry_is_clamped(columns, rows):
    result = recording.render_recording("Visible", columns=columns, rows=rows)
    assert "Visible" in result["output"]
