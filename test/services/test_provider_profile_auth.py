from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.services import provider_profile_auth as auth


@pytest.mark.parametrize(
    ("provider", "expected_command", "env_key"),
    [
        (ProviderType.CLAUDE_CODE, ("claude", "auth", "status", "--json"), "CLAUDE_CONFIG_DIR"),
        (ProviderType.CODEX, ("codex", "login", "status"), "CODEX_HOME"),
        (ProviderType.OPENCODE_CLI, ("opencode", "providers", "list"), "XDG_DATA_HOME"),
    ],
)
def test_auth_status_dispatches_with_isolated_environment(
    monkeypatch, tmp_path, provider, expected_command, env_key
):
    monkeypatch.setattr(
        auth,
        "get_provider_profile",
        lambda _profile_id: SimpleNamespace(provider=provider),
    )
    monkeypatch.setattr(
        auth,
        "profile_home",
        lambda _provider, _profile_id, create: tmp_path / provider.value,
    )
    persisted = {}
    monkeypatch.setattr(
        auth,
        "set_auth_state",
        lambda profile_id, state, detail: SimpleNamespace(
            id=profile_id, auth_state=state, auth_detail=detail
        ),
    )

    def fake_run(command, **kwargs):
        persisted["command"] = tuple(command)
        persisted["env"] = kwargs["env"]
        if provider == ProviderType.CLAUDE_CODE:
            return subprocess.CompletedProcess(command, 0, '{"loggedIn": true}', "")
        if provider == ProviderType.CODEX:
            return subprocess.CompletedProcess(command, 0, "Logged in using ChatGPT", "")
        return subprocess.CompletedProcess(command, 0, "└  2 credentials\n", "")

    monkeypatch.setattr(auth.subprocess, "run", fake_run)

    result = auth.check_auth_status("work")

    assert result["state"] == "authenticated"
    assert persisted["command"] == expected_command
    assert persisted["env"][env_key].startswith(str(tmp_path))


def test_codex_unconfigured_status_is_redacted(monkeypatch, tmp_path):
    monkeypatch.setattr(
        auth,
        "get_provider_profile",
        lambda _profile_id: SimpleNamespace(provider=ProviderType.CODEX),
    )
    monkeypatch.setattr(auth, "profile_home", lambda *_args, **_kwargs: tmp_path)
    monkeypatch.setattr(
        auth,
        "set_auth_state",
        lambda profile_id, state, detail: SimpleNamespace(
            id=profile_id, auth_state=state, auth_detail=detail
        ),
    )
    monkeypatch.setattr(
        auth.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0], 1, "Not logged in secret@example.com", "token=secret"
        ),
    )

    result = auth.check_auth_status("codex-work")

    assert result == {
        "id": "codex-work",
        "state": "unconfigured",
        "detail": "Codex account is not signed in",
    }
    assert "secret" not in result["detail"]


def test_status_timeout_persists_redacted_error(monkeypatch, tmp_path):
    monkeypatch.setattr(
        auth,
        "get_provider_profile",
        lambda _profile_id: SimpleNamespace(provider=ProviderType.OPENCODE_CLI),
    )
    monkeypatch.setattr(auth, "profile_home", lambda *_args, **_kwargs: tmp_path)
    monkeypatch.setattr(
        auth,
        "set_auth_state",
        lambda profile_id, state, detail: SimpleNamespace(
            id=profile_id, auth_state=state, auth_detail=detail
        ),
    )
    monkeypatch.setattr(
        auth.subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(args[0], kwargs["timeout"])
        ),
    )

    result = auth.check_auth_status("opencode-work")

    assert result["state"] == "error"
    assert result["detail"] == "OpenCode auth status timed out"


def test_logout_dispatches_to_profile_provider(monkeypatch, tmp_path):
    monkeypatch.setattr(
        auth,
        "get_provider_profile",
        lambda _profile_id: SimpleNamespace(provider=ProviderType.CODEX),
    )
    monkeypatch.setattr(auth, "profile_home", lambda *_args, **_kwargs: tmp_path)
    monkeypatch.setattr(
        auth,
        "set_auth_state",
        lambda profile_id, state, detail: SimpleNamespace(
            id=profile_id, auth_state=state, auth_detail=detail
        ),
    )
    calls = []
    monkeypatch.setattr(
        auth.subprocess,
        "run",
        lambda command, **kwargs: calls.append((tuple(command), kwargs["env"]))
        or subprocess.CompletedProcess(command, 0, "", ""),
    )

    result = auth.logout("codex-work")

    assert calls[0][0] == ("codex", "logout")
    assert calls[0][1]["CODEX_HOME"] == str(tmp_path)
    assert result["state"] == "unconfigured"
