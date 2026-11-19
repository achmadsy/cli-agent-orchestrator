"""Tests for per-profile worker routes and the auto_routing settings block."""

import json
from unittest.mock import patch

import pytest

from cli_agent_orchestrator.services import settings_service
from cli_agent_orchestrator.services.provider_policy import (
    parse_profile_routes_mapping,
    resolve_profile_route,
)
from cli_agent_orchestrator.services.settings_service import (
    AUTO_ROUTING_DEFAULTS,
    SettingsUnreadableError,
    get_auto_routing_settings,
    set_auto_routing_routes,
    validate_route_map,
)


class TestParseProfileRoutes:
    def test_valid_routes_are_compacted(self):
        routes = parse_profile_routes_mapping(
            {
                "planner": {"provider": "claude_code"},
                "developer": {"provider": "codex", "model": " gpt-5.5 "},
                "reviewer": {"model": ""},
            }
        )
        assert routes == {
            "planner": {"provider": "claude_code"},
            "developer": {"provider": "codex", "model": "gpt-5.5"},
        }

    def test_bad_entries_are_dropped_individually(self):
        routes = parse_profile_routes_mapping(
            {
                "planner": {"provider": "claude_code"},
                "developer": {"provider": "not-a-cli"},
                "reviewer": {"provider": "codex", "extra": 1},
                "bad name!": {"provider": "codex"},
                "x": "codex",
                "tester": {"model": "has space"},
            }
        )
        assert routes == {"planner": {"provider": "claude_code"}}

    @pytest.mark.parametrize("value", [None, "codex", ["planner"], 3])
    def test_non_mapping_is_empty(self, value):
        assert parse_profile_routes_mapping(value) == {}


class TestResolveProfileRoute:
    ROUTES = {"developer": {"provider": "codex", "model": "gpt-5.5"}}

    def test_route_applies_without_explicit_values(self):
        assert resolve_profile_route("developer", None, None, self.ROUTES) == ("codex", "gpt-5.5")

    def test_unrouted_profile_has_no_opinion(self):
        assert resolve_profile_route("reviewer", None, None, self.ROUTES) == (None, None)

    def test_explicit_model_wins(self):
        assert resolve_profile_route("developer", None, "o3", self.ROUTES) == ("codex", "o3")

    def test_explicit_other_provider_drops_route_model(self):
        assert resolve_profile_route("developer", "claude_code", None, self.ROUTES) == (
            "claude_code",
            None,
        )

    def test_explicit_same_provider_keeps_route_model(self):
        assert resolve_profile_route("developer", "codex", None, self.ROUTES) == (
            "codex",
            "gpt-5.5",
        )

    def test_no_routes_passes_explicit_through(self):
        assert resolve_profile_route("developer", "kiro_cli", "m1", None) == ("kiro_cli", "m1")


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    monkeypatch.delenv("CAO_AUTO_ROUTING_ENABLED", raising=False)
    monkeypatch.delenv("CAO_NINEROUTER_URL", raising=False)
    fake = tmp_path / "settings.json"
    with (
        patch.object(settings_service, "SETTINGS_FILE", fake),
        patch.object(settings_service, "CAO_HOME_DIR", tmp_path),
    ):
        yield fake


