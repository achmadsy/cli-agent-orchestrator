"""Provider-profile capabilities and closed non-secret settings validation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping

from cli_agent_orchestrator.models.provider import ProviderType


@dataclass(frozen=True)
class ProviderProfileCapabilities:
    profile_mode: str
    auth_lifecycle: bool
    quota: bool
    resume: bool = False

    @property
    def supported(self) -> bool:
        return self.profile_mode != "unsupported"


# Conservative declarations: a provider becomes selectable only when CAO has a
# verified way to keep account/config state separate. Quota support is separate;
# unsupported account isolation must never be hidden by an available HTTP adapter.
PROFILE_CAPABILITIES: Mapping[str, ProviderProfileCapabilities] = {
    ProviderType.CLAUDE_CODE.value: ProviderProfileCapabilities(
        "isolated_home", auth_lifecycle=True, quota=True, resume=True
    ),
    # Account isolation for these providers has not yet been verified against
    # an installed CLI. Keep them visible to capability/quota callers, but do
    # not allow profile creation or imply that an agent-level preset isolates
    # credentials.
    ProviderType.CODEX.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.KIMI_CLI.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.GROK_CLI.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.COPILOT_CLI.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.CURSOR_CLI.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.KIRO_CLI.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.ANTIGRAVITY_CLI.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.MINIMAX_CODE.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=True
    ),
    ProviderType.OPENCODE_CLI.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=False
    ),
    ProviderType.HERMES.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=False
    ),
    ProviderType.OMP.value: ProviderProfileCapabilities(
        "unsupported", auth_lifecycle=False, quota=False
    ),
}


def capabilities_for(provider: str) -> ProviderProfileCapabilities:
    try:
        return PROFILE_CAPABILITIES[provider]
    except KeyError as exc:
        raise ValueError(f"provider '{provider}' does not support account profiles") from exc


def public_capabilities() -> Dict[str, Dict[str, Any]]:
    """Return JSON-safe capabilities for every canonical non-test provider."""
    return {
        provider: {
            "supported": capabilities.supported,
            "profile_mode": capabilities.profile_mode,
            "auth_lifecycle": capabilities.auth_lifecycle,
            "quota": capabilities.quota,
            "resume": capabilities.resume,
        }
        for provider, capabilities in PROFILE_CAPABILITIES.items()
    }


def validate_profile_settings(provider: str, settings: Mapping[str, Any]) -> Dict[str, Any]:
    """Validate a closed, non-secret provider-settings object.

    Native-profile adapters accept only one opaque profile name. Isolated-home
    adapters derive their path from the profile ID and accept no path or token.
    """
    capabilities = capabilities_for(provider)
    if not capabilities.supported:
        raise ValueError(f"provider '{provider}' does not support isolated account profiles")
    data = dict(settings)
    if capabilities.profile_mode == "isolated_home":
        if data:
            raise ValueError(f"provider '{provider}' profile settings must be empty")
        return {}
    allowed = {"native_profile"}
    unknown = set(data) - allowed
    if unknown:
        raise ValueError(f"unsupported provider profile setting(s): {', '.join(sorted(unknown))}")
    native_profile = data.get("native_profile")
    if not isinstance(native_profile, str) or not native_profile.strip():
        raise ValueError("native_profile is required for this provider")
    if len(native_profile) > 128 or any(ord(ch) < 0x20 for ch in native_profile):
        raise ValueError("native_profile is invalid")
    return {"native_profile": native_profile.strip()}
