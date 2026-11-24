"""Question endpoint contracts; native input is always mocked."""

from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.api.main import app
from cli_agent_orchestrator.security.auth import get_current_scopes
from cli_agent_orchestrator.services import user_question
from cli_agent_orchestrator.providers.claude_question import ClaudeQuestion, QuestionOption

URL = "/terminals/abcd1234/question"
BODY = {"revision": "a" * 64, "option": 2}


def test_read_is_passive(client, monkeypatch):
    read = Mock(return_value={"question": None, "fallback": "Open Terminal"})
    answer = Mock()
    monkeypatch.setattr(user_question, "get_question", read)
    monkeypatch.setattr(user_question, "answer_question", answer)
    response = client.get(URL)
    assert response.status_code == 200
    assert response.json()["question"] is None
    read.assert_called_once_with("abcd1234")
    answer.assert_not_called()


def test_answer_contract(client, monkeypatch):
    answer = Mock(return_value={"success": True, "message": "Answer sent."})
    monkeypatch.setattr(user_question, "answer_question", answer)
    assert client.post(URL + "/answer", json=BODY).status_code == 200
    answer.assert_called_once_with("abcd1234", "a" * 64, 2, None)


@pytest.mark.parametrize(
    "failure,status",
    [
        (LookupError("missing"), 404),
        (user_question.QuestionConflict("Question changed"), 409),
        (ValueError("Invalid answer"), 422),
        (RuntimeError("private socket details"), 409),
    ],
)
def test_answer_errors(client, monkeypatch, failure, status):
    monkeypatch.setattr(user_question, "answer_question", Mock(side_effect=failure))
    response = client.post(URL + "/answer", json=BODY)
    assert response.status_code == status
    assert "private socket details" not in response.text


@pytest.mark.parametrize(
    "body",
    [
        {"option": 1},
        {"revision": "not-a-token", "option": 1},
        {"revision": "a" * 64, "option": True},
        {"revision": "a" * 64, "option": 5},
        {"revision": "a" * 64, "text": "x" * 2001},
    ],
)
def test_request_validation_before_delivery(client, monkeypatch, body):
    answer = Mock()
    monkeypatch.setattr(user_question, "answer_question", answer)
    assert client.post(URL + "/answer", json=body).status_code == 422
    answer.assert_not_called()


@pytest.mark.parametrize("answer", [{"option": 1}, {"text": "Custom fixture answer"}])
def test_answer_post_appears_in_inbox_get(client, isolated_memory_db, monkeypatch, answer):
    from cli_agent_orchestrator.clients import database

    database.create_terminal("abcd1234", "cao-fixture", "worker", "claude_code")
    question = ClaudeQuestion(
        "Package", "Which package?", (QuestionOption(1, "Fixture APK", "fixture.apk"),), 2, 1, ""
    )
    backend = Mock()
    row = {"id": "abcd1234", "last_active": "2026-11-24T00:00:00Z"}
    captured = (backend, row, {"pane_id": "%99"}, "fixture-witness", question, BODY["revision"])
    pending = {"value": False}
    monkeypatch.setattr(
        user_question, "_capture", lambda terminal_id: None if pending["value"] else captured
    )
    monkeypatch.setattr(user_question.store, "context", lambda terminal_id: row)
    monkeypatch.setattr(
        user_question.store, "identity", lambda context: ("abcd1234", "fixture-incarnation")
    )
    monkeypatch.setattr(user_question.store, "recoverable", lambda context: True)
    monkeypatch.setattr(user_question.store, "input_pending", lambda context: pending["value"])
    monkeypatch.setattr(user_question, "update_last_active", Mock())
    backend.question_pane_witness.return_value = "fixture-witness"
    monitor = Mock()
    monitor.notify_input_sent.side_effect = lambda terminal_id: pending.update(value=True)
    monkeypatch.setattr(user_question, "status_monitor", monitor)
    screen_state = {"selected": 1, "text": ""}
    monkeypatch.setattr(
        user_question,
        "parse_question",
        lambda screen: ClaudeQuestion(
            question.header,
            question.question,
            question.options,
            2,
            screen_state["selected"],
            screen_state["text"],
        ),
    )

    def send(target, witness, *, key=None, text=None):
        if key == "Down":
            screen_state["selected"] += 1
        if text is not None:
            screen_state["text"] = text

    backend.send_question_input_exact.side_effect = send

    response = client.post(URL + "/answer", json={"revision": BODY["revision"], **answer})
    assert response.status_code == 200 and response.json()["inbox_recorded"]
    inbox_url = (
        "/terminals/abcd1234/inbox/messages?latest=true&include_sent=true&include_history=true"
    )
    rows = client.get(inbox_url).json()
    assert len(rows) == 1
    assert rows[0]["sender_id"] == "ui" and rows[0]["receiver_id"] == "abcd1234"
    assert rows[0]["channel"] == "direct" and rows[0]["status"] == "delivered"
    expected = answer.get("text") or "1. Fixture APK\nfixture.apk"
    assert rows[0]["message"] == f"Question: Which package?\n\nAnswer: {expected}"
    assert database.get_pending_messages("abcd1234", limit=10) == []
    calls = backend.send_question_input_exact.call_count
    assert (
        client.post(URL + "/answer", json={"revision": BODY["revision"], **answer}).status_code
        == 409
    )
    assert backend.send_question_input_exact.call_count == calls
    assert len(client.get(inbox_url).json()) == 1


def test_read_scope_cannot_answer(client, monkeypatch):
    answer = Mock()
    monkeypatch.setattr(user_question, "answer_question", answer)
    monkeypatch.setattr(user_question, "get_question", Mock(return_value={"question": None}))
    monkeypatch.setattr("cli_agent_orchestrator.security.auth.is_auth_enabled", lambda: True)
    app.dependency_overrides[get_current_scopes] = lambda: ["cao:read"]
    try:
        assert client.get(URL).status_code == 200
        assert client.post(URL + "/answer", json=BODY).status_code == 403
        answer.assert_not_called()
    finally:
        app.dependency_overrides.pop(get_current_scopes, None)
