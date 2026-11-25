"""Native question parser and no-live-input answer safety regressions."""

from copy import deepcopy
from datetime import datetime
from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.backends.tmux_backend import TmuxBackend
from cli_agent_orchestrator.models.inbox import MessageChannel, MessageStatus
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
    state["record_history"] = service.terminal_service.record_direct_input
    state["history"] = Mock(return_value=42)
    monkeypatch.setattr(service.terminal_service, "record_direct_input", state["history"])
    return state, backend, monitor


def test_failed_durable_fence_sends_nothing(rig):
    state, backend, monitor = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    monitor.notify_input_sent.side_effect = None
    with pytest.raises(service.QuestionConflict, match="input boundary"):
        service.answer_question("e5f6a0a6", revision, 1, None)
    backend.send_question_input_exact.assert_not_called()
    state["history"].assert_not_called()


def test_get_is_passive(rig):
    state, backend, monitor = rig
    response = service.get_question("e5f6a0a6")
    assert len(response["question"]["revision"]) == 64
    assert response["question"]["options"][1]["label"] == "Nova Launcher"
    backend.send_question_input_exact.assert_not_called()
    monitor.notify_input_sent.assert_not_called()
    state["history"].assert_not_called()


def test_real_claude_probe_and_monitor_expose_question_on_completed_worker(rig, monkeypatch):
    from cli_agent_orchestrator.models.terminal import TerminalStatus
    from cli_agent_orchestrator.providers.claude_code import ClaudeCodeProvider
    from cli_agent_orchestrator.services.status_monitor import StatusMonitor
    from cli_agent_orchestrator.services import status_monitor as monitor_module

    state, backend, _ = rig
    backend.supports_event_inbox.return_value = False
    monkeypatch.setattr("cli_agent_orchestrator.backends.registry.get_backend", lambda: backend)
    provider = ClaudeCodeProvider("e5f6a0a6", "cao-test", "worker")
    monkeypatch.setattr(monitor_module.provider_manager, "get_provider", lambda tid: provider)
    monitor = StatusMonitor()
    monitor._last_status["e5f6a0a6"] = TerminalStatus.COMPLETED
    monitor._checkpoint = Mock()
    monkeypatch.setattr(service, "status_monitor", monitor)
    assert monitor.get_status("e5f6a0a6") == TerminalStatus.WAITING_USER_ANSWER
    assert service.get_question("e5f6a0a6")["question"]["header"] == "File APK"
    assert monitor.status_observation("e5f6a0a6").output_generation is None
    backend.send_question_input_exact.assert_not_called()
    state["history"].assert_not_called()
    monitor._checkpoint.assert_not_called()


def test_completed_worker_api_reports_waiting_and_question_without_input(
    rig, isolated_memory_db, monkeypatch
):
    from fastapi.testclient import TestClient

    from cli_agent_orchestrator.api.main import app
    from cli_agent_orchestrator.clients import database
    from cli_agent_orchestrator.models.terminal import TerminalStatus
    from cli_agent_orchestrator.providers.claude_code import ClaudeCodeProvider
    from cli_agent_orchestrator.services import status_monitor as monitor_module
    from cli_agent_orchestrator.services.status_monitor import StatusMonitor

    state, backend, _ = rig
    database.create_terminal("e5f6a0a6", "cao-test", "worker", "claude_code")
    backend.supports_event_inbox.return_value = False
    monkeypatch.setattr("cli_agent_orchestrator.backends.registry.get_backend", lambda: backend)
    provider = ClaudeCodeProvider("e5f6a0a6", "cao-test", "worker")
    monkeypatch.setattr(monitor_module.provider_manager, "get_provider", lambda tid: provider)
    monitor = StatusMonitor()
    monitor._last_status["e5f6a0a6"] = TerminalStatus.COMPLETED
    monitor._checkpoint = Mock()
    monkeypatch.setattr(service, "status_monitor", monitor)
    monkeypatch.setattr(service.terminal_service, "status_monitor", monitor)
    client = TestClient(app, base_url="http://localhost")
    terminal = client.get("/terminals/e5f6a0a6")
    assert terminal.status_code == 200
    assert terminal.json()["status"] == "waiting_user_answer"
    question = client.get("/terminals/e5f6a0a6/question")
    assert question.status_code == 200
    assert question.json()["question"]["header"] == "File APK"
    assert monitor._last_status["e5f6a0a6"] == TerminalStatus.COMPLETED
    monitor._checkpoint.assert_not_called()
    backend.send_question_input_exact.assert_not_called()
    assert database.get_inbox_messages("e5f6a0a6") == []


