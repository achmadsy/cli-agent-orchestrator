"""Models for workspace-backed MCP instances."""

from typing import List, Optional
from pydantic import BaseModel, Field


class WorkspaceMcpInstance(BaseModel):
    """Folder-backed workspace MCP server instance."""

    id: str = Field(..., description="Unique instance identifier (e.g. wmcp-xxxx)")
    folder_path: str = Field(..., description="Absolute canonical directory path")
    agentic: bool = Field(
        True, description="Whether agentic tools (bwrap sandbox, exec, git) are enabled"
    )
    port: int = Field(..., description="Allocated local HTTP port for workspace-mcp")
    state_dir: str = Field(
        ..., description="Instance-isolated state directory (~/.local/share/workspace-mcp/...)"
    )
    tmux_socket: str = Field(..., description="Isolated tmux socket name")
    tmux_session: str = Field(..., description="Isolated tmux session name")
    status: str = Field(
        "starting", description="Instance lifecycle status: starting, running, failed, stopped"
    )
    tunnel_url: Optional[str] = Field(
        None, description="Public TryCloudflare URL (https://*.trycloudflare.com)"
    )
    admin_password: Optional[str] = Field(
        None, description="Admin password from quick-tunnel.env (mode 0600)"
    )
    created_at: str = Field(..., description="UTC ISO-8601 creation timestamp")
    error: Optional[str] = Field(
        None, description="Error or failure detail if initialization fails"
    )


class CreateWorkspaceMcpRequest(BaseModel):
    """Request payload to spawn a new workspace MCP instance."""

    folder_path: str = Field(..., description="Local folder path to expose as MCP server")
    agentic: bool = Field(True, description="Enable agentic execution and git write tools")


class BrowseDirectoryItem(BaseModel):
    """Directory entry for directory browsing."""

    name: str = Field(..., description="Directory name")
    path: str = Field(..., description="Full absolute path")


class BrowseDirectoriesResponse(BaseModel):
    """Response containing directory suggestions."""

    current_path: str = Field(..., description="Resolved current directory path")
    parent_path: Optional[str] = Field(None, description="Parent directory path if traversable")
    directories: List[BrowseDirectoryItem] = Field(
        default_factory=list, description="Subdirectories in path"
    )
