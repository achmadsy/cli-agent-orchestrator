"""Quota dispatch for named provider-account profiles."""

from __future__ import annotations

from typing import Any, Dict

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services.provider_profile_registry import capabilities_for
from cli_agent_orchestrator.services.provider_profile_store import get_provider_profile


async def get_provider_quota(profile_id: str, *, force: bool = False) -> Dict[str, Any]:
    """Return normalized quota or an explicit unavailable result."""
    profile = get_provider_profile(profile_id)
    capabilities = capabilities_for(profile.provider.value)
    if not capabilities.quota:
        return {
            "profile_id": profile.id,
            "provider": profile.provider.value,
            "status": "unavailable",
            "quotas": [],
            "stale": False,
        }

    if profile.provider in (ProviderType.CLAUDE_CODE, ProviderType.CODEX):
        if profile.provider == ProviderType.CLAUDE_CODE:
            from cli_agent_orchestrator.services.claude_quota import get_quota
        else:
            from cli_agent_orchestrator.services.codex_quota import get_quota
        result = await get_quota(profile.id, force=force)
        from cli_agent_orchestrator.services.quota_support import allowance
        from cli_agent_orchestrator.services.quota_reset_store import blocked_profile
        reset = dict(result.get("reset_allowance") or allowance())
        blocked = blocked_profile(profile.id)
        if blocked or result.get("stale") or result["status"] != "ok":
            reset.update(can_reset=False, disabled_reason=(
                "Reset outcome unconfirmed; verify provider-side outcome" if blocked else "Fresh quota required before reset"))
        return {**result, "provider": profile.provider.value, "reset_allowance": reset, "reset_operation_id": blocked}

    # Quota protocol exists for some providers, but CAO cannot bind it to a
    # credential until that CLI's account-profile isolation is verified.
    return {
        "profile_id": profile.id,
        "provider": profile.provider.value,
        "status": "unavailable",
        "quotas": [],
        "stale": False,
    }
