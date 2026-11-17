"""Auto (Jev) lane classification through 9router's System One endpoint.

The first prompt of an Auto session is sent to ``POST {ninerouter_url}/v1/systemone``
as a single ``choice`` question whose options are the lane supervisor profiles.
Classification never raises: any failure (disabled, timeout, HTTP error,
malformed answer, unknown lane, low confidence) returns the fallback lane with a
``fallback_reason`` so session creation always proceeds.

Privacy: the truncated prompt leaves this node (9router forwards it to the
configured router model's upstream). Neither the prompt nor the bearer token is
ever logged.
"""

from __future__ import annotations

import logging
import os
from dataclasses import asdict, dataclass
from typing import Any, Dict, Mapping, Optional

import requests

from cli_agent_orchestrator.services.settings_service import get_auto_routing_settings

logger = logging.getLogger(__name__)

FALLBACK_LANE = "feature_supervisor"
MAX_STATE_CHARS = 2000
API_KEY_ENV = "CAO_NINEROUTER_API_KEY"

# Order matters only for readability; the allowlist is the dict's keys.
LANE_CRITERIA: Dict[str, str] = {
    "probe_supervisor": (
        "Questions, explanations, investigation, or code reading. "
        "The user wants an answer and no files changed."
    ),
    "fix_supervisor": (
        "A bug fix, failing test, error, typo, or other small well-scoped code change "
        "in one or a few files."
    ),
    "feature_supervisor": (
        "A new feature or a standard change that spans several files and needs "
        "implementation plus review."
    ),
    "architect_supervisor": (
        "A large, cross-cutting, or architectural change, refactor, or migration "
        "that needs a plan approved before implementation."
    ),
}
LANES = frozenset(LANE_CRITERIA)

_INSTRUCTIONS = (
    "Which CAO supervisor lane fits this request best? Pick the lightest lane that "
    "can fully handle it."
)


@dataclass(frozen=True)
class LaneDecision:
    """Outcome of one classification. ``fallback_reason`` is None on success."""

    lane: str
    confidence: Optional[float]
    fallback_reason: Optional[str] = None
    router_model: Optional[str] = None

    @property
    def fallback(self) -> bool:
        return self.fallback_reason is not None

    def as_metadata(self) -> Dict[str, Any]:
        return asdict(self)


def _fallback(
    reason: str, router_model: Optional[str], confidence: Optional[float] = None
) -> LaneDecision:
    return LaneDecision(
        lane=FALLBACK_LANE,
        confidence=confidence,
        fallback_reason=reason,
        router_model=router_model,
    )


def build_request_body(prompt: str, router_model: str) -> Dict[str, Any]:
    """Build the System One request. Exposed for tests."""
    return {
        "model": router_model,
        "state": prompt.strip()[:MAX_STATE_CHARS],
        "questions": {
            "lane": {
                "type": "choice",
                "instructions": _INSTRUCTIONS,
                "criteria": dict(LANE_CRITERIA),
            }
        },
    }


def _as_probability(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number or not 0.0 <= number <= 1.0:  # NaN or out of range
        return None
    return number


def parse_lane_answer(
    payload: Any, router_model: Optional[str], min_confidence: float
) -> LaneDecision:
    """Turn an untrusted System One response into a LaneDecision. Exposed for tests."""
    if not isinstance(payload, Mapping):
        return _fallback("malformed_response", router_model)
    answers = payload.get("answers")
    route = answers.get("lane") if isinstance(answers, Mapping) else None
    if not isinstance(route, Mapping):
        return _fallback("missing_answer", router_model)

    choice = route.get("choice")
    choice = choice.strip() if isinstance(choice, str) else ""
    if choice not in LANES:
        return _fallback("unknown_lane", router_model)

    confidence = _as_probability(route.get("confidence"))
    if confidence is None:
        probabilities = route.get("probabilities")
        if isinstance(probabilities, Mapping):
            confidence = _as_probability(probabilities.get(choice))
    if confidence is None:
        return _fallback("missing_confidence", router_model)
    if confidence < min_confidence:
        return _fallback("low_confidence", router_model, confidence)

    return LaneDecision(lane=choice, confidence=confidence, router_model=router_model)


def classify_lane(prompt: str, settings: Optional[Mapping[str, Any]] = None) -> LaneDecision:
    """Classify ``prompt`` into a lane profile. Never raises."""
    cfg = dict(settings) if settings is not None else get_auto_routing_settings()
    router_model = cfg.get("router_model")
    if not cfg.get("enabled"):
        return _fallback("disabled", router_model)
    if not isinstance(prompt, str) or not prompt.strip():
        return _fallback("empty_prompt", router_model)

    url = f"{cfg['ninerouter_url']}/v1/systemone"
    headers = {"Content-Type": "application/json"}
    token = os.environ.get(API_KEY_ENV, "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        response = requests.post(
            url,
            json=build_request_body(prompt, router_model),
            headers=headers,
            timeout=cfg["timeout_ms"] / 1000.0,
        )
    except requests.Timeout:
        logger.warning("auto routing: System One request timed out")
        return _fallback("timeout", router_model)
    except requests.RequestException as exc:
        logger.warning("auto routing: System One request failed (%s)", type(exc).__name__)
        return _fallback("unreachable", router_model)

    if response.status_code != 200:
        logger.warning("auto routing: System One returned HTTP %s", response.status_code)
        return _fallback(f"http_{response.status_code}", router_model)
    try:
        payload = response.json()
    except ValueError:
        return _fallback("invalid_json", router_model)

    decision = parse_lane_answer(payload, router_model, cfg["min_confidence"])
    if decision.fallback:
        logger.info(
            "auto routing: falling back to %s (%s)", FALLBACK_LANE, decision.fallback_reason
        )
    return decision
