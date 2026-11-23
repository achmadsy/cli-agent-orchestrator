"""Native question parser and no-live-input answer safety regressions."""

from copy import deepcopy
from datetime import datetime
from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.backends.tmux_backend import TmuxBackend
from cli_agent_orchestrator.providers.claude_question import parse_question
from cli_agent_orchestrator.services import user_question as service

SCREEN = """● Choose a package.
────────────────────────────────────────────────────────────────────
 ☐ File APK

│ APK mana di Downloads Windows yang ingin kamu periksa?

❯ 1. Google Activator
     Google-Activator-v1.1-release.apk
  2. Nova Launcher
     NovaLauncher_8.0.18.apk
  3. Magisk
     Ada versi v28.0 dan v29.0.
  4. Aurora Store / Termux
     com.aurora.store_70.apk atau termux-app.apk;
     sebutkan yang dimaksud di catatan.
  5. Type something.
────────────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
"""


def test_real_picker():
    q = parse_question(SCREEN)
    assert q.header == "File APK"
    assert q.question == "APK mana di Downloads Windows yang ingin kamu periksa?"
    assert [o.label for o in q.options] == [
        "Google Activator",
        "Nova Launcher",
        "Magisk",
        "Aurora Store / Termux",
    ]
    assert "sebutkan" in q.options[-1].description
    assert q.custom_number == 5 and q.selected == 1 and not q.custom_text


@pytest.mark.parametrize(
    "screen",
    [
        SCREEN + "❯ Ready for input",
        SCREEN.replace("☐ File APK", "Allow Bash?"),
        SCREEN.replace("☐ File APK", "☐ First  ☐ Second  Submit"),
        SCREEN.replace("Type something.", "Type something"),
        SCREEN.replace("Enter to select", "Space to select"),
        SCREEN.replace("  2. Nova", "❯ 2. Nova"),
        SCREEN.replace("  2. Nova", "  7. Nova"),
        SCREEN.replace("  6. Chat about this", "  6. Approve all"),
        "Do you want to proceed?\n❯ 1. Yes\n 2. No\nEnter to confirm",
        SCREEN[: SCREEN.index("  5.")],
    ],
)
def test_unsupported_or_ambiguous_dialogs_fail_closed(screen):
    q = parse_question(screen)
    assert q is None or q.custom_text  # service never initially offers non-empty input


@pytest.fixture
def rig(monkeypatch):
    row = {
        "id": "e5f6a0a6",
        "tmux_session": "cao-test",
        "tmux_window": "worker",
        "session_incarnation_id": "incarnation",
        "provider": "claude_code",
        "last_active": datetime(2026, 11, 24),
        "initial_delivery": '{"state":"delivered"}',
        "deferred_init_failure": None,
        "deferred_init_external_owner": None,
        "deferred_init_runtime_reclaimed": None,
        "status_checkpoint": None,
    }
    state = {
        "selected": 1,
        "text": "",
        "screen": SCREEN,
        "row": row,
        "pending": False,
        "witness": "live-pid-geometry",
    }
    backend = Mock(spec=TmuxBackend)
    backend.resolve_workspace_target.return_value = {
        "terminal": row["id"],
        "session": "cao-test",
        "pane_id": "%1",
        "socket": "/test",
    }
    backend.question_pane_witness.side_effect = lambda target: state["witness"]

    def capture(target):
        screen = state["screen"].replace("❯ 1.", "  1.")
        n = state["selected"]
        screen = screen.replace(f"  {n}.", f"❯ {n}.")
        if state["text"]:
            screen = screen.replace("Type something.", state["text"])
        return screen

    def send(target, witness, *, key=None, text=None):
        if key == "Down":
            state["selected"] += 1
        elif key == "Up":
            state["selected"] -= 1
        elif key == "Enter":
            state["screen"] = "Processing…"
        elif text is not None:
            state["text"] = text

    backend.observe_terminal_exact.side_effect = capture
    backend.send_question_input_exact.side_effect = send
    monkeypatch.setattr(service, "get_backend", lambda: backend)
    monkeypatch.setattr(service.store, "context", lambda tid: deepcopy(state["row"]))
    monkeypatch.setattr(service.store, "input_pending", lambda row: state["pending"])
    monkeypatch.setattr(service, "get_terminal_metadata", lambda tid: deepcopy(state["row"]))
    monkeypatch.setattr(service, "update_last_active", Mock())
    monitor = Mock()
    monitor.notify_input_sent.side_effect = lambda tid: state.update(pending=True)
    monkeypatch.setattr(service, "status_monitor", monitor)
    return state, backend, monitor


