"""Per-profile worker routes (Auto sessions) in assign/handoff resolution."""

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

from cli_agent_orchestrator.mcp_server.models import HandoffResult

ORCH = "cli_agent_orchestrator.utils.orchestration"

AUTO_METADATA = {
    "profile_routes": {
        "developer": {"provider": "codex", "model": "gpt-5.5"},
        "planner": {"provider": "claude_code"},
    },
    "role_providers": {"developer": "kiro_cli", "reviewer": "kiro_cli"},
    "account_strategy": "default",
}


def _meta_response(metadata, provider="claude_code"):
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {
        "provider": provider,
        "session_name": "cao-sup",
        "allowed_tools": None,
        "metadata": metadata,
    }
    response.raise_for_status.return_value = None
    return response


def _select_response(profile_id):
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"profile_id": profile_id}
    return response


class TestResolveHandoffProviderRoutes:
    def _resolve(self, metadata, *args, get_side_effect=None):
        from cli_agent_orchestrator.utils.orchestration import _resolve_handoff_provider

        with (
            patch(f"{ORCH}._resolve_child_allowed_tools", return_value=None),
            patch(f"{ORCH}.resolve_provider", return_value="claude_code"),
            patch.dict(os.environ, {"CAO_TERMINAL_ID": "c0ffee01"}),
            patch(f"{ORCH}.requests") as requests,
        ):
            requests.get.side_effect = get_side_effect or [_meta_response(metadata)]
            requests.RequestException = Exception
            return _resolve_handoff_provider("developer", *args), requests

    def test_route_wins_over_role_policy_and_carries_model(self):
        ctx, _ = self._resolve(AUTO_METADATA)
        assert ctx.provider == "codex"
        assert ctx.model == "gpt-5.5"

    def test_role_policy_still_applies_to_unrouted_profile(self):
        from cli_agent_orchestrator.utils.orchestration import _resolve_handoff_provider

        with (
            patch(f"{ORCH}._resolve_child_allowed_tools", return_value=None),
            patch(f"{ORCH}.resolve_provider", return_value="claude_code"),
            patch.dict(os.environ, {"CAO_TERMINAL_ID": "c0ffee01"}),
            patch(f"{ORCH}.requests") as requests,
        ):
            requests.get.return_value = _meta_response(AUTO_METADATA)
            ctx = _resolve_handoff_provider("reviewer")
        assert ctx.provider == "kiro_cli"
        assert ctx.model is None

    def test_explicit_provider_wins_and_drops_route_model(self):
        ctx, _ = self._resolve(AUTO_METADATA, "opencode_cli")
        assert ctx.provider == "opencode_cli"
        assert ctx.model is None

    def test_sessions_without_routes_are_unchanged(self):
        ctx, requests = self._resolve({"role_providers": {"developer": "codex"}})
        assert ctx.provider == "codex"
        assert ctx.model is None
        assert ctx.provider_profile is None
        assert requests.get.call_count == 1  # no account-selection call

    def test_corrupt_routes_are_ignored(self):
        ctx, _ = self._resolve(
            {"profile_routes": "codex", "role_providers": {"developer": "codex"}}
        )
        assert ctx.provider == "codex"

    def test_quota_strategy_asks_local_selector(self):
        metadata = dict(AUTO_METADATA, account_strategy="quota_desc")
        ctx, requests = self._resolve(
            metadata,
            get_side_effect=[_meta_response(metadata), _select_response("codex-work")],
        )
        assert ctx.provider_profile == "codex-work"
        select_call = requests.get.call_args_list[1]
        assert select_call.args[0].endswith("/agents/provider-profiles/select")
        assert select_call.kwargs["params"] == {"provider": "codex"}

    def test_quota_strategy_with_no_accounts_uses_default(self):
        metadata = dict(AUTO_METADATA, account_strategy="quota_desc")
        ctx, _ = self._resolve(
            metadata, get_side_effect=[_meta_response(metadata), _select_response(None)]
        )
        assert ctx.provider_profile is None

    def test_quota_strategy_rejects_malformed_profile_id(self):
        metadata = dict(AUTO_METADATA, account_strategy="quota_desc")
        ctx, _ = self._resolve(
            metadata, get_side_effect=[_meta_response(metadata), _select_response("../etc")]
        )
        assert ctx.provider_profile is None

    def test_quota_strategy_survives_selector_failure(self):
        metadata = dict(AUTO_METADATA, account_strategy="quota_desc")
        ctx, _ = self._resolve(
            metadata, get_side_effect=[_meta_response(metadata), Exception("server down")]
        )
        assert ctx.provider == "codex"
        assert ctx.provider_profile is None


