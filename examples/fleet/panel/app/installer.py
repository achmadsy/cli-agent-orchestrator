"""Guided Ubuntu/WSL2 fleet installation over Tailscale SSH."""
import hashlib
import io
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import config

_REMOTE_USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
WHEEL_PATH = Path(os.environ.get(
    "CAO_FLEET_WHEEL",
    "/home/ubuntu/workspace/cao/cli-agent-orchestrator/dist/cli_agent_orchestrator-2.5.3-py3-none-any.whl",
))
REMOTE_COMMAND = "install -d -m 700 ~/.cache/cao-fleet-install && tar -xf - -C ~/.cache/cao-fleet-install && bash ~/.cache/cao-fleet-install/install.sh"
INSTALL_TIMEOUT = int(os.environ.get("CAO_FLEET_INSTALL_TIMEOUT", "600"))

CBM_VERSION = "0.10.8"
CBM_RELEASE_BASE = f"https://github.com/DeusData/codebase-memory-mcp/releases/download/v{CBM_VERSION}"
CBM_ASSETS = {
    "amd64": {
        "filename": f"codebase-memory-mcp-linux-amd64-portable.tar.gz",
        "sha256": "6eef49652bc0c7820f43114125044d40bf7f4d97c11b2592f6b0f6a307702325",
    },
    "arm64": {
        "filename": f"codebase-memory-mcp-linux-arm64-portable.tar.gz",
        "sha256": "5697d986d9716c913163b4bff7b3a294287f3b843e993bc1ff71e78dcdc21781",
    },
}
_cbm_lock = threading.Lock()


def map_arch(raw_arch: str) -> str:
    cleaned = str(raw_arch or "").strip().lower()
    if cleaned in ("x86_64", "amd64"):
        return "amd64"
    if cleaned in ("aarch64", "arm64"):
        return "arm64"
    raise ValueError(f"unsupported architecture '{cleaned}'; amd64 and arm64 required")


def cbm_cache_dir() -> Path:
    override = os.environ.get("CAO_CBM_CACHE_DIR")
    if override:
        path = Path(override).expanduser().resolve()
    else:
        path = Path.home() / ".cache" / "cao-fleet-cbm"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def _file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def ensure_cbm_archive(arch: str) -> Path:
    normalized = map_arch(arch)
    meta = CBM_ASSETS[normalized]
    cache_path = cbm_cache_dir() / meta["filename"]
    with _cbm_lock:
        if cache_path.is_file() and _file_sha256(cache_path) == meta["sha256"]:
            return cache_path
        url = f"{CBM_RELEASE_BASE}/{meta['filename']}"
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{meta['filename']}.", dir=cache_path.parent
        )
        temp_path = Path(temp_name)
        try:
            with os.fdopen(fd, "wb") as output:
                req = urllib.request.Request(
                    url, headers={"User-Agent": f"cao-fleet-installer/{CBM_VERSION}"}
                )
                with urllib.request.urlopen(req, timeout=120) as response:
                    shutil.copyfileobj(response, output)
            actual_sha = _file_sha256(temp_path)
            if actual_sha != meta["sha256"]:
                raise RuntimeError(
                    f"codebase-memory-mcp {normalized} checksum mismatch: expected {meta['sha256']} got {actual_sha}"
                )
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, cache_path)
        finally:
            if temp_path.exists():
                try:
                    temp_path.unlink()
                except OSError:
                    pass
        return cache_path


