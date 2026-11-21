"""Read-only Claude quota and explicitly confirmed grant operations."""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services.provider_profile_store import ProviderProfileError, get_provider_profile, profile_home
from cli_agent_orchestrator.services.quota_support import QuotaCache, allowance, count, digest, finite, private_json

_USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1"
_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
_cache_store = QuotaCache()


def _credential_path(profile_id: str):
    profile = get_provider_profile(profile_id)
    if profile.provider != ProviderType.CLAUDE_CODE:
        raise ProviderProfileError("Quota requires a Claude profile")
    return profile_home(profile.provider.value, profile_id) / ".credentials.json"


def _read_access_token(profile_id: str) -> str:
    payload = private_json(_credential_path(profile_id))
    oauth = payload.get("claudeAiOauth", payload)
    if isinstance(oauth, dict):
        token = oauth.get("accessToken") or oauth.get("access_token")
        if isinstance(token, str) and token:
            return token
    raise ProviderProfileError("Claude OAuth login unavailable; sign in again")


def _parse_reset(value: Any) -> Optional[str]:
    if value is None or isinstance(value, bool):
        return None
    try:
        if isinstance(value, (int, float)):
            seconds = float(value) / 1000 if float(value) >= 1e12 else float(value)
            return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
        if isinstance(value, str):
            if value.strip().replace(".", "", 1).isdigit():
                return _parse_reset(float(value))
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except (ValueError, OSError, OverflowError):
        pass
    return None


def _quota_row(key: str, value: dict, name: str, field: str = "utilization") -> dict | None:
    used = finite(value.get(field))
    if used is None:
        return None
    used = max(0., min(100., used))
    return {"key": key, "name": name, "used": used, "total": 100.,
            "remaining": 100. - used, "reset_at": _parse_reset(value.get("resets_at"))}


