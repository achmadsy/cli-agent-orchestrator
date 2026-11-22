"""Recovery history is durable, read-only, and never inherited by delivery."""

import json
from pathlib import Path
import subprocess
import sys

import pytest

from cli_agent_orchestrator.clients import database as db
from cli_agent_orchestrator.models.inbox import MessageStatus as Status


@pytest.fixture
def history(isolated_memory_db):
    for tid in ("old00000", "new00000", "peer0000", "next0000"):
        db.create_terminal(tid, "cao-" + tid, "agent", "claude_code")
    incoming = db.record_direct_message("ui", "old00000", "original input", Status.DELIVERED)
    outgoing = db.create_inbox_message("old00000", "peer0000", "original outgoing").id
    pending = db.create_inbox_message("peer0000", "old00000", "not redelivered").id
    current = db.record_direct_message("ui", "new00000", "new input", Status.FAILED)
    return incoming, outgoing, pending, current


def test_explicit_link_exposes_history_without_rewriting_or_requeuing(history):
    incoming, outgoing, pending, current = history
    db.link_inbox_history("new00000", "old00000")
    rows = db.get_inbox_messages("new00000", include_sent=True, include_history=True)
    assert [r.id for r in rows] == [incoming, outgoing, pending, current]
    assert [r.history_terminal_id for r in rows] == ["old00000"] * 3 + [None]
    assert rows[0].receiver_id == "old00000"
    assert rows[1].sender_id == "old00000"
    assert [r.id for r in db.get_inbox_messages("new00000", include_sent=True)] == [current]
    assert db.get_pending_messages("new00000", limit=100) == []
    assert [r.id for r in db.get_pending_messages("old00000", limit=100)] == [pending]
    with db.SessionLocal() as session:
        assert session.query(db.InboxModel).count() == 4


def test_chain_filters_limits_and_duplicate_suppression(history):
    incoming, outgoing, pending, current = history
    db.link_inbox_history("new00000", "old00000")
    db.link_inbox_history("next0000", "new00000")
    # Both endpoints in the lineage must not duplicate this row.
    between = db.create_inbox_message("old00000", "new00000", "between identities").id
    rows = db.get_inbox_messages("next0000", include_history=True, include_sent=True)
    assert [r.id for r in rows] == [incoming, outgoing, pending, current, between]
    latest = db.get_inbox_messages(
        "next0000", include_history=True, include_sent=True, latest=True, limit=2
    )
    assert [r.id for r in latest] == [current, between]
    failed = db.get_inbox_messages("next0000", include_history=True, status=Status.FAILED)
    assert [r.id for r in failed] == [current]
    assert db.get_pending_messages("next0000", limit=100) == []


def test_link_is_idempotent_immutable_and_cycle_safe(history):
    db.link_inbox_history("new00000", "old00000")
    db.link_inbox_history("new00000", "old00000")
    with pytest.raises(ValueError, match="already"):
        db.link_inbox_history("new00000", "peer0000")
    with pytest.raises(ValueError, match="cycle"):
        db.link_inbox_history("old00000", "new00000")
    with pytest.raises(ValueError):
        db.link_inbox_history("old00000", "old00000")
    with pytest.raises(ValueError, match="not found"):
        db.link_inbox_history("missing0", "old00000")
    with pytest.raises(ValueError, match="not found"):
        db.link_inbox_history("new00000", "missing0")


def test_editable_metadata_cannot_grant_history_access(history):
    with db.SessionLocal() as session:
        row = session.get(db.TerminalModel, "new00000")
        row.metadata_json = json.dumps({"recovery": {"predecessor_terminal_id": "old00000"}})
        session.commit()
    assert [r.id for r in db.get_inbox_messages("new00000", include_history=True)] == [history[3]]


def test_history_retained_after_predecessor_registry_cleanup(history):
    db.link_inbox_history("new00000", "old00000")
    db.delete_terminal("old00000")
    rows = db.get_inbox_messages("new00000", include_history=True, include_sent=True)
    assert len(rows) == 4
    assert rows[0].history_terminal_id == "old00000"


def test_old_database_gets_additive_link_table_without_changing_messages(
    history, isolated_memory_db
):
    db.InboxHistoryLinkModel.__table__.drop(bind=isolated_memory_db)
    db.Base.metadata.create_all(bind=isolated_memory_db)
    db.Base.metadata.create_all(bind=isolated_memory_db)
    db.link_inbox_history("new00000", "old00000")
    assert len(db.get_inbox_messages("new00000", include_history=True, include_sent=True)) == 4
    with db.SessionLocal() as session:
        assert session.query(db.InboxModel).count() == 4


def test_plain_restart_keeps_same_terminal_inbox_without_a_history_link(
    history, isolated_memory_db, monkeypatch
):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    original = db.get_inbox_messages("old00000", include_sent=True)
    fresh_engine = create_engine(str(isolated_memory_db.url))
    try:
        monkeypatch.setattr(db, "SessionLocal", sessionmaker(bind=fresh_engine))
        assert db.get_inbox_messages("old00000", include_sent=True) == original
    finally:
        fresh_engine.dispose()


def test_link_and_messages_survive_separate_processes(history, isolated_memory_db):
    source = Path(__file__).resolve().parents[2] / "src"
    setup = f"""
import sys
sys.path.insert(0, {str(source)!r})
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from cli_agent_orchestrator.clients import database as db
db.SessionLocal = sessionmaker(bind=create_engine(sys.argv[1]))
"""
    for code in (
        'db.link_inbox_history("new00000", "old00000")',
        """
rows = db.get_inbox_messages("new00000", include_history=True, include_sent=True)
assert len(rows) == 4
assert rows[0].history_terminal_id == "old00000"
assert db.get_pending_messages("new00000", limit=100) == []
print("history survived; no replay")
""",
    ):
        result = subprocess.run(
            [sys.executable, "-I", "-c", setup + code, str(isolated_memory_db.url)],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    assert "history survived; no replay" in result.stdout
