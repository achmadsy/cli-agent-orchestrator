"""Read public conversation text independently of Claude Code's rendered viewport.

Session discovery requires an exact CAO terminal identity from a live process;
never select the newest JSONL in a working directory shared by other sessions.
Only user/assistant text is published, not thinking, tools or injected context.
"""

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_DISPLAY_CHARS = 1024 * 1024
_SESSION_ID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


def _process_terminal_id(pid: int) -> Optional[str]:
    try:
        with Path(f"/proc/{pid}/environ").open("rb") as handle:
            environ = handle.read(MAX_RECORD_BYTES)
        for entry in environ.split(b"\0"):
            if entry.startswith(b"CAO_TERMINAL_ID="):
                return entry.partition(b"=")[2].decode("utf-8")
    except (OSError, UnicodeError):
        pass
    return None


def _within(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def _session_path(config: Path, terminal_id: str) -> Optional[tuple[Path, str]]:
    candidates = set()
    try:
        for index, path in enumerate((config / "sessions").glob("*.json")):
            if index >= 256:
                return None  # ambiguous rather than an incomplete identity scan
            if not path.stem.isdecimal() or not _within(path, config):
                continue
            if path.stat().st_size > MAX_RECORD_BYTES:
                continue
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(record, dict):
                continue
            pid = record.get("pid")
            sid = record.get("sessionId")
            cwd = record.get("cwd")
            if (
                type(pid) is not int
                or str(pid) != path.stem
                or not isinstance(sid, str)
                or not _SESSION_ID.fullmatch(sid)
                or not isinstance(cwd, str)
                or not Path(cwd).is_absolute()
                or _process_terminal_id(pid) != terminal_id
            ):
                continue
            project = re.sub(r"[^a-zA-Z0-9_-]", "-", cwd)
            transcript = config / "projects" / project / f"{sid}.jsonl"
            if _within(transcript, config) and transcript.is_file():
                candidates.add((transcript, sid))
    except OSError:
        return None
    return next(iter(candidates)) if len(candidates) == 1 else None


def _public_text(record: dict) -> str:
    if record.get("isMeta") or record.get("isCompactSummary"):
        return ""
    message = record.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    if record.get("type") == "user" and any(
        isinstance(block, dict) and block.get("type") == "tool_result" for block in content
    ):
        return ""
    return "\n\n".join(
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def read_display_output(
    terminal_id: str, config_dir: Optional[Path], mode: str
) -> Optional[dict[str, Any]]:
    """Return a bounded public transcript, or None when identity is unavailable."""
    config = config_dir or Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    resolved = _session_path(config, terminal_id)
    if resolved is None:
        return None
    path, sid = resolved
    records: dict[str, dict] = {}
    leaf = None
    truncated = False
    try:
        with path.open("rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            if size > MAX_TRANSCRIPT_BYTES:
                handle.seek(size - MAX_TRANSCRIPT_BYTES)
                handle.readline(MAX_RECORD_BYTES)  # discard partial leading record
                truncated = True
            remaining = MAX_TRANSCRIPT_BYTES
            while remaining > 0:
                line = handle.readline(min(remaining, MAX_RECORD_BYTES) + 1)
                if not line:
                    break
                remaining -= len(line)
                if remaining <= 0:
                    truncated = True
                if len(line) > MAX_RECORD_BYTES:
                    return None  # never parse a partial oversized record
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeError):
                    continue  # a concurrently appended record may not be complete
                if not isinstance(record, dict) or record.get("sessionId") != sid:
                    continue
                if record.get("isSidechain"):
                    continue
                uid = record.get("uuid")
                if isinstance(uid, str):
                    records[uid] = record  # latest streamed snapshot wins
                    leaf = uid
    except OSError:
        return None
    if leaf is None:
        return None

    # Follow the active leaf's parents: abandoned retries/rewound branches are
    # not part of the visible conversation. Bound cycles in malformed records.
    chain = []
    seen = set()
    while leaf in records and leaf not in seen:
        seen.add(leaf)
        record = records[leaf]
        chain.append(record)
        parent = record.get("parentUuid")
        leaf = parent if isinstance(parent, str) else None
    if leaf is not None:
        truncated = True
    turns: list[tuple[str, str]] = []
    for record in reversed(chain):
        role = record.get("type")
        if role not in ("user", "assistant"):
            continue
        text = _public_text(record)
        if not text:
            continue
        if turns and turns[-1][0] == role:
            previous = turns.pop()[1]
            text = previous + "\n\n" + text
        turns.append((role, text))

    if mode == "last":
        output = turns[-1][1] if turns and turns[-1][0] == "assistant" else ""
    else:
        output = "\n\n".join(f"{role.title()}:\n{text}" for role, text in turns)
    if len(output) > MAX_DISPLAY_CHARS:
        output = output[-MAX_DISPLAY_CHARS:]
        truncated = True
    return {"output": output, "mode": mode, "source": "transcript", "truncated": truncated}
