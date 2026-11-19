"""API tests for Auto (Jev) routing endpoints."""

from unittest.mock import AsyncMock, patch

import pytest

from cli_agent_orchestrator.models.terminal import Terminal
from cli_agent_orchestrator.services.auto_router import LaneDecision

SETTINGS = "cli_agent_orchestrator.services.settings_service.get_auto_routing_settings"
CLASSIFY = "cli_agent_orchestrator.services.auto_router.classify_lane"
SELECT = "cli_agent_orchestrator.services.account_selector.select_provider_profile"
SESSION_SVC = "cli_agent_orchestrator.api.main.session_service"


def _cfg(**overrides):
    cfg = {
        "enabled": True,
        "ninerouter_url": "http://127.0.0.1:20128",
        "router_model": "oc/jev-1.13-free",
        "timeout_ms": 8000,
        "min_confidence": 0.5,
        "account_strategy": "default",
        "lanes": {},
        "workers": {"developer": {"provider": "codex", "model": "gpt-5.5"}},
        "custom_models": {},
    }
    cfg.update(overrides)
    return cfg


def _terminal(agent_profile="fix_supervisor", provider="claude_code"):
    return Terminal(
        id="abcd1234",
        name="sup-window",
        session_name="cao-auto",
        provider=provider,
        agent_profile=agent_profile,
    )


class TestStatus:
    def test_disabled_by_default_shape(self, client):
        with patch(SETTINGS, return_value=_cfg(enabled=False)):
            response = client.get("/auto-routing/status")
        assert response.status_code == 200
        assert response.json() == {"enabled": False, "router_model": "oc/jev-1.13-free"}

    def test_status_has_no_url_or_routes(self, client):
        with patch(SETTINGS, return_value=_cfg()):
            body = client.get("/auto-routing/status").json()
        assert set(body) == {"enabled", "router_model"}


