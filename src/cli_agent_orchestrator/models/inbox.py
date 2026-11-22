"""Inbox message models."""

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field, field_validator


class OrchestrationType(str, Enum):
    """Orchestration mode for a message delivery."""

    SEND_MESSAGE = "send_message"
    HANDOFF = "handoff"
    ASSIGN = "assign"


class MessageStatus(str, Enum):
    """Message status enumeration."""

    PENDING = "pending"
    DELIVERED = "delivered"
    FAILED = "failed"


class MessageChannel(str, Enum):
    """How a message reached the receiver.

    ``queued`` messages wait in the inbox and are typed in when the receiver is
    ready. ``direct`` rows are a record of input CAO already typed straight into
    the terminal; they are written with a final status and are never delivered
    by the inbox service.
    """

    QUEUED = "queued"
    DIRECT = "direct"


class InboxMessage(BaseModel):
    """Inbox message model."""

    id: int = Field(..., description="Message ID")
    sender_id: str = Field(..., description="Sender terminal ID")
    receiver_id: str = Field(..., description="Receiver terminal ID")
    message: str = Field(..., description="Message content")
    status: MessageStatus = Field(..., description="Message status")
    created_at: datetime = Field(..., description="Creation timestamp (UTC)")
    channel: MessageChannel = Field(MessageChannel.QUEUED, description="Delivery channel")
    history_terminal_id: str | None = Field(
        None, description="Original lineage terminal for a historical row; display only"
    )

    @field_validator("created_at")
    @classmethod
    def _created_at_is_utc(cls, v: datetime) -> datetime:
        return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v
