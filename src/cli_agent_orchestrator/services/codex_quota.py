"""Subscription quota for isolated Codex CLI OAuth homes (never API keys)."""
from __future__ import annotations

import re
import time
from typing import Any
from datetime import datetime, timezone

import requests

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services.claude_quota import _parse_reset
from cli_agent_orchestrator.services.provider_profile_store import ProviderProfileError, get_provider_profile, profile_home
from cli_agent_orchestrator.services.quota_support import QuotaCache, allowance, count, digest, finite, private_json

_BASE = "https://chatgpt.com/backend-api/wham"
_cache_store = QuotaCache()


def credentials(profile_id: str) -> tuple[str, str]:
    profile = get_provider_profile(profile_id)
    if profile.provider != ProviderType.CODEX:
        raise ProviderProfileError("Quota requires a Codex profile")
    data = private_json(profile_home(profile.provider.value, profile_id) / "auth.json")
    # Codex AuthDotJson's subscription login stores TokenData under tokens.
    # Refuse API-key and future/unknown login modes; never use ambient HOME.
    if data.get("auth_mode") not in (None, "chatgpt") or data.get("OPENAI_API_KEY"):
        raise ProviderProfileError("Codex quota requires a direct ChatGPT OAuth login")
    tokens = data.get("tokens")
    token = tokens.get("access_token") if isinstance(tokens, dict) else None
    account = tokens.get("account_id") if isinstance(tokens, dict) else None
    if (not isinstance(token, str) or not token or not isinstance(account, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", account)):
        raise ProviderProfileError("Codex subscription OAuth identity unavailable; sign in again")
    return token, account


def _headers(token: str, account: str) -> dict:
    return {"Authorization": f"Bearer {token}", "ChatGPT-Account-ID": account,
            "Accept": "application/json", "OpenAI-Beta": "codex-1", "originator": "codex_cli_rs"}


def normalize_codex_usage(data: dict) -> list[dict]:
    rows = []
    by_id = data.get("rate_limits_by_limit_id")
    by_id = by_id if isinstance(by_id, dict) else {}
    windows = [("", data.get("rate_limit") or data.get("rate_limits") or by_id.get("codex")),
               ("Review ", data.get("code_review_rate_limit") or data.get("review_rate_limit") or by_id.get("code_review") or by_id.get("codex_review") or by_id.get("review")),
               ("Spark ", data.get("spark_rate_limit") or data.get("gpt_5_3_codex_spark_rate_limit") or by_id.get("gpt-5.3-codex-spark") or by_id.get("spark"))]
    additional = data.get("additional_rate_limits")
    if isinstance(additional, list):
        for item in additional:
            if not isinstance(item, dict):
                continue
            name = str(item.get("limit_name") or item.get("metered_feature") or item.get("id") or "").lower()
            prefix = "Review " if "review" in name else "Spark " if "spark" in name else None
            if prefix and not any(p == prefix and w for p, w in windows):
                windows.append((prefix, item))
    for prefix, snapshot in windows:
        if not isinstance(snapshot, dict):
            continue
        body = snapshot.get("rate_limit", snapshot)
        if not isinstance(body, dict):
            continue
        for key, label in (("primary", "Session"), ("secondary", "Weekly")):
            window = body.get(key + "_window") or body.get(key) or snapshot.get(key + "_window") or snapshot.get(key)
            if not isinstance(window, dict):
                continue
            used = finite(window.get("used_percent", window.get("percent_used")))
            if used is None:
                continue
            used = min(100., max(0., used))
            rows.append({"key": f"{prefix.strip().lower()}_{key}", "name": prefix + label,
                         "used": used, "total": 100., "remaining": 100. - used,
                         "reset_at": _parse_reset(window.get("reset_at", window.get("resets_at", window.get("resetAt"))))})
    return rows


def parse_credits(data: Any, *, detailed: bool = False) -> dict:
    if not isinstance(data, dict):
        return allowance()
    remaining = count(data.get("available_count", data.get("availableCount")))
    details = []
    for item in data.get("credits", []) if isinstance(data.get("credits"), list) else []:
        if isinstance(item, dict):
            details.append({"label": "Reset credit", "status": str(item.get("status", "unknown"))[:80],
                            "granted_at": _parse_reset(item.get("granted_at", item.get("grantedAt"))),
                            "expires_at": _parse_reset(item.get("expires_at", item.get("expiresAt")))})
    actionable = remaining is not None and remaining > 0
    reason = "" if actionable else "No reset credits available" if remaining == 0 else "Reset count unavailable"
    if detailed and details and actionable:
        now = datetime.now(timezone.utc)
        valid = [item for item in details if item["status"] == "available" and item["expires_at"]
                 and datetime.fromisoformat(item["expires_at"]) > now]
        if len(valid) < remaining:
            actionable, reason = False, "Credit expiry/status does not match available count; refresh before resetting"
    return allowance("supported" if remaining is not None else "unknown", reason,
                     remaining_count=remaining, can_reset=actionable, details=details)


def _read(token: str, account: str, path: str) -> dict:
    response = requests.get(_BASE + path, headers=_headers(token, account), timeout=20, allow_redirects=False)
    if response.status_code in (401, 403, 429):
        return {"status": "rate_limited" if response.status_code == 429 else "reauth_required", "quotas": []}
    if response.status_code != 200:
        raise ProviderProfileError("Codex quota unavailable")
    data = response.json()
    if not isinstance(data, dict):
        raise ProviderProfileError("Codex quota unavailable")
    if path == "/usage":
        return {"status": "ok", "quotas": normalize_codex_usage(data),
                "reset_allowance": parse_credits(data.get("rate_limit_reset_credits"))}
    return {"status": "ok", "quotas": [], "reset_allowance": parse_credits(data, detailed=True)}


async def get_quota(profile_id: str, *, force: bool = False) -> dict:
    token, account = credentials(profile_id)
    result = await _cache_store.get(digest(token + ":" + account), lambda: _read(token, account, "/usage"), force=force)
    return {**result, "profile_id": profile_id}


def credit_details(profile_id: str) -> dict:
    token, account = credentials(profile_id)
    key = digest(token + ":" + account)
    if _cache_store.cooldowns.get(key, 0) > time.monotonic():
        raise ProviderProfileError("Codex quota endpoint cooling down")
    result = _read(token, account, "/rate-limit-reset-credits")
    if result["status"] == "rate_limited":
        _cache_store.cooldowns[key] = time.monotonic() + 180
    if result["status"] != "ok":
        raise ProviderProfileError("Fresh Codex reset information unavailable; re-check login or try later")
    return result["reset_allowance"]


def reset_context(profile_id: str) -> tuple[dict, dict]:
    token, account = credentials(profile_id)
    details = credit_details(profile_id)
    # Read once more after details to detect a concurrent CLI account change.
    if credentials(profile_id) != (token, account):
        raise ProviderProfileError("Codex credentials changed; request a new preview")
    if not details["can_reset"]:
        raise ProviderProfileError(details["disabled_reason"])
    # If both read surfaces supply a count, inconsistent snapshots are not
    # sufficient authorization to spend a credit.
    usage = _read(token, account, "/usage")
    if usage["status"] != "ok":
        if usage["status"] == "rate_limited":
            _cache_store.cooldowns[digest(token + ":" + account)] = time.monotonic() + 180
        raise ProviderProfileError("Fresh Codex usage unavailable")
    usage_count = usage["reset_allowance"]["remaining_count"]
    if usage_count is not None and usage_count != details["remaining_count"]:
        raise ProviderProfileError("Reset credit snapshots changed; request a new preview")
    if credentials(profile_id) != (token, account):
        raise ProviderProfileError("Codex credentials changed; request a new preview")
    return {"provider": "codex", "account_key": digest("codex:" + account),
            "credential": digest(token), "account": account, "clears": []}, details


def consume(profile_id: str, context: dict, request_id: str) -> tuple[str, str | None]:
    token, account = credentials(profile_id)
    if digest(token) != context["credential"] or account != context["account"]:
        return "rejected", "Credentials changed; request a new preview"
    response = requests.post(_BASE + "/rate-limit-reset-credits/consume", headers=_headers(token, account),
                             json={"redeem_request_id": request_id}, timeout=20, allow_redirects=False)
    data = response.json()
    if response.ok and isinstance(data, dict):
        windows = finite(data.get("windows_reset"))
        if data.get("code") == "reset" or (windows is not None and windows > 0):
            return "succeeded", None
        if data.get("code") == "no_credit":
            return "rejected", "No Codex reset credits available"
    return "unknown", "Provider did not confirm reset outcome; verify provider-side outcome"
