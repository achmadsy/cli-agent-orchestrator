"""Target-side fresh installation, never an existing-node updater.

Bundled with the trusted installer. No database or terminal-content inspection.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).absolute().parent
_spec = importlib.util.spec_from_file_location("node_release", ROOT / "node_release.py")
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)


def run(*args, timeout=120):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep:
            parsed = shlex.split(value)
            if len(parsed) != 1:
                raise ValueError("invalid private install environment")
            values[key] = parsed[0]
    return values


def release_arch():
    import platform
    return {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), "unsupported")


def preflight():
    home = Path.home()
    manifest, blobs = release.load_release(ROOT / "manifest.json", release_arch())
    if home.is_symlink() or home.stat().st_uid != os.getuid():
        raise RuntimeError("unexpected target home")
    existing = [
        ".local/bin/cao", ".local/bin/cao-server", ".local/bin/cao-terminal",
        ".local/share/uv/tools/cli-agent-orchestrator", ".local/share/cao",
        ".config/cao/cao-server.env", ".config/cao/terminal-workspace.env",
        ".config/cao/cao-terminal-ui.json", ".config/cao/node-install-incomplete",
        ".config/cao/node-release.json",
        ".config/systemd/user/cao-server.service", ".config/systemd/user/cao-server.service.d",
        ".config/systemd/user/cao-terminal.service",
    ]
    if any(os.path.lexists(home / name) for name in existing):
        raise RuntimeError("existing CAO installation found; use a controlled update, not Add Machine")
    # Do not overwrite symlinked/other-owner parent directories either.
    for relative in (".local/bin", ".local/share", ".config/cao", ".config/systemd/user"):
        for path in (home / relative, *(home / relative).parents):
            if path == home.parent:
                break
            if path.is_symlink() or (path.exists() and path.stat().st_uid != os.getuid()):
                raise RuntimeError("unsafe managed installation directory")
    for unit in ("cao-server.service", "cao-terminal.service"):
        state = subprocess.run(["systemctl", "--user", "show", unit, "-p", "LoadState", "--value"], capture_output=True, text=True, timeout=10)
        if state.returncode or state.stdout.strip() != "not-found":
            raise RuntimeError("existing or unverifiable CAO service; fresh installation refused")
    values = read_env(ROOT / "node.env")
    if values.get("CAO_HOME_DIR") != str(home / ".local/share/cao"):
        raise RuntimeError("remote home differs from selected account")
    if os.environ.get("TMUX") or os.environ.get("TMUX_TMPDIR") or os.environ.get("UV_TOOL_DIR") or os.environ.get("UV_TOOL_BIN_DIR"):
        raise RuntimeError("fresh install requires default tmux and uv tool locations")
    return manifest, blobs


def private_dir(path):
    for p in (path, *path.parents):
        if p.is_symlink():
            raise RuntimeError("symlink in managed installation path")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != os.getuid():
        raise RuntimeError("managed directory not owned by installer user")
    os.chmod(path, 0o700)


def create(path, data, mode):
    private_dir(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())


def fetch(url, headers):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, headers=headers), timeout=5) as response:
        return json.loads(response.read(65536))


def health(base, token, internal, protocol):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            assert fetch(base + "/health", {"Authorization": "Bearer " + token})["status"] == "ok"
            assert fetch("http://127.0.0.1:9528/health", {"X-CAO-Terminal-Token": internal})["version"] == protocol
            break
        except (OSError, ValueError, KeyError, AssertionError):
            time.sleep(.5)
    else:
        raise RuntimeError("authenticated CAO/terminal health failed")
    try:
        fetch("http://127.0.0.1:9528/health", {})
    except urllib.error.HTTPError as exc:
        if exc.code not in (401, 403):
            raise RuntimeError("unexpected anonymous terminal response") from None
    else:
        raise RuntimeError("anonymous terminal access admitted")


def resolve_socket():
    # CAO uses libtmux.Server() and the service's default environment.
    # display-message is read-only and never starts a tmux server.
    result = subprocess.run(["tmux", "display-message", "-p", "#{socket_path}"], capture_output=True, text=True, timeout=10)
    if result.returncode == 0:
        socket = Path(result.stdout.strip())
        if not socket.is_absolute() or not socket.is_socket() or socket.stat().st_uid != os.getuid():
            raise RuntimeError("cannot validate backend tmux socket")
        return socket
    socket = Path("/tmp") / ("tmux-" + str(os.getuid())) / "default"
    if os.path.lexists(socket) or str(socket) not in result.stderr or not any(x in result.stderr for x in ("No such file", "no server running")):
        raise RuntimeError("cannot resolve default tmux socket")
    # ENOENT alone does not rule out a live server whose socket was unlinked.
    table = Path("/proc/net/unix").read_text().splitlines()[1:]
    if any(row.split()[-1] == str(socket) for row in table if row.split()):
        raise RuntimeError("tmux socket unlinked while server remains live")
    return socket


def install(python):
    manifest, blobs = preflight()
    if sys.version_info[:2] not in ((3, 12), (3, 13), (3, 14)):
        raise RuntimeError("use an installed Python 3.12, 3.13 or 3.14 interpreter")
    home = Path.home()
    env = read_env(ROOT / "node.env")
    node = read_env(ROOT / "cao-server.env")
    if not node.get("CAO_AUTH_LOCAL_TOKEN") or len(node["CAO_AUTH_LOCAL_TOKEN"]) < 32:
        raise RuntimeError("node authentication unavailable")
    socket = resolve_socket()
    internal = secrets.token_urlsafe(48)
    config = home / ".config/cao"
    marker = config / "node-install-incomplete"
    create(marker, (manifest["id"] + "\n").encode(), 0o600)
    created = []
    tool_started = False
    services_started = False
    units = ["cao-server.service", "cao-terminal.service"]
    def write(path, data, mode=0o600):
        create(path, data, mode)
        created.append(path)
    try:
        tool_started = True
        run("uv", "tool", "install", "--python", python, "--no-python-downloads", "--no-build", "--with", "pillow==12.3.0", str(ROOT / manifest["wheel"]["file"]), timeout=300)
        toolpython = home / ".local/share/uv/tools/cli-agent-orchestrator/bin/python"
        run(str(toolpython), "-I", "-c", "from PIL import Image; import PIL,pydantic_core,libtmux; assert PIL.__version__=='12.3.0'; import cli_agent_orchestrator.api.terminal_workspace")
        run(str(home / ".local/bin/cao"), "install", "code_supervisor", timeout=60)
        write(config / "cao-server.env", (ROOT / "cao-server.env").read_bytes())
        write(config / "terminal-workspace.env", ("CAO_TERMINAL_WORKSPACE=1\nCAO_TERMINAL_URL=http://127.0.0.1:9528\nCAO_TERMINAL_INTERNAL_TOKEN=" + internal + "\n").encode())
        write(config / "cao-terminal-ui.json", blobs[manifest["config"]["file"]])
        write(home / ".local/bin/cao-terminal", blobs[manifest["sidecars"][release_arch()]["file"]], 0o755)
        unitdir = home / ".config/systemd/user"
        common = "[Service]\nType=simple\nEnvironment=PATH=/home/linuxbrew/.linuxbrew/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin\nEnvironmentFile=%h/.config/cao/terminal-workspace.env\nRestart=on-failure\nRestartSec=3\nUMask=0077\n"
        backend = "[Unit]\nDescription=CLI Agent Orchestrator server\nAfter=network-online.target\n\n" + common + "EnvironmentFile=%h/.config/cao/cao-server.env\nExecStart=%h/.local/bin/cao-server --host " + env["CAO_BIND_HOST"] + " --port 9889\n\n[Install]\nWantedBy=default.target\n"
        sidecar = "[Unit]\nDescription=CAO restricted terminal workspace\nAfter=network.target\n\n" + common + 'NoNewPrivileges=true\nExecStart=%h/.local/bin/cao-terminal --listen 127.0.0.1:9528 --socket "' + str(socket).replace("%", "%%") + '" --config %h/.config/cao/cao-terminal-ui.json\n\n[Install]\nWantedBy=default.target\n'
        write(unitdir / units[0], backend.encode())
        write(unitdir / units[1], sidecar.encode())
        provenance = {"release": manifest["id"], "source_sha256": manifest["source_sha256"], "wheel_sha256": manifest["wheel"]["sha256"], "sidecar_sha256": manifest["sidecars"][release_arch()]["sha256"], "protocol": manifest["protocol"], "method": "verified guided fresh install", "database": "not inspected by deployment"}
        write(config / "node-release.json", (json.dumps(provenance, indent=2) + "\n").encode())
        run("systemctl", "--user", "daemon-reload")
        services_started = True
        run("systemctl", "--user", "enable", "--now", *units)
        health("http://" + env["CAO_BIND_HOST"] + ":9889", node["CAO_AUTH_LOCAL_TOKEN"], internal, manifest["protocol"])
        marker.unlink()
        print("Authenticated CAO and terminal health passed")
        print("CAO fleet install complete")
    except BaseException:
        # Keep the marker/data: a retry must not silently reset a partial install.
        if services_started:
            subprocess.run(["systemctl", "--user", "disable", "--now", *units], capture_output=True, timeout=30)
        for path in reversed(created):
            if path.is_file() and not path.is_symlink():
                path.unlink()
        if tool_started:
            subprocess.run(["uv", "tool", "uninstall", "cli-agent-orchestrator"], capture_output=True, timeout=60)
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, timeout=30)
        raise


if __name__ == "__main__":
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "preflight":
            preflight()
            print("Verified CAO and terminal release")
        elif len(sys.argv) == 3 and sys.argv[1] == "install":
            install(sys.argv[2])
        else:
            raise ValueError("invalid install phase")
    except Exception as exc:
        # Never print child output, private environment or traceback locals.
        print("Node installation failed: " + (str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)
