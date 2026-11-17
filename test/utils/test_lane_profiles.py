"""Guards on the bundled Auto lane supervisor profiles."""

import re
from importlib import resources

import pytest

from cli_agent_orchestrator.services.auto_router import FALLBACK_LANE, LANES
from cli_agent_orchestrator.services.provider_policy import profile_role
from cli_agent_orchestrator.utils.agent_profiles import parse_agent_profile_text

LANE_PROFILES = sorted(LANES)


def _raw(name: str) -> str:
    return (resources.files("cli_agent_orchestrator.agent_store") / f"{name}.md").read_text()


def _section(text: str, heading: str) -> str:
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    assert match, f"missing '## {heading}' section"
    return match.group(1)


def test_classifier_lanes_match_bundled_profiles():
    bundled = {
        item.name[: -len(".md")]
        for item in resources.files("cli_agent_orchestrator.agent_store").iterdir()
        if item.name.endswith("_supervisor.md") and item.name != "code_supervisor.md"
    }
    assert bundled == LANES
    assert FALLBACK_LANE in LANES


@pytest.mark.parametrize("name", LANE_PROFILES)
def test_lane_profile_is_a_supervisor(name):
    profile = parse_agent_profile_text(_raw(name), name)
    assert profile.name == name
    assert profile.provider is None, "lane profiles must not pin a provider"
    assert profile_role(name) == "supervisor"


def test_lanes_section_is_identical_everywhere():
    sections = {name: _section(_raw(name), "Lanes") for name in LANE_PROFILES}
    first = sections[LANE_PROFILES[0]]
    for name, section in sections.items():
        assert section == first, f"{name} Lanes section drifted"


def test_probe_requires_confirmation_before_editing():
    lanes = _section(_raw("probe_supervisor"), "Lanes")
    assert "From Probe to any editing lane: STOP" in lanes
    assert "wait for the user to confirm" in lanes
    rules = _section(_raw("probe_supervisor"), "Critical Rules")
    assert "NEVER assign or hand off work to `developer`" in rules


def test_lanes_never_downgrade():
    assert "Never move to a lighter lane" in _section(_raw("fix_supervisor"), "Lanes")


EDITING_LANES = sorted(LANES - {"probe_supervisor"})


def test_lanes_force_architect_for_risky_changes():
    rule = _section(_raw("fix_supervisor"), "Lanes")
    assert "move to Architect" in rule
    for trigger in ("authentication", "public API", "data schema", "destructive"):
        assert trigger in rule


def test_verification_section_is_shared_by_editing_lanes():
    sections = {name: _section(_raw(name), "Verification") for name in EDITING_LANES}
    first = sections[EDITING_LANES[0]]
    for name, section in sections.items():
        assert section == first, f"{name} Verification section drifted"
    assert "root cause" in first
    assert "fails before the fix" in first
    assert "3 failed fix attempts" in first


def test_probe_has_no_verification_section():
    assert "## Verification" not in _raw("probe_supervisor")


@pytest.mark.parametrize("name", EDITING_LANES)
def test_developer_handoff_carries_verification(name):
    assert "Include the Verification requirements" in _section(_raw(name), "Workflow")


def test_architect_planner_compares_approaches():
    workflow = _section(_raw("architect_supervisor"), "Workflow")
    assert "compare 2-3 distinct approaches" in workflow
    assert "approaches considered" in workflow


def test_code_supervisor_is_unchanged():
    text = _raw("code_supervisor")
    assert "## Lanes" not in text
    assert "This review cycle (steps 3-5) MUST continue until the Code Reviewer approves" in text
