"""A passive native question vetoes stale readiness, never proves task execution."""

from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.models.terminal import TerminalStatus
from cli_agent_orchestrator.services import status_monitor as module


@pytest.fixture
def rig(monkeypatch):
    backend = Mock()
    backend.supports_event_inbox.return_value = False
    monkeypatch.setattr("cli_agent_orchestrator.backends.registry.get_backend", lambda: backend)
    provider = Mock()
    provider.supports_native_question_probe = True
    provider.has_pending_native_swarm = False
    provider.has_active_native_question.return_value = True
    monkeypatch.setattr(module.provider_manager, "get_provider", lambda tid: provider)
    clock = [10.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monitor = module.StatusMonitor()
    monitor._checkpoint = Mock()
    monitor._last_status["worker"] = TerminalStatus.COMPLETED
    monitor._status_generation["worker"] = 7
    monitor._output_generation["worker"] = 9
    monitor._capture_generation["worker"] = 11
    publish = Mock()
    monkeypatch.setattr(module.bus, "publish", publish)
    return monitor, provider, clock, publish


@pytest.mark.parametrize("ready", [TerminalStatus.IDLE, TerminalStatus.COMPLETED])
def test_question_vetoes_ready_without_applying_or_persisting_evidence(rig, ready):
    monitor, provider, _, publish = rig
    monitor._last_status["worker"] = ready
    assert monitor.get_status("worker") == TerminalStatus.WAITING_USER_ANSWER
    assert monitor.status_observation("worker") == (TerminalStatus.WAITING_USER_ANSWER, None)
    assert monitor._last_status["worker"] == ready
    assert monitor._status_generation["worker"] == 7
    assert monitor.output_generation("worker") == 9
    monitor._checkpoint.assert_not_called()
    publish.assert_not_called()
    provider.has_active_native_question.assert_called_once()


@pytest.mark.parametrize("active", [True, False])
def test_probe_is_rate_limited_even_when_output_generation_changes(rig, active):
    monitor, provider, clock, _ = rig
    provider.has_active_native_question.return_value = active
    expected = TerminalStatus.WAITING_USER_ANSWER if active else TerminalStatus.COMPLETED
    assert monitor.get_status("worker") == expected
    assert monitor.get_status("worker") == expected
    monitor._capture_generation["worker"] += 1
    assert monitor.get_status("worker") == TerminalStatus.UNKNOWN
    provider.has_active_native_question.assert_called_once()
    clock[0] += module.NATIVE_QUESTION_PROBE_INTERVAL_S
    assert monitor.get_status("worker") == expected
    assert provider.has_active_native_question.call_count == 2


def test_positive_result_expires_and_does_not_latch_answered_prompt(rig):
    monitor, provider, clock, _ = rig
    assert monitor.get_status("worker") == TerminalStatus.WAITING_USER_ANSWER
    clock[0] += module.NATIVE_QUESTION_PROBE_INTERVAL_S
    provider.has_active_native_question.return_value = False
    assert monitor.get_status("worker") == TerminalStatus.COMPLETED


@pytest.mark.parametrize("operation", ["input", "reset", "clear", "output", "status"])
def test_probe_crossing_new_boundary_is_discarded(rig, monkeypatch, operation):
    monitor, provider, _, _ = rig
    monkeypatch.setattr(module, "update_terminal_runtime_failure", Mock())

    def cross():
        if operation == "input":
            monitor.notify_input_sent("worker")
        elif operation == "reset":
            monitor.reset_buffer("worker")
        elif operation == "clear":
            monitor.clear_terminal("worker")
        elif operation == "output":
            monitor._capture_generation["worker"] += 1
        else:
            monitor._last_status["worker"] = TerminalStatus.PROCESSING
        return True

    provider.has_active_native_question.side_effect = cross
    expected = {
        "input": TerminalStatus.UNKNOWN,
        "reset": TerminalStatus.UNKNOWN,
        "clear": TerminalStatus.UNKNOWN,
        "output": TerminalStatus.UNKNOWN,
        "status": TerminalStatus.PROCESSING,
    }[operation]
    assert monitor.get_status("worker") == expected
    assert all(entry[2] is not True for entry in monitor._native_question_checks.values())


@pytest.mark.parametrize("operation", ["notify_input_sent", "reset_buffer", "clear_terminal"])
def test_input_reset_and_delete_clear_positive_cache(rig, monkeypatch, operation):
    monitor, _, _, _ = rig
    monkeypatch.setattr(module, "update_terminal_runtime_failure", Mock())
    assert monitor.get_status("worker") == TerminalStatus.WAITING_USER_ANSWER
    getattr(monitor, operation)("worker")
    assert "worker" not in monitor._native_question_checks


def test_probe_exception_is_not_cached_as_question_or_raised(rig):
    monitor, provider, _, _ = rig
    provider.has_active_native_question.side_effect = RuntimeError("unavailable")
    assert monitor.get_status("worker") == TerminalStatus.UNKNOWN
    assert monitor.get_status("worker") == TerminalStatus.UNKNOWN
    assert monitor.status_observation("worker") == (TerminalStatus.UNKNOWN, None)
    provider.has_active_native_question.assert_called_once()


@pytest.mark.parametrize(
    "status",
    [
        TerminalStatus.UNKNOWN,
        TerminalStatus.PROCESSING,
        TerminalStatus.WAITING_USER_ANSWER,
        TerminalStatus.ERROR,
    ],
)
def test_no_probe_for_nonready_states(rig, status):
    monitor, provider, _, _ = rig
    monitor._last_status["worker"] = status
    assert monitor.get_status("worker") == status
    provider.has_active_native_question.assert_not_called()


def test_concurrent_probe_does_not_leak_ready_to_pollers_or_waiters(rig):
    monitor, provider, _, _ = rig

    def probe():
        assert monitor.get_status("worker") == TerminalStatus.UNKNOWN
        assert monitor.status_observation("worker") == (TerminalStatus.UNKNOWN, None)
        return True

    provider.has_active_native_question.side_effect = probe
    assert monitor.get_status("worker") == TerminalStatus.WAITING_USER_ANSWER
    provider.has_active_native_question.assert_called_once()


@pytest.fixture
def display_rig(rig, isolated_memory_db):
    from cli_agent_orchestrator.clients import database
    from cli_agent_orchestrator.services import terminal_status_store as store

    monitor, provider, clock, publish = rig
    with database.SessionLocal() as db:
        db.add(
            database.TerminalModel(
                id="worker",
                tmux_session="cao-fixture",
                tmux_window="developer",
                provider="claude_code",
                session_incarnation_id="fixture-incarnation",
                last_active=datetime.now(timezone.utc),
                initial_delivery_json='{"state":"delivered"}',
            )
        )
        db.commit()
    assert store.save(store.context("worker"), monitor._last_status["worker"], "live_output")
    return monitor, provider, clock, publish


@pytest.mark.parametrize("ready", [TerminalStatus.IDLE, TerminalStatus.COMPLETED])
def test_stale_probe_keeps_display_but_not_execution_evidence(display_rig, ready):
    from cli_agent_orchestrator.services import terminal_status_store as store

    monitor, provider, clock, publish = display_rig
    monitor._last_status["worker"] = ready
    assert store.save(store.context("worker"), ready, "live_output")
    provider.has_active_native_question.return_value = False
    before = store.context("worker")["status_checkpoint"]
    assert monitor.get_status("worker") == ready
    for _ in range(4):
        monitor._capture_generation["worker"] += 1
        observed = monitor.get_status("worker")
        assert observed == TerminalStatus.UNKNOWN
        assert monitor.display_status("worker", observed) == ready
        assert monitor.status_observation("worker") == (TerminalStatus.UNKNOWN, None)
    provider.has_active_native_question.assert_called_once()
    clock[0] += module.NATIVE_QUESTION_PROBE_INTERVAL_S
    assert monitor.get_status("worker") == ready
    assert monitor._status_generation["worker"] == 7
    assert monitor.output_generation("worker") == 9
    assert store.context("worker")["status_checkpoint"] == before
    monitor._checkpoint.assert_not_called()
    publish.assert_not_called()


@pytest.mark.parametrize("active", [False, True])
def test_concurrent_probe_preserves_last_verified_display_only(display_rig, active):
    monitor, provider, clock, _ = display_rig
    provider.has_active_native_question.return_value = active
    shown = TerminalStatus.WAITING_USER_ANSWER if active else TerminalStatus.COMPLETED
    assert monitor.get_status("worker") == shown
    clock[0] += module.NATIVE_QUESTION_PROBE_INTERVAL_S

    during_probe = []

    def pending():
        # The production boundary catches probe exceptions. Assert OUTSIDE that
        # callback so an assertion failure cannot masquerade as capture failure.
        during_probe.append(
            (
                monitor.get_status("worker"),
                monitor.display_status("worker", TerminalStatus.UNKNOWN),
                monitor.status_observation("worker"),
            )
        )
        return active

    provider.has_active_native_question.side_effect = pending
    assert monitor.get_status("worker") == shown
    assert during_probe == [(TerminalStatus.UNKNOWN, shown, (TerminalStatus.UNKNOWN, None))]
    assert monitor._last_status["worker"] == TerminalStatus.COMPLETED


@pytest.mark.parametrize(
    "operation", ["notify_input_sent", "reset_buffer", "clear_terminal", "unavailable"]
)
def test_transient_display_invalidates_on_lifecycle_boundary(display_rig, monkeypatch, operation):
    monitor, provider, _, _ = display_rig
    provider.has_active_native_question.return_value = False
    monitor.get_status("worker")
    monitor._capture_generation["worker"] += 1
    assert (
        monitor.display_status("worker", monitor.get_status("worker")) == TerminalStatus.COMPLETED
    )
    monkeypatch.setattr(module, "update_terminal_runtime_failure", Mock())
    if operation == "unavailable":
        monitor.set_monitoring("worker", "unavailable", "observation_unavailable")
    else:
        getattr(monitor, operation)("worker")
    assert monitor.display_status("worker", TerminalStatus.UNKNOWN) == TerminalStatus.UNKNOWN


@pytest.mark.parametrize(
    "field,value",
    [
        ("session_incarnation_id", "new-incarnation"),
        ("last_active", datetime.now(timezone.utc) + timedelta(days=1)),
        ("initial_delivery_json", '{"state":"pending"}'),
        ("deferred_init_failure_json", '{"kind":"task_not_started"}'),
        ("status_checkpoint_json", "invalid"),
    ],
)
def test_transient_display_revalidates_durable_context(display_rig, field, value):
    from cli_agent_orchestrator.clients import database

    monitor, provider, _, _ = display_rig
    provider.has_active_native_question.return_value = False
    monitor.get_status("worker")
    monitor._capture_generation["worker"] += 1
    assert monitor.get_status("worker") == TerminalStatus.UNKNOWN
    with database.SessionLocal() as db:
        setattr(db.get(database.TerminalModel, "worker"), field, value)
        db.commit()
    assert monitor.display_status("worker", TerminalStatus.UNKNOWN) == TerminalStatus.UNKNOWN


@pytest.mark.parametrize("verdict", [None, RuntimeError("capture unavailable")])
def test_failed_probe_cannot_renew_verified_display(display_rig, verdict):
    monitor, provider, clock, _ = display_rig
    provider.has_active_native_question.return_value = False
    monitor.get_status("worker")
    assert "worker" in monitor._native_question_display
    clock[0] += module.NATIVE_QUESTION_PROBE_INTERVAL_S
    if isinstance(verdict, Exception):
        provider.has_active_native_question.side_effect = verdict
    else:
        provider.has_active_native_question.return_value = verdict
    monitor.get_status("worker")
    monitor._capture_generation["worker"] += 1
    assert monitor.get_status("worker") == TerminalStatus.UNKNOWN
    assert monitor.display_status("worker", TerminalStatus.UNKNOWN) == TerminalStatus.UNKNOWN
    assert "worker" not in monitor._native_question_display


@pytest.mark.parametrize("ready", [TerminalStatus.IDLE, TerminalStatus.COMPLETED])
def test_first_inflight_probe_does_not_invent_a_display_status(display_rig, ready):
    monitor, provider, _, _ = display_rig
    monitor._last_status["worker"] = ready
    during_probe = []

    def pending():
        observed = monitor.get_status("worker")
        during_probe.append(monitor.display_status("worker", observed))
        return False

    provider.has_active_native_question.side_effect = pending
    monitor.get_status("worker")
    assert during_probe == [TerminalStatus.UNKNOWN]


def test_fresh_applied_status_invalidates_pending_display(display_rig):
    monitor, provider, _, _ = display_rig
    provider.has_active_native_question.return_value = False
    monitor.get_status("worker")
    assert "worker" in monitor._native_question_display
    monitor._allow_processing_revert["worker"] = True
    monitor._apply_detection("worker", TerminalStatus.PROCESSING)
    assert "worker" not in monitor._native_question_display
    assert monitor.display_status("worker", TerminalStatus.UNKNOWN) == TerminalStatus.UNKNOWN


def test_reported_projection_stays_stable_without_relaxing_pending_delivery(
    display_rig, monkeypatch
):
    from cli_agent_orchestrator.services import terminal_service as service

    monitor, provider, _, _ = display_rig
    monkeypatch.setattr(service, "status_monitor", monitor)
    provider.has_active_native_question.return_value = False
    monitor.get_status("worker")
    monitor._capture_generation["worker"] += 1
    observed = monitor.get_status("worker")
    assert service.reported_status("worker", observed) == TerminalStatus.COMPLETED
    monkeypatch.setattr(service, "initial_delivery_pending", lambda tid: True)
    assert service.reported_status("worker", observed) == TerminalStatus.UNKNOWN


def test_transient_display_is_bounded_and_does_not_mask_known_status(display_rig):
    monitor, provider, clock, _ = display_rig
    provider.has_active_native_question.return_value = False
    monitor.get_status("worker")
    monitor._capture_generation["worker"] += 1
    for status in (
        TerminalStatus.PROCESSING,
        TerminalStatus.WAITING_USER_ANSWER,
        TerminalStatus.ERROR,
    ):
        assert monitor.display_status("worker", status) == status
    clock[0] += 3 * module.NATIVE_QUESTION_PROBE_INTERVAL_S
    assert monitor.display_status("worker", TerminalStatus.UNKNOWN) == TerminalStatus.UNKNOWN


def test_other_providers_are_unchanged(rig):
    monitor, provider, _, _ = rig
    provider.supports_native_question_probe = False
    assert monitor.get_status("worker") == TerminalStatus.COMPLETED
    provider.has_active_native_question.assert_not_called()


def test_native_event_inbox_backend_is_unchanged(rig, monkeypatch):
    monitor, provider, _, _ = rig
    backend = Mock()
    backend.supports_event_inbox.return_value = True
    monkeypatch.setattr("cli_agent_orchestrator.backends.registry.get_backend", lambda: backend)
    provider.get_status.return_value = TerminalStatus.IDLE
    assert monitor.get_status("worker") == TerminalStatus.IDLE
    provider.has_active_native_question.assert_not_called()
