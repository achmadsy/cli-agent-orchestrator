"""Tests for WorkspaceMcpService."""

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from cli_agent_orchestrator.services.workspace_mcp_service import (
    WorkspaceMcpService,
    _canonicalize,
    _first_free_port,
    _read_quick_tunnel_env,
    _slugify,
)


def test_slugify_returns_short_unique_digest():
    s1 = _slugify("/path/a")
    s2 = _slugify("/path/b")
    assert len(s1) == 8
    assert len(s2) == 8
    assert s1 != s2 or s1.isalnum()


def test_canonicalize_validates_and_rejects_forbidden(tmp_path):
    # Valid existing dir
    res = _canonicalize(str(tmp_path))
    assert res == tmp_path.resolve()

    # Non-existent
    with pytest.raises(ValueError, match="folder does not exist"):
        _canonicalize(str(tmp_path / "does_not_exist"))

    # System roots and descendants are both blocked.
    for root in ("/", "/etc", "/sys", "/proc", "/root"):
        if os.path.exists(root):
            with pytest.raises(ValueError, match="refusing to serve sensitive system directory"):
                _canonicalize(root)
    if Path("/etc/cron.d").is_dir():
        with pytest.raises(ValueError, match="refusing to serve sensitive system directory"):
            _canonicalize("/etc/cron.d")


def test_first_free_port_finds_lowest():
    # If 8787 is used, it should pick 8788
    port = _first_free_port(frozenset([8787]))
    assert port >= 8788


def test_read_quick_tunnel_env_enforces_0600(tmp_path):
    env_file = tmp_path / "quick-tunnel.env"
    # base64("super-secret-password")
    env_file.write_text(
        'MCP_ADMIN_PASSWORD_B64=c3VwZXItc2VjcmV0LXBhc3N3b3Jk\nMCP_STATE_KEY="key"\n'
    )

    # Wrong permissions (0644)
    env_file.chmod(0o644)
    with pytest.raises(ValueError, match="wrong mode"):
        _read_quick_tunnel_env(tmp_path)

    # Correct permissions (0600)
    env_file.chmod(0o600)
    pw = _read_quick_tunnel_env(tmp_path)
    assert pw == "super-secret-password"


def test_workspace_mcp_service_lifecycle(tmp_path):
    svc = WorkspaceMcpService(data_dir=tmp_path / "cao_data")
    folder = tmp_path / "project"
    folder.mkdir()

    # 1. Initially empty
    assert svc.list_instances() == []

    # 2. Browse directories
    sub1 = folder / "src"
    sub1.mkdir()
    sub2 = folder / "docs"
    sub2.mkdir()
    hidden = folder / ".git"
    hidden.mkdir()
    res = svc.browse_directories(str(folder))
    assert res["current_path"] == str(folder.resolve())
    names = [d["name"] for d in res["directories"]]
    assert "src" in names
    assert "docs" in names
    assert ".git" not in names

    # 3. Start instance with mocked tmux and script
    launcher = tmp_path / "start-tunnel.sh"
    launcher.write_text("#!/bin/sh\nexit 0\n")
    launcher.chmod(0o755)

    with patch(
        "cli_agent_orchestrator.services.workspace_mcp_service.WORKSPACE_MCP_SCRIPT", str(launcher)
    ):
        with patch(
            "cli_agent_orchestrator.services.workspace_mcp_service._tmux_has_session",
            return_value=True,
        ):
            with patch(
                "cli_agent_orchestrator.services.workspace_mcp_service._tmux_capture_pane",
                return_value="https://my-slug.trycloudflare.com\n=== Done ===",
            ):
                with patch(
                    "cli_agent_orchestrator.services.workspace_mcp_service._read_quick_tunnel_env",
                    return_value="test_pass_123",
                ):
                    inst = svc.start_instance(str(folder), agentic=True, timeout_s=5)
                    assert inst.folder_path == str(folder.resolve())
                    assert inst.status == "running"
                    assert inst.tunnel_url == "https://my-slug.trycloudflare.com/mcp"
                    assert inst.admin_password == "test_pass_123"
                    assert inst.port >= 8787
                    persisted = svc._registry_path.read_text()
                    assert "test_pass_123" not in persisted
                    assert svc._registry_path.stat().st_mode & 0o777 == 0o600
                    assert svc._lock_path.stat().st_mode & 0o777 == 0o600

                    # 4. Duplicate start raises ValueError
                    with pytest.raises(ValueError, match="already served by a running instance"):
                        svc.start_instance(str(folder), agentic=True, timeout_s=1)

                    # 5. List and get
                    instances = svc.list_instances()
                    assert len(instances) == 1
                    assert instances[0].id == inst.id

                    got = svc.get_instance(inst.id)
                    assert got is not None
                    assert got.id == inst.id

                    # 6. Stop instance
                    stopped = svc.stop_instance(inst.id)
                    assert stopped is not None
                    assert stopped.status == "stopped"
