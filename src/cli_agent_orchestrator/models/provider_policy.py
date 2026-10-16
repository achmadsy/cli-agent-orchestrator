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
