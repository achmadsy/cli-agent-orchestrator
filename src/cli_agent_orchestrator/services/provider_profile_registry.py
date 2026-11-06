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
    unavailable_reason: str | None = None

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
    ProviderType.CODEX.value: ProviderProfileCapabilities(
        "isolated_home", auth_lifecycle=True, quota=False
    ),
    ProviderType.OPENCODE_CLI.value: ProviderProfileCapabilities(
        "isolated_home", auth_lifecycle=True, quota=False
    ),
    ProviderType.KIMI_CLI.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=True,
        unavailable_reason=(
            "Kimi Code and legacy Kimi use different credential homes. CAO must persist "
            "the CLI dialect before it can isolate accounts safely."
        ),
    ),
    ProviderType.GROK_CLI.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=True,
        unavailable_reason=(
            "Grok currently links each terminal to the ambient ~/.grok credentials, so "
            "named accounts would not be isolated."
        ),
    ),
    ProviderType.COPILOT_CLI.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=True,
        unavailable_reason=(
            "Copilot supports --config-dir, but CAO has not verified that every credential "
            "is contained there."
        ),
    ),
    ProviderType.CURSOR_CLI.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=True,
        unavailable_reason="Cursor CLI has no verified credential-home override.",
    ),
    ProviderType.KIRO_CLI.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=True,
        unavailable_reason="Kiro CLI has no verified credential-home override.",
    ),
    ProviderType.ANTIGRAVITY_CLI.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=True,
        unavailable_reason=(
            "Antigravity uses shared ~/.gemini state and has no verified credential-home override."
        ),
    ),
    ProviderType.MINIMAX_CODE.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=True,
        unavailable_reason=(
            "MiniMax currently copies ambient credentials into temporary terminal data that is "
            "deleted during cleanup; durable account storage must be separated first."
        ),
    ),
    ProviderType.HERMES.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=False,
        unavailable_reason=(
            "Hermes agent aliases do not provide a verified isolated credential boundary."
        ),
    ),
    ProviderType.OMP.value: ProviderProfileCapabilities(
        "unsupported",
        auth_lifecycle=False,
        quota=False,
        unavailable_reason=(
            "OMP config overlays do not provide a verified isolated credential boundary."
        ),
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
            "unavailable_reason": capabilities.unavailable_reason,
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
