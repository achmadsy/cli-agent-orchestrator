"""Exact input commands never resolve names or interpret text as key names."""

from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.clients.tmux import TmuxClient


@pytest.fixture
def client(monkeypatch):
    client = object.__new__(TmuxClient)
    monkeypatch.setattr(client, "question_pane_witness", Mock(return_value="witness"))
    run = Mock()
    monkeypatch.setattr("cli_agent_orchestrator.clients.tmux.subprocess.run", run)
    return client, run


TARGET = {
    "socket": "/private/socket",
    "pane_id": "%23",
    "terminal": "abcd1234",
    "session": "cao-fixture",
}


def test_exact_key(client):
    tmux, run = client
    tmux.send_question_input_exact(TARGET, "witness", key="Enter")
    assert run.call_args.args[0] == [
        "tmux",
        "-S",
        "/private/socket",
        "send-keys",
        "-t",
        "%23",
        "Enter",
    ]


def test_literal_bracketed_paste(client):
    tmux, run = client
    tmux.send_question_input_exact(TARGET, "witness", text="3; Enter is literal")
    assert run.call_args.args[0][-3:] == ["-l", "--", "\x1b[200~3; Enter is literal\x1b[201~"]


@pytest.mark.parametrize(
    "kwargs", [{}, {"key": "Escape"}, {"key": "C-c"}, {"key": "Enter", "text": "yes"}]
)
def test_invalid_key_sends_nothing(client, kwargs):
    tmux, run = client
    with pytest.raises(ValueError):
        tmux.send_question_input_exact(TARGET, "witness", **kwargs)
    run.assert_not_called()


def test_changed_process_sends_nothing(client):
    tmux, run = client
    tmux.question_pane_witness.return_value = "different"
    with pytest.raises(ValueError):
        tmux.send_question_input_exact(TARGET, "witness", key="Enter")
    run.assert_not_called()