class TestAutoRoutingSettings:
    def test_absent_block_is_disabled_defaults(self, settings_file):
        assert get_auto_routing_settings() == AUTO_ROUTING_DEFAULTS

    def test_valid_block(self, settings_file):
        settings_file.write_text(
            json.dumps(
                {
                    "auto_routing": {
                        "enabled": True,
                        "ninerouter_url": "http://10.0.0.2:20128/",
                        "router_model": "typesafe/jev-1.13",
                        "timeout_ms": 4000,
                        "min_confidence": 0.65,
                        "account_strategy": "quota_desc",
                        "workers": {"developer": {"provider": "codex"}},
                    }
                }
            )
        )
        cfg = get_auto_routing_settings()
        assert cfg["enabled"] is True
        assert cfg["ninerouter_url"] == "http://10.0.0.2:20128"
        assert cfg["router_model"] == "typesafe/jev-1.13"
        assert cfg["timeout_ms"] == 4000
        assert cfg["min_confidence"] == pytest.approx(0.65)
        assert cfg["account_strategy"] == "quota_desc"
        assert cfg["workers"] == {"developer": {"provider": "codex"}}

    def test_invalid_values_fall_back_per_key(self, settings_file):
        settings_file.write_text(
            json.dumps(
                {
                    "auto_routing": {
                        "enabled": "yes",
                        "ninerouter_url": "file:///etc/passwd",
                        "timeout_ms": 5,
                        "min_confidence": 3,
                        "account_strategy": "random",
                        "workers": {"developer": {"provider": "nope"}},
                    }
                }
            )
        )
        cfg = get_auto_routing_settings()
        assert cfg["enabled"] is False
        assert cfg["ninerouter_url"] == AUTO_ROUTING_DEFAULTS["ninerouter_url"]
        assert cfg["timeout_ms"] == AUTO_ROUTING_DEFAULTS["timeout_ms"]
        assert cfg["min_confidence"] == AUTO_ROUTING_DEFAULTS["min_confidence"]
        assert cfg["account_strategy"] == "default"
        assert cfg["workers"] == {}

    def test_min_margin_default_and_override(self, settings_file):
        assert get_auto_routing_settings()["min_margin"] == pytest.approx(0.15)
        settings_file.write_text(json.dumps({"auto_routing": {"min_margin": 0}}))
        assert get_auto_routing_settings()["min_margin"] == 0.0

    @pytest.mark.parametrize("value", [-0.1, 1.5, True, "0.2", None])
    def test_invalid_min_margin_uses_default(self, settings_file, value):
        settings_file.write_text(json.dumps({"auto_routing": {"min_margin": value}}))
        assert get_auto_routing_settings()["min_margin"] == AUTO_ROUTING_DEFAULTS["min_margin"]

    def test_non_object_block_uses_defaults(self, settings_file):
        settings_file.write_text(json.dumps({"auto_routing": ["on"]}))
        assert get_auto_routing_settings() == AUTO_ROUTING_DEFAULTS

    def test_env_overrides(self, settings_file, monkeypatch):
        settings_file.write_text(json.dumps({"auto_routing": {"enabled": False}}))
        monkeypatch.setenv("CAO_AUTO_ROUTING_ENABLED", "true")
        monkeypatch.setenv("CAO_NINEROUTER_URL", "https://router.example")
        cfg = get_auto_routing_settings()
        assert cfg["enabled"] is True
        assert cfg["ninerouter_url"] == "https://router.example"

    def test_api_key_is_never_read_from_settings(self, settings_file):
        settings_file.write_text(json.dumps({"auto_routing": {"api_key": "sk-leak"}}))
        assert "sk-leak" not in json.dumps(get_auto_routing_settings())

    def test_lanes_keep_only_known_lanes_and_valid_routes(self, settings_file):
        settings_file.write_text(
            json.dumps(
                {
                    "auto_routing": {
                        "lanes": {
                            "fix_supervisor": {"provider": "codex", "model": "gpt-5.5"},
                            "probe_supervisor": {"provider": "nope"},
                            "code_supervisor": {"provider": "codex"},
                        }
                    }
                }
            )
        )
        assert get_auto_routing_settings()["lanes"] == {
            "fix_supervisor": {"provider": "codex", "model": "gpt-5.5"}
        }


class TestSetAutoRoutingRoutes:
    def test_replaces_maps_and_keeps_other_keys(self, settings_file):
        settings_file.write_text(
            json.dumps(
                {
                    "agents": {"extra_dirs": ["/x"]},
                    "auto_routing": {
                        "enabled": True,
                        "min_margin": 0.2,
                        "workers": {"developer": {"provider": "codex"}},
                    },
                }
            )
        )
        set_auto_routing_routes(lanes={"fix_supervisor": {"provider": "claude_code"}})
        saved = json.loads(settings_file.read_text())
        assert saved["agents"] == {"extra_dirs": ["/x"]}
        assert saved["auto_routing"]["enabled"] is True
        assert saved["auto_routing"]["min_margin"] == 0.2
        assert saved["auto_routing"]["workers"] == {"developer": {"provider": "codex"}}
        assert saved["auto_routing"]["lanes"] == {"fix_supervisor": {"provider": "claude_code"}}

    def test_creates_the_block_when_absent(self, settings_file):
        set_auto_routing_routes(workers={"reviewer": {"provider": "codex"}})
        saved = json.loads(settings_file.read_text())
        assert saved == {"auto_routing": {"workers": {"reviewer": {"provider": "codex"}}}}

    def test_refuses_to_overwrite_an_unreadable_file(self, settings_file):
        settings_file.write_text("{not json")
        with pytest.raises(SettingsUnreadableError):
            set_auto_routing_routes(workers={})
        assert settings_file.read_text() == "{not json"


class TestValidateRouteMap:
    def test_valid_map_is_normalized(self):
        assert validate_route_map(
            {
                "developer": {"provider": "codex", "model": " gpt-5.5 "},
                "reviewer": {"provider": "", "model": ""},
                "planner": {},
            },
            "workers",
        ) == {"developer": {"provider": "codex", "model": "gpt-5.5"}}

    @pytest.mark.parametrize(
        "value, message",
        [
            ([], "must be an object"),
            ({"bad name": {}}, "invalid profile name"),
            ({"developer": "codex"}, "only provider and model"),
            ({"developer": {"provider": "nope"}}, "unknown provider"),
            ({"developer": {"model": "gpt-5.5"}}, "needs a provider"),
            ({"developer": {"provider": "codex", "model": "a;b"}}, "not allowed"),
            ({"developer": {"provider": "codex", "model": "x" * 129}}, "at most"),
        ],
    )
    def test_rejects_with_a_named_reason(self, value, message):
        with pytest.raises(ValueError, match=message):
            validate_route_map(value, "workers")

    def test_allowed_names_are_enforced(self):
        with pytest.raises(ValueError, match="unknown lane"):
            validate_route_map({"developer": {"provider": "codex"}}, "lanes", {"fix_supervisor"})
