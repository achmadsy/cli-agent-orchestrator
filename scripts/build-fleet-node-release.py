#!/usr/bin/env python3
"""Build a local coherent node bundle, never deploy it or touch services.

Run with python -I. Uses the operator's reviewed source snapshot and sidecars.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--sidecar-amd64", type=Path)
    parser.add_argument("--sidecar-arm64", type=Path)
    parser.add_argument("--validator", type=Path, help="Reviewed staged validator; live Fleet files stay unchanged")
    parser.add_argument("--reuse-built-web", action="store_true", help="Package already verified frontend assets")
    args = parser.parse_args()
    source = args.source.absolute()
    output = args.out.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("release output must be new")
    if not args.sidecar_amd64 and not args.sidecar_arm64:
        raise ValueError("at least one verified sidecar is required")
    # Do not accidentally package the unrelated optional Rust TUI as py3-none-any.
    if list((source / "src/cli_agent_orchestrator").glob("cao-tui*")):
        raise ValueError("portable node source must not contain staged cao-tui executables")
    if not args.reuse_built_web:
        subprocess.run(["npm", "run", "build"], cwd=source / "web", check=True, timeout=600)
    output.mkdir(mode=0o700, parents=True)
    subprocess.run(["uv", "build", "--wheel", "--out-dir", str(output)], cwd=source,
                   env={**os.environ, "CAO_TUI_PLATFORM_WHEEL": "0"}, check=True, timeout=600)
    wheels = list(output.glob("*.whl"))
    if len(wheels) != 1:
        raise ValueError("expected one built wheel")
    wheel = wheels[0]
    validator = args.validator or source / "examples/fleet/panel/app/node_release.py"
    spec = importlib.util.spec_from_file_location("node_release", validator)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.validate_wheel(wheel.read_bytes())
    runtime = {}
    with zipfile.ZipFile(wheel) as archive:
        for name in archive.namelist():
            if name.endswith("/") or not name.startswith(("cli_agent_orchestrator/", "cao_workflow/")):
                continue
            data = archive.read(name)
            path = source / "src" / name
            if not path.is_file() or path.is_symlink() or path.read_bytes() != data:
                raise ValueError("wheel differs from reviewed source: " + name)
            runtime[name] = sha(data)
    def artifact(path):
        data = path.read_bytes()
        return {"file": path.name, "size": len(data), "sha256": sha(data)}
    config = output / "cao-terminal-ui.json"
    shutil.copyfile(source / "vendor/tmux-webui/cao-config.example.json", config)
    sidecars = {}
    for arch in ("amd64", "arm64"):
        path = getattr(args, "sidecar_" + arch)
        if path:
            data = path.read_bytes()
            module.validate_binary(data, arch)
            dest = output / ("cao-terminal-linux-" + arch)
            dest.write_bytes(data)
            dest.chmod(0o755)
            sidecars[arch] = artifact(dest)
    assets = {str(p.relative_to(source)): sha(p.read_bytes()) for p in sorted((source / "vendor/tmux-webui/internal/assets/static").rglob("*")) if p.is_file() and not p.is_symlink()}
    helper_source = source / "src/cli_agent_orchestrator/services/harness_mcp_integration.py"
    if helper_source.is_symlink() or not helper_source.is_file():
        raise ValueError("reviewed CAO CLI integration helper required")
    helper = output / module.CLI_ARTIFACT
    helper.write_bytes(helper_source.read_bytes())
    helper.chmod(0o600)
    integrations = {module.CLI_INTEGRATION: artifact(helper)}
    identity = {"runtime": runtime, "sidecar_assets": assets, "config": artifact(config)["sha256"],
                "integrations": {module.CLI_INTEGRATION: integrations[module.CLI_INTEGRATION]["sha256"]}}
    manifest = {
        "schema": 1, "id": args.id,
        "source_sha256": sha(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()),
        "protocol": module.PROTOCOL, "python": ["3.12", "3.13", "3.14"],
        "wheel": artifact(wheel), "config": artifact(config), "sidecars": sidecars,
        "integrations": integrations,
        "integrity": "operator-built local release with SHA-256; not a digital signature",
    }
    (output / "source.json").write_text(json.dumps(identity, indent=2) + "\n")
    path = output / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    module.load_release(path)
    print("VERIFIED_NODE_RELEASE", args.id, "architectures=" + ",".join(sidecars))
    print("MANIFEST", path)
    print("Local build only; no service, registry, database or remote changes.")


if __name__ == "__main__":
    main()
