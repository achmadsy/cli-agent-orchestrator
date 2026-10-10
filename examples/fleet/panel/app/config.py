"""Panel configuration, fleet registry validation, and atomic updates."""
import fcntl
import ipaddress
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

_APP_DIR = os.path.dirname(os.path.abspath(__file__))       # panel/app
_EXAMPLE_ROOT = os.path.dirname(os.path.dirname(_APP_DIR))  # examples/fleet
_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _default_config_path():
    real = os.path.join(_EXAMPLE_ROOT, "fleet.json")
    example = os.path.join(_EXAMPLE_ROOT, "fleet.example.json")
    return real if os.path.exists(real) else example


FLEET_CONFIG = os.environ.get("CAO_FLEET_CONFIG") or _default_config_path()
PANEL_HOST = os.environ.get("CAO_PANEL_HOST", "127.0.0.1")
PANEL_PORT = int(os.environ.get("CAO_PANEL_PORT", "9888"))
PANEL_TOKEN = os.environ.get("CAO_PANEL_TOKEN") or None
PANEL_USER = os.environ.get("CAO_PANEL_USER", "panel")
PANEL_PASSWORD = os.environ.get("CAO_PANEL_PASSWORD") or None
PANEL_SESSION_SECRET = os.environ.get("CAO_PANEL_SESSION_SECRET") or None
PANEL_SESSION_TTL = int(os.environ.get("CAO_PANEL_SESSION_TTL", "43200"))
NODE_TOKEN = os.environ.get("CAO_NODE_TOKEN") or None
FLEET_DOMAIN = os.environ.get("CAO_FLEET_DOMAIN", "zlink.my.id")
FLEET_HOST_PREFIX = os.environ.get("CAO_FLEET_HOST_PREFIX", "cao-")
SYNC_COMMAND = os.environ.get("CAO_FLEET_SYNC_COMMAND", "/usr/local/sbin/cao-fleet-sync")


def validate_name(name):
    value = str(name or "").strip().lower()
    if not _NAME.fullmatch(value):
        raise ValueError("name must be a DNS-safe label using lowercase letters, digits, and hyphens")
    return value


def validate_host(host):
    value = str(host or "").strip()
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise ValueError("host must be a Tailscale IPv4 address") from exc
    if address.version != 4 or address not in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("host must be inside the Tailscale 100.64.0.0/10 range")
    return value


def public_hostname(name):
    return f"{FLEET_HOST_PREFIX}{validate_name(name)}.{FLEET_DOMAIN}"


def _load_registry(path=None):
    target = Path(path or FLEET_CONFIG)
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"fleet registry not found at {target}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("machines"), list):
        raise RuntimeError("fleet registry must contain a machines array")
    default_port = int(data.get("port", 9889))
    seen_names = set()
    seen_hosts = set()
    machines = []
    for raw in data["machines"]:
        if not isinstance(raw, dict):
            raise RuntimeError("every fleet machine must be an object")
        machine = dict(raw)
        machine["name"] = validate_name(machine.get("name"))
        machine["host"] = validate_host(machine.get("host"))
        machine["port"] = int(machine.get("port", default_port))
        if not 1 <= machine["port"] <= 65535:
            raise ValueError("machine port must be between 1 and 65535")
        if machine["name"] in seen_names or machine["host"] in seen_hosts:
            raise ValueError("fleet machine names and hosts must be unique")
        seen_names.add(machine["name"])
        seen_hosts.add(machine["host"])
        machines.append(machine)
    return {**data, "port": default_port, "machines": machines}


def load_machines():
    return _load_registry()["machines"]


def base_url(machine):
    return f"http://{machine['host']}:{machine['port']}"


def _mutate_registry(mutator):
    target = Path(FLEET_CONFIG)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_suffix(target.suffix + ".lock")
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = _load_registry(target)
        result = mutator(data)
        # Validate the complete result before replacing the live registry.
        fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as temp:
                json.dump(data, temp, indent=2)
                temp.write("\n")
                temp.flush()
                os.fsync(temp.fileno())
            _load_registry(temp_name)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            shutil.copy2(target, target.with_name(f"{target.name}.bak.{stamp}"))
            os.replace(temp_name, target)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
        return result


def add_machine(machine):
    item = {
        "name": validate_name(machine.get("name")),
        "host": validate_host(machine.get("host")),
        "label": str(machine.get("label") or machine.get("name") or "").strip()[:120],
        "os": str(machine.get("os") or "linux").strip()[:32],
        "role": str(machine.get("role") or "agent").strip()[:32],
        "port": int(machine.get("port", 9889)),
    }

    def mutate(data):
        if any(m["name"] == item["name"] for m in data["machines"]):
            raise ValueError("machine name already exists")
        if any(m["host"] == item["host"] for m in data["machines"]):
            raise ValueError("machine host already exists")
        data["machines"].append(item)
        return item

    return _mutate_registry(mutate)


def remove_machine(name):
    value = validate_name(name)

    def mutate(data):
        removed = next((m for m in data["machines"] if m["name"] == value), None)
        if removed is None:
            raise KeyError(value)
        data["machines"] = [m for m in data["machines"] if m["name"] != value]
        return removed

    return _mutate_registry(mutate)