class TestCreateAutoSession:
    def test_disabled_returns_409_without_classifying(self, client):
        with patch(SETTINGS, return_value=_cfg(enabled=False)), patch(CLASSIFY) as classify:
            response = client.post("/auto-routing/sessions", json={"initial_message": "hi"})
        assert response.status_code == 409
        classify.assert_not_called()

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"initial_message": ""},
            {"initial_message": "   "},
            {"initial_message": "x", "provider": "not-a-cli"},
            {"initial_message": "x", "agent_profile": "code_supervisor"},
        ],
    )
    def test_invalid_body_is_422(self, client, body):
        with patch(SETTINGS, return_value=_cfg()):
            response = client.post("/auto-routing/sessions", json=body)
        assert response.status_code == 422

    def test_creates_lane_session_with_prompt_and_metadata(self, client):
        decision = LaneDecision("fix_supervisor", 0.82, None, "oc/jev-1.13-free")
        with (
            patch(SETTINGS, return_value=_cfg()),
            patch(CLASSIFY, return_value=decision),
            patch(SESSION_SVC) as svc,
        ):
            svc.create_session = AsyncMock(return_value=_terminal())
            response = client.post(
                "/auto-routing/sessions",
                json={
                    "initial_message": "fix the typo in README",
                    "provider": "claude_code",
                    "working_directory": "/tmp/project",
                },
            )

        assert response.status_code == 201, response.text
        payload = response.json()
        assert payload["decision"]["lane"] == "fix_supervisor"
        assert payload["terminal"]["agent_profile"] == "fix_supervisor"

        kwargs = svc.create_session.await_args.kwargs
        assert kwargs["agent_profile"] == "fix_supervisor"
        assert kwargs["provider"] == "claude_code"
        assert kwargs["provider_profile"] is None
        assert kwargs["initial_message"] == "fix the typo in README"
        assert kwargs["working_directory"] == "/tmp/project"
        metadata = kwargs["metadata"]
        assert metadata["auto_decision"]["lane"] == "fix_supervisor"
        assert metadata["profile_routes"] == {
            "developer": {"provider": "codex", "model": "gpt-5.5"}
        }
        assert metadata["account_strategy"] == "default"
        assert "fix the typo" not in str(metadata)
        assert "role_providers" not in metadata

    def test_fallback_decision_is_reported(self, client):
        decision = LaneDecision("feature_supervisor", None, "timeout", "oc/jev-1.13-free")
        with (
            patch(SETTINGS, return_value=_cfg(workers={})),
            patch(CLASSIFY, return_value=decision),
            patch(SESSION_SVC) as svc,
        ):
            svc.create_session = AsyncMock(return_value=_terminal("feature_supervisor"))
            response = client.post(
                "/auto-routing/sessions",
                json={"initial_message": "do something", "provider": "claude_code"},
            )
        assert response.status_code == 201
        assert response.json()["decision"]["fallback_reason"] == "timeout"
        metadata = svc.create_session.await_args.kwargs["metadata"]
        assert "profile_routes" not in metadata

    def test_quota_strategy_selects_supervisor_account(self, client):
        decision = LaneDecision("probe_supervisor", 0.9, None, "m")
        with (
            patch(SETTINGS, return_value=_cfg(account_strategy="quota_desc")),
            patch(CLASSIFY, return_value=decision),
            patch(SELECT, new=AsyncMock(return_value="claude-work")) as select,
            patch(SESSION_SVC) as svc,
        ):
            svc.create_session = AsyncMock(return_value=_terminal("probe_supervisor"))
            response = client.post(
                "/auto-routing/sessions",
                json={"initial_message": "how does auth work?", "provider": "claude_code"},
            )
        assert response.status_code == 201
        select.assert_awaited_once_with("claude_code")
        assert svc.create_session.await_args.kwargs["provider_profile"] == "claude-work"

    def test_explicit_account_skips_selector(self, client):
        decision = LaneDecision("probe_supervisor", 0.9, None, "m")
        with (
            patch(SETTINGS, return_value=_cfg(account_strategy="quota_desc")),
            patch(CLASSIFY, return_value=decision),
            patch(SELECT, new=AsyncMock()) as select,
            patch(SESSION_SVC) as svc,
        ):
            svc.create_session = AsyncMock(return_value=_terminal("probe_supervisor"))
            client.post(
                "/auto-routing/sessions",
                json={
                    "initial_message": "how does auth work?",
                    "provider": "claude_code",
                    "provider_profile": "claude-personal",
                },
            )
        select.assert_not_called()
        assert svc.create_session.await_args.kwargs["provider_profile"] == "claude-personal"

    def test_session_validation_errors_surface_as_400(self, client):
        decision = LaneDecision("fix_supervisor", 0.9, None, "m")
        with (
            patch(SETTINGS, return_value=_cfg()),
            patch(CLASSIFY, return_value=decision),
            patch(SESSION_SVC) as svc,
        ):
            svc.create_session = AsyncMock(side_effect=ValueError("bad working directory"))
            response = client.post(
                "/auto-routing/sessions",
                json={"initial_message": "fix it", "provider": "claude_code"},
            )
        assert response.status_code == 400

    def test_bad_session_name_is_400(self, client):
        decision = LaneDecision("fix_supervisor", 0.9, None, "m")
        with (
            patch(SETTINGS, return_value=_cfg()),
            patch(CLASSIFY, return_value=decision),
            patch(SESSION_SVC) as svc,
        ):
            svc.create_session = AsyncMock(return_value=_terminal())
            response = client.post(
                "/auto-routing/sessions",
                json={
                    "initial_message": "fix it",
                    "provider": "claude_code",
                    "session_name": "a b;c",
                },
            )
        assert response.status_code == 400
        svc.create_session.assert_not_called()


class TestLaneDefaults:
    """The supervisor's CLI: form provider > Settings lane default > profile > DEFAULT_PROVIDER."""

    LANES = {"fix_supervisor": {"provider": "codex", "model": "gpt-5.5"}}

    def _launch(self, client, body, lanes=None):
        decision = LaneDecision("fix_supervisor", 0.9, None, "m")
        with (
            patch(SETTINGS, return_value=_cfg(lanes=self.LANES if lanes is None else lanes)),
            patch(CLASSIFY, return_value=decision),
            patch(SESSION_SVC) as svc,
        ):
            svc.create_session = AsyncMock(return_value=_terminal())
            response = client.post("/auto-routing/sessions", json=body)
        assert response.status_code == 201, response.text
        return svc.create_session.await_args.kwargs

    def test_no_form_provider_uses_lane_default_and_model(self, client):
        kwargs = self._launch(client, {"initial_message": "fix it"})
        assert kwargs["provider"] == "codex"
        assert kwargs["model"] == "gpt-5.5"

    def test_form_provider_wins_and_drops_the_lane_model(self, client):
        kwargs = self._launch(client, {"initial_message": "fix it", "provider": "claude_code"})
        assert kwargs["provider"] == "claude_code"
        assert kwargs["model"] is None

    def test_form_provider_matching_the_lane_keeps_the_lane_model(self, client):
        kwargs = self._launch(client, {"initial_message": "fix it", "provider": "codex"})
        assert kwargs["provider"] == "codex"
        assert kwargs["model"] == "gpt-5.5"

    def test_no_lane_default_falls_back_to_default_provider(self, client):
        from cli_agent_orchestrator.constants import DEFAULT_PROVIDER

        kwargs = self._launch(client, {"initial_message": "fix it"}, lanes={})
        assert kwargs["provider"] == DEFAULT_PROVIDER
        assert kwargs["model"] is None

    def test_other_lanes_default_does_not_apply(self, client):
        from cli_agent_orchestrator.constants import DEFAULT_PROVIDER

        kwargs = self._launch(
            client,
            {"initial_message": "fix it"},
            lanes={"probe_supervisor": {"provider": "codex"}},
        )
        assert kwargs["provider"] == DEFAULT_PROVIDER

    ACCOUNT_LANES = {"fix_supervisor": {"provider": "codex", "provider_profile": "codex-work"}}

    def test_lane_account_applies_without_a_form_provider(self, client):
        kwargs = self._launch(client, {"initial_message": "fix it"}, lanes=self.ACCOUNT_LANES)
        assert kwargs["provider"] == "codex"
        assert kwargs["provider_profile"] == "codex-work"

    @pytest.mark.parametrize("provider", ["codex", "claude_code"])
    def test_form_provider_drops_the_lane_account(self, client, provider):
        # Picking a CLI (or an account) in the form replaces the lane default,
        # so the lane's account is never paired with the form's choice.
        kwargs = self._launch(
            client, {"initial_message": "fix it", "provider": provider}, lanes=self.ACCOUNT_LANES
        )
        assert kwargs["provider"] == provider
        assert kwargs["provider_profile"] is None

    def test_form_account_wins_over_the_lane_account(self, client):
        kwargs = self._launch(
            client,
            {
                "initial_message": "fix it",
                "provider": "codex",
                "provider_profile": "codex-personal",
            },
            lanes=self.ACCOUNT_LANES,
        )
        assert kwargs["provider_profile"] == "codex-personal"


