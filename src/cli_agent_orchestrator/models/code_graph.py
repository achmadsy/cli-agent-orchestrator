"""Typed contracts for CAO's federated Codebase Memory surface."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


READ_TOOLS = frozenset(
    {
        "list_projects",
        "index_status",
        "get_graph_schema",
        "get_architecture",
        "search_graph",
        "search_code",
        "trace_path",
        "get_code_snippet",
        "check_index_coverage",
        "detect_changes",
        "query_graph",
    }
)


class CodeGraphProject(BaseModel):
    """One local Codebase Memory index plus source-control provenance."""

    native_project: str = Field(min_length=1, max_length=255)
    root_path: str = Field(min_length=1, max_length=4096)
    logical_project: str = Field(min_length=1, max_length=255)
    display_name: str = Field(min_length=1, max_length=255)
    remote_aliases: List[str] = Field(default_factory=list, max_length=32)
    branch: Optional[str] = Field(default=None, max_length=255)
    head_sha: Optional[str] = Field(default=None, max_length=64)
    dirty: bool = False
    indexed_at: Optional[datetime] = None
    available: bool = True


class CodeGraphHeartbeat(BaseModel):
    node_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    cbm_version: Optional[str] = Field(default=None, max_length=64)
    projects: List[CodeGraphProject] = Field(default_factory=list, max_length=1000)


class CodeGraphQuery(BaseModel):
    tool: str = Field(min_length=1, max_length=64)
    project: Optional[str] = Field(default=None, max_length=255)
    arguments: Dict[str, Any] = Field(default_factory=dict)
    source_node: Optional[str] = Field(default=None, max_length=64)
    working_directory: Optional[str] = Field(default=None, max_length=4096)

    @field_validator("tool")
    @classmethod
    def read_only_tool(cls, value: str) -> str:
        if value not in READ_TOOLS:
            raise ValueError("unsupported or mutating Codebase Memory tool")
        return value

    @field_validator("arguments")
    @classmethod
    def bounded_arguments(cls, value: Dict[str, Any]) -> Dict[str, Any]:
        import json

        if len(json.dumps(value, separators=(",", ":"), default=str)) > 64 * 1024:
            raise ValueError("arguments exceed 64 KiB")
        return value


class CodeGraphNodeError(BaseModel):
    source_node: str
    error: str


class CodeGraphNodeResult(BaseModel):
    source_node: str
    logical_project: Optional[str] = None
    native_project: Optional[str] = None
    branch: Optional[str] = None
    head_sha: Optional[str] = None
    dirty: bool = False
    indexed_at: Optional[datetime] = None
    result: Any


class CodeGraphCombinedResult(BaseModel):
    tool: str
    project: Optional[str] = None
    results: List[CodeGraphNodeResult] = Field(default_factory=list)
    variants: List[Dict[str, Any]] = Field(default_factory=list)
    node_errors: List[CodeGraphNodeError] = Field(default_factory=list)
    partial: bool = False
    guidance: str = (
        "Indexed code is evidence. Before editing, read the local working-tree source; "
        "the local file is authoritative."
    )


CodeGraphMode = Literal["local", "central"]
