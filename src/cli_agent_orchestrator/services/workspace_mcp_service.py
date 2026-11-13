"""Workspace-backed MCP instance management.

Wraps ``workspace-mcp``'s Quick Tunnel launcher (``scripts/start-tunnel.sh``):
dispatches one isolated tmux session per folder, nudges its env knobs so
instances don't collide, scrapes the TryCloudflare URL and admin password it
produces, and reconciles live tmux against a durable 0600 registry.
"""

import base64
import fcntl
import json
import logging
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from cli_agent_orchestrator.constants import CAO_HOME_DIR
from cli_agent_orchestrator.models.workspace_mcp import WorkspaceMcpInstance

logger = logging.getLogger(__name__)
_REGISTRY_THREAD_LOCK = threading.RLock()

WORKSPACE_MCP_SCRIPT = os.environ.get(
    "WORKSPACE_MCP_SCRIPT",
    str(Path.home() / "workspace-mcp" / "scripts" / "start-tunnel.sh"),
)
PORT_START = 8787
PORT_END = 8887
_START_TIMEOUT_POLL_INTERVAL = 0.5

_FORBIDDEN_FOLDERS = {
    "/",
    "/etc",
    "/sys",
    "/proc",
    "/root",
    "/dev",
    "/boot",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/tmp",
}

_TUNNEL_URL_RE = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")


def _slugify(folder: str) -> str:
    """Short unique slug for the instance id (e.g. ``wmcp-c3a4d5f8``)."""
    import hashlib

    digest = hashlib.sha256(f"{folder}:{time.time_ns()}".encode()).hexdigest()[:8]
    return digest


def _canonicalize(folder: str) -> Path:
    """Resolve and canonicalize to an absolute path, raising on bad input."""
    path = Path(os.path.expanduser(folder)).resolve()
    if not path.exists():
        raise ValueError(f"folder does not exist: {path}")
    if not path.is_dir():
        raise ValueError(f"not a directory: {path}")
    forbidden = tuple(Path(value) for value in _FORBIDDEN_FOLDERS)
    # `/` and `/tmp` are exact-only bans; treating `/` as a forbidden parent
    # would reject every absolute path, and tmp descendants are needed for
    # disposable/test workspaces. Other system trees reject descendants too.
    tree_roots = tuple(root for root in forbidden if root not in (Path("/"), Path("/tmp")))
    if path in forbidden or any(root in path.parents for root in tree_roots):
        raise ValueError(f"refusing to serve sensitive system directory: {path}")
    return path


def _first_free_port(used_ports: frozenset) -> int:
    """Find the lowest free TCP port from PORT_START..PORT_END."""
    for port in range(PORT_START, PORT_END + 1):
        if port in used_ports:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise ValueError(f"no free local port in range {PORT_START}-{PORT_END}")


