"""Bounded history-only wire contract. No credentials or executable queue fields."""

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int
    sender_id: str = Field(max_length=128)
    receiver_id: str = Field(max_length=128)
    message: str = Field(max_length=4096)
    status: str = Field(max_length=32)
    channel: str = Field(max_length=32)
    created_at: str = Field(max_length=64)


class HistoryRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    terminal_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    session_name: str = Field(max_length=128)
    incarnation: str | None = Field(default=None, max_length=128)
    name: str = Field(max_length=128)
    provider: str = Field(max_length=64)
    agent_profile: str | None = Field(default=None, max_length=128)
    model: str | None = Field(default=None, max_length=256)
    working_directory: str | None = Field(default=None, max_length=4096)
    caller_id: str | None = Field(default=None, max_length=128)
    last_active: str | None = Field(default=None, max_length=64)
    recorded_at: str = Field(max_length=64)
    lifecycle: Literal["observed", "disconnected", "ended"]
    status: str | None = Field(default=None, max_length=64)
    output: str = Field(default="", max_length=65536)
    output_source: str = Field(default="unavailable", max_length=64)
    output_truncated: bool = False
    inbox: list[HistoryMessage] = Field(default_factory=list, max_length=100)
    inbox_truncated: bool = False


class HistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(gt=0)
    record: HistoryRecord


class HistoryBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: str = Field(pattern=r"^[a-f0-9]{32}$")
    source_node: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    records: list[HistoryItem] = Field(max_length=5)
    cursor: int = Field(ge=0)

    @model_validator(mode="after")
    def ordered(self):
        versions = [item.version for item in self.records]
        if versions != sorted(set(versions)) or (versions and self.cursor != versions[-1]):
            raise ValueError("Invalid history sequence")
        # Bound the encoded request independently of character/multibyte size.
        if len(self.model_dump_json().encode()) > 4 * 1024 * 1024:
            raise ValueError("History batch exceeds byte limit")
        return self
