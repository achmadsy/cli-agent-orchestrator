"""Guided Ubuntu/WSL2 fleet installation over Tailscale SSH."""

import hashlib
import io
import json
import os
import shlex
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

from . import config, node_release

_REMOTE_USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_REMOTE_SCRIPT = 'set -euo pipefail; umask 077; d=$(mktemp -d /tmp/cao-fleet-install.XXXXXXXX); trap \'rm -rf -- "$d"\' EXIT; tar --no-same-owner --no-same-permissions -xf - -C "$d"; bash "$d/install.sh"'
REMOTE_COMMAND = "bash -c " + shlex.quote(_REMOTE_SCRIPT)
INSTALL_TIMEOUT = int(os.environ.get("CAO_FLEET_INSTALL_TIMEOUT", "600"))

CBM_VERSION = "0.10.8"
CBM_RELEASE_BASE = (
    f"https://github.com/DeusData/codebase-memory-mcp/releases/download/v{CBM_VERSION}"
)
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
        fd, temp_name = tempfile.mkstemp(prefix=f".{meta['filename']}.", dir=cache_path.parent)
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
    return r"""#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/node.env"
export PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
[ "$(uname -s)" = Linux ] || { echo "unsupported OS: Linux required"; exit 20; }
grep -q '^ID=ubuntu' /etc/os-release || { echo "unsupported OS: Ubuntu required"; exit 21; }
umask 077
unset PYTHONPATH PYTHONHOME
PYTHON=""
for candidate in /home/linuxbrew/.linuxbrew/bin/python3.14 python3.14 python3.13 python3.12 python3; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  if "$candidate" -I -c 'import sys; assert sys.version_info[:2] in ((3,12),(3,13),(3,14))' >/dev/null 2>&1; then
    PYTHON="$(command -v "$candidate")"; break
  fi
done
[ -n "$PYTHON" ] || { echo "installed Python 3.12, 3.13 or 3.14 required"; exit 26; }
"$PYTHON" -I "$(dirname "$0")/node_install.py" preflight
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
ensure_workspace_mcp() {
  # workspace-mcp: repo clone + Quick Tunnel runtime deps, installed
  # non-interactively so scripts/start-tunnel.sh never hits its TTY gate.
  run_priv() {
    if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@" 2>/dev/null || sudo "$@"; fi
  }
  local missing=""
  for c in cloudflared bwrap slirp4netns git; do
    command -v "$c" >/dev/null || missing="$missing $c"
  done
  if [ -d "$HOME/workspace-mcp/.git" ] && [ -z "$missing" ]; then
    git -C "$HOME/workspace-mcp" pull --ff-only >/dev/null 2>&1 || true
    echo "workspace-mcp already installed"
    return 0
  fi

  # Sandbox + Quick Tunnel binaries (Ubuntu; the remote is probe-verified
  # Ubuntu before this script ever runs).
  local pkgs=""
  command -v git >/dev/null || pkgs="$pkgs git"
  command -v bwrap >/dev/null || pkgs="$pkgs bubblewrap"
  command -v slirp4netns >/dev/null || pkgs="$pkgs slirp4netns"
  if [ -n "$pkgs" ]; then
    run_priv env DEBIAN_FRONTEND=noninteractive apt-get update >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    run_priv env DEBIAN_FRONTEND=noninteractive apt-get install -y $pkgs >/dev/null 2>&1 ||
      { echo "workspace-mcp: failed to install deb packages:$pkgs (exit 26)"; exit 26; }
  fi

  # cloudflared from the Cloudflare apt repo (same repo/key the launcher adds).
  if ! command -v cloudflared >/dev/null; then
    run_priv mkdir -p --mode=0755 /usr/share/keyrings
    local cfkey="$(mktemp)"
    if ! curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o "$cfkey"; then
      rm -f "$cfkey"; echo "workspace-mcp: cloudflared key download failed (exit 27)"; exit 27
    fi
    if ! run_priv tee /usr/share/keyrings/cloudflare-main.gpg < "$cfkey" >/dev/null; then
      rm -f "$cfkey"; exit 27
    fi
    rm -f "$cfkey"
    printf '%s\n' "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" |
      run_priv tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    run_priv env DEBIAN_FRONTEND=noninteractive apt-get update >/dev/null 2>&1 || true
    run_priv env DEBIAN_FRONTEND=noninteractive apt-get install -y cloudflared >/dev/null 2>&1 ||
      { echo "workspace-mcp: cloudflared install failed (exit 27)"; exit 27; }
  fi

  # --agentic spawns need a running user manager for systemd-run --user.
  command -v loginctl >/dev/null && run_priv loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  command -v systemctl >/dev/null && run_priv systemctl start "user@$(id -u).service" >/dev/null 2>&1 || true

  # Repo clone.
  if [ -d "$HOME/workspace-mcp/.git" ]; then
    git -C "$HOME/workspace-mcp" pull --ff-only >/dev/null 2>&1 || true
  elif [ -d "$HOME/workspace-mcp" ]; then
    echo "workspace-mcp: $HOME/workspace-mcp exists but is not a git clone (exit 28)"; exit 28
  else
    if ! git clone --depth 1 https://github.com/achmadsy/workspace-mcp.git "$HOME/workspace-mcp" >/dev/null 2>&1; then
      echo "workspace-mcp: git clone failed (exit 29)"; exit 29
    fi
  fi
  for c in cloudflared bwrap slirp4netns; do
    command -v "$c" >/dev/null || { echo "workspace-mcp: $c still missing after install (exit 30)"; exit 30; }
  done
  [ -d "$HOME/workspace-mcp/scripts" ] || { echo "workspace-mcp: clone incomplete (exit 31)"; exit 31; }
  echo "workspace-mcp installed successfully"
}

ensure_workspace_mcp
export CAO_HOME_DIR
"$PYTHON" -I "$(dirname "$0")/node_install.py" install "$PYTHON"
"""


