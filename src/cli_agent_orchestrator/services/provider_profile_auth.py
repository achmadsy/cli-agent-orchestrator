"""Authentication operations scoped to managed provider profiles."""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Sequence

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services.provider_profile_registry import capabilities_for
from cli_agent_orchestrator.services.provider_profile_store import (
    ProviderProfileError,
    get_provider_profile,
    profile_home,
    set_auth_state,
)


@dataclass(frozen=True)
class _AuthAdapter:
    display_name: str
    status_command: Sequence[str]
    logout_command: Sequence[str]


_AUTH_ADAPTERS: Mapping[ProviderType, _AuthAdapter] = {
    ProviderType.CLAUDE_CODE: _AuthAdapter(
        "Claude Code",
        ("claude", "auth", "status", "--json"),
        ("claude", "auth", "logout"),
    ),
    ProviderType.CODEX: _AuthAdapter(
        "Codex",
        ("codex", "login", "status"),
        ("codex", "logout"),
    ),
    ProviderType.OPENCODE_CLI: _AuthAdapter(
        "OpenCode",
        ("opencode", "providers", "list"),
        ("opencode", "providers", "logout"),
    ),
}


def _profile_env(profile_id: str) -> tuple[ProviderType, _AuthAdapter, Dict[str, str]]:
    profile = get_provider_profile(profile_id)
    adapter = _AUTH_ADAPTERS.get(profile.provider)
    if adapter is None or not capabilities_for(profile.provider.value).auth_lifecycle:
        raise ProviderProfileError(
            f"authentication is not supported for {profile.provider.value} profiles"
        )

    home = profile_home(profile.provider.value, profile_id, create=True)
    env = dict(os.environ)
    if profile.provider == ProviderType.CLAUDE_CODE:
        env["CLAUDE_CONFIG_DIR"] = str(home)
        for key in list(env):
            if key.startswith("CLAUDE") and key != "CLAUDE_CONFIG_DIR":
                env.pop(key, None)
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
        env.pop("ANTHROPIC_PROFILE", None)
    elif profile.provider == ProviderType.CODEX:
        env["CODEX_HOME"] = str(home)
        env.pop("OPENAI_API_KEY", None)
        env.pop("CODEX_API_KEY", None)
        env.pop("CODEX_ACCESS_TOKEN", None)
    else:
        env["XDG_DATA_HOME"] = str(home / "data")
        env["XDG_CONFIG_HOME"] = str(home / "config")
        env["OPENCODE_CONFIG_DIR"] = str(home / "config" / "opencode")
        env["OPENCODE_CONFIG"] = str(home / "config" / "opencode" / "opencode.json")
        env.pop("OPENCODE_CONFIG_CONTENT", None)
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("OPENAI_API_KEY", None)
    return profile.provider, adapter, env


def _result(profile_id: str, state: str, detail: str | None) -> Dict[str, Any]:
    profile = set_auth_state(profile_id, state, detail)
    return {"id": profile.id, "state": profile.auth_state, "detail": profile.auth_detail}


def check_auth_status(profile_id: str, *, timeout: float = 15.0) -> Dict[str, Any]:
    """Run the selected CLI's bounded auth probe and return redacted state."""
    provider, adapter, env = _profile_env(profile_id)
    try:
        result = subprocess.run(
            adapter.status_command,
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return _result(profile_id, "error", f"{adapter.display_name} CLI is not installed")
    except subprocess.TimeoutExpired:
        return _result(profile_id, "error", f"{adapter.display_name} auth status timed out")

    combined = f"{result.stdout}\n{result.stderr}".lower()
    if provider == ProviderType.CLAUDE_CODE:
        payload: Dict[str, Any] = {}
        try:
            parsed = json.loads(result.stdout or "{}")
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            pass
        logged_in = payload.get("loggedIn")
        if logged_in is None:
            logged_in = payload.get("authenticated")
        if logged_in is True and result.returncode == 0:
            state, detail = "authenticated", None
        elif "expired" in combined:
            state, detail = "expired", "Claude login expired; sign in again"
        elif result.returncode != 0 or logged_in is False:
            state, detail = "unconfigured", "Claude account is not signed in"
        else:
            state, detail = "error", "Claude auth status could not be determined"
    elif provider == ProviderType.CODEX:
        if result.returncode == 0 and "not logged in" not in combined:
            state, detail = "authenticated", None
        elif "expired" in combined:
            state, detail = "expired", "Codex login expired; sign in again"
        else:
            state, detail = "unconfigured", "Codex account is not signed in"
    else:
        match = re.search(r"└\s*(\d+) credential", combined)
        if result.returncode == 0 and match and int(match.group(1)) > 0:
            state, detail = "authenticated", None
        elif "expired" in combined:
            state, detail = "expired", "OpenCode login expired; sign in again"
        else:
            state, detail = "unconfigured", "OpenCode has no configured provider credentials"

    return _result(profile_id, state, detail)


def logout(profile_id: str, *, timeout: float = 30.0) -> Dict[str, Any]:
    """Ask the selected CLI to remove only the managed profile's login."""
    provider, adapter, env = _profile_env(profile_id)
    try:
        result = subprocess.run(
            adapter.logout_command,
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ProviderProfileError(f"{adapter.display_name} CLI is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProviderProfileError(f"{adapter.display_name} logout timed out") from exc
    if result.returncode != 0:
        raise ProviderProfileError(f"{adapter.display_name} logout failed")
    if provider == ProviderType.OPENCODE_CLI and (
        "Unknown configured provider" in result.stdout + result.stderr
    ):
        raise ProviderProfileError(f"{adapter.display_name} logout failed: provider never signed in")

    details = {
        ProviderType.CLAUDE_CODE: "Claude account is not signed in",
        ProviderType.CODEX: "Codex account is not signed in",
        ProviderType.OPENCODE_CLI: "OpenCode has no configured provider credentials",
    }
    return _result(profile_id, "unconfigured", details[provider])
