"""Durable, content-free display checkpoints, never task-execution evidence.

Uses the existing CAO SQLite database. A checkpoint belongs to one terminal and
session incarnation; optimistic writes fence input/row changes during snapshot
reads. No terminal output, prompts or credentials are stored here.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import select, update

from cli_agent_orchestrator.clients import database
from cli_agent_orchestrator.models.terminal import TerminalStatus

_IDENTITY = ("id", "tmux_session", "tmux_window", "session_incarnation_id", "provider")
_FIELDS = (
    *_IDENTITY,
    "last_active",
    "initial_delivery",
    "deferred_init_failure",
    "deferred_init_external_owner",
    "deferred_init_runtime_reclaimed",
    "status_checkpoint",
)


def _columns():
    model = database.TerminalModel
    return {
        key: getattr(
            model,
            {
                "initial_delivery": "initial_delivery_json",
                "deferred_init_failure": "deferred_init_failure_json",
                "status_checkpoint": "status_checkpoint_json",
            }.get(key, key),
        )
        for key in _FIELDS
    }


def context(terminal_id: str) -> dict | None:
    columns = _columns()
    with database.SessionLocal() as db:
        row = (
            db.execute(
                select(*(col.label(key) for key, col in columns.items())).where(
                    columns["id"] == terminal_id
                )
            )
            .mappings()
            .first()
        )
    return dict(row) if row else None


def identity(row: dict) -> tuple:
    return tuple(row[key] for key in _IDENTITY)


def _active_stamp(row: dict) -> str | None:
    return row["last_active"].isoformat() if row["last_active"] else None


def read(row: dict) -> dict | None:
    try:
        record = json.loads(row["status_checkpoint"] or "null")
        if (
            not isinstance(record, dict)
            or record.get("identity") != list(identity(row))
            or record.get("last_active") != _active_stamp(row)
            or record.get("status") not in {item.value for item in TerminalStatus}
        ):
            return None
        return record
    except (ValueError, TypeError):
        return None


def input_pending(row: dict) -> bool:
    # last_active is updated AFTER keys are sent, so it may advance while this
    # pre-send fence remains valid. Only fresh provider output can clear it.
    try:
        record = json.loads(row["status_checkpoint"] or "null")
        return bool(
            isinstance(record, dict)
            and record.get("identity") == list(identity(row))
            and record.get("source") == "input_pending"
        )
    except (ValueError, TypeError):
        return True


def recoverable(row: dict) -> bool:
    try:
        delivery = json.loads(row["initial_delivery"] or "null")
    except (ValueError, TypeError):
        return False
    return bool(
        row["session_incarnation_id"]
        and not row["deferred_init_failure"]
        and not row["deferred_init_external_owner"]
        and not row["deferred_init_runtime_reclaimed"]
        and not (isinstance(delivery, dict) and delivery.get("state") in {"pending", "failed"})
    )


def save(row: dict, status: TerminalStatus, source: str) -> bool:
    """CAS against the exact row captured before detection/dispatch."""
    if not row["session_incarnation_id"]:
        return False
    record = {
        "status": status.value,
        "source": source,
        "identity": list(identity(row)),
        "last_active": _active_stamp(row),
        "observed_at": datetime.now(timezone.utc).isoformat(),
    }
    columns = _columns()
    with database.SessionLocal() as db:
        result = db.execute(
            update(database.TerminalModel)
            .where(*(column == row[key] for key, column in columns.items()))
            .values(status_checkpoint_json=json.dumps(record))
        )
        db.commit()
        return result.rowcount == 1
