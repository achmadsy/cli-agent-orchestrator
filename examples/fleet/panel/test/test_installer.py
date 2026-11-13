import hashlib
import io
import tarfile
import subprocess
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
    from test.test_node_release import sample_bundle
    path, manifest = sample_bundle(tmp_path, with_adapter=False)
    cbm = tmp_path / "codebase-memory-mcp-linux-amd64-portable.tar.gz"
    cbm.write_bytes(b"cbm-archive")
    monkeypatch.setattr(installer.node_release, "configured_manifest", lambda: path)
    monkeypatch.setattr(installer, "ensure_cbm_archive", lambda arch: cbm)
    monkeypatch.setitem(installer.CBM_ASSETS["amd64"], "sha256", hashlib.sha256(cbm.read_bytes()).hexdigest())
    token = "secret-value-" * 4
    payload = installer._payload(
        "worker-2", "worker-2", "ubuntu", "100.64.0.42", token, arch="amd64"
    )
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r") as archive:
        names = archive.getnames()
        assert set(names) == {
            "install.sh", "node.env", "cao-server.env", "manifest.json",
            "node_release.py", "node_install.py", "ui.json", "cao-terminal-linux-amd64",
            "cli_agent_orchestrator-2.5.3-py3-none-any.whl",
            "codebase-memory-mcp-linux-amd64-portable.tar.gz",
            "cao-harness-integration.py", "cli_integration.py",
        }
        assert len(names) == len(set(names))
        assert all(member.isreg() and member.mode in (0o600, 0o700) for member in archive.getmembers())
        env = archive.extractfile("cao-server.env").read().decode()
    assert token in env
    assert all(token not in name for name in names)
    assert "CAO_HOME_DIR=/home/ubuntu/.local/share/cao" in env
    assert "CAO_BIND_HOST=100.64.0.42" in env
    assert "CAO_API_HOST=100.64.0.42" in env
    assert "CAO_API_PORT=9889" in env
    assert "CAO_MEMORY_API_URL=http://100.78.240.36:9889" in env
    assert "CAO_CODEBASE_ENABLED=true" in env
    assert "CAO_CODEBASE_API_URL=http://100.78.240.36:9889" in env


def test_updated_installer_rejects_release_without_adapter(monkeypatch, tmp_path):
    from test.test_node_release import sample_bundle
    path, _ = sample_bundle(tmp_path, with_shared=False)
    monkeypatch.setattr(installer.node_release, "configured_manifest", lambda: path)
    monkeypatch.setattr(installer, "ensure_cbm_archive", lambda arch: pytest.fail("must fail before CBM download"))
    with pytest.raises(ValueError, match="lacks required CAO shared"):
        installer._payload("worker", "worker", "link", "100.64.0.42", "x" * 48)


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