@pytest.mark.parametrize("blocked", ["fenced", "shell", "provider", "identity", "populated"])
def test_active_question_probe_requires_live_owned_unedited_question(rig, blocked):
    state, backend, monitor = rig
    if blocked == "fenced":
        state["pending"] = True
    elif blocked == "shell":
        backend.question_pane_witness.side_effect = ValueError("no live native CLI")
    elif blocked == "provider":
        state["row"]["provider"] = "codex"
    elif blocked == "identity":
        backend.question_pane_witness.side_effect = ["old", "new"]
    else:
        state["selected"] = 5
        state["text"] = "draft from another client"
    assert service.has_active_question("e5f6a0a6") is False
    backend.send_question_input_exact.assert_not_called()
    monitor.notify_input_sent.assert_not_called()
    state["history"].assert_not_called()


@pytest.mark.parametrize("screen,expected", [(SCREEN, True), ("Ready for input", False)])
def test_probe_distinguishes_verified_absence_from_unavailable(rig, screen, expected):
    state, backend, monitor = rig
    state["screen"] = screen
    assert service.probe_active_question("e5f6a0a6") is expected
    backend.send_question_input_exact.assert_not_called()
    monitor.notify_input_sent.assert_not_called()


@pytest.mark.parametrize("blocked", ["shell", "identity", "fenced", "provider"])
def test_unverified_probe_cannot_refresh_display_grace(rig, blocked):
    state, backend, monitor = rig
    if blocked == "shell":
        backend.question_pane_witness.side_effect = ValueError("no live Claude process")
    elif blocked == "identity":
        backend.question_pane_witness.side_effect = ["old", "new"]
        state["screen"] = "Ready for input"  # Negative reads need the same ownership fence.
    elif blocked == "fenced":
        state["pending"] = True
    else:
        state["row"]["provider"] = "codex"
    assert service.probe_active_question("e5f6a0a6") is None
    backend.send_question_input_exact.assert_not_called()
    monitor.notify_input_sent.assert_not_called()


@pytest.mark.parametrize("option", [1, 2, 3, 4])
def test_answer_selects_exact_option_and_fences_duplicate(rig, option):
    state, backend, monitor = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    response = service.answer_question("e5f6a0a6", revision, option, None)
    assert response["success"] and response["inbox_recorded"]
    question = parse_question(SCREEN)
    selected = question.options[option - 1]
    state["history"].assert_called_once_with(
        "e5f6a0a6",
        "ui",
        f"Question: {question.question}\n\nAnswer: {option}. {selected.label}\n{selected.description}",
        MessageStatus.DELIVERED,
    )
    assert state["selected"] == option
    keys = [call.kwargs.get("key") for call in backend.send_question_input_exact.call_args_list]
    assert keys == ["Down"] * (option - 1) + ["Enter"]
    monitor.notify_input_sent.assert_called_once()
    with pytest.raises(service.QuestionConflict):
        service.answer_question("e5f6a0a6", revision, option, None)
    assert backend.send_question_input_exact.call_count == option
    state["history"].assert_called_once()


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
    state["history"].assert_called_once_with(
        "e5f6a0a6",
        "ui",
        f"Question: {parse_question(SCREEN).question}\n\nAnswer: Magisk v29.0",
        MessageStatus.DELIVERED,
    )


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
    state["history"].assert_not_called()


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
    assert state["history"].call_args.args[-1] == MessageStatus.FAILED
    state["history"].assert_called_once()


