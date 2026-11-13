"""Storage-independent memory outcomes shared by HTTP clients and services."""
from dataclasses import dataclass
from typing import Literal, Optional

MEMORY_DISABLED_MESSAGE = (
    "memory subsystem is disabled. Set memory.enabled=true in settings.json to re-enable."
)
MEMORY_MANAGER_PROFILE = "memory_manager"


class MemoryDisabledError(RuntimeError):
    """The hosted or local memory subsystem is disabled."""


class MemoryPartialWriteError(RuntimeError):
    """Durable wiki projections outlived a failed metadata write."""

    error_kind = "memory_metadata_partial_write"
    repair_command = "cao memory repair --apply"

    def __init__(self, *, key: str, scope: str, scope_id: Optional[str], file_path: str):
        self.key, self.scope, self.scope_id, self.file_path = key, scope, scope_id, file_path
        self.completed_phases = ["wiki", "index"]
        super().__init__(
            "Memory content and index were saved, but SQLite metadata could not be updated. "
            f"Run `{self.repair_command}`."
        )


@dataclass(frozen=True)
class ForgetResult:
    """Content-free deletion/deindexing result; truthiness preserves legacy API."""

    action: Literal["deleted", "deindexed", "deleted_and_deindexed", "absent"]
    source_kind: Literal["native", "vault", "both"] | None
    path: str | None
    paths: tuple[str, ...] = ()

    def __bool__(self) -> bool:
        return self.action != "absent"
