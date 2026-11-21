"""Private credential reads and bounded, generation-fenced quota caching."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import stat
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from cli_agent_orchestrator.services.provider_profile_store import ProviderProfileError


def private_json(path: Path) -> dict:
    """Read an owner-only regular file without following a final symlink."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 1024 * 1024):
                raise ValueError
            data = json.load(stream)
            if not isinstance(data, dict):
                raise ValueError
            return data
    except (OSError, ValueError, UnicodeError):
        raise ProviderProfileError("Private OAuth credentials unavailable; sign in again") from None


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def count(value: Any) -> int | None:
    number = finite(value)
    return int(number) if number is not None and number >= 0 and number.is_integer() else None


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def allowance(status: str = "unknown", reason: str = "Reset information unavailable", **values: Any) -> dict:
    return {"status": status, "remaining_count": None, "can_reset": False,
            "disabled_reason": reason, "observed_at": iso_now(), "details": [], **values}


class QuotaCache:
    """Deduplicate reads, honor 429 cooldown and discard reads spanning a mutation.

    A durable global generation intentionally invalidates *all* quota entries on
    reset. This small fleet favors safe alias/worker fencing over cache precision.
    """
    def __init__(self) -> None:
        self.entries: dict = {}
        self.inflight: dict = {}
        self.cooldowns: dict = {}

    async def get(self, key: str, fetch: Callable[[], dict], *, force: bool = False) -> dict:
        from cli_agent_orchestrator.services.quota_reset_store import generation
        epoch = generation()
        cache_key = (key, epoch)
        now = time.monotonic()
        cached = self.entries.get(cache_key)
        if self.cooldowns.get(key, 0) > now:
            result = cached[1] if cached else {"status": "rate_limited", "quotas": []}
            return {**result, "stale": True}
        if not force and cached and cached[0] > now:
            return {**cached[1], "stale": False}
        task = self.inflight.get(cache_key)
        if task is None:
            task = asyncio.create_task(asyncio.to_thread(fetch))
            self.inflight[cache_key] = task
            # Shielded workers own cleanup even if the requesting client leaves.
            def cleanup(done: asyncio.Task) -> None:
                if self.inflight.get(cache_key) is done:
                    self.inflight.pop(cache_key, None)
                if not done.cancelled():
                    done.exception()
            task.add_done_callback(cleanup)
        try:
            result = await asyncio.shield(task)
        except Exception:
            result = cached[1] if cached and generation() == epoch else {"status": "error", "quotas": []}
            return {**result, "stale": True}
        if generation() != epoch:
            return {"status": "refresh_required", "quotas": [], "stale": True,
                    "reset_allowance": allowance(reason="Quota changed; refresh before resetting")}
        if result["status"] == "rate_limited":
            self.cooldowns[key] = time.monotonic() + 180
            return {**(cached[1] if cached else result), "stale": True}
        if result["status"] == "ok":
            # Keep storage bounded; an epoch change makes old entries unreachable.
            if len(self.entries) >= 256:
                self.entries.clear()
            self.entries[cache_key] = (time.monotonic() + 300, result)
        return {**result, "stale": False}
