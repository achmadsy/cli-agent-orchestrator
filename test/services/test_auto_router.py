"""Tests for Auto (Jev) lane classification."""

from unittest.mock import MagicMock, patch

import pytest
import requests

from cli_agent_orchestrator.services import auto_router
from cli_agent_orchestrator.services.auto_router import (
    FALLBACK_LANE,
    LANES,
    MAX_STATE_CHARS,
    build_request_body,
    classify_lane,
    parse_lane_answer,
)

POST = "cli_agent_orchestrator.services.auto_router.requests.post"


def _cfg(**overrides):
    cfg = {
        "enabled": True,
        "ninerouter_url": "http://127.0.0.1:20128",
        "router_model": "oc/jev-1.13-free",
        "timeout_ms": 8000,
        "min_confidence": 0.5,
        "account_strategy": "default",
        "workers": {},
    }
    cfg.update(overrides)
    return cfg


def _response(status=200, payload=None, json_error=False):
    response = MagicMock()
    response.status_code = status
    if json_error:
        response.json.side_effect = ValueError("not json")
    else:
        response.json.return_value = payload
    return response


def _answer(choice, confidence=0.9, probabilities=None):
    route = {"type": "choice", "choice": choice}
    if confidence is not None:
        route["confidence"] = confidence
    if probabilities is not None:
        route["probabilities"] = probabilities
    return {"model": "jev-1.13", "answers": {"lane": route}}


@pytest.fixture(autouse=True)
def no_api_key(monkeypatch):
    monkeypatch.delenv(auto_router.API_KEY_ENV, raising=False)


class TestBuildRequestBody:
    def test_choice_question_lists_every_lane(self):
        body = build_request_body("fix the login bug", "oc/jev-1.13-free")
        assert body["model"] == "oc/jev-1.13-free"
        question = body["questions"]["lane"]
        assert question["type"] == "choice"
        assert set(question["criteria"]) == LANES
        assert all(isinstance(text, str) and text for text in question["criteria"].values())

    def test_prompt_is_truncated(self):
        body = build_request_body("x" * (MAX_STATE_CHARS + 500), "m")
        assert len(body["state"]) == MAX_STATE_CHARS


class TestParseLaneAnswer:
    def test_valid_answer(self):
        decision = parse_lane_answer(_answer("fix_supervisor", 0.82), "m", 0.5)
        assert decision.lane == "fix_supervisor"
        assert decision.confidence == pytest.approx(0.82)
        assert decision.fallback_reason is None
        assert not decision.fallback

    def test_confidence_from_probabilities(self):
        payload = _answer(
            "probe_supervisor", None, {"probe_supervisor": 0.7, "fix_supervisor": 0.3}
        )
        decision = parse_lane_answer(payload, "m", 0.5)
        assert decision.lane == "probe_supervisor"
        assert decision.confidence == pytest.approx(0.7)

    @pytest.mark.parametrize(
        "payload, reason",
        [
            (None, "malformed_response"),
            ([], "malformed_response"),
            ({}, "missing_answer"),
            ({"answers": {"lane": "fix_supervisor"}}, "missing_answer"),
            (_answer("rm -rf /"), "unknown_lane"),
            (_answer("code_supervisor"), "unknown_lane"),
            (_answer("fix_supervisor", None), "missing_confidence"),
            (_answer("fix_supervisor", "high"), "missing_confidence"),
            (_answer("fix_supervisor", 1.7), "missing_confidence"),
            (_answer("fix_supervisor", True), "missing_confidence"),
        ],
    )
    def test_untrusted_shapes_fall_back(self, payload, reason):
        decision = parse_lane_answer(payload, "m", 0.5)
        assert decision.lane == FALLBACK_LANE
        assert decision.fallback_reason == reason

    def test_low_confidence_falls_back_but_keeps_score(self):
        decision = parse_lane_answer(_answer("architect_supervisor", 0.3), "m", 0.5)
        assert decision.lane == FALLBACK_LANE
        assert decision.fallback_reason == "low_confidence"
        assert decision.confidence == pytest.approx(0.3)

    def test_close_runner_up_is_ambiguous(self):
        payload = _answer(
            "fix_supervisor", 0.55, {"fix_supervisor": 0.55, "feature_supervisor": 0.45}
        )
        decision = parse_lane_answer(payload, "m", 0.5, 0.15)
        assert decision.lane == FALLBACK_LANE
        assert decision.fallback_reason == "ambiguous"
        assert decision.confidence == pytest.approx(0.55)

    def test_clear_lead_passes_margin(self):
        payload = _answer("fix_supervisor", 0.7, {"fix_supervisor": 0.7, "feature_supervisor": 0.2})
        decision = parse_lane_answer(payload, "m", 0.5, 0.15)
        assert decision.lane == "fix_supervisor"
        assert not decision.fallback

    def test_margin_needs_runner_up_probabilities(self):
        decision = parse_lane_answer(_answer("fix_supervisor", 0.55), "m", 0.5, 0.15)
        assert decision.lane == "fix_supervisor"

    def test_margin_ignores_unknown_and_invalid_entries(self):
        payload = _answer(
            "probe_supervisor",
            0.6,
            {"probe_supervisor": 0.6, "code_supervisor": 0.59, "fix_supervisor": "high"},
        )
        decision = parse_lane_answer(payload, "m", 0.5, 0.15)
        assert decision.lane == "probe_supervisor"

    def test_zero_margin_disables_check(self):
        payload = _answer("fix_supervisor", 0.5, {"fix_supervisor": 0.5, "feature_supervisor": 0.5})
        assert parse_lane_answer(payload, "m", 0.5, 0.0).lane == "fix_supervisor"

    def test_architect_criteria_name_forced_triggers(self):
        criteria = auto_router.LANE_CRITERIA["architect_supervisor"].lower()
        for trigger in ("authentication", "security", "public api", "schema", "destructive"):
            assert trigger in criteria