def normalize_claude_usage(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for key, value in payload.items():
        label = {"five_hour": "Session (5h)", "seven_day": "Weekly (7d)"}.get(key)
        if key.startswith("seven_day_"):
            label = f"Weekly {key.removeprefix('seven_day_').replace('_', ' ')} (7d)"
        if label and isinstance(value, dict):
            row = _quota_row(key, value, label)
            if row:
                rows.append(row)
    scoped = payload.get("limits")
    for index, item in enumerate(scoped if isinstance(scoped, list) else []):
        if not isinstance(item, dict) or item.get("kind") != "weekly_scoped":
            continue
        scope = item.get("scope")
        model = scope.get("model") if isinstance(scope, dict) else None
        name = model.get("display_name") if isinstance(model, dict) else None
        if isinstance(name, str) and name.strip():
            row = _quota_row(f"limit_{index}", item, f"Weekly {name} (7d)", "percent")
            if row:
                rows.append(row)
    return rows


def parse_reset_allowance(block: Any, *, now: datetime | None = None) -> dict:
    if not isinstance(block, dict):
        return allowance()
    if block.get("eligible") is not True:
        return allowance("unsupported", "Account is not eligible for manual resets")
    grants = block.get("grants")
    if not isinstance(grants, list):
        return allowance()
    now = now or datetime.now(timezone.utc)
    details, remaining, known = [], 0, True
    selected = None
    seen = set()
    cooldown = _parse_reset(block.get("cooldown_until"))
    cooling = cooldown is not None and datetime.fromisoformat(cooldown) > now
    if block.get("cooldown_until") is not None and cooldown is None:
        cooling = True
    for item in grants:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            known = False
            continue
        if item["id"] in seen:
            return allowance(reason="Duplicate provider grant identifiers; refresh before resetting")
        seen.add(item["id"])
        left = count(item.get("resets_left"))
        start, end = _parse_reset(item.get("starts_at")), _parse_reset(item.get("ends_at"))
        expired = end is not None and datetime.fromisoformat(end) <= now
        future = start is not None and datetime.fromisoformat(start) > now
        timing_unknown = end is None or (item.get("starts_at") is not None and start is None)
        paused = item.get("paused") is True
        clears = item.get("clears")
        valid_clears = isinstance(clears, list) and bool(clears) and all(isinstance(c, str) for c in clears)
        reason = ("Expired" if expired else "Paused" if paused else "Not started" if future else
                  "Grant details unavailable" if timing_unknown or left is None or not valid_clears else
                  "No resets left" if left == 0 else "Cooldown active" if cooling else
                  "Provider has not marked this grant usable now" if item.get("usable_now") is not True else None)
        if left is None:
            known = False
        if left is not None and not expired and not paused and not timing_unknown:
            remaining += left
        detail = {"label": str(item.get("label") or "Limit reset")[:160], "remaining_count": left,
                  "total_count": count(item.get("resets_total")), "starts_at": start, "expires_at": end,
                  "clears": clears if valid_clears else [], "usable_now": reason is None,
                  "disabled_reason": reason}
        details.append(detail)
        if item["id"] == block.get("next_grant_id"):
            selected = (item, detail)
    actionable = selected is not None and selected[1]["usable_now"]
    return allowance("supported", "" if actionable else (selected[1]["disabled_reason"] if selected else "No usable grant selected by provider"),
                     remaining_count=remaining if known else None, can_reset=actionable,
                     cooldown_until=cooldown, weekly_resets_at=_parse_reset(block.get("weekly_resets_at")),
                     details=details, clears=selected[1]["clears"] if selected else [])


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01", "User-Agent": "claude-cli/2.1.322 (external, cli)"}


def _usage(token: str) -> dict:
    response = requests.get(_USAGE_URL, headers=_headers(token), timeout=20, allow_redirects=False)
    if response.status_code in (401, 403, 429):
        return {"status": "rate_limited" if response.status_code == 429 else "reauth_required", "quotas": []}
    if response.status_code != 200:
        raise ProviderProfileError("Claude quota unavailable")
    payload = response.json()
    if not isinstance(payload, dict):
        raise ProviderProfileError("Claude quota response unavailable")
    return {"status": "ok", "quotas": normalize_claude_usage(payload),
            "reset_allowance": parse_reset_allowance(payload.get("cedar_ember"))}


async def get_quota(profile_id: str, *, force: bool = False) -> dict:
    token = _read_access_token(profile_id)
    result = await _cache_store.get(digest(token), lambda: _usage(token), force=force)
    return {**result, "profile_id": profile_id}


def reset_context(profile_id: str) -> tuple[dict, dict]:
    token = _read_access_token(profile_id)
    if _cache_store.cooldowns.get(digest(token), 0) > time.monotonic():
        raise ProviderProfileError("Quota endpoint cooling down; try a fresh preview later")
    response = requests.get(_USAGE_URL, headers=_headers(token), timeout=20, allow_redirects=False)
    if response.status_code == 429:
        _cache_store.cooldowns[digest(token)] = time.monotonic() + 180
    if response.status_code != 200:
        raise ProviderProfileError("Fresh Claude reset eligibility unavailable")
    data = response.json()
    block = data.get("cedar_ember") if isinstance(data, dict) else None
    allowed = parse_reset_allowance(block)
    if not allowed["can_reset"]:
        raise ProviderProfileError(allowed["disabled_reason"])
    grant = block["next_grant_id"]
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", grant):
        raise ProviderProfileError("Invalid provider grant")
    profile = requests.get(_PROFILE_URL, headers=_headers(token), timeout=20, allow_redirects=False)
    data = profile.json() if profile.status_code == 200 else {}
    org = data.get("organization", {}).get("uuid") if isinstance(data, dict) else None
    if not isinstance(org, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", org):
        raise ProviderProfileError("Claude account identity unavailable")
    if _read_access_token(profile_id) != token:
        raise ProviderProfileError("Claude credentials changed; request a new preview")
    context = {"provider": "claude_code", "account_key": digest("claude:" + org),
               "credential": digest(token), "organization": org, "grant": grant, "clears": allowed["clears"]}
    return context, allowed


def consume(profile_id: str, context: dict, request_id: str) -> tuple[str, str | None]:
    token = _read_access_token(profile_id)
    if digest(token) != context["credential"]:
        return "rejected", "Credentials changed; request a new preview"
    response = requests.post(
        f"https://api.anthropic.com/api/organizations/{context['organization']}/reset_rate_limits",
        headers=_headers(token), json={"program": "cedar_ember", "grant_id": context["grant"], "request_id": request_id},
        timeout=20, allow_redirects=False)
    data = response.json()
    if response.ok and isinstance(data, dict) and data.get("result") == "reset":
        return "succeeded", None
    # Unrecognized errors may occur after consumption; never automatically retry.
    return "unknown", "Provider did not confirm reset outcome; verify provider-side outcome"
