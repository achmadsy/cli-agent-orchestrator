"""Durable non-secret reset intents and cross-worker account gates."""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager

from cli_agent_orchestrator.constants import DATABASE_FILE


class ResetConflict(ValueError):
    pass


def migrate(db_path=None) -> None:
    with sqlite3.connect(str(db_path or DATABASE_FILE)) as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS quota_reset_epoch (
            id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
        INSERT OR IGNORE INTO quota_reset_epoch VALUES(1, 0);
        CREATE TABLE IF NOT EXISTS quota_reset_operation (
            id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, owner TEXT NOT NULL,
            account_key TEXT NOT NULL, expires REAL NOT NULL, epoch INTEGER NOT NULL,
            state TEXT NOT NULL, context TEXT NOT NULL, summary TEXT NOT NULL,
            upstream_id TEXT NOT NULL, reason TEXT);
        CREATE TABLE IF NOT EXISTS quota_reset_gate (
            account_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
        """)


@contextmanager
def connect():
    migrate()
    conn = sqlite3.connect(str(DATABASE_FILE), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def generation() -> int:
    with connect() as conn:
        return conn.execute("SELECT value FROM quota_reset_epoch WHERE id=1").fetchone()[0]


def create(profile_id: str, owner: str, account_key: str, context: dict, summary: dict, epoch: int) -> dict:
    ident = uuid.uuid4().hex
    expires = time.time() + 120
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT COUNT(*) FROM quota_reset_operation WHERE state='preview' AND expires>?", (time.time(),)).fetchone()[0] >= 512:
            raise ResetConflict("Too many pending reset previews; try later")
        if conn.execute("SELECT 1 FROM quota_reset_gate WHERE account_key=?", (account_key,)).fetchone():
            raise ResetConflict("A reset is submitted or its outcome is unknown; verify provider-side outcome")
        if conn.execute("SELECT value FROM quota_reset_epoch WHERE id=1").fetchone()[0] != epoch:
            raise ResetConflict("Quota changed; request a new reset preview")
        # Expired previews are never submitted, so safe to prune. Keep all spends.
        conn.execute("DELETE FROM quota_reset_operation WHERE state='preview' AND expires<?", (time.time(),))
        conn.execute("INSERT INTO quota_reset_operation VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
            ident, profile_id, owner, account_key, expires, epoch, "preview",
            json.dumps(context), json.dumps(summary), str(uuid.uuid4()), None))
    from datetime import datetime, timezone
    return {"intent_id": ident, "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat(), **summary}


def read(ident: str, profile_id: str, owner: str) -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM quota_reset_operation WHERE id=? AND profile_id=? AND owner=?",
                           (ident, profile_id, owner)).fetchone()
    if row is None:
        raise ResetConflict("Reset intent not found for this caller/profile")
    result = dict(row)
    result["context"] = json.loads(result["context"])
    result["summary"] = json.loads(result["summary"])
    return result


def reject_preview(ident: str, reason: str) -> None:
    """Invalidate only an unsubmitted preview, never overwrite a winning worker."""
    with connect() as conn:
        conn.execute("UPDATE quota_reset_operation SET state='rejected', reason=? WHERE id=? AND state='preview'", (reason, ident))


def claim(operation: dict) -> None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT state, expires, epoch FROM quota_reset_operation WHERE id=?", (operation["id"],)).fetchone()
        epoch = conn.execute("SELECT value FROM quota_reset_epoch WHERE id=1").fetchone()[0]
        if row is None or row["state"] != "preview" or row["expires"] <= time.time() or row["epoch"] != epoch:
            raise ResetConflict("Reset preview expired or changed; request a new preview")
        try:
            conn.execute("INSERT INTO quota_reset_gate VALUES(?,?)", (operation["account_key"], operation["id"]))
        except sqlite3.IntegrityError:
            raise ResetConflict("Another reset for this account is submitted or unknown") from None
        conn.execute("UPDATE quota_reset_operation SET state='submitted' WHERE id=?", (operation["id"],))
        conn.execute("UPDATE quota_reset_epoch SET value=value+1 WHERE id=1")


def finish(ident: str, state: str, reason: str | None = None) -> None:
    if state not in ("succeeded", "rejected", "unknown"):
        raise ValueError("Invalid reset state")
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("UPDATE quota_reset_operation SET state=?, reason=? WHERE id=? AND state='submitted'", (state, reason, ident))
        if state != "unknown":
            conn.execute("DELETE FROM quota_reset_gate WHERE operation_id=?", (ident,))
        conn.execute("UPDATE quota_reset_epoch SET value=value+1 WHERE id=1")


def public(operation: dict) -> dict:
    # A crash after 'submitted' cannot prove that no provider request was sent.
    state = operation["state"]
    return {"operation_id": operation["id"], "status": state,
            "reason": operation["reason"] or (
                "Outcome not confirmed; do not retry. Verify provider-side outcome." if state in ("unknown", "submitted") else None),
            "quota_refresh": "not_attempted"}


def blocked_profile(profile_id: str) -> str | None:
    with connect() as conn:
        row = conn.execute("SELECT g.operation_id FROM quota_reset_gate g JOIN quota_reset_operation o "
                           "ON g.account_key=o.account_key WHERE o.profile_id=? LIMIT 1", (profile_id,)).fetchone()
    return row[0] if row else None
