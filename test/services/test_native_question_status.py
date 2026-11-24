"""A passive native question vetoes stale readiness, never proves task execution."""

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
    assert monitor.get_status("worker") == TerminalStatus.COMPLETED
    assert monitor.get_status("worker") == TerminalStatus.COMPLETED
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
