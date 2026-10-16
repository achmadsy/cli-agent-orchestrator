"""Durable, non-secret metadata and managed homes for provider profiles."""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
from pathlib import Path
from typing import List, Optional

from cli_agent_orchestrator.constants import CAO_HOME_DIR, DATABASE_FILE, PROVIDERS
from cli_agent_orchestrator.models.provider import ProviderType
from cli_agent_orchestrator.models.provider_profile import (
    ProviderProfile,
    ProviderProfileCreate,
    ProviderProfileUpdate,
    utc_now_iso,
)

_PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PROVIDER_PROFILES_ROOT = CAO_HOME_DIR / "provider-profiles"


class ProviderProfileError(ValueError):
    """Base provider-profile validation error."""


class ProviderProfileNotFoundError(ProviderProfileError):
    """Requested provider profile does not exist."""


class ProviderProfileExistsError(ProviderProfileError):
    """Requested provider profile already exists."""


class ProviderProfileInUseError(ProviderProfileError):
    """Provider profile remains referenced by live configuration."""


def _connect() -> sqlite3.Connection:
    # init_db() owns production schema setup. This guard preserves standalone
    # store use and tests that intentionally repoint DATABASE_FILE without
    # starting the API lifespan.
    from cli_agent_orchestrator.clients.database import _migrate_provider_profiles

    _migrate_provider_profiles(DATABASE_FILE)
    conn = sqlite3.connect(str(DATABASE_FILE))
    conn.row_factory = sqlite3.Row
    return conn


def _validate_id(profile_id: str) -> None:
    if not _PROFILE_ID_RE.fullmatch(profile_id):
        raise ProviderProfileError(
            "provider profile id must match [A-Za-z0-9_-]{1,64}"
        )


def profile_home(provider: str, profile_id: str, *, create: bool = False) -> Path:
    """Resolve one managed provider home beneath CAO's fixed profile root."""
    _validate_id(profile_id)
    if provider not in PROVIDERS:
        raise ProviderProfileError(f"unknown canonical provider '{provider}'")

    provider_root = PROVIDER_PROFILES_ROOT / provider
    candidate = provider_root / profile_id
    for managed_path in (PROVIDER_PROFILES_ROOT, provider_root, candidate):
        if managed_path.is_symlink():
            raise ProviderProfileError("provider profile path cannot contain a symlink")

    root = PROVIDER_PROFILES_ROOT.resolve(strict=False)
    resolved = candidate.resolve(strict=False)
    if not resolved.is_relative_to(root):
        raise ProviderProfileError("provider profile path escapes managed root")
    if create:
        resolved.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(resolved, 0o700)
    return resolved


def _from_row(row: sqlite3.Row) -> ProviderProfile:
    return ProviderProfile(
        id=row["id"],
        label=row["label"],
        provider=row["provider"],
        login_method=row["login_method"],
        settings=json.loads(row["settings_json"] or "{}"),
        is_default=bool(row["is_default"]),
        auth_state=row["auth_state"],
        auth_detail=row["auth_detail"],
        last_checked_at=row["last_checked_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def list_provider_profiles(provider: Optional[str] = None) -> List[ProviderProfile]:
    with _connect() as conn:
        if provider is None:
            rows = conn.execute(
                "SELECT * FROM provider_profiles ORDER BY provider, label COLLATE NOCASE, id"
            ).fetchall()
        else:
            if provider not in PROVIDERS:
                raise ProviderProfileError(f"unknown canonical provider '{provider}'")
            rows = conn.execute(
                "SELECT * FROM provider_profiles WHERE provider = ? "
                "ORDER BY is_default DESC, label COLLATE NOCASE, id",
                (provider,),
            ).fetchall()
    return [_from_row(row) for row in rows]


def get_provider_profile(profile_id: str) -> ProviderProfile:
    _validate_id(profile_id)
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM provider_profiles WHERE id = ?", (profile_id,)
        ).fetchone()
    if row is None:
        raise ProviderProfileNotFoundError(f"provider profile '{profile_id}' not found")
    return _from_row(row)


def create_provider_profile(request: ProviderProfileCreate) -> ProviderProfile:
    provider = request.provider.value
    if provider == ProviderType.MOCK_CLI.value:
        raise ProviderProfileError("mock_cli provider profiles cannot be created")
    from cli_agent_orchestrator.services.provider_profile_registry import (
        capabilities_for,
        validate_profile_settings,
    )

    capabilities = capabilities_for(provider)
    if not capabilities.supported:
        raise ProviderProfileError(
            f"provider '{provider}' does not support isolated account profiles"
        )
    if request.login_method != capabilities.profile_mode:
        raise ProviderProfileError(
            f"provider '{provider}' requires login_method '{capabilities.profile_mode}'"
        )
    settings = validate_profile_settings(provider, request.settings)
    home = profile_home(provider, request.id, create=True)
    now = utc_now_iso()
    try:
        with _connect() as conn:
            if request.is_default:
                conn.execute(
                    "UPDATE provider_profiles SET is_default = 0, updated_at = ? "
                    "WHERE provider = ?",
                    (now, provider),
                )
            conn.execute(
                "INSERT INTO provider_profiles "
                "(id, label, provider, login_method, settings_json, is_default, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    request.id,
                    request.label.strip(),
                    provider,
                    request.login_method,
                    json.dumps(settings, separators=(",", ":"), sort_keys=True),
                    int(request.is_default),
                    now,
                    now,
                ),
            )
    except sqlite3.IntegrityError as exc:
        if home.exists() and not any(home.iterdir()):
            home.rmdir()
        raise ProviderProfileExistsError(
            f"provider profile '{request.id}' already exists"
        ) from exc
    return get_provider_profile(request.id)


