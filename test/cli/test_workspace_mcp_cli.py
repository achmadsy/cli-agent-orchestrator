"""Tests for `cao workspace-mcp` CLI commands."""

import json
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from cli_agent_orchestrator.cli.commands.workspace_mcp import workspace_mcp
from cli_agent_orchestrator.cli.main import cli
from cli_agent_orchestrator.models.workspace_mcp import WorkspaceMcpInstance


def _instance(**overrides):
    base = dict(
        id="wmcp-abcdef12",
        folder_path="/home/ubuntu/workspace/repo-a",
        agentic=True,
        port=8787,
        state_dir="/home/ubuntu/.local/share/workspace-mcp/instances/wmcp-abcdef12",
        tmux_socket="wmcp-abcdef12",
        tmux_session="wmcp-abcdef12",
        status="running",
        tunnel_url="https://my-slug.trycloudflare.com",
        admin_password="secret-password",
        created_at="2026-10-17T00:00:00Z",
        error=None,
    )
    base.update(overrides)
    return WorkspaceMcpInstance(**base)


class TestWorkspaceMcpGroup:
    def test_group_registered_in_main_cli(self):
        runner = CliRunner()
        result = runner.invoke(cli, ["workspace-mcp", "--help"])
        assert result.exit_code == 0
        for verb in ("start", "list", "status", "stop"):
            assert verb in result.output

    def test_help_lists_commands(self):
        runner = CliRunner()
        result = runner.invoke(workspace_mcp, ["--help"])
        assert result.exit_code == 0
        for verb in ("start", "list", "status", "stop"):
            assert verb in result.output


class TestLocalCommands:
    def test_start_success(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.start_instance.return_value = _instance()
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["start", "/home/ubuntu/workspace/repo-a"])
        assert result.exit_code == 0, result.output
        assert "wmcp-abcdef12" in result.output
        assert "https://my-slug.trycloudflare.com" in result.output
        svc.start_instance.assert_called_once()

    def test_start_failure_raises_click_exception(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.start_instance.side_effect = ValueError("not a directory: /nope")
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["start", "/nope"])
        assert result.exit_code != 0
        assert "not a directory" in result.output

    def test_list_empty(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.list_instances.return_value = []
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["list"])
        assert result.exit_code == 0
        assert "No workspace MCP instances running" in result.output

    def test_list_json_flag(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.list_instances.return_value = [_instance()]
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["list", "--json"])
        assert result.exit_code == 0
        rows = json.loads(result.output)
        assert rows[0]["id"] == "wmcp-abcdef12"

    def test_list_table(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.list_instances.return_value = [_instance()]
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["list"])
        assert result.exit_code == 0
        assert "wmcp-abcdef12" in result.output
        assert "running" in result.output

    def test_status_found(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.get_instance.return_value = _instance()
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["status", "wmcp-abcdef12"])
        assert result.exit_code == 0
        assert "wmcp-abcdef12" in result.output

    def test_status_not_found(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.get_instance.return_value = None
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["status", "ghost"])
        assert result.exit_code != 0
        assert "not found" in result.output

    def test_stop_success(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            stopped = _instance(status="stopped")
            svc.stop_instance.return_value = stopped
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["stop", "wmcp-abcdef12"])
        assert result.exit_code == 0
        assert "Stopped instance" in result.output

    def test_stop_not_found(self):
        runner = CliRunner()
        with patch(
            "cli_agent_orchestrator.cli.commands.workspace_mcp.get_workspace_mcp_service"
        ) as get_svc:
            svc = MagicMock()
            svc.stop_instance.return_value = None
            get_svc.return_value = svc
            result = runner.invoke(workspace_mcp, ["stop", "ghost"])
        assert result.exit_code != 0
        assert "not found" in result.output


class TestNodeFlag:
    FLEET = {
        "port": 9889,
        "machines": [
            {"name": "node-a", "host": "100.64.0.11", "role": "central"},
            {"name": "node-b", "host": "100.64.0.12", "port": 9999, "role": "agent"},
        ],
    }

    @pytest.fixture(autouse=True)
    def fleet_registry(self, tmp_path, monkeypatch):
        reg = tmp_path / "fleet.json"
        reg.write_text(json.dumps(self.FLEET))
        monkeypatch.setenv("CAO_FLEET_CONFIG", str(reg))

    def test_list_remote(self):
        runner = CliRunner()
        with patch("cli_agent_orchestrator.cli.commands.workspace_mcp._remote_api_call") as call:
            call.return_value = [_instance().model_dump()]
            result = runner.invoke(workspace_mcp, ["list", "-n", "node-a"])
        assert result.exit_code == 0, result.output
        assert "wmcp-abcdef12" in result.output
        call.assert_called_once()
        assert call.call_args.args[:3] == ("100.64.0.11", 9889, "GET")

    def test_start_remote(self):
        runner = CliRunner()
        with patch("cli_agent_orchestrator.cli.commands.workspace_mcp._remote_api_call") as call:
            call.return_value = _instance().model_dump()
            result = runner.invoke(workspace_mcp, ["start", "/home/x", "-n", "node-b"])
        assert result.exit_code == 0, result.output
        assert call.call_args.args[:3] == ("100.64.0.12", 9999, "POST")

    def test_stop_remote(self):
        runner = CliRunner()
        with patch("cli_agent_orchestrator.cli.commands.workspace_mcp._remote_api_call") as call:
            call.return_value = _instance().model_dump()
            result = runner.invoke(workspace_mcp, ["stop", "wmcp-abcdef12", "-n", "node-a"])
        assert result.exit_code == 0, result.output
        assert call.call_args.args[:3] == ("100.64.0.11", 9889, "DELETE")

    def test_unknown_node_fails(self):
        runner = CliRunner()
        with patch("cli_agent_orchestrator.cli.commands.workspace_mcp._remote_api_call") as call:
            result = runner.invoke(workspace_mcp, ["list", "-n", "ghost-node"])
        assert result.exit_code != 0
        assert "Unknown fleet node" in result.output
        call.assert_not_called()
