from __future__ import annotations

import os
from pathlib import Path

import pytest

from cli_agent_orchestrator.models.provider_profile import (
    ProviderProfileCreate,
    ProviderProfileUpdate,
)
from cli_agent_orchestrator.services import provider_profile_store as store


@pytest.fixture
def isolated_store(tmp_path, monkeypatch):
    db_path = tmp_path / "profiles.db"
    root = tmp_path / "provider-profiles"
    monkeypatch.setattr(store, "DATABASE_FILE", db_path)
    monkeypatch.setattr(store, "PROVIDER_PROFILES_ROOT", root)
    return root


def test_profile_schema_migration_preserves_legacy_rows(tmp_path):
    import sqlite3

    from cli_agent_orchestrator.clients.database import _migrate_provider_profiles

    db_path = tmp_path / "legacy.db"
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute(
            "CREATE TABLE provider_profiles ("
            "id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL, "
            "login_method TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, "
            "auth_state TEXT NOT NULL DEFAULT 'unknown', auth_detail TEXT, "
            "last_checked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO provider_profiles "
            "(id, label, provider, login_method, created_at, updated_at) "
            "VALUES ('legacy', 'Legacy', 'claude_code', 'isolated_home', 'now', 'now')"
        )

    _migrate_provider_profiles(db_path)
    _migrate_provider_profiles(db_path)

    with sqlite3.connect(str(db_path)) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(provider_profiles)")}
        row = conn.execute(
            "SELECT id, settings_json FROM provider_profiles WHERE id = 'legacy'"
        ).fetchone()
        indexes = {
            result[0]
            for result in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            )
        }
    assert "settings_json" in columns
    assert row == ("legacy", "{}")
    assert "idx_provider_profiles_one_default" in indexes


def test_create_profile_uses_private_managed_home(isolated_store):
    profile = store.create_provider_profile(
        ProviderProfileCreate(id="claude-code-profile1", label="Work", provider="claude_code", login_method="isolated_home", is_default=True)
    )
    home = isolated_store / "claude_code" / profile.id
    assert profile.provider.value == "claude_code"
    assert profile.is_default is True
    assert home.is_dir()
    assert (home.stat().st_mode & 0o777) == 0o700


def test_default_switch_is_atomic_per_provider(isolated_store):
    first = store.create_provider_profile(
        ProviderProfileCreate(id="one", label="One", provider="claude_code", login_method="isolated_home", is_default=True)
    )
    second = store.create_provider_profile(
        ProviderProfileCreate(id="two", label="Two", provider="claude_code", login_method="isolated_home", is_default=False)
    )
    store.update_provider_profile(second.id, ProviderProfileUpdate(is_default=True))
    assert store.get_provider_profile(first.id).is_default is False
    assert store.get_default_provider_profile("claude_code").id == second.id


def test_rejects_unsafe_profile_id(isolated_store):
    with pytest.raises(ValueError):
        ProviderProfileCreate(
            id="../escape",
            label="Bad",
            provider="claude_code",
            login_method="isolated_home",
        )


def test_rejects_unverified_provider_profile(isolated_store):
    with pytest.raises(store.ProviderProfileError, match="does not support"):
        store.create_provider_profile(
            ProviderProfileCreate(
                id="codex-work",
                label="Codex Work",
                provider="codex",
                login_method="native_profile",
                settings={"native_profile": "work"},
            )
        )


def test_rejects_wrong_login_method(isolated_store):
    with pytest.raises(store.ProviderProfileError, match="requires login_method"):
        store.create_provider_profile(
            ProviderProfileCreate(
                id="claude-work",
                label="Claude Work",
                provider="claude_code",
                login_method="native_profile",
                settings={"native_profile": "work"},
            )
        )


def test_profile_home_rejects_symlinked_provider_root(isolated_store, tmp_path):
    provider_root = isolated_store / "claude_code"
    isolated_store.mkdir()
    provider_root.symlink_to(tmp_path / "outside", target_is_directory=True)

    with pytest.raises(store.ProviderProfileError, match="symlink"):
        store.profile_home("claude_code", "work", create=True)


def test_delete_home_is_explicit(isolated_store):
    profile = store.create_provider_profile(ProviderProfileCreate(id="delete-me", label="Delete", provider="claude_code", login_method="isolated_home"))
    home = store.profile_home("claude_code", profile.id)
    marker = home / "settings.json"
    marker.write_text("{}")
    os.chmod(marker, 0o600)

    store.delete_provider_profile(profile.id, delete_home=False)
    assert home.exists()