def test_failed_durable_fence_sends_nothing(rig):
    _, backend, monitor = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    monitor.notify_input_sent.side_effect = None
    with pytest.raises(service.QuestionConflict, match="input boundary"):
        service.answer_question("e5f6a0a6", revision, 1, None)
    backend.send_question_input_exact.assert_not_called()


def test_get_is_passive(rig):
    state, backend, monitor = rig
    response = service.get_question("e5f6a0a6")
    assert len(response["question"]["revision"]) == 64
    assert response["question"]["options"][1]["label"] == "Nova Launcher"
    backend.send_question_input_exact.assert_not_called()
    monitor.notify_input_sent.assert_not_called()


@pytest.mark.parametrize("option", [1, 2, 3, 4])
def test_answer_selects_exact_option_and_fences_duplicate(rig, option):
    state, backend, monitor = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    assert service.answer_question("e5f6a0a6", revision, option, None)["success"]
    assert state["selected"] == option
    keys = [call.kwargs.get("key") for call in backend.send_question_input_exact.call_args_list]
    assert keys == ["Down"] * (option - 1) + ["Enter"]
    monitor.notify_input_sent.assert_called_once()
    with pytest.raises(service.QuestionConflict):
        service.answer_question("e5f6a0a6", revision, option, None)
    assert backend.send_question_input_exact.call_count == option


def test_navigate_from_nonfirst_selection(rig):
    state, backend, _ = rig
    state["selected"] = 4
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    service.answer_question("e5f6a0a6", revision, 2, None)
    assert [c.kwargs["key"] for c in backend.send_question_input_exact.call_args_list] == [
        "Up",
        "Up",
        "Enter",
    ]


def test_custom_answer_is_literal_not_task_delivery(rig):
    state, backend, _ = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    service.answer_question("e5f6a0a6", revision, None, "Magisk v29.0")
    calls = backend.send_question_input_exact.call_args_list
    assert [c.kwargs.get("key") for c in calls] == ["Down"] * 4 + [None, "Enter"]
    assert calls[-2].kwargs["text"] == "Magisk v29.0"


@pytest.mark.parametrize(
    "change",
    ["question", "incarnation", "target", "witness", "input", "provider", "delivery", "selected"],
)
def test_stale_revision_never_sends(rig, change):
    state, backend, monitor = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    if change == "question":
        state["screen"] = SCREEN.replace("APK mana", "Which APK")
    if change == "incarnation":
        state["row"]["session_incarnation_id"] = "new"
    if change == "target":
        backend.resolve_workspace_target.return_value["pane_id"] = "%2"
    if change == "witness":
        state["witness"] = "dead-or-replaced"
    if change == "input":
        state["pending"] = True
    if change == "provider":
        state["row"]["provider"] = "hermes"
    if change == "delivery":
        state["row"]["initial_delivery"] = '{"state":"pending"}'
    if change == "selected":
        state["selected"] = 2
    with pytest.raises(service.QuestionConflict):
        service.answer_question("e5f6a0a6", revision, 2, None)
    backend.send_question_input_exact.assert_not_called()
    monitor.notify_input_sent.assert_not_called()


def test_changed_question_mid_navigation_never_submits(rig):
    state, backend, _ = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]

    def change(*args, **kwargs):
        state["screen"] = "❯ shell is now idle"

    backend.send_question_input_exact.side_effect = change
    with pytest.raises(service.QuestionConflict):
        service.answer_question("e5f6a0a6", revision, 2, None)
    assert backend.send_question_input_exact.call_count == 1
    assert backend.send_question_input_exact.call_args.kwargs == {"key": "Down"}
    assert state["pending"]


@pytest.mark.parametrize(
    "option,text",
    [
        (None, ""),
        (None, "line\nEnter"),
        (None, "\x1b[31m"),
        (None, "x" * 2001),
        (1, "also"),
        (None, None),
        (5, None),
    ],
)
def test_invalid_answers_send_nothing(rig, option, text):
    _, backend, _ = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    with pytest.raises(ValueError):
        service.answer_question("e5f6a0a6", revision, option, text)
    backend.send_question_input_exact.assert_not_called()
