"""Pick a provider account (provider profile) by remaining quota.

Used by Auto routing when ``account_strategy == "quota_desc"``. Returning
``None`` always means "no opinion": terminal creation then resolves the
provider's default account, or the ambient CLI config when no accounts exist.
That keeps a node with zero configured accounts working exactly as today.

Ranking only uses live quota data CAO already exposes (``get_provider_quota``,
currently Claude Code only). An account's score is its *lowest* ``remaining``
row, so an account that is nearly out of its 5-hour window loses even if its
weekly window is full. Fresh data beats stale data on equal scores.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Mapping, Optional, Tuple

from cli_agent_orchestrator.constants import PROVIDERS

logger = logging.getLogger(__name__)

SELECT_TIMEOUT_SECONDS = 5.0


def quota_score(result: Mapping[str, Any]) -> Optional[float]:
    """Return the lowest ``remaining`` value of an ``ok`` quota result, else None."""
    if result.get("status") != "ok":
        return None
    rows = result.get("quotas")
    if not isinstance(rows, list):
        return None
    values: List[float] = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        remaining = row.get("remaining")
        if isinstance(remaining, bool) or not isinstance(remaining, (int, float)):
            continue
        values.append(float(remaining))
    return min(values) if values else None


def rank_quota_results(results: List[Mapping[str, Any]]) -> Optional[str]:
    """Return the profile id with the highest score; fresh beats stale on ties."""
    ranked: List[Tuple[float, int, str]] = []
    for result in results:
        profile_id = result.get("profile_id")
        score = quota_score(result)
        if not isinstance(profile_id, str) or score is None:
            continue
        fresh = 0 if result.get("stale") else 1
        ranked.append((score, fresh, profile_id))
    if not ranked:
        return None
    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return ranked[0][2]


async def _quota_for(profile_id: str) -> Dict[str, Any]:
    from cli_agent_orchestrator.services.provider_quota import get_provider_quota

    try:
        return await get_provider_quota(profile_id)
    except Exception as exc:  # one bad account must not sink the selection
        logger.debug("quota lookup failed for %s: %s", profile_id, type(exc).__name__)
        return {"profile_id": profile_id, "status": "error", "quotas": [], "stale": False}


async def select_provider_profile(
    provider: str, *, timeout: float = SELECT_TIMEOUT_SECONDS
) -> Optional[str]:
    """Return the authenticated account of ``provider`` with the most quota left, or None."""
    if provider not in PROVIDERS:
        return None
    from cli_agent_orchestrator.services.provider_profile_registry import capabilities_for
    from cli_agent_orchestrator.services.provider_profile_store import list_provider_profiles

    try:
        if not capabilities_for(provider).quota:
            return None
        profiles = await asyncio.to_thread(list_provider_profiles, provider)
    except Exception as exc:
        logger.debug("account selection skipped for %s: %s", provider, type(exc).__name__)
        return None

    candidates = [p.id for p in profiles if p.auth_state == "authenticated"]
    if not candidates:
        return None

    try:
        results = await asyncio.wait_for(
            asyncio.gather(*(_quota_for(pid) for pid in candidates)), timeout=timeout
        )
    except asyncio.TimeoutError:
        logger.info("account selection for %s timed out; using default account", provider)
        return None
    return rank_quota_results(list(results))
