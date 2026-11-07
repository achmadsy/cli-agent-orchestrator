"""Restore output observation only; never initialize providers or send keys."""

import asyncio
import functools
import logging

from cli_agent_orchestrator.backends.registry import get_backend
from cli_agent_orchestrator.backends.tmux_backend import TmuxBackend
from cli_agent_orchestrator.clients.database import get_terminal_metadata, list_all_terminals
from cli_agent_orchestrator.constants import FIFO_DIR
from cli_agent_orchestrator.services.fifo_reader import fifo_manager
from cli_agent_orchestrator.services.session_lock import session_lifecycle_lock
from cli_agent_orchestrator.services.status_monitor import status_monitor

logger = logging.getLogger(__name__)


def attach_output(terminal_id: str, session_name: str):
    """Attach an idempotent, exact-owned output pipeline under lifecycle lock.

    The returned capture callable revalidates registry and tmux ownership on
    every use. The same guarded callable is used by the watchdog, not names.
    """
    backend = get_backend()
    if not isinstance(backend, TmuxBackend):
        raise ValueError("Backend has no exact output attachment contract")
    with session_lifecycle_lock(session_name):
        metadata = get_terminal_metadata(terminal_id)
        if not metadata or metadata["tmux_session"] != session_name:
            raise ValueError("Terminal registry changed")
        target = backend.resolve_workspace_target(terminal_id, session_name)
        fifo_path = str(FIFO_DIR / f"{terminal_id}.fifo")

        def observe(path=None):
            with session_lifecycle_lock(session_name):
                current = get_terminal_metadata(terminal_id)
                if not current or current["tmux_session"] != session_name:
                    raise ValueError("Terminal registry changed")
                return backend.observe_terminal_exact(target, path)

        if not fifo_manager.has_reader(terminal_id):
            status_monitor.set_monitoring(terminal_id, "attached", "awaiting_output")
            fifo_manager.create_reader(
                terminal_id,
                pane_probe=observe,
                rearm=lambda: observe(fifo_path),
            )
            try:
                backend.observe_terminal_exact(target, fifo_path)
            except Exception:
                fifo_manager.stop_reader(terminal_id)
                raise
    return observe


async def _settled_worker(fn, *args):
    """Cancellation cannot leave a still-attaching executor thread behind."""
    job = asyncio.get_running_loop().run_in_executor(None, functools.partial(fn, *args))
    cancelled = False
    while not job.done():
        try:
            await asyncio.shield(job)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            break
    if cancelled:
        # Retrieve a failure too, so cancellation cannot leak an unhandled Future.
        if not job.cancelled():
            job.exception()
        raise asyncio.CancelledError
    return job.result()


async def recover_observation() -> None:
    """Bounded, serial startup recovery; failures are isolated per terminal."""
    from cli_agent_orchestrator.services.inbox_service import inbox_service
    from cli_agent_orchestrator.services.log_writer import log_writer
    from cli_agent_orchestrator.services.terminal_service import (
        should_retain_deferred_failure_tombstone,
    )

    if not isinstance(get_backend(), TmuxBackend):
        return
    try:
        for consumer in (status_monitor, log_writer, inbox_service):
            await asyncio.wait_for(consumer.ready.wait(), timeout=10)
        rows = await asyncio.to_thread(list_all_terminals)
        for row in rows:
            terminal_id = row["id"]
            if row.get("deferred_init_failure") or row.get("deferred_init_external_owner"):
                continue
            try:
                retained = await asyncio.to_thread(
                    should_retain_deferred_failure_tombstone, terminal_id, row
                )
            except Exception:
                status_monitor.set_monitoring(terminal_id, "unavailable", "observation_unavailable")
                logger.warning("Cannot verify output recovery eligibility for %s", terminal_id)
                continue
            if retained:
                continue
            status_monitor.set_monitoring(terminal_id, "recovering", "reconnecting")
            for attempt in range(3):
                try:
                    capture = await _settled_worker(attach_output, terminal_id, row["tmux_session"])
                    # Snapshot classification is optional. A detector failure
                    # must not misreport a successfully attached reader as down.
                    try:
                        await _settled_worker(status_monitor.observe_snapshot, terminal_id, capture)
                        await asyncio.sleep(0.4)
                        await _settled_worker(status_monitor.observe_snapshot, terminal_id, capture)
                    except Exception:
                        status_monitor.set_monitoring(
                            terminal_id, "attached", "snapshot_unavailable"
                        )
                    break
                except Exception:
                    status_monitor.set_monitoring(
                        terminal_id, "unavailable", "observation_unavailable"
                    )
                    if attempt < 2:
                        await asyncio.sleep(0.25 * (attempt + 1))
                    else:
                        logger.warning(
                            "Output observation unavailable for terminal %s", terminal_id
                        )
    except asyncio.TimeoutError:
        logger.warning("Output recovery skipped: consumers not ready")
    except Exception:
        logger.exception("Output observation recovery failed")