def _payload(machine, peer, user, host, token, arch="amd64"):
    machine = config.validate_name(machine)
    user = validate_user(user)
    host = config.validate_host(host)
    if not isinstance(token, str) or len(token) < 32 or not re.fullmatch(r"[A-Za-z0-9_.~-]+", token):
        raise ValueError("node authentication token is unavailable or not install-safe")
    manifest, blobs = node_release.load_release(node_release.configured_manifest(), map_arch(arch))
    hostname = config.public_hostname(machine)
    remote_home = f"/home/{user}"
    node_env = "\n".join(
        [
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
        ]
    ).encode()
    install_env = f"CAO_HOME_DIR={remote_home}/.local/share/cao\nCAO_BIND_HOST={host}\n".encode()
    cbm_archive = ensure_cbm_archive(arch)
    cbm_data = cbm_archive.read_bytes()
    if hashlib.sha256(cbm_data).hexdigest() != CBM_ASSETS[map_arch(arch)]["sha256"]:
        raise RuntimeError("bundled codebase-memory-mcp checksum mismatch")
    app = Path(__file__).absolute().parent
    entries = {
        "install.sh": _install_script().encode(), "node.env": install_env,
        "cao-server.env": node_env, "manifest.json": (json.dumps(manifest) + "\n").encode(),
        "node_release.py": (app / "node_release.py").read_bytes(),
        "node_install.py": (app / "node_install.py").read_bytes(),
        cbm_archive.name: cbm_data,
    }
    if set(entries) & set(blobs):
        raise ValueError("release artifact collides with installer payload")
    entries.update(blobs)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o700 if name == "install.sh" else 0o600
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def _ingress_check(*args, marker):
    result = subprocess.run(
        ["sudo", "-n", config.INGRESS_COMMAND, *args],
        check=True, capture_output=True, text=True, timeout=60,
    )
    if marker not in result.stdout.splitlines():
        raise RuntimeError("fleet attachment ingress proof missing")


def _run(job, host, token):
    job.status = "running"
    job.steps.append("Validated target against live Tailscale peer list")
    try:
        _ingress_check("--check-policy", marker="CAO_FLEET_POLICY_OK_V1")
        job.steps.append("Central attachment ingress policy is ready")
        arch = probe_remote_arch(job.user, job.peer)
        job.steps.append(f"Probed remote architecture: {arch}")
        ensure_cbm_archive(arch)
        job.steps.append(f"Prepared verified codebase-memory-mcp {CBM_VERSION} ({arch})")
        payload = _payload(job.machine, job.peer, job.user, host, token, arch)
        job.steps.append("Built checksum-verified CAO and terminal release payload")
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
                "workspace-mcp already installed",
                "workspace-mcp installed successfully",
                "CAO fleet install complete",
            ):
                job.steps.append(line_str)
        if result.returncode:
            raise RuntimeError(f"Tailscale SSH install exited {result.returncode}")
        if "CAO fleet install complete" not in output.splitlines() or "Authenticated CAO and terminal health passed" not in output.splitlines():
            raise RuntimeError("remote install completion/health proof missing")
        job.steps.append("Remote authenticated CAO and terminal health checks passed")
        machine = config.add_machine(
            {
                "name": job.machine,
                "host": host,
                "label": job.machine,
                "os": "linux",
                "role": "agent",
                "port": 9889,
            }
        )
        try:
            subprocess.run(
                ["sudo", "-n", config.SYNC_COMMAND],
                check=True,
                capture_output=True,
                text=True,
                timeout=90,
            )
            _ingress_check("--verify-ingress", machine["name"], marker="CAO_FLEET_INGRESS_VERIFIED_V1")
        except Exception:
            try:
                config.remove_machine(machine["name"])
                # Reconcile through the existing routing lifecycle after registry
                # compensation. Never uninstall the remote node or erase its data.
                subprocess.run(
                    ["sudo", "-n", config.SYNC_COMMAND], check=True,
                    capture_output=True, text=True, timeout=90,
                )
            except Exception:
                raise RuntimeError("fleet routing/ingress failed; registration cleanup incomplete") from None
            raise RuntimeError("fleet routing/attachment ingress failed after install; registration reverted") from None
        job.steps.append("Verified 10 MiB attachment ingress and ordinary request limit")
        job.steps.append(f"Registered {machine['name']} in fleet")
        job.status = "installed"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc).replace(token, "[redacted]")


def start_job(machine, peer, user, host, token):
    try:
        node_release.load_release(node_release.configured_manifest())
    except (OSError, ValueError, KeyError) as exc:
        raise RuntimeError("verified CAO and terminal release is unavailable") from exc
    if not isinstance(token, str) or len(token) < 32:
        raise ValueError("node authentication token is unavailable")
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
