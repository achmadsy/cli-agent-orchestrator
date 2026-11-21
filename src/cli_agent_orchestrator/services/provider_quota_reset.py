"""Explicit preview/confirm coordinator. No reset is retried automatically."""
from __future__ import annotations

import asyncio
import time

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services import quota_reset_store as store
from cli_agent_orchestrator.services.provider_profile_store import ProviderProfileError, get_provider_profile


def adapter(profile_id: str):
    provider = get_provider_profile(profile_id).provider
    if provider == ProviderType.CLAUDE_CODE:
        from cli_agent_orchestrator.services import claude_quota
        return claude_quota
    if provider == ProviderType.CODEX:
        from cli_agent_orchestrator.services import codex_quota
        return codex_quota
    raise ProviderProfileError("Manual reset is unsupported for this provider")


def _preview(profile_id: str, owner: str) -> dict:
    epoch = store.generation()
    context, allowed = adapter(profile_id).reset_context(profile_id)
    profile = get_provider_profile(profile_id)
    summary = {"account_display": profile.label, "provider": profile.provider.value,
               "allowance": allowed, "effect": ("Reset only these limits: " + ", ".join(context["clears"]))
               if context["clears"] else "Use one credit to reset eligible Codex rate-limit windows",
               "cost": 1}
    return store.create(profile_id, owner, context["account_key"], context, summary, epoch)


async def preview(profile_id: str, owner: str) -> dict:
    try:
        return await asyncio.to_thread(_preview, profile_id, owner)
    except store.ResetConflict:
        raise
    except Exception:
        # Provider/network/parser exceptions must never leak credentials or URLs.
        raise ProviderProfileError("Fresh reset eligibility unavailable. Re-check login or refresh later.") from None


def _confirm(profile_id: str, owner: str, ident: str) -> dict:
    operation = store.read(ident, profile_id, owner)
    if operation["state"] != "preview":
        return store.public(operation)
    if operation["expires"] <= time.time():
        raise store.ResetConflict("Reset preview expired; request a new preview")
    service = adapter(profile_id)
    try:
        from cli_agent_orchestrator.services.quota_support import digest
        credential = (service.credentials(profile_id)[0] if operation["context"]["provider"] == "codex"
                      else service._read_access_token(profile_id))
        if digest(credential) != operation["context"]["credential"]:
            raise store.ResetConflict("Credentials changed")
        context, allowed = service.reset_context(profile_id)
    except Exception:
        store.reject_preview(ident, "Fresh eligibility unavailable; request a new preview")
        raise store.ResetConflict("Fresh eligibility unavailable; no reset submitted by this request") from None
    prior = operation["summary"]["allowance"]
    terms = ("remaining_count", "expires_at", "cooldown_until", "clears", "details")
    if (context != operation["context"] or not allowed["can_reset"]
            or any(allowed.get(key) != prior.get(key) for key in terms)):
        store.reject_preview(ident, "Account or grant changed; request a new preview")
        raise store.ResetConflict("Account or grant changed; request a new preview")
    # Unique persistent account gate and epoch check close the preflight race.
    # claim commits BEFORE POST; a crash leaves a durable submitted gate.
    store.claim(operation)
    state, reason = "unknown", "Outcome unknown; do not retry. Verify provider-side outcome."
    try:
        state, reason = service.consume(profile_id, context, operation["upstream_id"])
    except Exception:
        pass
    store.finish(ident, state, reason)
    return store.public(store.read(ident, profile_id, owner))


async def confirm(profile_id: str, owner: str, ident: str) -> dict:
    # The worker finishes recording even if the HTTP client disconnects/cancels.
    task = asyncio.create_task(asyncio.to_thread(_confirm, profile_id, owner, ident))
    def retrieve(done: asyncio.Task) -> None:
        if not done.cancelled():
            done.exception()
    task.add_done_callback(retrieve)
    result = await asyncio.shield(task)
    if result["status"] == "succeeded":
        from cli_agent_orchestrator.services.provider_quota import get_provider_quota
        try:
            quota = await get_provider_quota(profile_id, force=True)
            result["quota_refresh"] = "succeeded" if quota["status"] == "ok" and not quota["stale"] else "failed"
            if result["quota_refresh"] == "succeeded":
                result["quota"] = quota
        except Exception:
            result["quota_refresh"] = "failed"
    return result


async def details(profile_id: str) -> dict:
    service = adapter(profile_id)
    if get_provider_profile(profile_id).provider == ProviderType.CODEX:
        return await asyncio.to_thread(service.credit_details, profile_id)
    from cli_agent_orchestrator.services.provider_quota import get_provider_quota
    quota = await get_provider_quota(profile_id, force=True)
    if quota.get("stale") or quota["status"] != "ok":
        raise ProviderProfileError("Fresh reset details unavailable")
    return quota["reset_allowance"]
