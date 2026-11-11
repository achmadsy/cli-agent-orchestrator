import hashlib
import io
import json
import struct
import zipfile

import pytest

from app import node_release as release


def sample_bundle(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as wheel:
        for name in release.REQUIRED_WHEEL:
            wheel.writestr(name, b"fixture")
        wheel.writestr("cli_agent_orchestrator/web_ui/assets/app.js", b"fixture")
        wheel.writestr("cli_agent_orchestrator-2.5.3.dist-info/WHEEL", "Tag: py3-none-any\n")
    binary = bytearray(64)
    binary[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", binary, 18, 62)
    binary.extend(release.PROTOCOL.encode())
    def artifact(name, data):
        (tmp_path / name).write_bytes(data)
        return {"file": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    manifest = {"schema": 1, "id": "fixture-1", "source_sha256": "a" * 64,
                "protocol": release.PROTOCOL, "python": ["3.12", "3.13", "3.14"],
                "wheel": artifact("cli_agent_orchestrator-2.5.3-py3-none-any.whl", buffer.getvalue()),
                "config": artifact("ui.json", b'{"ui":{"theme":{}}}'),
                "sidecars": {"amd64": artifact("cao-terminal-linux-amd64", bytes(binary))}}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    return path, manifest


def test_valid_bundle_and_missing_arch(tmp_path):
    path, expected = sample_bundle(tmp_path)
    result, blobs = release.load_release(path, "amd64")
    assert result == expected
    assert len(blobs) == 3
    with pytest.raises(ValueError, match="unavailable"):
        release.load_release(path, "arm64")


@pytest.mark.parametrize("part", ["wheel", "config", "sidecar"])
def test_tamper_rejected(tmp_path, part):
    path, manifest = sample_bundle(tmp_path)
    spec = manifest[part] if part != "sidecar" else manifest["sidecars"]["amd64"]
    file = tmp_path / spec["file"]
    data = file.read_bytes()
    file.write_bytes(b"x" + data[1:])
    with pytest.raises(ValueError, match="checksum"):
        release.load_release(path)


@pytest.mark.parametrize("name", ["../outside", "/outside", "..", "a/b", "a\\b", ""])
def test_unsafe_names(tmp_path, name):
    path, manifest = sample_bundle(tmp_path)
    manifest["config"]["file"] = name
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="unsafe"):
        release.load_release(path)


def test_symlink_artifact_rejected(tmp_path):
    path, manifest = sample_bundle(tmp_path)
    config = tmp_path / manifest["config"]["file"]
    data = config.read_bytes()
    config.unlink()
    other = tmp_path / "other"
    other.write_bytes(data)
    config.symlink_to(other)
    with pytest.raises(ValueError, match="symlinks"):
        release.load_release(path)


@pytest.mark.parametrize("change", ["protocol", "python", "duplicate", "oversize", "wrongarch", "missing"])
def test_manifest_and_pairing_guards(tmp_path, change):
    path, manifest = sample_bundle(tmp_path)
    if change == "protocol":
        manifest["protocol"] = "old"
    elif change == "python":
        manifest["python"] = ["3.10"]
    elif change == "duplicate":
        manifest["config"] = manifest["wheel"]
    elif change == "oversize":
        manifest["config"]["size"] = release.MAX_ARTIFACT + 1
    elif change == "wrongarch":
        manifest["sidecars"]["arm64"] = manifest["sidecars"].pop("amd64")
    else:
        (tmp_path / manifest["config"]["file"]).unlink()
    path.write_text(json.dumps(manifest))
    with pytest.raises((ValueError, OSError)):
        release.load_release(path)


def test_reject_stale_wheel(tmp_path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as wheel:
        wheel.writestr("cli_agent_orchestrator/web_ui/index.html", "old")
    with pytest.raises(ValueError, match="lacks current"):
        release.validate_wheel(buf.getvalue())


def test_wrong_protocol_in_binary():
    binary = bytearray(64)
    binary[:6] = b"\x7fELF\x02\x01"
    binary[18:20] = (62).to_bytes(2, "little")
    with pytest.raises(ValueError, match="protocol"):
        release.validate_binary(binary, "amd64")


def test_configured_pointer_no_symlink(monkeypatch, tmp_path):
    path, _ = sample_bundle(tmp_path)
    monkeypatch.setenv("CAO_FLEET_RELEASE", str(path))
    assert release.configured_manifest() == path
