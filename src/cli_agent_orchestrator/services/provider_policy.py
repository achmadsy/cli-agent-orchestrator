"""Provider-role resolution without changing custom profile behavior."""

from __future__ import annotations

import json
import logging
from typing import Dict, Mapping, Optional

from cli_agent_orchestrator.models.provider_policy import RoleProviderPolicy
from cli_agent_orchestrator.utils.agent_profiles import load_launch_profile

logger = logging.getLogger(__name__)

_RECOGNIZED_ROLES = frozenset({"supervisor", "developer", "reviewer"})
_BUILTIN_NAME_ROLES = {
    "code_supervisor": "supervisor",
    "developer": "developer",
    "reviewer": "reviewer",
}


def profile_role(profile_name: str) -> Optional[str]:
    """Return a recognized role from profile metadata or exact built-in fallback."""
    try:
        profile, _source = load_launch_profile(profile_name)
    except (FileNotFoundError, RuntimeError):
        return _BUILTIN_NAME_ROLES.get(profile_name)
    if profile.role in _RECOGNIZED_ROLES:
        return profile.role
    return _BUILTIN_NAME_ROLES.get(profile_name)


def resolve_role_provider(
    profile_name: str,
    authored_provider: str,
    role_providers: Optional[Mapping[str, str]],
) -> str:
    """Apply a matching role override, preserving authored provider otherwise."""
    role = profile_role(profile_name)
    if role is None or not role_providers:
        return authored_provider
    return role_providers.get(role, authored_provider)


def parse_role_policy_mapping(value: object) -> Dict[str, str]:
    """Validate an untrusted metadata value, degrading invalid policy to empty."""
    if not isinstance(value, Mapping):
        return {}
    try:
        return RoleProviderPolicy(**dict(value)).compact()
    except (ValueError, TypeError) as exc:
        logger.debug("role provider metadata corrupt; using empty policy: %s", exc)
        return {}


def parse_stored_policy(raw: Optional[str]) -> Dict[str, str]:
    """Parse durable ``role_providers_json`` fail-open to empty policy.

    Additive optional field: corrupt stored value degrades to {} (current
    behavior), never to run-absent. Corrupt spec/inputs still fail closed
    in ``_rebuild_record_from_journal``; policy alone must not 404 a run.
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("role_providers_json is not a JSON object")
        return RoleProviderPolicy(**parsed).compact()
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        logger.debug("stored role policy corrupt; using empty policy: %s", exc)
        return {}
