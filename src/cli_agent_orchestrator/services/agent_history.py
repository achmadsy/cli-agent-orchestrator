"""History observation and explicit recovery; never feeds readiness or delivery."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path

from sqlalchemy import text

from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.services import agent_history_store as store

logger = logging.getLogger(__name__)
OUTPUT_LIMIT = 65536


def collect_one(terminal_id):
    from cli_agent_orchestrator.services import terminal_service
    from cli_agent_orchestrator.services.status_monitor import status_monitor
    from cli_agent_orchestrator.services.terminal_service import OutputMode

    metadata = database.get_terminal_metadata(terminal_id)
    if metadata is None:
        return
    existing = store.local_record(terminal_id)
    public, private = {}, existing[1] if existing else {}
    runtime = {"session": metadata["tmux_session"], "window": metadata["tmux_window"]}
    state = presence(terminal_id, runtime)
    public.update(lifecycle="observed" if state == "live" else "disconnected")
    if state == "live":
        public["status"] = status_monitor.get_status(terminal_id).value
    try:
        # Read the same provider-filtered output as the UI, including persistent
        # recordings after reboot. No initialize/launch/send-input operation.
        if state == "live":
            result = terminal_service.get_display_output(terminal_id, OutputMode.FULL)
        else:
            # A missing/unverified pane must never fall back to a same-name
            # replacement's viewport. Only read this terminal's on-disk log.
            from cli_agent_orchestrator.constants import TERMINAL_LOG_DIR
            from cli_agent_orchestrator.services.terminal_recording import read_recording
            from cli_agent_orchestrator.providers.manager import provider_manager
            from cli_agent_orchestrator.providers.base import BaseProvider

            provider = provider_manager.get_provider(terminal_id)
            if not isinstance(provider, BaseProvider):
                raise ValueError("Unverified output filter")
            result = read_recording(
                TERMINAL_LOG_DIR / f"{terminal_id}.log", columns=220, rows=50, ansi=True
            )
            if result is None:
                raise ValueError("No saved recording")
            result["output"] = provider.filter_display_history(result["output"])
            result["source"] = "recording"
        if result["output"].strip():
            public.update(
                output=result["output"][-OUTPUT_LIMIT:],
                output_source=result.get("source", "recording"),
                output_truncated=bool(
                    result.get("truncated") or len(result["output"]) > OUTPUT_LIMIT
                ),
            )
    except Exception:
        pass  # Keep last successful capture, never publish an unfiltered fallback.
    if state == "live" and metadata["provider"] == "claude_code":
        try:
            from cli_agent_orchestrator.providers.claude_transcript import _session_path

            config = config_root(metadata.get("provider_profile"))
            found = _session_path(config, terminal_id)
            if found:
                path, sid = found
                private["native"] = {
                    "session_id": sid,
                    "config": str(config),
                    "relative": str(path.relative_to(config)),
                    "root_identity": [config.stat().st_dev, config.stat().st_ino],
                    "file_identity": [path.stat().st_dev, path.stat().st_ino],
                }
        except (OSError, ValueError):
            pass
    with database.SessionLocal() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        row = db.get(database.TerminalModel, terminal_id)
        if row is None or row.session_incarnation_id != metadata.get("session_incarnation_id"):
            return  # Concurrent teardown/replacement owns the final archive.
        current = db.get(store.AgentHistory, terminal_id)
        if existing and current and current.version != existing[2]:
            return  # Another collector/teardown saved a newer observation.
        store.retain_terminal(db, row)
        current = db.get(store.AgentHistory, terminal_id)
        minimal, current_private = json.loads(current.public_json), json.loads(current.private_json)
        # Inbox is merged within this transaction, not overwritten by a stale read.
        public.pop("inbox", None)
        public.pop("inbox_truncated", None)
        minimal.update(public)
        if private.get("native"):
            current_private["native"] = private["native"]
        store.put(db, terminal_id, minimal, current_private)
        db.commit()


def collect():
    for metadata in database.list_all_terminals():
        try:
            collect_one(metadata["id"])
        except Exception as exc:
            logger.warning(
                "History observation deferred for %s (%s)", metadata["id"], type(exc).__name__
            )


def presence(terminal_id, runtime):
    """Only an exact non-destructive backend absence check can permit resume."""
    from cli_agent_orchestrator.backends.registry import get_backend
    from cli_agent_orchestrator.backends.base import TerminalCleanupOutcome

    if not isinstance(runtime, dict) or not runtime.get("session") or not runtime.get("window"):
        return "unverified"
    try:
        result = get_backend().cleanup_terminal_exact(
            terminal_id, runtime["session"], runtime["window"], close=False
        )
        if result.outcome == TerminalCleanupOutcome.STILL_PRESENT:
            return "live"
        if result.outcome == TerminalCleanupOutcome.ABSENT:
            return "disconnected"
    except Exception:
        pass
    return "unverified"


def config_root(profile):
    if profile:
        from cli_agent_orchestrator.services.provider_profile_store import (
            get_provider_profile,
            profile_home,
        )

        if get_provider_profile(profile).provider.value != "claude_code":
            raise ValueError("Provider account changed")
        return profile_home("claude_code", profile).resolve()
    return Path(os.getenv("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").resolve()


def native_reference(private):
    """Validate pinned account, root and transcript identities, never newest-in-cwd."""
    from cli_agent_orchestrator.providers.claude_transcript import _SESSION_ID

    ref = private.get("native")
    if (
        not isinstance(ref, dict)
        or not isinstance(ref.get("session_id"), str)
        or not _SESSION_ID.fullmatch(ref["session_id"])
    ):
        return None
    try:
        config, relative = Path(ref["config"]), Path(ref["relative"])
        if not config.is_absolute() or relative.is_absolute() or ".." in relative.parts:
            return None
        if config != config_root(private.get("provider_profile")):
            return None
        path = config / relative
        if (
            not path.resolve().is_relative_to(config)
            or any(p.is_symlink() for p in (path, *path.parents))
            or not path.is_file()
        ):
            return None
        if path.name != ref["session_id"] + ".jsonl":
            return None
        if [config.stat().st_dev, config.stat().st_ino] != ref.get("root_identity"):
            return None
        if [path.stat().st_dev, path.stat().st_ino] != ref.get("file_identity"):
            return None
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return ref


def native_absent(ref):
    """Fail closed on inaccessible same-user processes or a resumed native ID.

    Native sessions may have been reopened outside their old tmux window. Scan
    both the native process registry and process arguments; never kill either.
    """
    import psutil
    from cli_agent_orchestrator.providers.claude_transcript import MAX_RECORD_BYTES

    try:
        for index, path in enumerate((Path(ref["config"]) / "sessions").glob("*.json")):
            if index >= 4096 or path.is_symlink() or path.stat().st_size > MAX_RECORD_BYTES:
                return False
            try:
                record = json.loads(path.read_text())
            except (ValueError, UnicodeError):
                return False
            if not isinstance(record, dict):
                return False
            if record.get("sessionId") == ref["session_id"]:
                pid = record.get("pid")
                if type(pid) is not int or psutil.pid_exists(pid):
                    return False
        for proc in psutil.process_iter():
            try:
                if proc.uids().real == os.getuid() and ref["session_id"] in proc.cmdline():
                    return False
            except psutil.NoSuchProcess:
                continue
            except psutil.AccessDenied:
                return False
    except (OSError, psutil.Error):
        return False
    return True


def listing(offset=0, limit=100):
    records, total = store.listings(offset, limit)
    for record in records:
        record.pop("output", None)
        record.pop("inbox", None)
        record["last_known_status"] = record.pop("status", None)
        record["runtime_state"] = "offline_snapshot" if record["replica"] else "unverified"
        record["resume_available"] = False
        record["resume_state"] = None
        if not record["replica"]:
            local = store.local_record(record["terminal_id"])
            if local:
                private = local[1]
                record["runtime_state"] = presence(record["terminal_id"], private.get("runtime"))
                with database.SessionLocal() as db:
                    intent = db.get(store.HistoryState, "resume:" + record["terminal_id"])
                    record["resume_state"] = intent.value if intent else None
                record["resume_available"] = bool(
                    record["runtime_state"] == "disconnected"
                    and not record["resume_state"]
                    and record["provider"] == "claude_code"
                    and native_reference(private)
                    and bool(record.get("working_directory"))
                    and Path(record["working_directory"]).is_dir()
                )
    return {"records": records, "total": total, "offset": offset}


def detail(source, origin, terminal_id):
    from cli_agent_orchestrator.services.code_graph_service import node_id

    if source == node_id() and origin == store.origin():
        found = store.local_record(terminal_id)
        if found:
            return {**found[0], "version": found[2]}
    with database.SessionLocal() as db:
        row = db.get(store.HistoryReplica, (source, origin, terminal_id))
        return {**json.loads(row.public_json), "version": row.version} if row else None


def connection():
    from cli_agent_orchestrator.mcp_server.shared_client import Connection

    return Connection.load(
        Path(
            os.getenv("CAO_HISTORY_CONNECTION_FILE")
            or os.getenv("CAO_SHARED_CONNECTION_FILE")
            or Path.home() / ".config/cao/mcp-client.json"
        )
    )


def sync_once(stop=None):
    """Destination-origin cursor permits full replay after coordinator DB loss."""
    if os.getenv("CAO_HISTORY_SYNC_ENABLED", "false").lower() != "true":
        return
    from cli_agent_orchestrator.services.code_graph_service import node_id

    peer = connection()
    if peer.central_url == peer.local_url:
        return
    destination = peer.request("GET", "/internal/agent-history/identity")["origin"]
    if not isinstance(destination, str) or not re.fullmatch(r"[a-f0-9]{32}", destination):
        raise ValueError("Invalid history destination identity")
    cursor_key = "sync_cursor:" + peer.central_url + ":" + destination
    with database.SessionLocal() as db:
        row = db.get(store.HistoryState, cursor_key)
        after = int(row.value) if row else 0
    with database.SessionLocal() as db:
        clock = db.get(store.HistoryState, "version")
        through = int(clock.value) if clock else 0
    # Drain the finite version snapshot before the next collection, rather than
    # starving active agents at the back of a large fleet. Check shutdown between
    # requests; any network failure exits immediately without advancing its cursor.
    while True:
        if stop is not None and stop.is_set():
            break
        batch = store.export(after, limit=1, through=through)
        if not batch["records"]:
            break
        batch["source_node"] = node_id()
        response = peer.request("POST", "/internal/agent-history/sync", body=batch)
        if (
            response.get("accepted") is not True
            or response.get("cursor") != batch["cursor"]
            or response.get("destination_origin") != destination
        ):
            raise RuntimeError("History acknowledgement mismatch")
        with database.SessionLocal() as db:
            db.execute(text("BEGIN IMMEDIATE"))
            row = store._state(db, cursor_key, "0")
            row.value = str(max(int(row.value), batch["cursor"]))
            db.commit()
        after = batch["cursor"]


async def run(stop):
    """Serial bounded observations; shutdown drains a running thread before exit."""
    while not stop.is_set():
        try:
            await asyncio.to_thread(collect)
            if not stop.is_set():
                await asyncio.to_thread(sync_once, stop)
        except Exception as exc:
            logger.warning("History sync deferred (%s)", type(exc).__name__)
        try:
            await asyncio.wait_for(stop.wait(), timeout=15)
        except asyncio.TimeoutError:
            pass


def verify_launch_account(public, private):
    """The normal launcher must resolve to the pinned account, not today's default."""
    from cli_agent_orchestrator.utils import agent_profiles
    from cli_agent_orchestrator.services.provider_profile_store import resolve_provider_profile

    profile = None
    try:
        profile, source = agent_profiles.load_launch_profile(
            public.get("agent_profile") or "developer"
        )
        if source is agent_profiles.ProfileSource.EPHEMERAL:
            raise ValueError("Ephemeral history requires an operator-managed recovery.")
    except FileNotFoundError:
        pass
    requested = private.get("provider_profile") or (profile.providerProfile if profile else None)
    resolved = resolve_provider_profile("claude_code", requested)
    if (resolved.id if resolved else None) != private.get("provider_profile"):
        raise ValueError("Launch account changed. Automatic account substitution is not allowed.")


