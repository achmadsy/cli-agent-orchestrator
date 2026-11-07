"""Output recovery is exact-scoped and cannot masquerade as new execution."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.services import observation_recovery as recovery
from cli_agent_orchestrator.services.status_monitor import StatusMonitor


def test_attachment_has_no_provider_or_input_calls():
    backend = MagicMock(spec=recovery.TmuxBackend)
    target = {"pane_id": "%1", "terminal": "abcdef12"}
    backend.resolve_workspace_target.return_value = target
    fifo = MagicMock()
    fifo.has_reader.return_value = False
    with (
        patch.object(recovery, "get_backend", return_value=backend),
        patch.object(recovery, "get_terminal_metadata", return_value={"tmux_session": "cao-test"}),
        patch.object(recovery, "fifo_manager", fifo),
    ):
        capture = recovery.attach_output("abcdef12", "cao-test")
        fifo.create_reader.assert_called_once()
        backend.observe_terminal_exact.assert_called_once_with(
            target, str(recovery.FIFO_DIR / "abcdef12.fifo")
        )
        capture()
        assert backend.observe_terminal_exact.call_args.args == (target, None)
        backend.send_special_key.assert_not_called()
        backend.send_keys.assert_not_called()


def test_recovery_revalidates_registry_on_watchdog():
    backend = MagicMock(spec=recovery.TmuxBackend)
    fifo = MagicMock()
    fifo.has_reader.return_value = False
    with (
        patch.object(recovery, "get_backend", return_value=backend),
        patch.object(
            recovery, "get_terminal_metadata", side_effect=[{"tmux_session": "cao-test"}, None]
        ),
        patch.object(recovery, "fifo_manager", fifo),
    ):
        capture = recovery.attach_output("abcdef12", "cao-test")
        with pytest.raises(ValueError):
            capture()
        assert backend.observe_terminal_exact.call_count == 1


def test_failed_attachment_cleans_reader():
    backend = MagicMock(spec=recovery.TmuxBackend)
    backend.observe_terminal_exact.side_effect = ValueError("foreign pipe")
    fifo = MagicMock()
    fifo.has_reader.return_value = False
    with (
        patch.object(recovery, "get_backend", return_value=backend),
        patch.object(recovery, "get_terminal_metadata", return_value={"tmux_session": "cao-test"}),
        patch.object(recovery, "fifo_manager", fifo),
    ):
        with pytest.raises(ValueError):
            recovery.attach_output("abcdef12", "cao-test")
        fifo.stop_reader.assert_called_once_with("abcdef12")


def test_quiet_ready_snapshot_is_display_only():
    monitor = StatusMonitor()
    provider = MagicMock(supports_screen_detection=True)
    provider.get_status_from_screen.return_value = TerminalStatus.COMPLETED
    with (
        patch(
            "cli_agent_orchestrator.services.status_monitor.provider_manager.get_provider",
            return_value=provider,
        ),
        patch("cli_agent_orchestrator.services.status_monitor.bus.publish") as publish,
    ):
        monitor.observe_snapshot("t", lambda: "old ready screen")
        monitor.observe_snapshot("t", lambda: "old ready screen")
        assert monitor.monitoring_diagnostic("t")["observed_status"] == "completed"
        assert "t" not in monitor._last_status
        assert monitor.output_generation("t") == 0
        publish.assert_not_called()


def test_snapshot_crossing_output_boundary_rejected():
    monitor = StatusMonitor()
    provider = MagicMock(supports_screen_detection=True)
    provider.get_status_from_screen.return_value = TerminalStatus.IDLE

    def racing_capture():
        monitor._capture_generation["t"] = 1
        return "old prompt"

    with patch(
        "cli_agent_orchestrator.services.status_monitor.provider_manager.get_provider",
        return_value=provider,
    ):
        monitor.observe_snapshot("t", racing_capture)
    assert "t" not in monitor._snapshot_candidate


def test_raw_only_and_stale_processing_capability_do_not_bootstrap():
    monitor = StatusMonitor()
    provider = MagicMock(supports_screen_detection=False, supports_stale_processing_capture=True)
    capture = MagicMock()
    with patch(
        "cli_agent_orchestrator.services.status_monitor.provider_manager.get_provider",
        return_value=provider,
    ):
        monitor.observe_snapshot("t", capture)
    capture.assert_not_called()
    provider.get_status.assert_not_called()


@pytest.mark.asyncio
async def test_recovery_waits_for_consumers_then_bounds_each_terminal_failure():
    backend = MagicMock(spec=recovery.TmuxBackend)
    monitor = MagicMock()
    monitor.ready = SimpleNamespace(wait=AsyncMock())
    log = SimpleNamespace(ready=SimpleNamespace(wait=AsyncMock()))
    inbox = SimpleNamespace(ready=SimpleNamespace(wait=AsyncMock()))
    rows = [dict(id="bad", tmux_session="cao-test"), dict(id="good", tmux_session="cao-test")]
    capture = MagicMock()

    def attach(terminal_id, session):
        for consumer in (monitor, log, inbox):
            consumer.ready.wait.assert_awaited_once()
        if terminal_id == "bad":
            raise ValueError("missing ownership")
        return capture

    with (
        patch.object(recovery, "get_backend", return_value=backend),
        patch.object(recovery, "status_monitor", monitor),
        patch.object(recovery, "list_all_terminals", return_value=rows),
        patch.object(recovery, "attach_output", side_effect=attach) as attachment,
        patch(
            "cli_agent_orchestrator.services.terminal_service.should_retain_deferred_failure_tombstone",
            return_value=False,
        ),
        patch("cli_agent_orchestrator.services.log_writer.log_writer", log),
        patch("cli_agent_orchestrator.services.inbox_service.inbox_service", inbox),
        patch.object(recovery.asyncio, "sleep", new_callable=AsyncMock),
    ):
        await recovery.recover_observation()
    assert attachment.call_count == 4
    assert monitor.observe_snapshot.call_count == 2


@pytest.mark.asyncio
async def test_settled_worker_finishes_before_cancellation_returns():
    import threading

    entered, release, done = threading.Event(), threading.Event(), threading.Event()

    def work():
        entered.set()
        release.wait(timeout=2)
        done.set()

    task = asyncio.create_task(recovery._settled_worker(work))
    while not entered.is_set():
        await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert done.is_set()