def _tmux_has_session(socket_name: str, session_name: str) -> bool:
    """True if the (socket, session) tmux pair is still alive."""
    result = subprocess.run(
        ["tmux", "-L", socket_name, "has-session", "-t", f"={session_name}"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _tmux_capture_pane(socket_name: str, session_name: str, max_lines: int = 400) -> str:
    """Pull recent pane text so we can look for the TryCloudflare URL."""
    result = subprocess.run(
        [
            "tmux",
            "-L",
            socket_name,
            # `has-session -t =name` supports exact-session syntax, but
            # `capture-pane -t =name` does not ("can't find pane"). Target the
            # session directly; each isolated socket holds only one session.
            "capture-pane",
            "-p",
            "-t",
            session_name,
            "-S",
            f"-{max_lines}",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return ""
    return result.stdout or ""


def _read_quick_tunnel_env(state_dir: Path) -> Optional[str]:
    """Read admin_password from the 0600 quick-tunnel.env credentials file."""
    env_file = state_dir / "quick-tunnel.env"
    if not env_file.is_file():
        return None
    mode = env_file.stat().st_mode & 0o777
    if mode != 0o600:
        raise ValueError(
            f"quick-tunnel.env has wrong mode {oct(mode)} (expected 0o600), refusing to read"
        )
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("MCP_ADMIN_PASSWORD_B64="):
            # Stored value is base64 (see start-tunnel.sh); decode before
            # returning it to CLI/API users. Never log either representation.
            encoded = line[len("MCP_ADMIN_PASSWORD_B64=") :].strip('"')
            try:
                return base64.b64decode(encoded, validate=True).decode("utf-8")
            except (ValueError, UnicodeDecodeError) as exc:
                raise ValueError("quick-tunnel.env contains an invalid admin password") from exc
    return None


class WorkspaceMcpService:
    """Spawn/dispatch, inspect, list, and kill workspace-MCP tunnel instances."""

    def __init__(self, data_dir: Optional[Path] = None):
        self._data_dir = Path(data_dir) if data_dir else CAO_HOME_DIR
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._registry_path = self._data_dir / "workspace_mcp_instances.json"
        self._lock_path = self._data_dir / "workspace_mcp_instances.lock"
        if self._registry_path.exists():
            mode = self._registry_path.stat().st_mode & 0o777
            if mode != 0o600:
                self._registry_path.chmod(0o600)

    # -- registry -----------------------------------------------------------

    @contextmanager
    def _registry_lock(self):
        """Serialize registry read-modify-write across threads and processes."""
        with _REGISTRY_THREAD_LOCK:
            fd = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                os.chmod(self._lock_path, 0o600)
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

    def _load(self, default=None):
        """Load persisted instance entries from the 0600 registry file."""
        if not self._registry_path.exists():
            return default if default is not None else []
        return json.loads(self._registry_path.read_text())

    def _save(self, instances):
        # Password is returned once from start_instance but never persisted.
        # The authoritative credential stays in mode-0600 quick-tunnel.env.
        durable = [{**instance, "admin_password": None} for instance in instances]
        payload = json.dumps(durable, indent=2)
        fd, tmp_name = tempfile.mkstemp(
            prefix=".workspace_mcp_instances.", dir=self._data_dir, text=True
        )
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, self._registry_path)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass
            raise

    # -- reconciliation -----------------------------------------------------

    def _reconcile_locked(self, units: list):
        """Drop entries whose tmux session terminated; report failure if any."""
        alive = []
        changed = False
        for unit in units:
            exit_ok = _tmux_has_session(unit["tmux_socket"], unit["tmux_session"])
            if not exit_ok and unit["status"] not in ("stopped", "failed"):
                unit["status"] = "stopped"
                changed = True
            if exit_ok or unit["status"] in ("stopped", "failed"):
                # keep recent rows so status history can be inspected later
                alive.append(unit)
        return alive, changed

    # -- lifecycle ops ------------------------------------------------------

    def start_instance(
        self, folder_path: str, agentic: bool = True, timeout_s: int = 60
    ) -> WorkspaceMcpInstance:
        """Spawn a new workspace-MCP tunnel backing the given folder."""
        folder = _canonicalize(folder_path)
        now = datetime.now(timezone.utc)
        instance_id = f"wmcp-{_slugify(str(folder))}"

        state_dir = Path(
            os.path.expanduser(f"~/.local/share/workspace-mcp/instances/{instance_id}")
        )
        state_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(state_dir, 0o700)

        # Reserve folder + port before launching. Lock covers the whole
        # read/check/reserve/write transaction so concurrent API requests cannot
        # choose the same port or both launch the same folder.
        with self._registry_lock():
            units = self._load(default=[])
            units, _ = self._reconcile_locked(units)
            for existing in units:
                if existing["folder_path"] == str(folder) and existing["status"] in (
                    "starting",
                    "running",
                ):
                    raise ValueError(
                        f"folder already served by a running instance {existing['id']}"
                    )

            used_ports = frozenset(
                u["port"] for u in units if u["status"] in ("starting", "running")
            )
            port = _first_free_port(used_ports)
            unit = {
                "id": instance_id,
                "folder_path": str(folder),
                "agentic": agentic,
                "port": port,
                "state_dir": str(state_dir),
                "tmux_socket": instance_id,
                "tmux_session": instance_id,
                "status": "starting",
                "tunnel_url": None,
                "admin_password": None,
                "created_at": now.isoformat(),
                "error": None,
            }
            units.append(unit)
            self._save(units)

        script = Path(WORKSPACE_MCP_SCRIPT)
        if not script.is_file():
            unit["status"] = "failed"
            unit["error"] = f"launcher not found: {script}"
            with self._registry_lock():
                units = self._load(default=[])
                units = [u for u in units if u["id"] != instance_id]
                units.append(unit)
                self._save(units)
            raise ValueError(unit["error"])

        env = os.environ.copy()
        env.update(
            {
                "WORKSPACE_MCP_SESSION": unit["tmux_session"],
                "WORKSPACE_MCP_TMUX_SOCKET": unit["tmux_socket"],
                "MCP_PORT": str(port),
                "MCP_STATE_DIR": str(state_dir),
            }
        )

        # start-tunnel.sh itself creates the detached tmux session we want; we
        # just invoke it with --agentic and let it self-detach (it exits once
        # connector URL is ready). Fresh process group so nothing lingers.
        argv = [str(script)]
        if agentic:
            argv.append("--agentic")
        argv.append(str(folder))
        try:
            completed = subprocess.run(
                argv,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout_s + 10,
                start_new_session=True,
            )
        except subprocess.TimeoutExpired:
            # The detached tmux server may still be healthy. Poll below rather
            # than declaring failure from wrapper timeout alone.
            logger.warning("start-tunnel.sh wrapper timed out; checking its tmux session")
        else:
            if completed.returncode != 0:
                detail = (
                    completed.stderr or completed.stdout or "launcher exited non-zero"
                ).strip()
                # Keep the registry safe to expose: command output can contain
                # an admin password after the tunnel banner starts. Persist only
                # a bounded final line, and never log it.
                safe_detail = (
                    detail.splitlines()[-1][:300] if detail else "launcher exited non-zero"
                )
                unit["status"] = "failed"
                unit["error"] = f"workspace-mcp launcher failed: {safe_detail}"

        # Wrapper has its own wait loop. Give pane discovery a fresh bounded
        # budget rather than charging wrapper duration twice.
        discovery_started = time.monotonic()
        while unit["status"] != "failed":
            if time.monotonic() - discovery_started > timeout_s:
                unit["status"] = "failed"
                unit["error"] = f"timed out polling for TryCloudflare URL after {timeout_s}s"
                break
            if not _tmux_has_session(unit["tmux_socket"], unit["tmux_session"]):
                unit["status"] = "failed"
                unit["error"] = "tmux session died during initialization"
                break
            pane = _tmux_capture_pane(unit["tmux_socket"], unit["tmux_session"])
            match = _TUNNEL_URL_RE.search(pane)
            if match:
                # Exact MCP connector endpoint, matching start-tunnel.sh's
                # `MCP_PUBLIC_URL="$TUNNEL_URL/mcp"` output.
                unit["tunnel_url"] = f"{match.group(0)}/mcp"
                try:
                    unit["admin_password"] = _read_quick_tunnel_env(state_dir)
                except ValueError as exc:
                    unit["error"] = str(exc)
                unit["status"] = "running"
                break
            time.sleep(_START_TIMEOUT_POLL_INTERVAL)

        with self._registry_lock():
            units = self._load(default=[])
            units = [u for u in units if u["id"] != instance_id]
            units.append(unit)
            self._save(units)
        if unit["status"] == "failed":
            # Best-effort: kill the half-started tmux session.
            subprocess.run(
                ["tmux", "-L", unit["tmux_socket"], "kill-server"],
                capture_output=True,
            )
            raise RuntimeError(unit["error"])
        return WorkspaceMcpInstance(**unit)

    def list_instances(self) -> List[WorkspaceMcpInstance]:
        """List all tracked instances, reconciling tmux state."""
        with self._registry_lock():
            units = self._load(default=[])
            units, changed = self._reconcile_locked(units)
            if changed:
                self._save(units)
        return [WorkspaceMcpInstance(**u) for u in units]

    def get_instance(self, id_or_folder: str) -> Optional[WorkspaceMcpInstance]:
        """Look up an instance by id or by exact canonical folder path."""
        with self._registry_lock():
            units = self._load(default=[])
            units, changed = self._reconcile_locked(units)
            if changed:
                self._save(units)
        canon = None
        try:
            canon = str(_canonicalize(id_or_folder))
        except ValueError:
            pass
        for u in units:
            if u["id"] == id_or_folder or (canon and u["folder_path"] == canon):
                return WorkspaceMcpInstance(**u)
        return None

    def stop_instance(self, id_or_folder: str) -> Optional[WorkspaceMcpInstance]:
        """Kill the instance's tmux server; return the updated record."""
        instance = self.get_instance(id_or_folder)
        if instance is None:
            return None
        subprocess.run(
            ["tmux", "-L", instance.tmux_socket, "kill-server"],
            capture_output=True,
        )
        with self._registry_lock():
            units = self._load(default=[])
            for u in units:
                if u["id"] == instance.id:
                    u["status"] = "stopped"
            self._save(units)
        return self.get_instance(instance.id)

    def browse_directories(
        self, path: Optional[str] = None, *, offset: int = 0, limit: int = 200, query: str = ""
    ) -> dict:
        """Bounded, read-only listing; never starts a workspace/tunnel or subprocess.

        Refuse an over-large directory explicitly rather than silently omitting
        entries. Paging and name filtering operate over this one directory only.
        """
        if offset < 0 or not 1 <= limit <= 500 or len(query) > 255:
            raise ValueError("Invalid directory listing range")
        base = _canonicalize(path or os.path.expanduser("~"))

        def navigable(candidate: Path) -> Optional[Path]:
            try:
                resolved = _canonicalize(str(candidate))
                if not os.access(resolved, os.R_OK | os.X_OK):
                    return None
                return resolved
            except (OSError, ValueError, RuntimeError):
                return None

        if not os.access(base, os.R_OK | os.X_OK):
            raise PermissionError("This folder cannot be listed")
        dirs = []
        try:
            with os.scandir(base) as entries:
                for count, entry in enumerate(entries, 1):
                    if count > 10000:
                        raise ValueError("This folder has too many entries to browse. Enter a more specific path.")
                    if entry.name.startswith(".") or query.casefold() not in entry.name.casefold():
                        continue
                    try:
                        if not entry.is_dir():
                            continue
                        target = navigable(Path(entry.path))
                        if target is None or any(part.startswith(".") for part in target.parts):
                            continue
                        dirs.append({"name": entry.name, "path": str(target)})
                    except OSError:
                        continue  # An entry removed while listing is not a destination.
        except PermissionError:
            raise PermissionError("This folder cannot be listed") from None
        dirs.sort(key=lambda entry: (entry["name"].casefold(), entry["name"]))
        parent = navigable(base.parent) if base.parent != base else None
        ancestors = []
        for candidate in reversed((base, *base.parents)):
            valid = navigable(candidate)
            if valid is not None:
                ancestors.append({"name": valid.name or str(valid), "path": str(valid)})
        home = navigable(Path.home())
        end = offset + limit
        return {
            "current_path": str(base),
            "parent_path": str(parent) if parent else None,
            "directories": dirs[offset:end],
            "ancestors": ancestors,
            "home_path": str(home) if home else None,
            "source_node": os.environ.get("CAO_FLEET_NODE_ID") or socket.gethostname(),
            "next_offset": end if end < len(dirs) else None,
            "total": len(dirs),
        }


_service: Optional[WorkspaceMcpService] = None


def get_workspace_mcp_service() -> WorkspaceMcpService:
    """Lazily construct the module-level service singleton."""
    global _service
    if _service is None:
        _service = WorkspaceMcpService()
    return _service