async def resume(terminal_id, expected_version, registry):
    """Explicit action; durable one-shot fence before any process launch."""
    from cli_agent_orchestrator.services import session_service
    from cli_agent_orchestrator.services.code_graph_service import node_id

    record = await asyncio.to_thread(store.local_record, terminal_id)
    if not record or record[2] != expected_version:
        raise ValueError("History changed. Refresh before resuming.")
    public, private, _ = record
    ref = native_reference(private)
    if public["provider"] != "claude_code" or ref is None:
        raise ValueError("Verified native resume is unavailable for this provider/history.")
    await asyncio.to_thread(verify_launch_account, public, private)
    directory = public.get("working_directory")
    if not directory or not Path(directory).is_dir():
        raise ValueError("Original working directory is unavailable.")
    if await asyncio.to_thread(presence, terminal_id, private.get("runtime")) != "disconnected":
        raise ValueError("Old runtime is live or unverified; refusing a second process.")
    if not await asyncio.to_thread(native_absent, ref):
        raise ValueError("Native conversation is live or unverified; refusing a second process.")
    with database.SessionLocal() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        # Version and ancestor checks repeat under the write lock.
        row = db.get(store.AgentHistory, terminal_id)
        if row is None or row.version != expected_version:
            raise ValueError("History changed. Refresh before resuming.")
        if len(database._inbox_history_ids(db, terminal_id)) >= 100:
            raise ValueError("Inbox history chain limit reached.")
        key = "resume:" + terminal_id
        native_key = "resume_native:" + ref["config"] + ":" + ref["session_id"]
        native_owner = db.get(store.HistoryState, native_key)
        if db.get(store.HistoryState, key) or (native_owner and native_owner.value != terminal_id):
            raise ValueError(
                "Resume already requested. Inspect the resulting session; do not replay."
            )
        db.add(store.HistoryState(key=key, value="launching"))
        if native_owner is None:
            db.add(store.HistoryState(key=native_key, value=terminal_id))
        db.commit()
    # Even failure/cancellation leaves the fence in place: launch outcome may be
    # uncertain, so retry must never create a second native process.
    terminal = await session_service.create_session(
        provider="claude_code",
        provider_profile=private.get("provider_profile"),
        agent_profile=public.get("agent_profile") or "developer",
        working_directory=directory,
        allowed_tools=private.get("allowed_tools"),
        model=public.get("model"),
        resume_session_id=ref["session_id"],
        registry=registry,
        initial_message=None,
    )
    with database.SessionLocal() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        if terminal.id in database._inbox_history_ids(db, terminal_id):
            raise ValueError("Invalid history cycle after launch; inspect the new session.")
        db.add(database.InboxHistoryLinkModel(terminal_id=terminal.id, predecessor_id=terminal_id))
        db.get(store.HistoryState, key).value = terminal.id
        db.get(store.HistoryState, native_key).value = terminal.id
        # Carry the pinned native identity to the successor before any collector
        # tick; the account and original transcript remain local-only.
        successor = db.get(database.TerminalModel, terminal.id)
        if successor is not None:
            store.retain_terminal(db, successor)
            archived = db.get(store.AgentHistory, terminal.id)
            successor_private = json.loads(archived.private_json)
            successor_private["native"] = ref
            successor_public = json.loads(archived.public_json)
            successor_public.update(
                output=public["output"],
                output_source=public["output_source"],
                output_truncated=public["output_truncated"],
            )
            # Preserve predecessor entries even after normal Inbox retention.
            merged = {store.message_key(m): m for m in public["inbox"]}
            merged.update({store.message_key(m): m for m in successor_public["inbox"]})
            successor_public["inbox"] = sorted(
                merged.values(), key=lambda m: (m["created_at"], m["id"])
            )[-100:]
            successor_public["inbox_truncated"] = public["inbox_truncated"] or len(merged) > 100
            store.put(db, terminal.id, successor_public, successor_private)
        db.commit()
    return {
        "terminal_id": terminal.id,
        "session_name": terminal.session_name,
        "source_node": node_id(),
        "task_replayed": False,
    }
