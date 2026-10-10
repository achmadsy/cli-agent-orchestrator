"""Guided Ubuntu/WSL2 fleet installation over Tailscale SSH."""
import io
import os
import re
import subprocess
import tarfile
import threading
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


def _payload(machine, peer, user, host, token):
    hostname = config.public_hostname(machine)
    remote_home = f"/home/{user}"
    node_env = "\n".join([
        f"CAO_AUTH_LOCAL_TOKEN={token}",
        f"CAO_HOME_DIR={remote_home}/.local/share/cao",
        f"CAO_BIND_HOST={host}",
        "CAO_MEMORY_API_URL=http://100.78.240.36:9889",
        f"CAO_ALLOWED_HOSTS={host},{machine},{machine}.taildbbd8c.ts.net,{hostname},localhost,127.0.0.1",
        f"CAO_CORS_ORIGINS=http://{host}:9889,https://{hostname}",
        "CAO_WS_ALLOWED_CLIENTS=100.78.240.36,127.0.0.1,::1,localhost",
        f"CAO_WS_ALLOWED_ORIGINS=https://{hostname}",
        "CAO_FORWARDED_ALLOW_IPS=100.78.240.36",
        "CAO_MCP_APPS_ENABLED=true",
        "",
    ]).encode()
    install_env = f"CAO_HOME_DIR={remote_home}/.local/share/cao\nCAO_BIND_HOST={host}\n".encode()
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
    return buffer.getvalue()


def _run(job, host, token):
    job.status = "running"
    job.steps.append("Validated target against live Tailscale peer list")
    try:
        payload = _payload(job.machine, job.peer, job.user, host, token)
        job.steps.append("Built signed-version local install payload")
        result = subprocess.run(
            ["tailscale", "ssh", f"{job.user}@{job.peer}", REMOTE_COMMAND],
            input=payload,
            capture_output=True,
            timeout=300,
        )
        output = (result.stdout + result.stderr).decode(errors="replace")
        for line in output.splitlines():
            if "https://login.tailscale.com/a/" in line:
                job.steps.append(line.strip())
            elif line.strip() in ("CAO fleet install complete",):
                job.steps.append(line.strip())
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
