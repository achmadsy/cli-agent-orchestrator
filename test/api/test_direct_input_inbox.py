"""POST /terminals/{id}/input records the send in the receiver's Inbox history."""

from unittest.mock import patch

import pytest

from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.clients.database import InboxModel, create_terminal, get_inbox_messages
from cli_agent_orchestrator.models.inbox import MessageChannel, MessageStatus
from cli_agent_orchestrator.models.terminal import TerminalInputBlockedError

_DISPATCH = "cli_agent_orchestrator.services.terminal_service.dispatch_input"


@pytest.fixture
def worker(isolated_memory_db):
    create_terminal("abcd1234", "cao-s", "w-0", "kiro_cli")
    return "abcd1234"


def test_successful_send_is_recorded_delivered(client, worker):
    with patch(_DISPATCH, return_value=0):
        response = client.post(
            f"/terminals/{worker}/input", params={"message": "hello", "sender_id": "ui"}
        )

    assert response.status_code == 200
    assert response.json() == {"success": True}
    (row,) = get_inbox_messages(worker, limit=10)
    assert (row.sender_id, row.message) == ("ui", "hello")
    assert (row.status, row.channel) == (MessageStatus.DELIVERED, MessageChannel.DIRECT)


def test_sender_defaults_to_api(client, worker):
    with patch(_DISPATCH, return_value=0):
        client.post(f"/terminals/{worker}/input", params={"message": "hello"})

    (row,) = get_inbox_messages(worker, limit=10)
    assert row.sender_id == "api"


def test_blocked_send_is_recorded_failed(client, worker):
    with patch(_DISPATCH, side_effect=TerminalInputBlockedError("waiting for a user answer")):
        response = client.post(f"/terminals/{worker}/input", params={"message": "hello"})

    assert response.status_code == 409
    (row,) = get_inbox_messages(worker, limit=10)
    assert row.status == MessageStatus.FAILED


def test_unknown_terminal_records_nothing(client, isolated_memory_db):
    with patch(_DISPATCH, side_effect=ValueError("Terminal deadbeef not found")):
        response = client.post("/terminals/deadbeef/input", params={"message": "hello"})

    assert response.status_code == 404
    with database.SessionLocal() as session:
        assert session.query(InboxModel).count() == 0