class TestAccountDeletion:
    REFS = "cli_agent_orchestrator.services.settings_service.auto_routing_account_references"
    DELETE = "cli_agent_orchestrator.services.provider_profile_store.delete_provider_profile"

    def test_account_used_by_auto_defaults_cannot_be_deleted(self, client):
        with patch(self.REFS, return_value=["fix_supervisor"]), patch(self.DELETE) as delete:
            response = client.delete("/agents/provider-profiles/codex-work")
        assert response.status_code == 409
        assert "fix_supervisor" in response.json()["detail"]
        delete.assert_not_called()

    def test_unused_account_is_deleted(self, client):
        with patch(self.REFS, return_value=[]), patch(self.DELETE) as delete:
            response = client.delete("/agents/provider-profiles/codex-work")
        assert response.status_code == 204
        delete.assert_called_once_with("codex-work", delete_home=False)


class TestFlowAccount:
    BODY = {
        "name": "nightly",
        "schedule": "0 2 * * *",
        "agent_profile": "developer",
        "provider": "codex",
        "prompt_template": "run the tests",
    }
    RESOLVE = "cli_agent_orchestrator.services.provider_profile_store.resolve_provider_profile"
    ADD = "cli_agent_orchestrator.api.main.flow_service.add_flow"

    def test_flow_account_is_written_to_the_flow_file(self, client, tmp_path):
        from cli_agent_orchestrator.models.flow import Flow

        flow = Flow(name="nightly", file_path="x", schedule="0 2 * * *", agent_profile="developer")
        with (
            patch("cli_agent_orchestrator.api.main.CAO_HOME_DIR", tmp_path),
            patch(self.RESOLVE) as resolve,
            patch(self.ADD, return_value=flow),
        ):
            response = client.post("/flows", json={**self.BODY, "provider_profile": "codex-work"})
        assert response.status_code == 201, response.text
        resolve.assert_called_once_with("codex", "codex-work")
        text = (tmp_path / "flows" / "nightly.flow.md").read_text()
        assert "provider_profile: codex-work" in text

    def test_account_of_another_cli_is_400_and_writes_nothing(self, client, tmp_path):
        from cli_agent_orchestrator.services.provider_profile_store import ProviderProfileError

        error = ProviderProfileError("provider profile 'x' belongs to 'hermes', not 'codex'")
        with (
            patch("cli_agent_orchestrator.api.main.CAO_HOME_DIR", tmp_path),
            patch(self.RESOLVE, side_effect=error),
        ):
            response = client.post("/flows", json={**self.BODY, "provider_profile": "x"})
        assert response.status_code == 400
        assert not (tmp_path / "flows").exists()

    def test_malformed_account_id_is_422(self, client):
        response = client.post("/flows", json={**self.BODY, "provider_profile": "a\nscript: x"})
        assert response.status_code == 422


ROUTES_GET = "cli_agent_orchestrator.services.settings_service.get_auto_routing_settings"
ROUTES_SET = "cli_agent_orchestrator.services.settings_service.set_auto_routing_routes"


