"""Hermetic target installer execution: real files, fake external services/tools."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
from unittest.mock import MagicMock

import pytest

from app import node_install as install
from test.test_node_release import sample_bundle


@pytest.fixture
def target(monkeypatch, tmp_path):
    root = tmp_path / "payload"
    root.mkdir()
    path, manifest = sample_bundle(root, with_adapter=False)
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    connection = home / '.config/cao/mcp-client.json'
    connection.parent.mkdir(parents=True, mode=0o700)
    connection.write_text(json.dumps({'version': 1, 'central_url': 'http://100.78.240.36:9889',
                                     'local_url': 'http://100.64.0.42:9889',
                                     'central_token': 'synthetic-central-token', 'local_token': 'synthetic-local-token'}))
    connection.chmod(0o600)
    (root / "node.env").write_text(f"CAO_HOME_DIR={home}/.local/share/cao\nCAO_BIND_HOST=100.64.0.42\n")
    token = "fixture-secret-" * 4
    (root / "cao-server.env").write_text(f"CAO_AUTH_LOCAL_TOKEN={token}\n")
    monkeypatch.setattr(install, "ROOT", root)
    monkeypatch.setattr(install.integration, 'helper', lambda manifest, blobs: __import__('cli_agent_orchestrator.services.harness_mcp_integration', fromlist=['prepare']))
    monkeypatch.setattr(install.integration, 'preflight_connection', lambda *a, **k: None)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setattr(install, "release_arch", lambda: "amd64")
    for key in ("TMUX", "TMUX_TMPDIR", "UV_TOOL_DIR", "UV_TOOL_BIN_DIR", "XDG_CONFIG_HOME"):
        monkeypatch.delenv(key, raising=False)
    calls = []
    def fake_run(command, **kwargs):
        calls.append(list(command))
        if command[:3] == ["systemctl", "--user", "show"]:
            return MagicMock(returncode=0, stdout="not-found\n", stderr="")
        if '--check' in command:
            return MagicMock(returncode=0, stdout=json.dumps({'proof': install.integration.PROOF, 'tools': list(range(14))}), stderr='')
        return MagicMock(returncode=0, stdout="", stderr="")
    monkeypatch.setattr(install.subprocess, "run", fake_run)
    monkeypatch.setattr(install, "resolve_socket", lambda: Path("/tmp/tmux-fixture/default"))
    return root, home, manifest, calls


def test_fresh_install_real_files_and_health_order(target, monkeypatch, capsys):
    root, home, manifest, calls = target
    def healthy(base, token, internal, protocol):
        assert token == "fixture-secret-" * 4
        assert len(internal) >= 48 and internal != token
        env = (home / ".config/cao/terminal-workspace.env").read_text()
        assert internal in env
        assert protocol == install.release.PROTOCOL
        assert calls[-1][:4] == ["systemctl", "--user", "enable", "--now"]
    monkeypatch.setattr(install, "health", healthy)
    install.install("/usr/bin/python3.12")
    output = capsys.readouterr().out
    assert "CAO fleet install complete" in output
    assert install.integration.PROOF in output
    assert not (home / '.config/opencode/plugins/cbm-augment.ts').exists()
    assert (home / '.config/cao/cli-integration-receipt.json').exists()
    assert "fixture-secret" not in output
    assert not (home / ".config/cao/node-install-incomplete").exists()
    for name in ("cao-server.env", "terminal-workspace.env", "cao-terminal-ui.json", "node-release.json"):
        assert stat.S_IMODE((home / ".config/cao" / name).stat().st_mode) == 0o600
    binary = home / ".local/bin/cao-terminal"
    assert stat.S_IMODE(binary.stat().st_mode) == 0o755
    assert binary.read_bytes() == (root / manifest["sidecars"]["amd64"]["file"]).read_bytes()
    unit = (home / ".config/systemd/user/cao-terminal.service").read_text()
    assert "--listen 127.0.0.1:9528" in unit
    assert "/tmp/tmux-fixture/default" in unit and "NoNewPrivileges=true" in unit
    backend = (home / ".config/systemd/user/cao-server.service").read_text()
    assert "terminal-workspace.env" in backend
    uv = next(c for c in calls if c[:3] == ["uv", "tool", "install"])
    assert "--no-python-downloads" in uv and "--no-build" in uv and "--reinstall" not in uv
    assert "--only-binary" not in uv
    assert uv[uv.index("--python") + 1] == "/usr/bin/python3.12"


@pytest.mark.parametrize("path", [".local/share/cao", ".local/bin/cao", ".config/cao/terminal-workspace.env", ".config/systemd/user/cao-terminal.service"])
def test_refuses_existing_node_before_mutation(target, path):
    _, home, _, calls = target
    p = home / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"preserve")
    with pytest.raises(RuntimeError, match="existing CAO"):
        install.install("/usr/bin/python3.12")
    assert not calls
    assert p.read_bytes() == b"preserve"


def test_failed_health_removes_only_created_artifacts_retains_data_marker(target, monkeypatch, capsys):
    _, home, _, calls = target
    def fail(*args):
        data = home / ".local/share/cao"
        data.mkdir(parents=True)
        (data / "keep").write_bytes(b"unchanged")
        raise RuntimeError("health failed")
    monkeypatch.setattr(install, "health", fail)
    with pytest.raises(RuntimeError, match="health failed"):
        install.install("/usr/bin/python3.12")
    assert (home / ".local/share/cao/keep").read_bytes() == b"unchanged"
    assert (home / ".config/cao/node-install-incomplete").is_file()
    assert not (home / ".local/bin/cao-terminal").exists()
    assert not (home / ".config/opencode/plugins/cbm-augment.ts").exists()
    assert not (home / ".config/systemd/user/cao-terminal.service").exists()
    assert ["systemctl", "--user", "disable", "--now", "cao-server.service", "cao-terminal.service"] in calls
    assert "CAO fleet install complete" not in capsys.readouterr().out


def test_health_requires_denied_anonymous_sidecar(monkeypatch):
    calls = []
    def fetch(url, headers):
        calls.append(headers)
        return {"status": "ok", "version": install.release.PROTOCOL}
    monkeypatch.setattr(install, "fetch", fetch)
    with pytest.raises(RuntimeError, match="anonymous"):
        install.health("http://100.64.0.42:9889", "node", "internal", install.release.PROTOCOL)
    assert calls[0] == {"Authorization": "Bearer node"}
    assert calls[1] == {"X-CAO-Terminal-Token": "internal"}


def test_install_rejects_tamper_before_tools(target):
    root, home, _, calls = target
    (root / "ui.json").write_bytes(b"bad")
    with pytest.raises(ValueError, match="mismatch"):
        install.install("/usr/bin/python3.12")
    assert not calls and not (home / '.config/cao/node-install-incomplete').exists()


def test_missing_operator_connection_refused_before_packages(target):
    _, home, _, calls = target
    (home / '.config/cao/mcp-client.json').unlink()
    with pytest.raises(ValueError, match='Operator must provision'):
        install.install('/usr/bin/python3.12')
    assert not any(c[:3] == ['uv', 'tool', 'install'] for c in calls)
    assert not (home / '.config/cao/node-install-incomplete').exists()


def test_existing_adapter_restored_on_later_health_failure(target, monkeypatch):
    _, home, _, calls = target
    plugins = home / ".config/opencode/plugins"
    plugins.mkdir(parents=True)
    target_file = plugins / "cbm-augment.ts"
    from cli_agent_orchestrator.services.harness_mcp_integration import digest
    adapter_bytes = Path('/home/ubuntu/workspace/cao/cli-agent-orchestrator/examples/opencode/codebase-memory/cbm-augment.mjs').read_bytes()
    assert digest(adapter_bytes) == 'db724ef9a7f127b2adafd158390e2f22ea496674756ae1a7be83d9db3ca34d79'
    target_file.write_bytes(adapter_bytes)
    target_file.chmod(0o640)
    config = plugins.parent / "opencode.jsonc"
    config.write_bytes(b'{"provider":{"keep":true}}')
    def fail(*args):
        raise RuntimeError("synthetic health failure")
    monkeypatch.setattr(install, "health", fail)
    with pytest.raises(RuntimeError, match="health failure"):
        install.install("/usr/bin/python3.12")
    assert target_file.read_bytes() == adapter_bytes
    assert stat.S_IMODE(target_file.stat().st_mode) == 0o640
    assert config.read_bytes() == b'{"provider":{"keep":true}}'
    assert not (home / ".config/cao/opencode-cbm-v2.json").exists()


def test_fresh_installer_user_service_policy(target, monkeypatch):
    monkeypatch.setattr(install.subprocess, "run", lambda *a, **k: MagicMock(returncode=0, stdout="loaded\n"))
    with pytest.raises(RuntimeError, match="service"):
        install.preflight()