class TestClassifyLane:
    def test_disabled_never_calls_router(self):
        with patch(POST) as post:
            decision = classify_lane("anything", _cfg(enabled=False))
        post.assert_not_called()
        assert decision.lane == FALLBACK_LANE
        assert decision.fallback_reason == "disabled"

    def test_blank_prompt_never_calls_router(self):
        with patch(POST) as post:
            decision = classify_lane("   ", _cfg())
        post.assert_not_called()
        assert decision.fallback_reason == "empty_prompt"

    def test_success_posts_to_systemone(self):
        with patch(POST, return_value=_response(payload=_answer("fix_supervisor"))) as post:
            decision = classify_lane("fix the typo in README", _cfg(timeout_ms=3000))
        assert decision.lane == "fix_supervisor"
        url = post.call_args.args[0]
        kwargs = post.call_args.kwargs
        assert url == "http://127.0.0.1:20128/v1/systemone"
        assert kwargs["timeout"] == pytest.approx(3.0)
        assert kwargs["json"]["state"] == "fix the typo in README"
        assert "Authorization" not in kwargs["headers"]

    def test_margin_comes_from_settings(self):
        close = _answer("fix_supervisor", 0.6, {"fix_supervisor": 0.6, "feature_supervisor": 0.4})
        with patch(POST, return_value=_response(payload=close)):
            assert classify_lane("fix it", _cfg(min_margin=0.3)).fallback_reason == "ambiguous"
        with patch(POST, return_value=_response(payload=close)):
            assert classify_lane("fix it", _cfg(min_margin=0.1)).lane == "fix_supervisor"

    def test_default_margin_when_settings_omit_it(self):
        close = _answer(
            "fix_supervisor", 0.55, {"fix_supervisor": 0.55, "feature_supervisor": 0.45}
        )
        with patch(POST, return_value=_response(payload=close)):
            assert classify_lane("fix it", _cfg()).fallback_reason == "ambiguous"

    def test_bearer_only_from_env(self, monkeypatch):
        monkeypatch.setenv(auto_router.API_KEY_ENV, "sk-test")
        with patch(POST, return_value=_response(payload=_answer("fix_supervisor"))) as post:
            classify_lane("fix it", _cfg())
        assert post.call_args.kwargs["headers"]["Authorization"] == "Bearer sk-test"

    @pytest.mark.parametrize(
        "side_effect, reason",
        [
            (requests.Timeout("slow"), "timeout"),
            (requests.ConnectionError("refused"), "unreachable"),
        ],
    )
    def test_transport_errors_fall_back(self, side_effect, reason):
        with patch(POST, side_effect=side_effect):
            decision = classify_lane("add a feature", _cfg())
        assert decision.lane == FALLBACK_LANE
        assert decision.fallback_reason == reason

    def test_non_200_falls_back(self):
        with patch(POST, return_value=_response(status=503, payload={})):
            decision = classify_lane("add a feature", _cfg())
        assert decision.fallback_reason == "http_503"

    def test_invalid_json_falls_back(self):
        with patch(POST, return_value=_response(json_error=True)):
            decision = classify_lane("add a feature", _cfg())
        assert decision.fallback_reason == "invalid_json"

    def test_prompt_and_token_are_not_logged(self, monkeypatch, caplog):
        monkeypatch.setenv(auto_router.API_KEY_ENV, "sk-secret-token")
        prompt = "SECRET-PROMPT-CONTENT please fix"
        with caplog.at_level("DEBUG"):
            with patch(POST, side_effect=requests.ConnectionError("refused")):
                classify_lane(prompt, _cfg())
            with patch(POST, return_value=_response(payload=_answer("nope"))):
                classify_lane(prompt, _cfg())
        assert "SECRET-PROMPT-CONTENT" not in caplog.text
        assert "sk-secret-token" not in caplog.text