def test_uncertain_enter_is_recorded_failed_without_retry(rig):
    state, backend, _ = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    backend.send_question_input_exact.side_effect = TimeoutError("unknown delivery")
    with pytest.raises(TimeoutError):
        service.answer_question("e5f6a0a6", revision, 1, None)
    backend.send_question_input_exact.assert_called_once()
    state["history"].assert_called_once()
    assert state["history"].call_args.args[-1] == MessageStatus.FAILED


@pytest.mark.parametrize(
    "answer", [{"option": 2, "text": None}, {"option": None, "text": "Magisk v29.0"}]
)
def test_answer_is_visible_in_real_inbox_without_being_queued(
    rig, isolated_memory_db, monkeypatch, answer
):
    from cli_agent_orchestrator.clients import database

    state, _, _ = rig
    database.create_terminal("e5f6a0a6", "cao-test", "worker", "claude_code")
    monkeypatch.setattr(service.terminal_service, "record_direct_input", state["record_history"])
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    result = service.answer_question("e5f6a0a6", revision, **answer)
    assert result["inbox_recorded"]
    (message,) = database.get_inbox_messages("e5f6a0a6", latest=True, include_sent=True)
    assert message.sender_id == "ui" and message.receiver_id == "e5f6a0a6"
    assert message.channel == MessageChannel.DIRECT and message.status == MessageStatus.DELIVERED
    assert message.message.startswith(f"Question: {parse_question(SCREEN).question}\n\nAnswer: ")
    assert (answer["text"] or "2. Nova Launcher\nNovaLauncher_8.0.18.apk") in message.message
    assert database.get_pending_messages("e5f6a0a6", limit=10) == []
    with pytest.raises(service.QuestionConflict):
        service.answer_question("e5f6a0a6", revision, **answer)
    assert len(database.get_inbox_messages("e5f6a0a6")) == 1


def test_uncertain_answer_is_failed_in_real_inbox_without_being_queued(
    rig, isolated_memory_db, monkeypatch
):
    from cli_agent_orchestrator.clients import database

    state, backend, _ = rig
    database.create_terminal("e5f6a0a6", "cao-test", "worker", "claude_code")
    monkeypatch.setattr(service.terminal_service, "record_direct_input", state["record_history"])
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    backend.send_question_input_exact.side_effect = TimeoutError("unknown delivery")
    with pytest.raises(TimeoutError):
        service.answer_question("e5f6a0a6", revision, 1, None)
    (message,) = database.get_inbox_messages("e5f6a0a6")
    assert message.channel == MessageChannel.DIRECT and message.status == MessageStatus.FAILED
    assert database.get_pending_messages("e5f6a0a6", limit=10) == []
    with pytest.raises(service.QuestionConflict):
        service.answer_question("e5f6a0a6", revision, 1, None)
    backend.send_question_input_exact.assert_called_once()
    assert len(database.get_inbox_messages("e5f6a0a6")) == 1


def test_history_failure_does_not_turn_delivered_answer_into_retry(rig):
    state, backend, _ = rig
    state["history"].return_value = None
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    result = service.answer_question("e5f6a0a6", revision, 1, None)
    assert result == {
        "success": True,
        "message": "Answer sent to the terminal.",
        "inbox_recorded": False,
    }
    backend.send_question_input_exact.assert_called_once()
    state["history"].assert_called_once()


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
    state, backend, _ = rig
    revision = service.get_question("e5f6a0a6")["question"]["revision"]
    with pytest.raises(ValueError):
        service.answer_question("e5f6a0a6", revision, option, text)
    backend.send_question_input_exact.assert_not_called()
    state["history"].assert_not_called()
