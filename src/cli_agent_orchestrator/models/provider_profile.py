"""Named provider-account profiles with no credential-bearing fields."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from cli_agent_orchestrator.models.provider import ProviderType

ProviderAuthState = Literal[
    "unknown", "authenticated", "expired", "unconfigured", "unsupported", "error"
]
ProviderLoginMethod = Literal["isolated_home", "native_profile", "unsupported"]


def utc_now_iso() -> str:
    """Return a stable UTC timestamp for persisted provider-profile metadata."""
    return datetime.now(timezone.utc).isoformat()


class ProviderProfileCreate(BaseModel):
    """Create payload for a provider-account profile."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=128)
    provider: ProviderType
    login_method: ProviderLoginMethod
    settings: Dict[str, Any] = Field(default_factory=dict)
    is_default: bool = False

    @field_validator("provider")
    @classmethod
    def reject_mock_provider(cls, value: ProviderType) -> ProviderType:
        if value == ProviderType.MOCK_CLI:
            raise ValueError("mock_cli provider profiles are test-only and cannot be created")
        return value


class ProviderProfileUpdate(BaseModel):
    """Editable non-secret provider-profile fields."""

    model_config = ConfigDict(extra="forbid")

    label: Optional[str] = Field(default=None, min_length=1, max_length=128)
    settings: Optional[Dict[str, Any]] = None
    is_default: Optional[bool] = None


class ProviderProfile(BaseModel):
    """Public provider-profile metadata. Never contains credentials or paths."""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    provider: ProviderType
    login_method: ProviderLoginMethod
    settings: Dict[str, Any] = Field(default_factory=dict)
    is_default: bool = False
    auth_state: ProviderAuthState = "unknown"
    auth_detail: Optional[str] = None
    last_checked_at: Optional[str] = None
    created_at: str
    updated_at: str
