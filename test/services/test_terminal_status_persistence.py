"""Durable status survives monitor recreation but is never execution evidence."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.models.terminal import TerminalStatus as Status
from cli_agent_orchestrator.services import terminal_status_store as store
from cli_agent_orchestrator.services.status_monitor import StatusMonitor


@pytest.fixture
def terminal(isolated_memory_db):
    with database.SessionLocal() as db:
        db.add(
            database.TerminalModel(
                id="t",
                tmux_session="cao-test",
                tmux_window="worker",
                provider="claude_code",
                session_incarnation_id="incarnation-a",
                last_active=datetime.now(timezone.utc),
                initial_delivery_json='{"state":"delivered"}',
            )
        )
        db.commit()
    return "t"


def snapshot(monitor, status=Status.COMPLETED):
    provider = MagicMock(supports_screen_detection=True)
    provider.get_status_from_screen.return_value = status
    with patch(
        "cli_agent_orchestrator.services.status_monitor.provider_manager.get_provider",
        return_value=provider,
    ):
        monitor.observe_snapshot("t", lambda: "ready screen")
        monitor.observe_snapshot("t", lambda: "ready screen")


def test_live_status_persisted_and_recovered_by_a_new_monitor(terminal):
    first = StatusMonitor()
    first._apply_detection("t", Status.COMPLETED)
    record = store.read(store.context("t"))
    assert record["status"] == "completed" and record["source"] == "live_output"

    second = StatusMonitor()
    snapshot(second)
    assert second.display_status("t", Status.UNKNOWN) == Status.COMPLETED
    assert second.output_generation("t") == 0
    with patch("cli_agent_orchestrator.backends.registry.get_backend") as backend:
        backend.return_value.supports_event_inbox.return_value = False
        assert second.status_observation("t").status == Status.UNKNOWN
        assert second.status_observation("t").output_generation == 0


def test_existing_precheckpoint_session_bootstraps_from_two_guarded_snapshots(terminal):
    monitor = StatusMonitor()
    assert store.read(store.context("t")) is None
    snapshot(monitor, Status.IDLE)
    assert store.read(store.context("t"))["status"] == "idle"
    assert monitor.display_status("t", Status.UNKNOWN) == Status.IDLE
    assert "t" not in monitor._last_status


def test_input_fence_survives_restart_and_last_active_update(terminal):
    monitor = StatusMonitor()
    snapshot(monitor)
    monitor.notify_input_sent("t")
    assert store.input_pending(store.context("t"))
    assert monitor.display_status("t", Status.UNKNOWN) == Status.UNKNOWN
    with database.SessionLocal() as db:
        row = db.get(database.TerminalModel, "t")
        row.last_active += timedelta(seconds=1)
        db.commit()
    restarted = StatusMonitor()
    snapshot(restarted)
    assert restarted.display_status("t", Status.UNKNOWN) == Status.UNKNOWN
    assert store.input_pending(store.context("t"))
    restarted._apply_detection("t", Status.PROCESSING)
    assert not store.input_pending(store.context("t"))
    assert store.read(store.context("t"))["status"] == "processing"


def test_optimistic_processing_does_not_clear_input_fence(terminal):
    monitor = StatusMonitor()
    monitor.notify_input_sent("t", assume_processing=True)
    assert store.input_pending(store.context("t"))
    monitor._apply_detection("t", Status.PROCESSING)
    assert not store.input_pending(store.context("t"))


def test_projection_rejects_a_replaced_session_even_after_recovery(terminal):
    monitor = StatusMonitor()
    snapshot(monitor)
    with database.SessionLocal() as db:
        db.get(database.TerminalModel, "t").session_incarnation_id = "new-incarnation"
        db.commit()
    assert monitor.display_status("t", Status.UNKNOWN) == Status.UNKNOWN


def test_raw_only_provider_recovers_checkpoint_without_parsing_raw_snapshot(terminal):
    first = StatusMonitor()
    first._apply_detection("t", Status.COMPLETED)
    second = StatusMonitor()
    provider = MagicMock(supports_screen_detection=False)
    capture = MagicMock(return_value="live exact-owned screen")
    with patch(
        "cli_agent_orchestrator.services.status_monitor.provider_manager.get_provider",
        return_value=provider,
    ):
        second.observe_snapshot("t", capture)
    capture.assert_called_once()
    provider.get_status.assert_not_called()
    assert second.display_status("t", Status.UNKNOWN) == Status.COMPLETED
    assert second.output_generation("t") == 0


@pytest.mark.parametrize(
    "field,value",
    [
        ("session_incarnation_id", "incarnation-b"),
        ("provider", "codex"),
        ("tmux_window", "other-worker"),
        ("deferred_init_failure_json", '{"kind":"task_not_started"}'),
        ("initial_delivery_json", '{"state":"pending"}'),
    ],
)
def test_snapshot_cas_rejects_changed_session_or_delivery(terminal, field, value):
    original = store.context("t")
    with database.SessionLocal() as db:
        setattr(db.get(database.TerminalModel, "t"), field, value)
        db.commit()
    assert not store.save(original, Status.COMPLETED, "viewport")


def test_input_echo_ready_status_does_not_settle_the_new_turn(terminal):
    monitor = StatusMonitor()
    monitor._apply_detection("t", Status.COMPLETED)
    monitor.notify_input_sent("t")
    monitor._apply_detection("t", Status.IDLE)
    monitor._apply_detection("t", Status.COMPLETED)
    assert store.input_pending(store.context("t"))
    restarted = StatusMonitor()
    snapshot(restarted)
    assert restarted.display_status("t", Status.UNKNOWN) == Status.UNKNOWN
    restarted._apply_detection("t", Status.COMPLETED)
    assert store.input_pending(store.context("t"))


def test_fast_output_checkpoint_restamped_after_last_active_changes(terminal):
    monitor = StatusMonitor()
    monitor.notify_input_sent("t")
    monitor._apply_detection("t", Status.PROCESSING)
    with database.SessionLocal() as db:
        row = db.get(database.TerminalModel, "t")
        row.last_active += timedelta(seconds=1)
        db.commit()
    assert store.read(store.context("t")) is None
    monitor.checkpoint_after_input("t")
    assert store.read(store.context("t"))["status"] == "processing"


def test_newer_checkpoint_cannot_be_overwritten_by_an_old_detection(terminal):
    stale = store.context("t")
    assert store.save(stale, Status.PROCESSING, "live_output")
    assert not store.save(stale, Status.COMPLETED, "viewport")


def test_snapshot_with_inflight_new_input_cannot_publish_old_status(terminal):
    monitor = StatusMonitor()
    provider = MagicMock(supports_screen_detection=True)
    provider.get_status_from_screen.return_value = Status.COMPLETED
    with patch(
        "cli_agent_orchestrator.services.status_monitor.provider_manager.get_provider",
        return_value=provider,
    ):
        monitor.observe_snapshot("t", lambda: "old ready")

        def capture_during_input():
            monitor.notify_input_sent("t")
            return "old ready"

        monitor.observe_snapshot("t", capture_during_input)
    assert monitor.display_status("t", Status.UNKNOWN) == Status.UNKNOWN
    assert store.input_pending(store.context("t"))


def test_checkpoint_does_not_write_again_for_unchanged_processing(terminal):
    monitor = StatusMonitor()
    with patch.object(store, "save", wraps=store.save) as save:
        monitor._apply_detection("t", Status.PROCESSING)
        for _ in range(5):
            monitor._apply_detection("t", Status.PROCESSING)
        assert save.call_count == 1


def test_reported_status_uses_checkpoint_but_pending_delivery_stays_unknown(terminal):
    from cli_agent_orchestrator.services import terminal_service as service

    monitor = StatusMonitor()
    snapshot(monitor)
    with patch.object(service, "status_monitor", monitor):
        assert service.reported_status("t", Status.UNKNOWN) == Status.COMPLETED
        with patch.object(service, "initial_delivery_pending", return_value=True):
            assert service.reported_status("t", Status.UNKNOWN) == Status.UNKNOWN


def test_additive_migration_is_idempotent_on_legacy_database(tmp_path, monkeypatch):
    import sqlite3
    from cli_agent_orchestrator import constants

    path = tmp_path / "legacy.sqlite3"
    # Existing metadata columns are present; only the new checkpoint is absent.
    columns = [
        column
        for column in database.TerminalModel.__table__.columns
        if column.name != "status_checkpoint"
    ]
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE terminals ("
            + ",".join('"' + column.name + '" TEXT' for column in columns)
            + ")"
        )
    monkeypatch.setattr(constants, "DATABASE_FILE", path)
    database._migrate_terminals_schema()
    database._migrate_terminals_schema()
    with sqlite3.connect(path) as conn:
        names = [row[1] for row in conn.execute("PRAGMA table_info(terminals)")]
    assert names.count("status_checkpoint") == 1


def test_checkpoint_survives_a_real_process_exit(terminal, isolated_memory_db):
    import subprocess
    import sys
    from pathlib import Path

    setup = """
