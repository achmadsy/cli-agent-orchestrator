"""Question endpoint contracts; native input is always mocked."""

from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.api.main import app
from cli_agent_orchestrator.security.auth import get_current_scopes
from cli_agent_orchestrator.services import user_question

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