def update_provider_profile(
    profile_id: str, request: ProviderProfileUpdate
) -> ProviderProfile:
    current = get_provider_profile(profile_id)
    label = request.label.strip() if request.label is not None else current.label
    settings = current.settings
    if request.settings is not None:
        from cli_agent_orchestrator.services.provider_profile_registry import (
            validate_profile_settings,
        )

        settings = validate_profile_settings(current.provider.value, request.settings)
    make_default = request.is_default if request.is_default is not None else current.is_default
    now = utc_now_iso()
    with _connect() as conn:
        if make_default:
            conn.execute(
                "UPDATE provider_profiles SET is_default = 0, updated_at = ? "
                "WHERE provider = ? AND id != ?",
                (now, current.provider.value, profile_id),
            )
        conn.execute(
            "UPDATE provider_profiles SET label = ?, settings_json = ?, is_default = ?, "
            "updated_at = ? WHERE id = ?",
            (
                label,
                json.dumps(settings, separators=(",", ":"), sort_keys=True),
                int(make_default),
                now,
                profile_id,
            ),
        )
    return get_provider_profile(profile_id)


def get_default_provider_profile(provider: str) -> Optional[ProviderProfile]:
    if provider not in PROVIDERS:
        raise ProviderProfileError(f"unknown canonical provider '{provider}'")
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM provider_profiles WHERE provider = ? AND is_default = 1",
            (provider,),
        ).fetchone()
    return _from_row(row) if row is not None else None


def resolve_provider_profile(
    provider: str, requested_profile: Optional[str]
) -> Optional[ProviderProfile]:
    """Resolve an explicit profile or the provider default and validate ownership."""
    profile = (
        get_provider_profile(requested_profile)
        if requested_profile
        else get_default_provider_profile(provider)
    )
    if profile is not None and profile.provider.value != provider:
        raise ProviderProfileError(
            f"provider profile '{profile.id}' belongs to '{profile.provider.value}', not '{provider}'"
        )
    return profile


_AUTH_STATES = frozenset(
    {"unknown", "authenticated", "expired", "unconfigured", "unsupported", "error"}
)


def set_auth_state(
    profile_id: str, state: str, detail: Optional[str] = None
) -> ProviderProfile:
    get_provider_profile(profile_id)
    if state not in _AUTH_STATES:
        raise ProviderProfileError(f"invalid auth state '{state}'")
    now = utc_now_iso()
    bounded_detail = detail[:256] if detail else None
    with _connect() as conn:
        conn.execute(
            "UPDATE provider_profiles SET auth_state = ?, auth_detail = ?, "
            "last_checked_at = ?, updated_at = ? WHERE id = ?",
            (state, bounded_detail, now, now, profile_id),
        )
    return get_provider_profile(profile_id)


def delete_provider_profile(profile_id: str, *, delete_home: bool = False) -> None:
    profile = get_provider_profile(profile_id)
    with _connect() as conn:
        terminal_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(terminals)").fetchall()
        }
        if "provider_profile" in terminal_columns:
            referenced = conn.execute(
                "SELECT 1 FROM terminals WHERE provider_profile = ? LIMIT 1",
                (profile_id,),
            ).fetchone()
            if referenced is not None:
                raise ProviderProfileInUseError(
                    f"provider profile '{profile_id}' is referenced by a terminal"
                )
            if "provider_profile" in {
                row[1] for row in conn.execute("PRAGMA table_info(flows)").fetchall()
            }:
                flow_referenced = conn.execute(
                    "SELECT 1 FROM flows WHERE provider_profile = ? LIMIT 1",
                    (profile_id,),
                ).fetchone()
                if flow_referenced is not None:
                    raise ProviderProfileInUseError(
                        f"provider profile '{profile_id}' is referenced by a flow"
                    )
        conn.execute("DELETE FROM provider_profiles WHERE id = ?", (profile_id,))

    if delete_home:
        home = profile_home(profile.provider.value, profile_id)
        if home.exists():
            shutil.rmtree(home)
