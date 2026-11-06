"""Tests for /workspace-mcp REST API endpoints."""

from unittest.mock import MagicMock, patch
import pytest

from cli_agent_orchestrator.models.workspace_mcp import WorkspaceMcpInstance


@pytest.fixture
def mock_service():
    with patch("cli_agent_orchestrator.api.main._workspace_mcp_service") as mock_get_svc:
        svc = MagicMock()
        mock_get_svc.return_value = svc
        yield svc


def test_list_workspace_mcp(client, mock_service):
    mock_service.list_instances.return_value = [
        WorkspaceMcpInstance(
            id="wmcp-11111111",
            folder_path="/home/ubuntu/workspace/repo-a",
            agentic=True,
            port=8787,
            state_dir="/home/ubuntu/.local/share/workspace-mcp/instances/wmcp-11111111",
            tmux_socket="wmcp-11111111",
            tmux_session="wmcp-11111111",
            status="running",
            tunnel_url="https://slug-a.trycloudflare.com",
            admin_password="pass",
            created_at="2026-10-17T00:00:00Z",
            error=None,
        )
    ]
    resp = client.get("/workspace-mcp")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["id"] == "wmcp-11111111"
    assert data[0]["status"] == "running"
    assert data[0]["tunnel_url"] == "https://slug-a.trycloudflare.com"
    assert data[0]["admin_password"] is None


def test_get_workspace_mcp_by_id(client, mock_service):
    mock_service.get_instance.return_value = WorkspaceMcpInstance(
        id="wmcp-11111111",
        folder_path="/home/ubuntu/workspace/repo-a",
        agentic=True,
        port=8787,
        state_dir="/home/ubuntu/.local/share/workspace-mcp/instances/wmcp-11111111",
        tmux_socket="wmcp-11111111",
        tmux_session="wmcp-11111111",
        status="running",
        tunnel_url="https://slug-a.trycloudflare.com",
        admin_password="pass",
        created_at="2026-10-17T00:00:00Z",
        error=None,
    )
    resp = client.get("/workspace-mcp/wmcp-11111111")
    assert resp.status_code == 200
    assert resp.json()["id"] == "wmcp-11111111"
    assert resp.json()["admin_password"] is None

    # 404 for unknown
    mock_service.get_instance.return_value = None
    resp404 = client.get("/workspace-mcp/unknown-id")
    assert resp404.status_code == 404


def test_create_workspace_mcp_success(client, mock_service):
    mock_service.start_instance.return_value = WorkspaceMcpInstance(
        id="wmcp-22222222",
        folder_path="/home/ubuntu/workspace/repo-b",
        agentic=True,
        port=8788,
        state_dir="/home/ubuntu/.local/share/workspace-mcp/instances/wmcp-22222222",
        tmux_socket="wmcp-22222222",
        tmux_session="wmcp-22222222",
        status="running",
        tunnel_url="https://slug-b.trycloudflare.com",
        admin_password="pass",
        created_at="2026-10-17T00:00:00Z",
        error=None,
    )
    resp = client.post(
        "/workspace-mcp",
        json={"folder_path": "/home/ubuntu/workspace/repo-b", "agentic": True},
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == "wmcp-22222222"
    assert resp.json()["admin_password"] == "pass"
    mock_service.start_instance.assert_called_once_with(
        "/home/ubuntu/workspace/repo-b", True, timeout_s=60
    )


def test_create_workspace_mcp_errors(client, mock_service):
    # 409 when folder is already served
    mock_service.start_instance.side_effect = ValueError(
        "folder already served by a running instance wmcp-1234"
    )
    resp409 = client.post(
        "/workspace-mcp",
        json={"folder_path": "/home/ubuntu/workspace/repo-b", "agentic": True},
    )
    assert resp409.status_code == 409

    # 400 for bad directory
    mock_service.start_instance.side_effect = ValueError("not a directory: /bad")
    resp400 = client.post(
        "/workspace-mcp",
        json={"folder_path": "/bad", "agentic": True},
    )
    assert resp400.status_code == 400

    # 504 for timeout during initialization
    mock_service.start_instance.side_effect = RuntimeError(
        "timed out polling for TryCloudflare URL"
    )
    resp504 = client.post(
        "/workspace-mcp",
        json={"folder_path": "/home/ubuntu/workspace/repo-b", "agentic": True},
    )
    assert resp504.status_code == 504


def test_delete_workspace_mcp(client, mock_service):
    mock_service.stop_instance.return_value = WorkspaceMcpInstance(
        id="wmcp-11111111",
        folder_path="/home/ubuntu/workspace/repo-a",
        agentic=True,
        port=8787,
        state_dir="/home/ubuntu/.local/share/workspace-mcp/instances/wmcp-11111111",
        tmux_socket="wmcp-11111111",
        tmux_session="wmcp-11111111",
        status="stopped",
        tunnel_url=None,
        admin_password=None,
        created_at="2026-10-17T00:00:00Z",
        error=None,
    )
    resp = client.delete("/workspace-mcp/wmcp-11111111")
    assert resp.status_code == 200
    assert resp.json()["status"] == "stopped"

    # 404 when stopping unknown
    mock_service.stop_instance.return_value = None
    resp404 = client.delete("/workspace-mcp/nonexistent")
    assert resp404.status_code == 404


def test_browse_directories(client, mock_service):
    mock_service.browse_directories.return_value = {
        "current_path": "/home/ubuntu/workspace",
        "parent_path": "/home/ubuntu",
        "directories": [
            {"name": "repo-a", "path": "/home/ubuntu/workspace/repo-a"},
            {"name": "repo-b", "path": "/home/ubuntu/workspace/repo-b"},
        ],
    }
    resp = client.get("/workspace-mcp/browse-directories?path=%2Fhome%2Fubuntu%2Fworkspace")
    assert resp.status_code == 200
    data = resp.json()
    assert data["current_path"] == "/home/ubuntu/workspace"
    assert len(data["directories"]) == 2