class TestRoutesEndpoints:
    def test_get_returns_lanes_workers_and_lane_names_only(self, client):
        with patch(ROUTES_GET, return_value=_cfg(lanes={"fix_supervisor": {"provider": "codex"}})):
            body = client.get("/settings/auto-routing").json()
        assert set(body) == {
            "enabled",
            "lane_names",
            "fallback_provider",
            "lanes",
            "workers",
            "builtin_models",
            "custom_models",
        }
        assert body["lane_names"] == sorted(
            ["architect_supervisor", "feature_supervisor", "fix_supervisor", "probe_supervisor"]
        )
        assert body["lanes"] == {"fix_supervisor": {"provider": "codex"}}
        assert "ninerouter_url" not in body

    def test_get_lists_builtin_and_custom_models(self, client):
        with patch(ROUTES_GET, return_value=_cfg(custom_models={"hermes": ["my-model"]})):
            body = client.get("/settings/auto-routing").json()
        assert "opus" in body["builtin_models"]["claude_code"]
        assert "gpt-5.5" in body["builtin_models"]["codex"]
        assert body["custom_models"] == {"hermes": ["my-model"]}

    def test_put_saves_custom_models(self, client):
        with patch(ROUTES_SET) as save, patch(ROUTES_GET, return_value=_cfg()):
            response = client.put(
                "/settings/auto-routing", json={"custom_models": {"codex": [" gpt-7 "]}}
            )
        assert response.status_code == 200, response.text
        save.assert_called_once_with(lanes=None, workers=None, custom_models={"codex": ["gpt-7"]})

    def test_put_saves_validated_maps(self, client):
        with patch(ROUTES_SET) as save, patch(ROUTES_GET, return_value=_cfg()):
            response = client.put(
                "/settings/auto-routing",
                json={
                    "lanes": {"probe_supervisor": {"provider": "claude_code", "model": " opus "}},
                    "workers": {"developer": {"provider": "codex"}, "reviewer": {}},
                },
            )
        assert response.status_code == 200, response.text
        save.assert_called_once_with(
            lanes={"probe_supervisor": {"provider": "claude_code", "model": "opus"}},
            workers={"developer": {"provider": "codex"}},
            custom_models=None,
        )

    def test_put_omitted_map_is_left_unchanged(self, client):
        with patch(ROUTES_SET) as save, patch(ROUTES_GET, return_value=_cfg()):
            client.put("/settings/auto-routing", json={"workers": {}})
        save.assert_called_once_with(lanes=None, workers={}, custom_models=None)

    @pytest.mark.parametrize(
        "body",
        [
            {"lanes": {"code_supervisor": {"provider": "codex"}}},
            {"lanes": {"fix_supervisor": {"provider": "not-a-cli"}}},
            {"lanes": {"fix_supervisor": {"model": "gpt-5.5"}}},
            {"lanes": {"fix_supervisor": {"provider": "codex", "model": "rm -rf"}}},
            {"lanes": {"fix_supervisor": {"provider": "codex", "extra": 1}}},
            {"workers": {"a b": {"provider": "codex"}}},
            {"workers": {f"w{i}": {"provider": "codex"} for i in range(33)}},
            {"custom_models": {"not-a-cli": ["x"]}},
            {"custom_models": {"codex": ["rm -rf"]}},
        ],
    )
    def test_put_rejects_bad_entries_without_saving(self, client, body):
        with patch(ROUTES_SET) as save:
            response = client.put("/settings/auto-routing", json=body)
        assert response.status_code == 400
        save.assert_not_called()

    def test_put_unknown_top_level_key_is_422(self, client):
        response = client.put("/settings/auto-routing", json={"enabled": True})
        assert response.status_code == 422

    def test_put_unreadable_settings_is_503(self, client):
        from pathlib import Path

        from cli_agent_orchestrator.services.settings_service import SettingsUnreadableError

        error = SettingsUnreadableError(Path("/secret/settings.json"), PermissionError("denied"))
        with patch(ROUTES_SET, side_effect=error):
            response = client.put("/settings/auto-routing", json={"workers": {}})
        assert response.status_code == 503
        assert "/secret" not in response.text


class TestSelectEndpoint:
    def test_unknown_provider_is_400(self, client):
        response = client.get("/agents/provider-profiles/select", params={"provider": "nope"})
        assert response.status_code == 400

    def test_returns_selector_result(self, client):
        with patch(SELECT, new=AsyncMock(return_value=None)):
            response = client.get(
                "/agents/provider-profiles/select", params={"provider": "claude_code"}
            )
        assert response.status_code == 200
        assert response.json() == {"profile_id": None}
