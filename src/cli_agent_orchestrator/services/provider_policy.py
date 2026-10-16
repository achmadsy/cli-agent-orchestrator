"""Provider-role resolution without changing custom profile behavior."""

from __future__ import annotations

import json
import logging
from typing import Dict, Mapping, Optional

from cli_agent_orchestrator.models.provider_policy import (
    RoleProviderPolicy,
    RoleProviderProfilePolicy,
)
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


def resolve_role_provider_profile(
    profile_name: str,
    explicit_profile: Optional[str],
    role_provider_profiles: Optional[Mapping[str, str]],
) -> Optional[str]:
    """Apply a matching role profile override; explicit per-step value wins.

    Returns ``explicit_profile`` unchanged when given (a step/request override
    always beats the role policy). Otherwise resolves the agent profile's role
    and returns the role policy's entry, or ``None`` when neither applies.
    ``None`` means "no override" — ``terminal_service`` then falls back to the
    agent profile default / provider default. Ownership (profile belongs to the
    step's provider) is validated by ``terminal_service`` at creation, not here.
    """
    if explicit_profile is not None:
        return explicit_profile
    role = profile_role(profile_name)
    if role is None or not role_provider_profiles:
        return None
    return role_provider_profiles.get(role)


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


def parse_stored_profile_policy(raw: Optional[str]) -> Dict[str, str]:
    """Parse durable ``role_provider_profiles_json`` fail-open to empty policy.

    Same posture as :func:`parse_stored_policy`: corrupt value degrades to {},
    never to run-absent. Values are profile ids (no secrets); nothing logged
    beyond the existing debug line shape.
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("role_provider_profiles_json is not a JSON object")
        return RoleProviderProfilePolicy(**parsed).compact()
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        logger.debug("stored role profile policy corrupt; using empty policy: %s", exc)
        return {}