class TestHandoffImplUsesRouteModel:
    @patch(f"{ORCH}._run_step_and_build_result", new_callable=AsyncMock)
    @patch(f"{ORCH}._resolve_handoff_provider")
    def test_route_model_reaches_run_step(self, resolve, run_step):
        from cli_agent_orchestrator.utils.orchestration import HandoffContext, _handoff_impl

        resolve.return_value = HandoffContext(
            "codex", "cao-sup", "c0ffee01", None, None, model="gpt-5.5"
        )
        run_step.return_value = HandoffResult(success=True, message="ok")
        with patch.dict(os.environ, {"CAO_TERMINAL_ID": "c0ffee01"}):
            asyncio.run(_handoff_impl("developer", "task"))
        assert run_step.await_args.args[0]["model"] == "gpt-5.5"

    @patch(f"{ORCH}._run_step_and_build_result", new_callable=AsyncMock)
    @patch(f"{ORCH}._resolve_handoff_provider")
    def test_explicit_model_beats_route_model(self, resolve, run_step):
        from cli_agent_orchestrator.utils.orchestration import HandoffContext, _handoff_impl

        resolve.return_value = HandoffContext(
            "codex", "cao-sup", "c0ffee01", None, None, model="gpt-5.5"
        )
        run_step.return_value = HandoffResult(success=True, message="ok")
        with patch.dict(os.environ, {"CAO_TERMINAL_ID": "c0ffee01"}):
            asyncio.run(_handoff_impl("developer", "task", model="o3"))
        assert run_step.await_args.args[0]["model"] == "o3"

    @patch(f"{ORCH}._run_step_and_build_result", new_callable=AsyncMock)
    @patch(f"{ORCH}._resolve_remote_provider")
    def test_remote_handoff_forwards_route_provider_and_model(self, remote_profile, run_step):
        from cli_agent_orchestrator.utils.orchestration import _handoff_impl

        remote_profile.return_value = "claude_code"
        run_step.return_value = HandoffResult(success=True, message="ok")
        with (
            patch.dict(os.environ, {"CAO_TERMINAL_ID": "c0ffee01"}),
            patch(f"{ORCH}.requests.get", return_value=_meta_response(AUTO_METADATA)),
        ):
            asyncio.run(_handoff_impl("developer", "task", target_host="worker.internal"))
        assert run_step.await_args.args[2] == "codex"
        assert run_step.await_args.args[0]["model"] == "gpt-5.5"
        assert "provider_profile" not in run_step.await_args.args[0]
        remote_profile.assert_not_called()


class TestCreateTerminalRoutes:
    def test_assign_path_applies_route_provider_and_model(self):
        from cli_agent_orchestrator.utils.orchestration import _create_terminal

        created = MagicMock()
        created.json.return_value = {"id": "dev00001", "provider": "codex"}
        created.raise_for_status.return_value = None
        workdir = MagicMock(status_code=200)
        workdir.json.return_value = {"working_directory": "/tmp/project"}
        with (
            patch(f"{ORCH}._resolve_child_allowed_tools", return_value=None),
            patch(f"{ORCH}.resolve_provider", return_value="claude_code"),
            patch.dict(os.environ, {"CAO_TERMINAL_ID": "c0ffee01"}),
            patch(f"{ORCH}.requests") as requests,
        ):
            requests.get.side_effect = [_meta_response(AUTO_METADATA), workdir]
            requests.post.return_value = created
            _create_terminal("developer", defer_init=True, initial_message="do it")

        params = requests.post.call_args.kwargs["params"]
        assert params["provider"] == "codex"
        assert params["model"] == "gpt-5.5"
        assert "provider_profile" not in params
