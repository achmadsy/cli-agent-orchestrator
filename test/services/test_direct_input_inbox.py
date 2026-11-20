"""Direct input sent through CAO is recorded in the receiver's Inbox history.

Covers the ``channel`` column (queued vs direct), ``record_direct_message``, the
``latest``/``include_sent`` read options, the migration, ``send_input``'s
``inbox_log_sender`` option, and the deferred-init initial message.
"""

import asyncio
import logging
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.clients.database import (
    InboxModel,
    create_inbox_message,
    create_terminal,
    get_inbox_messages,
    get_pending_messages,
    list_pending_receiver_ids_by_provider,
    list_pending_receiver_ids_older_than,
    record_direct_message,
)
from cli_agent_orchestrator.models.inbox import MessageChannel, MessageStatus, OrchestrationType
from cli_agent_orchestrator.models.terminal import TerminalInputBlockedError, TerminalStatus
from cli_agent_orchestrator.services import terminal_service

_TS = "cli_agent_orchestrator.services.terminal_service"


def _rows(receiver_id):
    return get_inbox_messages(receiver_id, limit=100)


@pytest.fixture
def db(isolated_memory_db):
    create_terminal("worker99", "cao-s", "w-0", "kiro_cli")
    create_terminal("sup12345", "cao-s", "w-1", "kiro_cli")
    return isolated_memory_db


class TestRecordDirectMessage:
    def test_writes_a_direct_row_with_final_status(self, db):
        row_id = record_direct_message("ui", "worker99", "hello", MessageStatus.DELIVERED)

        (row,) = _rows("worker99")
        assert row.id == row_id
        assert (row.sender_id, row.message) == ("ui", "hello")
        assert row.status == MessageStatus.DELIVERED
        assert row.channel == MessageChannel.DIRECT

    def test_unknown_receiver_records_nothing(self, db):
        assert record_direct_message("ui", "gone0000", "hello", MessageStatus.DELIVERED) is None

    def test_pending_status_is_rejected(self, db):
        with pytest.raises(ValueError):
            record_direct_message("ui", "worker99", "hello", MessageStatus.PENDING)

    def test_queued_messages_keep_the_queued_channel(self, db):
        create_inbox_message("sup12345", "worker99", "queued")

        (row,) = _rows("worker99")
        assert row.channel == MessageChannel.QUEUED


class TestPendingQueriesIgnoreDirectRows:
    def test_a_direct_row_is_never_pending_work(self, db):
        # record_direct_message never writes pending; insert one by hand to
        # prove the channel filter alone keeps it out of every delivery query.
        with database.SessionLocal() as session:
            session.add(
                InboxModel(
                    sender_id="ui",
                    receiver_id="worker99",
                    message="typed",
                    status=MessageStatus.PENDING.value,
                    channel=MessageChannel.DIRECT.value,
                )
            )
            session.commit()

        assert get_pending_messages("worker99", limit=10) == []
        assert list_pending_receiver_ids_by_provider("kiro_cli") == []
        # A negative age puts the cutoff in the future, so age never excludes a row.
        assert list_pending_receiver_ids_older_than(-60) == []

        queued = create_inbox_message("sup12345", "worker99", "queued")
        assert [m.id for m in get_pending_messages("worker99", limit=10)] == [queued.id]
        assert list_pending_receiver_ids_by_provider("kiro_cli") == ["worker99"]
        assert list_pending_receiver_ids_older_than(-60) == ["worker99"]


class TestGetInboxMessagesOptions:
    def test_latest_returns_the_newest_rows_oldest_first(self, db):
        ids = [create_inbox_message("sup12345", "worker99", f"m{i}").id for i in range(3)]

        assert [m.id for m in get_inbox_messages("worker99", limit=2)] == ids[:2]
        assert [m.id for m in get_inbox_messages("worker99", limit=2, latest=True)] == ids[1:]

    def test_include_sent_adds_rows_this_terminal_sent(self, db):
        incoming = record_direct_message("ui", "worker99", "hi", MessageStatus.DELIVERED)
        outgoing = create_inbox_message("worker99", "sup12345", "done")

        assert [m.id for m in get_inbox_messages("worker99")] == [incoming]
        assert {m.id for m in get_inbox_messages("worker99", include_sent=True)} == {
            incoming,
            outgoing.id,
        }