import sys
from unittest.mock import MagicMock, patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.models.terminal import TerminalStatus as Status
from cli_agent_orchestrator.services.status_monitor import StatusMonitor
engine = create_engine(sys.argv[1])
database.SessionLocal = sessionmaker(bind=engine)
monitor = StatusMonitor()
"""
    cwd = Path(__file__).resolve().parents[2]
    env_code = f"import sys; sys.path.insert(0, {str(cwd / 'src')!r})\n" + setup
    subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            env_code + 'monitor._apply_detection("t", Status.COMPLETED)',
            str(isolated_memory_db.url),
        ],
        check=True,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
    )
    read_code = """
provider = MagicMock(supports_screen_detection=False)
with patch('cli_agent_orchestrator.services.status_monitor.provider_manager.get_provider', return_value=provider):
    monitor.observe_snapshot('t', lambda: 'exact-owned live pane')
assert monitor.display_status('t', Status.UNKNOWN) == Status.COMPLETED
assert monitor.output_generation('t') == 0
assert 't' not in monitor._last_status
print('recovered completed from SQLite after process exit; no execution evidence')
"""
    result = subprocess.run(
        [sys.executable, "-I", "-c", env_code + read_code, str(isolated_memory_db.url)],
        check=True,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert "recovered completed from SQLite" in result.stdout


def test_failed_initial_delivery_cannot_be_recovered_as_success(terminal):
    with database.SessionLocal() as db:
        db.get(database.TerminalModel, "t").initial_delivery_json = '{"state":"failed"}'
        db.commit()
    monitor = StatusMonitor()
    snapshot(monitor)
    assert monitor.display_status("t", Status.UNKNOWN) == Status.UNKNOWN
    assert store.read(store.context("t")) is None
