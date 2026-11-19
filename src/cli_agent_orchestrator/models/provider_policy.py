"""Typed provider policy shared by workflow runs and delegated agents."""

from __future__ import annotations

from typing import Dict, Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator

import re

from cli_agent_orchestrator.constants import PROVIDERS

ProviderRole = Literal["supervisor", "developer", "reviewer"]

PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class RoleProviderProfilePolicy(BaseModel):
    """Optional provider-account profile overrides for orchestration roles."""

    model_config = ConfigDict(extra="forbid")

    supervisor: Optional[str] = None
    developer: Optional[str] = None
    reviewer: Optional[str] = None

    @field_validator("supervisor", "developer", "reviewer")
    @classmethod
    def validate_profile_id(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not PROFILE_ID_RE.fullmatch(value):
            raise ValueError("provider profile id must match [A-Za-z0-9_-]{1,64}")
        return value

    def compact(self) -> Dict[str, str]:
        return {
            key: value
            for key, value in self.model_dump().items()
            if isinstance(value, str)
        }


PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_MAX_MODEL_LEN = 256


class ProfileRoute(BaseModel):
    """Provider/model override for one worker agent profile, keyed by profile name.

    Unlike ``RoleProviderPolicy`` this routes by profile NAME, so profiles that
    share a role (``planner`` and ``reviewer`` are both ``role: reviewer``) can
    still be sent to different CLIs.
    """

    model_config = ConfigDict(extra="forbid")

    provider: Optional[str] = None
    model: Optional[str] = None
    # Account (provider profile ID) for the route's provider. Used only when the
    # launch runs on that same provider, like ``model``.
    provider_profile: Optional[str] = None

    @field_validator("provider")
    @classmethod
    def validate_provider(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in PROVIDERS:
            raise ValueError(
                f"unknown provider '{value}' (accepted: {', '.join(sorted(PROVIDERS))})"
            )
        return value

    @field_validator("provider_profile")
    @classmethod
    def validate_provider_profile(cls, value: Optional[str]) -> Optional[str]:
        if value is None or value == "":
            return None
        if not PROFILE_ID_RE.fullmatch(value):
            raise ValueError("provider profile id must match [A-Za-z0-9_-]{1,64}")
        return value

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        if len(stripped) > _MAX_MODEL_LEN or any(ch.isspace() for ch in stripped):
            raise ValueError("model must be a single token of at most 256 characters")
        return stripped

    def compact(self) -> Dict[str, str]:
        return {key: value for key, value in self.model_dump().items() if isinstance(value, str)}


class RoleProviderPolicy(BaseModel):
    """Optional provider overrides for CAO's three recognized orchestration roles."""

    model_config = ConfigDict(extra="forbid")

    supervisor: Optional[str] = None
    developer: Optional[str] = None
    reviewer: Optional[str] = None

    @field_validator("supervisor", "developer", "reviewer")
    @classmethod
    def validate_provider(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in PROVIDERS:
            raise ValueError(
                f"unknown provider '{value}' (accepted: {', '.join(sorted(PROVIDERS))})"
            )
        return value

    def compact(self) -> Dict[str, str]:
        return {
            key: value
            for key, value in self.model_dump().items()
            if isinstance(value, str)
        }
