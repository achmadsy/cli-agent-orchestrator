"""Durable read-only history, deliberately outside the executable terminal registry."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, Text, or_, text

from cli_agent_orchestrator.clients import database


class HistoryState(database.Base):
    __tablename__ = "agent_history_state"
    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)


class AgentHistory(database.Base):
    __tablename__ = "agent_history"
    terminal_id = Column(String, primary_key=True)
    version = Column(Integer, nullable=False, index=True)
    public_json = Column(Text, nullable=False)
    # Local-only launch facts and verified native reference. Never replicated.
    private_json = Column(Text, nullable=False, default="{}")


class HistoryReplica(database.Base):
    __tablename__ = "agent_history_replicas"
    source_node = Column(String, primary_key=True)
    origin = Column(String, primary_key=True)
    terminal_id = Column(String, primary_key=True)
    version = Column(Integer, nullable=False)
    public_json = Column(Text, nullable=False)
    synced_at = Column(database.UTCDateTime, nullable=False)


def _state(db, key, default):
    row = db.get(HistoryState, key)
    if row is None:
        row = HistoryState(key=key, value=default)
        db.add(row)
        db.flush()
    return row


def origin():
    with database.SessionLocal() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        value = _state(db, "origin", uuid.uuid4().hex).value
        db.commit()
        return value


def bounded_text(value, byte_limit):
    """Bound UTF-8 bytes too, so escaped JSON always fits the replication limit."""
    encoded = value.encode("utf-8", errors="replace")
    return encoded[-byte_limit:].decode("utf-8", errors="ignore")


def put(db, terminal_id, public, private=None):
    """Caller holds a SQLite write transaction; never upsert an executable row."""
    from cli_agent_orchestrator.models.agent_history import HistoryRecord

    output = public.get("output", "")
    bounded = bounded_text(output, 65536)
    if bounded != output:
        public = {**public, "output": bounded, "output_truncated": True}
    public = HistoryRecord.model_validate(public).model_dump(mode="json")
    row = db.get(AgentHistory, terminal_id)
    encoded = json.dumps(public, sort_keys=True, separators=(",", ":"))
    secret = json.dumps(private, sort_keys=True) if private is not None else None
    if row and row.public_json == encoded and (secret is None or row.private_json == secret):
        return
    clock = _state(db, "version", "0")
    clock.value = str(int(clock.value) + 1)
    if row is None:
        row = AgentHistory(terminal_id=terminal_id, private_json="{}")
        db.add(row)
    row.public_json = encoded
    row.version = int(clock.value)
    if secret is not None:
        row.private_json = secret
    db.flush()


def message_key(message):
    # Legacy SQLite inbox lacks AUTOINCREMENT: IDs can be reused after retention.
    return (message["id"], message["sender_id"], message["receiver_id"], message["created_at"])


def retain_inbox(db, terminal_id, public):
    """Merge bounded history before retention deletes original queue/history rows.

    This only reads the executable inbox. Archived pending entries are text, not
    deliverable rows, and never get inserted into the queue on resume.
    """
    ids = database._inbox_history_ids(db, terminal_id)
    messages = (
        db.query(database.InboxModel)
        .filter(
            or_(database.InboxModel.receiver_id.in_(ids), database.InboxModel.sender_id.in_(ids))
        )
        .order_by(database.InboxModel.created_at.desc(), database.InboxModel.id.desc())
        .limit(101)
        .all()
    )
    merged = {message_key(m): m for m in public.get("inbox", [])}
    truncated = public.get("inbox_truncated", False) or len(messages) > 100
    for m in messages:
        item = {
            "id": m.id,
            "sender_id": m.sender_id,
            "receiver_id": m.receiver_id,
            "message": bounded_text(m.message, 4096),
            "status": m.status,
            "channel": m.channel or "queued",
            "created_at": m.created_at.isoformat(),
        }
        merged[message_key(item)] = item
        truncated |= len(m.message.encode("utf-8", errors="replace")) > 4096
    ordered = sorted(merged.values(), key=lambda m: (m["created_at"], m["id"]))
    public["inbox"] = ordered[-100:]
    public["inbox_truncated"] = truncated or len(ordered) > 100


def retain_terminal(db, terminal, *, ended=False):
    """Metadata and Inbox survive even a crash before the first collector tick."""
    row = db.get(AgentHistory, terminal.id)
    public = json.loads(row.public_json) if row else {}
    public.update(
        {
            "terminal_id": terminal.id,
            "session_name": terminal.tmux_session,
            "incarnation": terminal.session_incarnation_id,
            "name": terminal.tmux_window,
            "provider": terminal.provider,
            "agent_profile": terminal.agent_profile,
            "model": terminal.model,
            "working_directory": terminal.working_directory,
            "caller_id": terminal.caller_id,
            "last_active": terminal.last_active.isoformat() if terminal.last_active else None,
        }
    )
    public.setdefault("recorded_at", datetime.now(timezone.utc).isoformat())
    public.setdefault("lifecycle", "disconnected")
    retain_inbox(db, terminal.id, public)
    if ended:
        public.update(lifecycle="ended")
    private = json.loads(row.private_json) if row else {}
    private.update(
        {
            "provider_profile": terminal.provider_profile,
            "allowed_tools": json.loads(terminal.allowed_tools) if terminal.allowed_tools else None,
            "runtime": {"session": terminal.tmux_session, "window": terminal.tmux_window},
            "engine": terminal.engine,
            "provider_variant": terminal.provider_variant,
        }
    )
    put(db, terminal.id, public, private)


def retain_orphan_inboxes(db):
    """Archive final statuses for deleted terminal identities before Inbox sweep."""
    for row in db.query(AgentHistory).all():
        public = json.loads(row.public_json)
        retain_inbox(db, row.terminal_id, public)
        put(db, row.terminal_id, public)


def local_record(terminal_id):
    with database.SessionLocal() as db:
        row = db.get(AgentHistory, terminal_id)
        return (
            (json.loads(row.public_json), json.loads(row.private_json), row.version)
            if row
            else None
        )


def export(after=0, limit=5, through=None):
    own = origin()
    with database.SessionLocal() as db:
        query = db.query(AgentHistory).filter(AgentHistory.version > after)
        if through is not None:
            query = query.filter(AgentHistory.version <= through)
        rows = query.order_by(AgentHistory.version).limit(min(limit, 5)).all()
        return {
            "origin": own,
            "records": [
                {"version": row.version, "record": json.loads(row.public_json)} for row in rows
            ],
            "cursor": rows[-1].version if rows else after,
        }


def accept(source_node, batch):
    """Idempotent monotonic snapshots; replicas never enter terminals or inbox."""
    now = datetime.now(timezone.utc)
    with database.SessionLocal() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        for item in batch.records:
            key = (source_node, batch.origin, item.record.terminal_id)
            row = db.get(HistoryReplica, key)
            if row and row.version >= item.version:
                continue
            if row is None:
                row = HistoryReplica(
                    source_node=source_node,
                    origin=batch.origin,
                    terminal_id=item.record.terminal_id,
                )
                db.add(row)
            row.version = item.version
            row.public_json = item.record.model_dump_json()
            row.synced_at = now
        db.commit()
    return {"accepted": True, "cursor": batch.cursor, "destination_origin": origin()}


def listings(offset=0, limit=100):
    own = origin()
    from cli_agent_orchestrator.services.code_graph_service import node_id

    with database.SessionLocal() as db:
        # Page by stable identities, not a timestamp that changes between reads.
        local = (
            db.query(AgentHistory)
            .order_by(AgentHistory.terminal_id)
            .offset(offset)
            .limit(limit)
            .all()
        )
        replica_offset = max(0, offset - db.query(AgentHistory).count())
        replicas = []
        if len(local) < limit:
            replicas = (
                db.query(HistoryReplica)
                .order_by(
                    HistoryReplica.source_node, HistoryReplica.origin, HistoryReplica.terminal_id
                )
                .offset(replica_offset)
                .limit(limit - len(local))
                .all()
            )
        records = [
            {
                **json.loads(row.public_json),
                "source_node": node_id(),
                "origin": own,
                "version": row.version,
                "replica": False,
                "synced_at": None,
            }
            for row in local
        ]
        records += [
            {
                **json.loads(row.public_json),
                "source_node": row.source_node,
                "origin": row.origin,
                "version": row.version,
                "replica": True,
                "synced_at": row.synced_at.isoformat(),
            }
            for row in replicas
        ]
        total = db.query(AgentHistory).count() + db.query(HistoryReplica).count()
    return records, total