class TestMigration:
    def test_adds_channel_to_a_legacy_inbox_table(self, tmp_path, monkeypatch):
        db_file = tmp_path / "legacy.db"
        conn = sqlite3.connect(str(db_file))
        try:
            conn.execute(
                "CREATE TABLE inbox (id INTEGER PRIMARY KEY, sender_id TEXT NOT NULL, "
                "receiver_id TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, "
                "created_at DATETIME)"
            )
            conn.execute(
                "INSERT INTO inbox (sender_id, receiver_id, message, status) "
                "VALUES ('a', 'b', 'old', 'delivered')"
            )
            conn.commit()
        finally:
            conn.close()
        monkeypatch.setattr(
            "cli_agent_orchestrator.constants.DATABASE_FILE", db_file, raising=False
        )

        database._migrate_inbox_channel()
        database._migrate_inbox_channel()  # idempotent

        conn = sqlite3.connect(str(db_file))
        try:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(inbox)")]
            rows = conn.execute("SELECT message, channel FROM inbox").fetchall()
        finally:
            conn.close()
        assert columns.count("channel") == 1
        assert rows == [("old", "queued")], "existing rows are queued messages"


class TestSendInputRecording:
    def test_success_is_recorded_delivered(self, db):
        with patch(f"{_TS}.dispatch_input", return_value=0) as m_dispatch:
            assert terminal_service.send_input("worker99", "hello", inbox_log_sender="ui") is True

        m_dispatch.assert_called_once()
        (row,) = _rows("worker99")
        assert (row.sender_id, row.message) == ("ui", "hello")
        assert (row.status, row.channel) == (MessageStatus.DELIVERED, MessageChannel.DIRECT)

    def test_failure_is_recorded_failed_and_reraised(self, db):
        with patch(f"{_TS}.dispatch_input", side_effect=TerminalInputBlockedError("waiting")):
            with pytest.raises(TerminalInputBlockedError):
                terminal_service.send_input("worker99", "hello", inbox_log_sender="ui")

        (row,) = _rows("worker99")
        assert row.status == MessageStatus.FAILED

    def test_no_sender_records_nothing(self, db):
        with patch(f"{_TS}.dispatch_input", return_value=0):
            terminal_service.send_input("worker99", "hello")

        assert _rows("worker99") == []

    def test_recording_failure_does_not_fail_the_send(self, db, caplog):
        with (
            patch(f"{_TS}.dispatch_input", return_value=0),
            patch(f"{_TS}.record_direct_message", side_effect=RuntimeError("db locked")),
            caplog.at_level(logging.WARNING, logger=terminal_service.logger.name),
        ):
            assert terminal_service.send_input("worker99", "tok-abc123", inbox_log_sender="ui")

        assert "worker99" in caplog.text
        assert "RuntimeError" in caplog.text
        assert "tok-abc123" not in caplog.text, "message text must never reach the log"

    def test_recording_failure_does_not_mask_the_send_error(self, db):
        with (
            patch(f"{_TS}.dispatch_input", side_effect=TerminalInputBlockedError("waiting")),
            patch(f"{_TS}.record_direct_message", side_effect=RuntimeError("db locked")),
        ):
            with pytest.raises(TerminalInputBlockedError):
                terminal_service.send_input("worker99", "hello", inbox_log_sender="ui")


def _provider():
    provider = AsyncMock()
    provider.initialize.return_value = True
    provider.shell_baseline = None
    provider.runtime_variant = None
    provider.requires_execution_evidence = False
    return provider


async def _run_deferred(provider, message="do the task"):
    before = set(terminal_service._deferred_init_tasks)
    terminal_service._schedule_deferred_init(
        provider,
        "worker99",
        message,
        OrchestrationType.ASSIGN,
        None,
        initial_caller_id="sup12345",
        delete_on_failure=False,
    )
    (task,) = set(terminal_service._deferred_init_tasks) - before
    await task


@pytest.fixture
def deferred(db):
    with (
        patch(f"{_TS}.get_terminal_metadata", return_value={"caller_id": "sup12345"}),
        patch(f"{_TS}._persist_initial_delivery", return_value=True),
        patch(f"{_TS}._clear_deferred_init_external_owner", new=AsyncMock()),
        patch(f"{_TS}._notify_caller_of_deferred_failure"),
        patch(f"{_TS}._surface_deferred_init_failure", new=AsyncMock()) as m_surface,
        patch(f"{_TS}.dispatch_input", return_value=0) as m_dispatch,
        patch(
            f"{_TS}._confirm_worker_started_or_resubmit", new=AsyncMock(return_value=True)
        ) as m_confirm,
    ):
        yield SimpleNamespace(dispatch=m_dispatch, confirm=m_confirm, surface=m_surface)


