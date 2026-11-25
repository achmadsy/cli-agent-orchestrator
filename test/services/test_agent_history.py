"""History never reconstructs executable rows, input, or completion evidence."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import text

from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.models.agent_history import HistoryBatch
from cli_agent_orchestrator.services import agent_history as service
from cli_agent_orchestrator.services import agent_history_store as store


@pytest.fixture
def history_db(isolated_memory_db):
    return isolated_memory_db


def terminal(tmp_path, terminal_id="old", provider="claude_code"):
    database.create_terminal(
        terminal_id,
        "cao-history",
        "developer",
        provider,
        working_directory=str(tmp_path),
        session_incarnation_id="inc",
    )
    return terminal_id


def mutate(terminal_id, *, public=None, private=None):
    record, secret, _ = store.local_record(terminal_id)
    record.update(public or {})
    secret.update(private or {})
    with database.SessionLocal() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        store.put(db, terminal_id, record, secret)
        db.commit()


@pytest.mark.parametrize(
    "provider", ["claude_code", "codex", "kiro_cli", "gemini_cli", "opencode_cli"]
)
def test_archive_survives_registry_delete(history_db, tmp_path, provider):
    tid = terminal(tmp_path, provider=provider)
    message = database.create_inbox_message("human", tid, "do not replay")
    mutate(tid, public={"output": "Assistant: saved answer", "output_source": "recording"})
    database.delete_terminal(tid)
    history_db.dispose()  # Reopen persistent SQLite connection, as after restart.
    record, private, _ = store.local_record(tid)
    assert record["output"] == "Assistant: saved answer"
    assert record["inbox"][0]["id"] == message.id
    assert record["inbox"][0]["status"] == "pending"
    assert record["lifecycle"] == "ended"
    assert database.get_terminal_metadata(tid) is None
    assert private["runtime"]["session"] == "cao-history"


@pytest.mark.parametrize("provider", ["claude_code", "codex", "kiro_cli", "gemini_cli", "opencode_cli"])
def test_live_collection_captures_filtered_output_and_inbox(history_db, tmp_path, monkeypatch, provider):
    from cli_agent_orchestrator.services import terminal_service
    from cli_agent_orchestrator.services.status_monitor import status_monitor
    from cli_agent_orchestrator.models.terminal import TerminalStatus

    tid = terminal(tmp_path, provider=provider)
    database.create_inbox_message("human", tid, "saved message")
    monkeypatch.setattr(service, "presence", lambda *_: "live")
    monkeypatch.setattr(service, "config_root", Mock(side_effect=ValueError("No native fixture")))
    monkeypatch.setattr(status_monitor, "get_status", lambda _: TerminalStatus.PROCESSING)
    display = Mock(return_value={"output": "filtered capture", "source": "native_transcript", "truncated": False})
    monkeypatch.setattr(terminal_service, "get_display_output", display)
    service.collect_one(tid)
    public, _, _ = store.local_record(tid)
    assert public["output"] == "filtered capture"
    assert public["status"] == "processing"
    assert public["inbox"][0]["message"] == "saved message"
    display.assert_called_once_with(tid, terminal_service.OutputMode.FULL)


def test_absent_collection_retains_status_only_as_history(history_db, tmp_path, monkeypatch):
    from cli_agent_orchestrator.services import terminal_service
    from cli_agent_orchestrator.providers.manager import provider_manager
    tid = terminal(tmp_path)
    mutate(tid, public={"status": "processing", "output": "previous safe capture"})
    monkeypatch.setattr(service, "presence", lambda *_: "disconnected")
    display = Mock(side_effect=AssertionError("Must not read a replacement pane"))
    monkeypatch.setattr(terminal_service, "get_display_output", display)
    monkeypatch.setattr(provider_manager, "get_provider", Mock(side_effect=ValueError("No filter")))
    service.collect_one(tid)
    display.assert_not_called()
    assert store.local_record(tid)[0]["output"] == "previous safe capture"
    record = service.listing()["records"][0]
    assert record["runtime_state"] == "disconnected"
    assert record["last_known_status"] == "processing"


def test_multibyte_snapshot_fits_wire_limit(history_db, tmp_path):
    tid = terminal(tmp_path)
    with database.SessionLocal() as db:
        for i in range(100):
            db.add(database.InboxModel(sender_id="human", receiver_id=tid, message="😀" * 4096, status="pending"))
        db.flush()
        store.retain_terminal(db, db.get(database.TerminalModel, tid))
        db.commit()
    mutate(tid, public={"output": "😀" * 65536})
    exported = {**store.export(), "source_node": "fixture"}
    batch = HistoryBatch.model_validate(exported)
    assert len(json.dumps(exported).encode()) < 4 * 1024 * 1024
    assert batch.records[0].record.output_truncated
    assert batch.records[0].record.inbox_truncated


def test_versions_change_only_with_content(history_db, tmp_path):
    tid = terminal(tmp_path)
    _, _, before = store.local_record(tid)
    mutate(tid)
    assert store.local_record(tid)[2] == before
    mutate(tid, public={"output": "new"})
    assert store.local_record(tid)[2] > before


def test_replication_is_idempotent_and_read_only(history_db, tmp_path):
    tid = terminal(tmp_path)
    batch = HistoryBatch.model_validate({**store.export(), "source_node": "fixture"})
    store.accept("fixture", batch)
    store.accept("fixture", batch)
    with database.SessionLocal() as db:
        assert db.query(store.HistoryReplica).count() == 1
        assert db.query(database.TerminalModel).count() == 1
        assert db.query(database.InboxModel).count() == 0
    mutate(tid, public={"output": "newer"})
    newer = HistoryBatch.model_validate({**store.export(), "source_node": "fixture"})
    store.accept("fixture", newer)
    store.accept("fixture", batch)
    assert service.detail("fixture", batch.origin, tid)["output"] == "newer"


def test_unknown_presence_never_offers_resume(history_db, tmp_path, monkeypatch):
    terminal(tmp_path)
    monkeypatch.setattr(service, "presence", lambda *_: "unverified")
    monkeypatch.setattr(service, "native_reference", lambda *_: {"session_id": "valid"})
    record = service.listing()["records"][0]
    assert record["runtime_state"] == "unverified"
    assert record["resume_available"] is False


def test_retained_inbox_survives_original_retention(history_db, tmp_path):
    tid = terminal(tmp_path)
    database.create_inbox_message("human", tid, "saved")
    with database.SessionLocal() as db:
        store.retain_terminal(db, db.get(database.TerminalModel, tid))
        db.query(database.InboxModel).delete()
        db.commit()
    mutate(tid)
    assert store.local_record(tid)[0]["inbox"][0]["message"] == "saved"


def test_native_reference_rejects_replacement_and_profile_change(history_db, tmp_path, monkeypatch):
    config = tmp_path / "config"
    config.mkdir()
    sid = "12345678-1234-1234-1234-123456789abc"
    transcript = config / (sid + ".jsonl")
    transcript.write_text("{}")
    ref = {
        "config": str(config),
        "relative": transcript.name,
        "session_id": sid,
        "root_identity": [config.stat().st_dev, config.stat().st_ino],
        "file_identity": [transcript.stat().st_dev, transcript.stat().st_ino],
    }
    monkeypatch.setattr(service, "config_root", lambda _: config)
    assert service.native_reference({"native": ref}) == ref
    replacement = config / "replacement"
    replacement.write_text("{}")
    replacement.replace(transcript)
    assert service.native_reference({"native": ref}) is None


@pytest.mark.asyncio
async def test_resume_one_shot_and_no_task_or_queue_copy(history_db, tmp_path, monkeypatch):
    from cli_agent_orchestrator.services import session_service

    tid = terminal(tmp_path)
    database.create_inbox_message("human", tid, "pending old task")
    ref = {"session_id": "12345678-1234-1234-1234-123456789abc", "config": str(tmp_path)}
    monkeypatch.setattr(service, "native_reference", lambda _: ref)
    monkeypatch.setattr(service, "presence", lambda *_: "disconnected")
    monkeypatch.setattr(service, "native_absent", lambda _: True)
    monkeypatch.setattr(service, "verify_launch_account", lambda *_: None)

    async def launch(**kwargs):
        assert kwargs["initial_message"] is None
        assert kwargs["resume_session_id"] == ref["session_id"]
        terminal(tmp_path, "new")
        return SimpleNamespace(id="new", session_name="cao-new")

    launcher = AsyncMock(side_effect=launch)
    monkeypatch.setattr(session_service, "create_session", launcher)
    version = store.local_record(tid)[2]
    result = await service.resume(tid, version, None)
    assert result["task_replayed"] is False
    assert database.get_pending_messages("new") == []
    assert len(database.get_inbox_messages("new", include_history=True)) == 1
    with pytest.raises(ValueError, match="already requested"):
        await service.resume(tid, version, None)
    assert launcher.await_count == 1


@pytest.mark.asyncio
async def test_uncertain_launch_remains_fenced(history_db, tmp_path, monkeypatch):
    from cli_agent_orchestrator.services import session_service

    tid = terminal(tmp_path)
    monkeypatch.setattr(
        service, "native_reference", lambda _: {"session_id": "sid", "config": str(tmp_path)}
    )
    monkeypatch.setattr(service, "presence", lambda *_: "disconnected")
    monkeypatch.setattr(service, "native_absent", lambda _: True)
    monkeypatch.setattr(service, "verify_launch_account", lambda *_: None)
    launcher = AsyncMock(side_effect=RuntimeError("uncertain"))
    monkeypatch.setattr(session_service, "create_session", launcher)
    version = store.local_record(tid)[2]
    with pytest.raises(RuntimeError):
        await service.resume(tid, version, None)
    with pytest.raises(ValueError, match="already requested"):
        await service.resume(tid, version, None)
    assert launcher.await_count == 1


def test_failed_sync_does_not_acknowledge(history_db, tmp_path, monkeypatch):
    terminal(tmp_path)
    monkeypatch.setenv("CAO_HISTORY_SYNC_ENABLED", "true")
    peer = SimpleNamespace(central_url="http://100.64.0.1:9889", local_url="http://100.64.0.2:9889")
    peer.request = Mock(side_effect=[{"origin": "a" * 32}, RuntimeError("offline")])
    monkeypatch.setattr(service, "connection", lambda: peer)
    with pytest.raises(RuntimeError):
        service.sync_once()
    with database.SessionLocal() as db:
        assert (
            db.query(store.HistoryState)
            .filter(store.HistoryState.key.like("sync_cursor:%"))
            .count()
            == 0
        )
    peer.request.side_effect = lambda method, path, **kwargs: (
        {"origin": "a" * 32}
        if method == "GET"
        else {"accepted": True, "cursor": kwargs["body"]["cursor"], "destination_origin": "a" * 32}
    )
    service.sync_once()
    with database.SessionLocal() as db:
        assert (
            db.query(store.HistoryState)
            .filter(store.HistoryState.key.like("sync_cursor:%"))
            .count()
            == 1
        )


def test_reused_inbox_ids_do_not_erase_archive(history_db, tmp_path):
    tid = terminal(tmp_path)
    first = database.create_inbox_message("human", tid, "first")
    with database.SessionLocal() as db:
        store.retain_terminal(db, db.get(database.TerminalModel, tid))
        db.query(database.InboxModel).delete()
        db.commit()
    second = database.create_inbox_message("human", tid, "second")
    assert first.id == second.id  # Legacy SQLite rowid is reusable.
    database.delete_terminal(tid)
    assert [m["message"] for m in store.local_record(tid)[0]["inbox"]] == ["first", "second"]


def test_multi_agent_sync_drains_snapshot_and_replays_new_destination(
    history_db, tmp_path, monkeypatch
):
    for i in range(8):
        terminal(tmp_path, f"agent{i}")
    monkeypatch.setenv("CAO_HISTORY_SYNC_ENABLED", "true")
    destination = ["a" * 32]
    sent = []

    def request(method, path, **kwargs):
        if method == "GET":
            return {"origin": destination[0]}
        sent.append(kwargs["body"]["records"][0]["record"]["terminal_id"])
        return {
            "accepted": True,
            "cursor": kwargs["body"]["cursor"],
            "destination_origin": destination[0],
        }

    monkeypatch.setattr(
        service,
        "connection",
        lambda: SimpleNamespace(
            central_url="http://100.64.0.1:9889",
            local_url="http://100.64.0.2:9889",
            request=request,
        ),
    )
    service.sync_once()
    assert len(set(sent)) == 8
    service.sync_once()
    assert len(sent) == 8
    destination[0] = "b" * 32
    service.sync_once()
    assert len(sent) == 16


def test_account_default_change_is_rejected(monkeypatch):
    from cli_agent_orchestrator.services import provider_profile_store
    from cli_agent_orchestrator.utils import agent_profiles

    monkeypatch.setattr(
        agent_profiles,
        "load_launch_profile",
        lambda _: (None, agent_profiles.ProfileSource.INSTALLED),
    )
    monkeypatch.setattr(
        provider_profile_store,
        "resolve_provider_profile",
        lambda *_: SimpleNamespace(id="different-account"),
    )
    with pytest.raises(ValueError, match="account changed"):
        service.verify_launch_account({"agent_profile": "developer"}, {"provider_profile": None})


def test_wire_rejects_credentials_and_duplicate_versions(history_db, tmp_path):
    terminal(tmp_path)
    payload = {**store.export(), "source_node": "fixture"}
    payload["records"][0]["record"]["token"] = "not allowed"
    with pytest.raises(ValueError):
        HistoryBatch.model_validate(payload)
    payload["records"][0]["record"].pop("token")
    payload["records"] *= 2
    with pytest.raises(ValueError):
        HistoryBatch.model_validate(payload)
