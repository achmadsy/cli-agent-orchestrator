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
        "workers": {"developer": {"provider": "codex", "model": "gpt-5.5"}},
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