class TestDeferredInitRecording:

    @pytest.mark.asyncio
    async def test_attachments_join_the_first_message_and_retry_payload(self, deferred):
        from unittest.mock import MagicMock

        provider = _provider()
        order = []
        provider.initialize.side_effect = lambda: order.append("initialize")
        batch = MagicMock()
        batch.prepare.side_effect = lambda terminal: order.append("prepare") or [
            "/private/generated.data.pdf"
        ]
        batch.retain.side_effect = lambda: order.append("retain")
        deferred.dispatch.side_effect = lambda *args, **kwargs: order.append("dispatch") or 0
        task = terminal_service._schedule_deferred_init(
            provider,
            "worker99",
            "inspect report",
            None,
            None,
            initial_attachments=batch,
            delete_on_failure=False,
        )
        await task
        assert order == ["initialize", "prepare", "retain", "dispatch"]
        message = deferred.dispatch.call_args.args[1]
        assert message.startswith("inspect report") and "/private/generated.data.pdf" in message
        assert deferred.confirm.call_args.args[1] == message
        assert _rows("worker99")[0].message == message
        batch.discard.assert_called_once()

    @pytest.mark.asyncio
    async def test_attachment_prepare_failure_never_dispatches(self, deferred):
        from unittest.mock import MagicMock

        batch = MagicMock()
        batch.prepare.side_effect = ValueError("Attachment unavailable")
        task = terminal_service._schedule_deferred_init(
            _provider(),
            "worker99",
            "inspect",
            None,
            None,
            initial_attachments=batch,
            delete_on_failure=False,
        )
        await task
        deferred.dispatch.assert_not_called()
        batch.discard.assert_called_once()
        deferred.surface.assert_awaited_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("before_start", [True, False])
    async def test_attachment_cancellation_cleans_pending_batch(self, deferred, before_start):
        from unittest.mock import MagicMock

        provider = _provider()
        entered = asyncio.Event()

        async def initialize():
            entered.set()
            await asyncio.Event().wait()

        provider.initialize.side_effect = initialize
        batch = MagicMock()
        task = terminal_service._schedule_deferred_init(
            provider,
            "worker99",
            "inspect",
            None,
            None,
            initial_attachments=batch,
            delete_on_failure=False,
        )
        if not before_start:
            await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)  # done callback also owns never-started cleanup
        batch.discard.assert_called_once()
        batch.retain.assert_not_called()
        deferred.dispatch.assert_not_called()

    @pytest.mark.asyncio
    async def test_attachment_init_failure_cleans_pending_batch(self, deferred):
        from unittest.mock import MagicMock

        provider = _provider()
        provider.initialize.side_effect = RuntimeError("init failed")
        batch = MagicMock()
        task = terminal_service._schedule_deferred_init(
            provider,
            "worker99",
            "inspect",
            None,
            None,
            initial_attachments=batch,
            delete_on_failure=False,
        )
        await task
        batch.discard.assert_called_once()
        batch.retain.assert_not_called()
        deferred.dispatch.assert_not_called()

    @pytest.mark.asyncio
    async def test_initial_message_is_recorded_once_despite_a_resubmit(self, deferred):
        async def _resubmit_then_start(*_args, **_kwargs):
            terminal_service.dispatch_input("worker99", "do the task")
            return True

        deferred.confirm.side_effect = _resubmit_then_start

        await _run_deferred(_provider())

        assert deferred.dispatch.call_count == 2
        (row,) = _rows("worker99")
        assert (row.sender_id, row.message) == ("sup12345", "do the task")
        assert (row.status, row.channel) == (MessageStatus.DELIVERED, MessageChannel.DIRECT)

    @pytest.mark.asyncio
    async def test_task_not_started_flips_the_row_to_failed(self, deferred):
        deferred.confirm.return_value = False

        await _run_deferred(_provider())

        assert deferred.surface.call_args.kwargs["kind"] == "task_not_started"
        (row,) = _rows("worker99")
        assert row.status == MessageStatus.FAILED

    @pytest.mark.asyncio
    async def test_provider_error_after_delivery_flips_the_row_to_failed(self, deferred):
        provider = _provider()
        provider.requires_execution_evidence = True

        with patch(f"{_TS}.status_monitor.get_status", return_value=TerminalStatus.ERROR):
            await _run_deferred(provider)

        assert deferred.surface.call_args.kwargs["kind"] == "provider_error_after_delivery"
        (row,) = _rows("worker99")
        assert row.status == MessageStatus.FAILED

    @pytest.mark.asyncio
    async def test_blocked_prompt_records_one_failed_row(self, deferred):
        deferred.dispatch.side_effect = TerminalInputBlockedError("waiting")

        await _run_deferred(_provider())

        (row,) = _rows("worker99")
        assert (row.sender_id, row.status) == ("sup12345", MessageStatus.FAILED)

    @pytest.mark.asyncio
    async def test_init_error_records_one_failed_row(self, deferred):
        provider = _provider()
        provider.initialize.side_effect = RuntimeError("provider startup failed")

        await _run_deferred(provider)

        deferred.dispatch.assert_not_called()
        (row,) = _rows("worker99")
        assert (row.sender_id, row.message) == ("sup12345", "do the task")
        assert row.status == MessageStatus.FAILED