def probe_remote_arch(user: str, peer: str) -> str:
    run = subprocess.run(
        ["tailscale", "ssh", f"{user}@{peer}", "uname -m"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if run.returncode != 0:
        error = (run.stderr or run.stdout).strip() or f"exit {run.returncode}"
        raise RuntimeError(f"failed to probe remote architecture: {error}")
    return map_arch(run.stdout)



@dataclass
class Job:
    id: str
    machine: str
    peer: str
    user: str
    status: str = "queued"
    steps: list[str] = field(default_factory=list)
    error: str | None = None

    def public(self):
        return {
            "id": self.id,
            "machine": self.machine,
            "peer": self.peer,
            "user": self.user,
            "status": self.status,
            "steps": list(self.steps),
            "error": self.error,
        }


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def validate_user(user):
    value = str(user or "").strip()
    if not _REMOTE_USER.fullmatch(value):
        raise ValueError("remote user must be a safe Linux account name")
    return value


def get_job(job_id):
    with _lock:
        return _jobs.get(job_id)


def list_jobs():
    with _lock:
        return [job.public() for job in _jobs.values()]


def _install_script():
    return r'''#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/node.env"
export PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
[ "$(uname -s)" = Linux ] || { echo "unsupported OS: Linux required"; exit 20; }
grep -q '^ID=ubuntu' /etc/os-release || { echo "unsupported OS: Ubuntu required"; exit 21; }
python3 - <<'PY'
import sys
assert sys.version_info >= (3, 10), "Python 3.10+ required"
PY
command -v tailscale >/dev/null || { echo "tailscale missing"; exit 22; }
command -v uv >/dev/null || { echo "uv missing"; exit 23; }
command -v tmux >/dev/null || { echo "tmux missing"; exit 24; }
python3 - <<'PY'
import re, subprocess
text=subprocess.check_output(['tmux','-V'], text=True)
match=re.search(r'(\d+)\.(\d+)', text)
assert match and tuple(map(int, match.groups())) >= (3, 3), 'tmux 3.3+ required'
PY
command -v claude >/dev/null || { echo "Claude Code missing"; exit 25; }

ensure_cbm() {
  if command -v codebase-memory-mcp >/dev/null && [ "$(codebase-memory-mcp --version 2>&1 || true)" = "codebase-memory-mcp 0.10.8" ]; then
    echo "codebase-memory-mcp 0.10.8 already installed"
    return 0
  fi
  local arch="$(uname -m)"
  local tarball="" expected_sha=""
  case "$arch" in
    x86_64|amd64)
      tarball="codebase-memory-mcp-linux-amd64-portable.tar.gz"
      expected_sha="6eef49652bc0c7820f43114125044d40bf7f4d97c11b2592f6b0f6a307702325"
      ;;
    aarch64|arm64)
      tarball="codebase-memory-mcp-linux-arm64-portable.tar.gz"
      expected_sha="5697d986d9716c913163b4bff7b3a294287f3b843e993bc1ff71e78dcdc21781"
      ;;
    *)
      echo "unsupported arch: $arch"; exit 28 ;;
  esac

  local archive_path="$(dirname "$0")/$tarball"
  [ -f "$archive_path" ] || { echo "bundled codebase-memory-mcp archive missing: $tarball"; exit 29; }

  local actual_sha
  actual_sha="$(sha256sum "$archive_path" | awk '{print $1}')"
  [ "$actual_sha" = "$expected_sha" ] || { echo "checksum mismatch for $tarball: expected $expected_sha got $actual_sha"; exit 30; }

  local staging
  staging="$(mktemp -d)"
  tar -xzf "$archive_path" -C "$staging" codebase-memory-mcp
  if [ ! -f "$staging/codebase-memory-mcp" ]; then
    rm -rf "$staging"
    echo "extracted binary missing"; exit 31
  fi
  chmod 755 "$staging/codebase-memory-mcp"
  if [ "$("$staging/codebase-memory-mcp" --version 2>&1 || true)" != "codebase-memory-mcp 0.10.8" ]; then
    rm -rf "$staging"
    echo "extracted binary version check failed"; exit 32
  fi
  install -d -m 700 "$HOME/.local/bin"
  install -m 755 "$staging/codebase-memory-mcp" "$HOME/.local/bin/codebase-memory-mcp.tmp"
  rm -rf "$staging"
  mv -f "$HOME/.local/bin/codebase-memory-mcp.tmp" "$HOME/.local/bin/codebase-memory-mcp"
  [ "$(codebase-memory-mcp --version 2>&1 || true)" = "codebase-memory-mcp 0.10.8" ] || { echo "final binary version check failed"; exit 33; }
  echo "codebase-memory-mcp 0.10.8 installed successfully"
}

ensure_cbm
install -d -m 700 "$CAO_HOME_DIR" "$HOME/.config/cao" "$HOME/.config/systemd/user"
uv tool install "$(dirname "$0")/cli_agent_orchestrator-2.5.3-py3-none-any.whl" --reinstall
CAO_HOME_DIR="$CAO_HOME_DIR" cao install code_supervisor
install -m 600 "$(dirname "$0")/cao-server.env" "$HOME/.config/cao/cao-server.env"
cat > "$HOME/.config/systemd/user/cao-server.service" <<UNIT
[Unit]
Description=CLI Agent Orchestrator server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=$HOME/.config/cao/cao-server.env
ExecStart=$HOME/.local/bin/cao-server --host $CAO_BIND_HOST --port 9889
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now cao-server.service
for _ in 1 2 3 4 5; do curl -fsS --max-time 5 "http://$CAO_BIND_HOST:9889/health" >/dev/null && break; sleep 2; done
curl -fsS --max-time 5 "http://$CAO_BIND_HOST:9889/health" >/dev/null
echo "CAO fleet install complete"
'''


def _payload(machine, peer, user, host, token, arch="amd64"):
    hostname = config.public_hostname(machine)
    remote_home = f"/home/{user}"
    node_env = "\n".join([
        f"CAO_AUTH_LOCAL_TOKEN={token}",
        f"CAO_HOME_DIR={remote_home}/.local/share/cao",
        f"CAO_BIND_HOST={host}",
        f"CAO_API_HOST={host}",
        "CAO_API_PORT=9889",
        "CAO_MEMORY_API_URL=http://100.78.240.36:9889",
        "CAO_CODEBASE_ENABLED=true",
        f"CAO_FLEET_NODE_ID={machine}",
        "CAO_CODEBASE_API_URL=http://100.78.240.36:9889",
        f"CAO_ADVERTISED_URL=http://{host}:9889",
        f"CAO_ALLOWED_HOSTS={host},{machine},{machine}.taildbbd8c.ts.net,{hostname},localhost,127.0.0.1",
        f"CAO_CORS_ORIGINS=http://{host}:9889,https://{hostname}",
        "CAO_WS_ALLOWED_CLIENTS=100.78.240.36,127.0.0.1,::1,localhost",
        f"CAO_WS_ALLOWED_ORIGINS=https://{hostname}",
        "CAO_FORWARDED_ALLOW_IPS=100.78.240.36",
        "CAO_MCP_APPS_ENABLED=true",
        "",
    ]).encode()
    install_env = f"CAO_HOME_DIR={remote_home}/.local/share/cao\nCAO_BIND_HOST={host}\n".encode()
    cbm_archive = ensure_cbm_archive(arch)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, data, mode in (
            ("install.sh", _install_script().encode(), 0o700),
            ("node.env", install_env, 0o600),
            ("cao-server.env", node_env, 0o600),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            archive.addfile(info, io.BytesIO(data))
        archive.add(WHEEL_PATH, arcname=WHEEL_PATH.name, recursive=False)
        ti = tarfile.TarInfo(cbm_archive.name)
        ti.size = cbm_archive.stat().st_size
        ti.mode = 0o600
        with cbm_archive.open("rb") as stream:
            archive.addfile(ti, stream)
    return buffer.getvalue()


def _run(job, host, token):
    job.status = "running"
    job.steps.append("Validated target against live Tailscale peer list")
    try:
        arch = probe_remote_arch(job.user, job.peer)
        job.steps.append(f"Probed remote architecture: {arch}")
        ensure_cbm_archive(arch)
        job.steps.append(f"Prepared verified codebase-memory-mcp {CBM_VERSION} ({arch})")
        payload = _payload(job.machine, job.peer, job.user, host, token, arch)
        job.steps.append("Built signed-version local install payload")
        result = subprocess.run(
            ["tailscale", "ssh", f"{job.user}@{job.peer}", REMOTE_COMMAND],
            input=payload,
            capture_output=True,
            timeout=INSTALL_TIMEOUT,
        )
        output = (result.stdout + result.stderr).decode(errors="replace")
        for line in output.splitlines():
            line_str = line.strip()
            if "https://login.tailscale.com/a/" in line_str:
                job.steps.append(line_str)
            elif line_str in (
                "codebase-memory-mcp 0.10.8 already installed",
                "codebase-memory-mcp 0.10.8 installed successfully",
                "CAO fleet install complete",
            ):
                job.steps.append(line_str)
        if result.returncode:
            raise RuntimeError(f"Tailscale SSH install exited {result.returncode}")
        job.steps.append("Remote authenticated CAO health check passed")
        machine = config.add_machine({
            "name": job.machine,
            "host": host,
            "label": job.machine,
            "os": "linux",
            "role": "agent",
            "port": 9889,
        })
        try:
            subprocess.run(
                ["sudo", "-n", config.SYNC_COMMAND],
                check=True,
                capture_output=True,
                text=True,
                timeout=90,
            )
        except Exception:
            config.remove_machine(machine["name"])
            raise RuntimeError("fleet routing sync failed after install")
        job.steps.append(f"Registered {machine['name']} in fleet")
        job.status = "installed"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc).replace(token, "[redacted]")


def start_job(machine, peer, user, host, token):
    if not WHEEL_PATH.is_file():
        raise RuntimeError("verified CAO wheel is unavailable")
    job = Job(
        id=uuid.uuid4().hex,
        machine=config.validate_name(machine),
        peer=config.validate_name(peer),
        user=validate_user(user),
    )
    config.validate_host(host)
    with _lock:
        _jobs[job.id] = job
    thread = threading.Thread(target=_run, args=(job, host, token), daemon=True)
    thread.start()
    return job