def test_generated_shell_syntax_and_private_remote_staging():
    result = subprocess.run(["bash", "-n"], input=installer._install_script(), text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    import shlex
    parts = shlex.split(installer.REMOTE_COMMAND)
    assert parts[:2] == ["bash", "-c"]
    assert subprocess.run(["bash", "-n"], input=parts[2], text=True).returncode == 0
    assert "mktemp -d /tmp/cao-fleet-install." in parts[2]
    assert "trap" in parts[2]
    assert "--reinstall" not in installer._install_script()
    assert "--no-python-downloads" in (installer.Path(installer.__file__).parent / "node_install.py").read_text()


@pytest.mark.parametrize("output,code", [(b"", 0), (b"CAO fleet install complete\n", 0), (b"Authenticated CAO and terminal health passed\nCAO fleet install complete\n", 0), (b"", 1)])
def test_no_registration_without_both_health_markers(monkeypatch, output, code):
    monkeypatch.setattr(installer, "_ingress_check", lambda *a, **k: None)
    monkeypatch.setattr(installer, "probe_remote_arch", lambda *a: "amd64")
    monkeypatch.setattr(installer, "ensure_cbm_archive", lambda *a: None)
    monkeypatch.setattr(installer, "_payload", lambda *a: b"fixture")
    monkeypatch.setattr(installer.subprocess, "run", lambda *a, **k: MagicMock(returncode=code, stdout=output, stderr=b""))
    monkeypatch.setattr(installer.config, "add_machine", lambda *a: pytest.fail("must not register"))
    job = installer.Job(id="1", machine="worker", peer="worker", user="link")
    installer._run(job, "100.64.0.42", "x" * 48)
    assert job.status == "failed"


def test_registration_after_health(monkeypatch):
    calls = []
    monkeypatch.setattr(installer, "probe_remote_arch", lambda *a: "amd64")
    monkeypatch.setattr(installer, "ensure_cbm_archive", lambda *a: None)
    monkeypatch.setattr(installer, "_payload", lambda *a: b"fixture")
    def run(command, **kwargs):
        if command[0] == "sudo" and installer.config.INGRESS_COMMAND in command:
            calls.append(command[3])
            marker = "CAO_FLEET_POLICY_OK_V1" if command[3] == "--check-policy" else "CAO_FLEET_INGRESS_VERIFIED_V1"
            return MagicMock(returncode=0, stdout=marker + "\n", stderr="")
        calls.append(command[0])
        return MagicMock(returncode=0, stdout=b"CAO_SHARED_CLI_READY_V1\nAuthenticated CAO and terminal health passed\nCAO fleet install complete\n", stderr=b"")
    monkeypatch.setattr(installer.subprocess, "run", run)
    monkeypatch.setattr(installer.config, "add_machine", lambda m: calls.append("register") or m)
    job = installer.Job(id="1", machine="worker", peer="worker", user="link")
    installer._run(job, "100.64.0.42", "x" * 48)
    assert calls == ["--check-policy", "tailscale", "register", "sudo", "--verify-ingress"]
    assert job.status == "installed"
    assert any("10 MiB" in step for step in job.steps)


def test_old_proxy_policy_blocks_remote_mutation(monkeypatch):
    monkeypatch.setattr(installer.subprocess, "run", lambda *a, **k: MagicMock(returncode=0, stdout="old helper", stderr=""))
    monkeypatch.setattr(installer, "probe_remote_arch", lambda *a: pytest.fail("must not SSH before policy proof"))
    job = installer.Job(id="1", machine="worker", peer="worker", user="link")
    installer._run(job, "100.64.0.42", "x" * 48)
    assert job.status == "failed" and "proof missing" in job.error


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_ingress_failure_compensates_registration(monkeypatch, cleanup_fails):
    calls = []
    def ingress(*args, **kwargs):
        if args[0] == "--verify-ingress":
            raise RuntimeError("no ingress")
    monkeypatch.setattr(installer, "_ingress_check", ingress)
    monkeypatch.setattr(installer, "probe_remote_arch", lambda *a: "amd64")
    monkeypatch.setattr(installer, "ensure_cbm_archive", lambda *a: None)
    monkeypatch.setattr(installer, "_payload", lambda *a: b"fixture")
    def run(command, **kwargs):
        calls.append(command[0])
        if cleanup_fails and calls.count("sudo") == 2:
            raise RuntimeError("cleanup failed")
        return MagicMock(returncode=0, stdout=b"CAO_SHARED_CLI_READY_V1\nAuthenticated CAO and terminal health passed\nCAO fleet install complete\n", stderr=b"")
    monkeypatch.setattr(installer.subprocess, "run", run)
    monkeypatch.setattr(installer.config, "add_machine", lambda m: calls.append("register") or m)
    monkeypatch.setattr(installer.config, "remove_machine", lambda name: calls.append("remove"))
    job = installer.Job(id="1", machine="worker", peer="worker", user="link")
    installer._run(job, "100.64.0.42", "x" * 48)
    assert calls == ["tailscale", "register", "sudo", "remove", "sudo"]
    assert job.status == "failed"
    assert ("cleanup incomplete" if cleanup_fails else "registration reverted") in job.error
