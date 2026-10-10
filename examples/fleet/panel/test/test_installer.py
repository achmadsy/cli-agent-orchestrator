import io
import tarfile

import pytest

from app import installer


def test_validate_user():
    assert installer.validate_user("ubuntu") == "ubuntu"
    with pytest.raises(ValueError):
        installer.validate_user("bad user")


def test_payload_contains_no_token_in_file_names(monkeypatch, tmp_path):
    wheel = tmp_path / "cli_agent_orchestrator-2.5.3-py3-none-any.whl"
    wheel.write_bytes(b"wheel")
    monkeypatch.setattr(installer, "WHEEL_PATH", wheel)
    payload = installer._payload("worker-2", "worker-2", "ubuntu", "100.64.0.42", "secret-value")
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r") as archive:
        names = archive.getnames()
        assert names == [
            "install.sh",
            "node.env",
            "cao-server.env",
            "cli_agent_orchestrator-2.5.3-py3-none-any.whl",
        ]
        env = archive.extractfile("cao-server.env").read().decode()
    assert "secret-value" in env
    assert all("secret-value" not in name for name in names)
    assert "CAO_HOME_DIR=/home/ubuntu/.local/share/cao" in env
    assert "CAO_MEMORY_API_URL=http://100.78.240.36:9889" in env


def test_job_public_never_contains_node_token():
    job = installer.Job(id="abc", machine="worker", peer="worker", user="ubuntu")
    assert "token" not in job.public()
