"""Read-only Claude subscription quota for isolated provider profiles."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import stat
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services.provider_profile_store import (
    ProviderProfileError,
    get_provider_profile,
    profile_home,
)

_USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
_CACHE_TTL_SECONDS = 300.0
_RATE_LIMIT_COOLDOWN_SECONDS = 180.0
_cache: Dict[str, Dict[str, Any]] = {}
_inflight: Dict[str, asyncio.Task] = {}
_cooldowns: Dict[str, float] = {}
_lock = asyncio.Lock()


def _credential_path(profile_id: str) -> Path:
    profile = get_provider_profile(profile_id)
    if profile.provider != ProviderType.CLAUDE_CODE:
        raise ProviderProfileError("quota is only supported for claude_code profiles")
    return profile_home(profile.provider.value, profile_id) / ".credentials.json"


def _read_access_token(profile_id: str) -> str:
    path = _credential_path(profile_id)
    if not path.is_file() or path.is_symlink():
        raise ProviderProfileError("Claude account is not signed in")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise ProviderProfileError("Claude credential file permissions are not private")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProviderProfileError("Claude credential file is unreadable") from exc

    candidates = [payload]
    oauth = payload.get("claudeAiOauth") if isinstance(payload, dict) else None
    if isinstance(oauth, dict):
        candidates.insert(0, oauth)
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        for key in ("accessToken", "access_token"):
            value = candidate.get(key)
            if isinstance(value, str) and value:
                return value
    raise ProviderProfileError("Claude OAuth credential is unavailable; sign in again")


def _parse_reset(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            seconds = float(value) / 1000 if float(value) >= 1e12 else float(value)
            return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
        if isinstance(value, str):
            numeric = value.strip()
            if numeric.replace(".", "", 1).isdigit():
                return _parse_reset(float(numeric))
            parsed = datetime.fromisoformat(numeric.replace("Z", "+00:00"))
            return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, OSError, OverflowError):
        return None
    return None


def _quota_row(key: str, value: Dict[str, Any], name: str) -> Dict[str, Any]:
    used = max(0.0, min(100.0, float(value.get("utilization") or 0)))
    return {
        "key": key,
        "name": name,
        "used": used,
        "total": 100.0,
        "remaining": max(0.0, 100.0 - used),
        "reset_at": _parse_reset(value.get("resets_at")),
    }


def normalize_claude_usage(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Normalize Claude's usage response without inventing absent limits."""
    rows: List[Dict[str, Any]] = []
    labels = {"five_hour": "Session (5h)", "seven_day": "Weekly (7d)"}
    for key, label in labels.items():
        value = payload.get(key)
        if isinstance(value, dict):
            rows.append(_quota_row(key, value, label))

    for key, value in payload.items():
        if key.startswith("seven_day_") and isinstance(value, dict):
            model = key.removeprefix("seven_day_").replace("_", " ")
            rows.append(_quota_row(key, value, f"Weekly {model} (7d)"))

    scoped = payload.get("limits")
    if isinstance(scoped, list):
        for index, item in enumerate(scoped):
            if not isinstance(item, dict):
                continue
            scope = item.get("scope")
            model = scope.get("model") if isinstance(scope, dict) else None
            display = model.get("display_name") if isinstance(model, dict) else None
            if isinstance(display, str) and display:
                rows.append(_quota_row(f"limit_{index}", item, f"Weekly {display} (7d)"))
    return rows


def _fetch(token: str) -> Dict[str, Any]:
    response = requests.get(
        _USAGE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "User-Agent": "claude-cli/2.1 (external, cli)",
        },
        timeout=20,
    )
    if response.status_code == 401:
        return {"status": "reauth_required", "quotas": []}
    if response.status_code == 429:
        return {"status": "rate_limited", "quotas": []}
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ProviderProfileError("Claude quota response has an invalid shape")
    return {"status": "ok", "quotas": normalize_claude_usage(payload)}


async def get_quota(profile_id: str, *, force: bool = False) -> Dict[str, Any]:
    token = _read_access_token(profile_id)
    cache_key = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.monotonic()
    cached = _cache.get(cache_key)
    if not force and cached and cached["expires_at"] > now:
        return {**cached["result"], "profile_id": profile_id, "stale": False}
    if _cooldowns.get(cache_key, 0) > now and cached:
        return {**cached["result"], "profile_id": profile_id, "stale": True}

    async with _lock:
        task = _inflight.get(cache_key)
        if task is None:
            task = asyncio.create_task(asyncio.to_thread(_fetch, token))
            _inflight[cache_key] = task
    try:
        result = await task
    except Exception:
        if cached:
            return {**cached["result"], "profile_id": profile_id, "stale": True}
        return {"profile_id": profile_id, "status": "error", "quotas": [], "stale": False}
    finally:
        async with _lock:
            if _inflight.get(cache_key) is task:
                _inflight.pop(cache_key, None)

    if result["status"] == "rate_limited":
        _cooldowns[cache_key] = now + _RATE_LIMIT_COOLDOWN_SECONDS
        if cached:
            return {**cached["result"], "profile_id": profile_id, "stale": True}
    if result["status"] == "ok":
        _cache[cache_key] = {"result": result, "expires_at": now + _CACHE_TTL_SECONDS}
    return {**result, "profile_id": profile_id, "stale": False}
