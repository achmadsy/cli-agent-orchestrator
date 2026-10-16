"""Claude Code authentication operations scoped to managed provider profiles."""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Dict

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services.provider_profile_store import (
    ProviderProfileError,
    get_provider_profile,
    profile_home,
    set_auth_state,
)


def _profile_env(profile_id: str) -> Dict[str, str]:
    profile = get_provider_profile(profile_id)
    if profile.provider != ProviderType.CLAUDE_CODE:
        raise ProviderProfileError("authentication is only supported for claude_code profiles")
    home = profile_home(profile.provider.value, profile_id, create=True)
    env = dict(os.environ)
    env["CLAUDE_CONFIG_DIR"] = str(home)
    # A server launched from inside Claude Code can inherit credentials or nested-
    # session markers that outrank the selected profile. The interactive provider
    # strips these too; auth probes must use the same account boundary.
    for key in list(env):
        if key.startswith("CLAUDE") and key != "CLAUDE_CONFIG_DIR":
            env.pop(key, None)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    env.pop("ANTHROPIC_PROFILE", None)
    return env


def check_auth_status(profile_id: str, *, timeout: float = 15.0) -> Dict[str, Any]:
    """Run Claude's own bounded auth probe and return redacted normalized state."""
    try:
        result = subprocess.run(
            ["claude", "auth", "status", "--json"],
            env=_profile_env(profile_id),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        profile = set_auth_state(profile_id, "error", "Claude Code CLI is not installed")
        return {"id": profile.id, "state": profile.auth_state, "detail": profile.auth_detail}
    except subprocess.TimeoutExpired:
        profile = set_auth_state(profile_id, "error", "Claude auth status timed out")
        return {"id": profile.id, "state": profile.auth_state, "detail": profile.auth_detail}

    payload: Dict[str, Any] = {}
    try:
        parsed = json.loads(result.stdout or "{}")
        if isinstance(parsed, dict):
            payload = parsed
    except json.JSONDecodeError:
        payload = {}

    logged_in = payload.get("loggedIn")
    if logged_in is None:
        logged_in = payload.get("authenticated")
    if logged_in is True and result.returncode == 0:
        state, detail = "authenticated", None
    else:
        combined = f"{result.stdout}\n{result.stderr}".lower()
        if "expired" in combined:
            state, detail = "expired", "Claude login expired; sign in again"
        elif result.returncode != 0 or logged_in is False:
            state, detail = "unconfigured", "Claude account is not signed in"
        else:
            state, detail = "error", "Claude auth status could not be determined"

    profile = set_auth_state(profile_id, state, detail)
    return {"id": profile.id, "state": profile.auth_state, "detail": profile.auth_detail}


def logout(profile_id: str, *, timeout: float = 30.0) -> Dict[str, Any]:
    """Ask Claude Code to revoke/remove only the selected profile login."""
    try:
        result = subprocess.run(
            ["claude", "auth", "logout"],
            env=_profile_env(profile_id),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ProviderProfileError("Claude Code CLI is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProviderProfileError("Claude logout timed out") from exc
    if result.returncode != 0:
        raise ProviderProfileError("Claude logout failed")
    profile = set_auth_state(profile_id, "unconfigured", "Claude account is not signed in")
    return {"id": profile.id, "state": profile.auth_state, "detail": profile.auth_detail}
