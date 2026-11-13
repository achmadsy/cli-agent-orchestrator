"""Validate an operator-built, checksum-pinned CAO node release (not a signature)."""

import hashlib
import json
import os
import re
import stat
import zipfile
from pathlib import Path

PROTOCOL = "cao-terminal/195ad23136c500b10fc88ba50397a25fa7b8c4d9-grid-v2"
MAX_ARTIFACT = 128 * 1024 * 1024
OPENCODE_INTEGRATION = "opencode_cbm_v2"
OPENCODE_ARTIFACT = "opencode-cbm-v2.mjs"  # Historical manifests only.
CLI_INTEGRATION = "cao_shared_cli_v1"
CLI_ARTIFACT = "cao-harness-integration.py"
REQUIRED_WHEEL = {
    "cli_agent_orchestrator/api/terminal_workspace.py",
    "cli_agent_orchestrator/services/terminal_workspace_service.py",
    "cli_agent_orchestrator/services/terminal_attachment_service.py",
    "cli_agent_orchestrator/web_ui/index.html",
}


def _regular(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError("release paths must not contain symlinks")
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("release artifact must be a regular file")
    return path


def read_artifact(root, spec):
    if not isinstance(spec, dict) or set(spec) != {"file", "sha256", "size"}:
        raise ValueError("invalid release artifact metadata")
    name = spec["file"]
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}", name):
        raise ValueError("unsafe release artifact name")
    if type(spec["size"]) is not int or not 0 < spec["size"] <= MAX_ARTIFACT:
        raise ValueError("invalid release artifact size")
    if not isinstance(spec["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", spec["sha256"]):
        raise ValueError("invalid release artifact checksum")
    path = _regular(Path(root) / name)
    if path.stat().st_size != spec["size"]:
        raise ValueError("release artifact size mismatch")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != spec["sha256"]:
        raise ValueError("release artifact checksum mismatch")
    return data


def validate_wheel(data):
    import io

    with zipfile.ZipFile(io.BytesIO(data)) as wheel:
        names = wheel.namelist()
        if len(names) != len(set(names)) or len(names) > 10000:
            raise ValueError("invalid wheel member list")
        if not REQUIRED_WHEEL.issubset(names):
            raise ValueError("wheel lacks current terminal gateway/frontend")
        total = 0
        for info in wheel.infolist():
            name = info.filename
            total += info.file_size
            if name.startswith("/") or ".." in Path(name).parts or "\\" in name or any(ord(c) < 32 for c in name) or total > 256 * 1024 * 1024:
                raise ValueError("unsafe wheel members")
            if stat.S_ISLNK(info.external_attr >> 16) or Path(name).name.startswith("cao-tui"):
                raise ValueError("unexpected executable or symlink in portable wheel")
        tags = [n for n in names if n.endswith(".dist-info/WHEEL")]
        if len(tags) != 1 or b"Tag: py3-none-any" not in wheel.read(tags[0]):
            raise ValueError("node release requires a portable Python wheel")
        if not any(n.startswith("cli_agent_orchestrator/web_ui/assets/") and n.endswith(".js") for n in names):
            raise ValueError("wheel lacks built frontend assets")


def validate_binary(data, arch):
    expected = {"amd64": 62, "arm64": 183}.get(arch)
    if expected is None or len(data) < 64 or data[:6] != b"\x7fELF\x02\x01" or int.from_bytes(data[18:20], "little") != expected:
        raise ValueError("sidecar architecture mismatch")
    # Go formats the prefix and pinned version separately at runtime.
    if PROTOCOL.split("/", 1)[1].encode() not in data or b"cao-terminal/" not in data:
        raise ValueError("sidecar protocol mismatch")


def load_release(manifest_path, arch=None):
    path = _regular(manifest_path)
    if path.stat().st_size > 64 * 1024:
        raise ValueError("release manifest too large")
    manifest = json.loads(path.read_text())
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise ValueError("unsupported node release manifest")
    if not isinstance(manifest.get("id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,79}", manifest["id"]):
        raise ValueError("invalid release id")
    if manifest.get("protocol") != PROTOCOL or manifest.get("python") != ["3.12", "3.13", "3.14"]:
        raise ValueError("unsupported release protocol/Python policy")
    if not isinstance(manifest.get("source_sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", manifest["source_sha256"]):
        raise ValueError("missing source identity")
    binaries = manifest.get("sidecars")
    if not isinstance(binaries, dict) or not binaries or not set(binaries).issubset({"amd64", "arm64"}):
        raise ValueError("invalid sidecar architectures")
    if arch is not None and arch not in binaries:
        raise ValueError("verified terminal artifact unavailable for target architecture")
    integrations = manifest.get("integrations", {})
    if not isinstance(integrations, dict) or not set(integrations).issubset({OPENCODE_INTEGRATION, CLI_INTEGRATION}):
        raise ValueError("unsupported node integration artifact")
    if OPENCODE_INTEGRATION in integrations:
        adapter = integrations[OPENCODE_INTEGRATION]
        if (not isinstance(adapter, dict) or adapter.get("file") != OPENCODE_ARTIFACT
                or type(adapter.get("size")) is not int or not 0 < adapter["size"] <= 128 * 1024):
            raise ValueError("invalid OpenCode v2 adapter artifact")
    if CLI_INTEGRATION in integrations:
        helper = integrations[CLI_INTEGRATION]
        if (not isinstance(helper, dict) or helper.get("file") != CLI_ARTIFACT
                or type(helper.get("size")) is not int or not 0 < helper["size"] <= 256 * 1024):
            raise ValueError("invalid CAO shared CLI integration artifact")
    specs = [manifest.get("wheel"), manifest.get("config"), *binaries.values(), *integrations.values()]
    names = [spec.get("file") for spec in specs if isinstance(spec, dict)]
    if len(names) != len(specs) or not all(isinstance(name, str) for name in names) or len(names) != len(set(names)):
        raise ValueError("duplicate/invalid release artifact")
    blobs = {spec["file"]: read_artifact(path.parent, spec) for spec in specs}
    if not manifest["wheel"]["file"].endswith("-py3-none-any.whl"):
        raise ValueError("unexpected node wheel name")
    validate_wheel(blobs[manifest["wheel"]["file"]])
    config = json.loads(blobs[manifest["config"]["file"]])
    if not isinstance(config, dict) or set(config) != {"ui"} or not isinstance(config["ui"], dict):
        raise ValueError("invalid terminal UI config")
    for key, spec in binaries.items():
        validate_binary(blobs[spec["file"]], key)
    return manifest, blobs


def configured_manifest():
    override = os.environ.get("CAO_FLEET_RELEASE")
    if override:
        return Path(override).expanduser().absolute()
    # Local pointer is data, never a symlink, and is only changed after validation.
    pointer = Path(__file__).absolute().parents[4] / "dist/fleet-node-active.json"
    _regular(pointer)
    if pointer.stat().st_size > 4096:
        raise ValueError("invalid release pointer")
    value = json.loads(pointer.read_text())
    if not isinstance(value, dict) or set(value) != {"manifest"} or not isinstance(value["manifest"], str):
        raise ValueError("invalid release pointer")
    path = Path(value["manifest"])
    if not path.is_absolute():
        raise ValueError("release pointer must be absolute")
    return path
