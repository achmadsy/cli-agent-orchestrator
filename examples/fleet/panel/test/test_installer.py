import io
import tarfile
from unittest.mock import MagicMock

import pytest

from app import installer


def test_validate_user():
    assert installer.validate_user("ubuntu") == "ubuntu"
    with pytest.raises(ValueError):
        installer.validate_user("bad user")


def test_map_arch():
    assert installer.map_arch("x86_64") == "amd64"
    assert installer.map_arch("amd64") == "amd64"
    assert installer.map_arch("aarch64") == "arm64"
    assert installer.map_arch("arm64") == "arm64"
    with pytest.raises(ValueError, match="unsupported architecture"):
        installer.map_arch("armv7l")


def test_payload_contains_no_token_in_file_names(monkeypatch, tmp_path):
    wheel = tmp_path / "cli_agent_orchestrator-2.5.3-py3-none-any.whl"
    wheel.write_bytes(b"wheel")
    cbm = tmp_path / "codebase-memory-mcp-linux-amd64-portable.tar.gz"
    cbm.write_bytes(b"cbm-archive")
    monkeypatch.setattr(installer, "WHEEL_PATH", wheel)
    monkeypatch.setattr(installer, "ensure_cbm_archive", lambda arch: cbm)
    payload = installer._payload(
        "worker-2", "worker-2", "ubuntu", "100.64.0.42", "secret-value", arch="amd64"
    )
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r") as archive:
        names = archive.getnames()
        assert names == [
            "install.sh",
            "node.env",
            "cao-server.env",
            "cli_agent_orchestrator-2.5.3-py3-none-any.whl",
            "codebase-memory-mcp-linux-amd64-portable.tar.gz",
        ]
        env = archive.extractfile("cao-server.env").read().decode()
    assert "secret-value" in env
    assert all("secret-value" not in name for name in names)
    assert "CAO_HOME_DIR=/home/ubuntu/.local/share/cao" in env
    assert "CAO_BIND_HOST=100.64.0.42" in env
    assert "CAO_API_HOST=100.64.0.42" in env
    assert "CAO_API_PORT=9889" in env
    assert "CAO_MEMORY_API_URL=http://100.78.240.36:9889" in env
    assert "CAO_CODEBASE_ENABLED=true" in env
    assert "CAO_CODEBASE_API_URL=http://100.78.240.36:9889" in env


def test_install_script_contains_cbm_pins_and_integrity_guards():
    script = installer._install_script()
    assert installer.CBM_ASSETS["amd64"]["sha256"] in script
    assert installer.CBM_ASSETS["arm64"]["sha256"] in script
    assert "ensure_cbm" in script
    assert 'codebase-memory-mcp 0.10.8' in script
    assert "sha256sum" in script
    assert "mktemp -d" in script
    assert "install -m 755" in script
    assert "claude mcp add" not in script


def test_ensure_cbm_archive_uses_cached_if_valid(monkeypatch, tmp_path):
    monkeypatch.setattr(installer, "cbm_cache_dir", lambda: tmp_path)
    meta = installer.CBM_ASSETS["amd64"]
    target = tmp_path / meta["filename"]
    target.write_bytes(b"valid-content")
    monkeypatch.setattr(installer, "_file_sha256", lambda p: meta["sha256"])
    monkeypatch.setattr(
        installer.urllib.request,
        "urlopen",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not download")),
    )
    resolved = installer.ensure_cbm_archive("amd64")
    assert resolved == target


def test_ensure_cbm_archive_rejects_checksum_mismatch(monkeypatch, tmp_path):
    monkeypatch.setattr(installer, "cbm_cache_dir", lambda: tmp_path)
    meta = installer.CBM_ASSETS["amd64"]

    class FakeResponse:
        def read(self, *args):
            return b""
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass

    monkeypatch.setattr(installer.urllib.request, "urlopen", lambda *args, **kwargs: FakeResponse())
    monkeypatch.setattr(installer.shutil, "copyfileobj", lambda src, dst: None)
    monkeypatch.setattr(installer, "_file_sha256", lambda p: "bad-sha256")
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        installer.ensure_cbm_archive("amd64")


def test_probe_remote_arch_success_and_error(monkeypatch):
    def fake_run(cmd, **kwargs):
        return MagicMock(returncode=0, stdout="x86_64\n", stderr="")

    monkeypatch.setattr(installer.subprocess, "run", fake_run)
    assert installer.probe_remote_arch("ubuntu", "worker-1") == "amd64"

    def fake_run_err(cmd, **kwargs):
        return MagicMock(returncode=1, stdout="", stderr="permission denied")

    monkeypatch.setattr(installer.subprocess, "run", fake_run_err)
    with pytest.raises(RuntimeError, match="failed to probe remote architecture"):
        installer.probe_remote_arch("ubuntu", "worker-1")


def test_job_public_never_contains_node_token():
    job = installer.Job(id="abc", machine="worker", peer="worker", user="ubuntu")
    assert "token" not in job.public()
