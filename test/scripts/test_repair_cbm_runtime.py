"""Synthetic socket/lock tests; never use the user's CBM runtime or databases."""

import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/repair-cbm-runtime.py"
spec = importlib.util.spec_from_file_location("repair_cbm_runtime", SCRIPT)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)
ENDPOINT = "cbm-0123456789abcdef"
GUARDS = [
    "cbm-version-cohort-maintenance-v1.lock",
    "cbm-version-cohort-admission-v1.lock",
    "cbm-version-cohort-lifetime-v1.lock",
    "cbm-version-cohort-daemon-v1.lock",
    ENDPOINT + ".startup-v2.lock",
    ENDPOINT + ".lock",
    ENDPOINT + ".lifetime.lock",
]


@pytest.fixture
def runtime():
    # AF_UNIX sun_path is capped at 108 bytes, including quarantine paths.
    with tempfile.TemporaryDirectory(prefix="cbmt-", dir="/tmp") as temporary:
        root = Path(temporary)
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(root / (ENDPOINT + ".anc")))
        sock.close()
        (root / (ENDPOINT + ".anc")).chmod(0o600)
        os.link(root / (ENDPOINT + ".anc"), root / (ENDPOINT + ".sock"))
        for name in GUARDS:
            (root / name).write_bytes(b"keep guard contents")
            (root / name).chmod(0o600)
        yield root


def test_dry_run_does_not_modify(runtime):
    before = {p.name: repair.identity(p.lstat()) for p in runtime.iterdir()}
    endpoint, _ = repair.inspect(runtime)
    assert endpoint == ENDPOINT
    assert {p.name: repair.identity(p.lstat()) for p in runtime.iterdir()} == before


def test_quarantine_and_restore_exact_pair_preserves_guards(runtime):
    guards = {
        name: (repair.identity((runtime / name).stat()), (runtime / name).read_bytes())
        for name in GUARDS
    }
    endpoint, before = repair.inspect(runtime)
    target = repair.quarantine(runtime, endpoint, before)
    assert not (runtime / (ENDPOINT + ".sock")).exists()
    assert (target / (ENDPOINT + ".sock")).stat().st_ino == before[0][1]
    assert (target / (ENDPOINT + ".anc")).stat().st_nlink == 2
    assert json.loads((target / "metadata.json").read_text())["database"] == "not accessed"
    repair.restore(runtime, target)
    assert (runtime / (ENDPOINT + ".sock")).stat().st_ino == before[0][1]
    for name, (identity, contents) in guards.items():
        assert repair.identity((runtime / name).stat()) == identity
        assert (runtime / name).read_bytes() == contents


@pytest.mark.parametrize("suffix", [".sock.identity", ".sock.pending", ".sock.unknown"])
def test_publication_records_refused(runtime, suffix):
    (runtime / (ENDPOINT + suffix)).touch()
    with pytest.raises(repair.Refused):
        repair.inspect(runtime)


def test_live_kernel_bound_socket_refused(runtime):
    (runtime / (ENDPOINT + ".sock")).unlink()
    (runtime / (ENDPOINT + ".anc")).unlink()
    sock = socket.socket(socket.AF_UNIX)
    try:
        sock.bind(str(runtime / (ENDPOINT + ".anc")))
        (runtime / (ENDPOINT + ".anc")).chmod(0o600)
        os.link(runtime / (ENDPOINT + ".anc"), runtime / (ENDPOINT + ".sock"))
        with pytest.raises(repair.Refused, match="kernel-bound"):
            repair.inspect(runtime)
    finally:
        sock.close()


@pytest.mark.parametrize("name", GUARDS)
def test_native_guard_busy_refused(runtime, name):
    code = """
import fcntl,sys
with open(sys.argv[1], 'r+b') as f:
    (fcntl.lockf if sys.argv[1].endswith('.lifetime.lock') else fcntl.flock)(f, fcntl.LOCK_EX)
    print('locked', flush=True)
    sys.stdin.read()
"""
    child = subprocess.Popen(
        [sys.executable, "-I", "-c", code, str(runtime / name)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout.readline().strip() == "locked"
        with pytest.raises(repair.Refused, match="busy"):
            repair.inspect(runtime)
    finally:
        child.communicate("", timeout=10)
        assert child.returncode == 0


@pytest.mark.parametrize(
    "kind",
    [
        "mode",
        "symlink",
        "extra_link",
        "different_inode",
        "directory_mode",
        "guard_mode",
        "guard_symlink",
        "guard_missing",
    ],
)
def test_unsafe_paths_refused(runtime, kind):
    p = runtime / (ENDPOINT + ".sock")
    if kind == "mode":
        p.chmod(0o666)
    elif kind == "symlink":
        p.unlink()
        p.symlink_to(runtime / (ENDPOINT + ".anc"))
    elif kind == "extra_link":
        os.link(p, runtime / "unexpected")
    elif kind == "different_inode":
        p.unlink()
        s = socket.socket(socket.AF_UNIX)
        s.bind(str(p))
        s.close()
        p.chmod(0o600)
    elif kind == "directory_mode":
        runtime.chmod(0o755)
    elif kind == "guard_mode":
        (runtime / GUARDS[0]).chmod(0o644)
    elif kind == "guard_symlink":
        (runtime / GUARDS[0]).unlink()
        (runtime / GUARDS[0]).symlink_to(runtime / GUARDS[1])
    elif kind == "guard_missing":
        (runtime / GUARDS[0]).unlink()
    with pytest.raises((repair.Refused, OSError)):
        repair.inspect(runtime)


def test_socket_drift_refused_at_apply(runtime):
    endpoint, before = repair.inspect(runtime)
    (runtime / (ENDPOINT + ".sock")).chmod(0o400)
    with pytest.raises(repair.Refused):
        repair.quarantine(runtime, endpoint, before)
    assert not list(runtime.glob("quarantine-*"))


def test_occupied_rollback_namespace_never_overwritten(runtime):
    endpoint, before = repair.inspect(runtime)
    target = repair.quarantine(runtime, endpoint, before)
    occupied = runtime / (ENDPOINT + ".sock")
    occupied.write_text("new generation evidence")
    with pytest.raises(repair.Refused, match="occupied"):
        repair.restore(runtime, target)
    assert occupied.read_text() == "new generation evidence"
    assert (target / (ENDPOINT + ".anc")).is_socket()


def test_wrong_uid_refused(runtime, monkeypatch):
    monkeypatch.setattr(repair.os, "getuid", lambda: runtime.stat().st_uid + 1)
    with pytest.raises(repair.Refused, match="owner"):
        repair.inspect(runtime)


def test_live_listener_refused_even_if_kernel_table_misses_it(runtime, monkeypatch):
    (runtime / (ENDPOINT + ".sock")).unlink()
    (runtime / (ENDPOINT + ".anc")).unlink()
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(runtime / (ENDPOINT + ".anc")))
        listener.listen(1)
        (runtime / (ENDPOINT + ".anc")).chmod(0o600)
        os.link(runtime / (ENDPOINT + ".anc"), runtime / (ENDPOINT + ".sock"))
        monkeypatch.setattr(repair, "assert_unbound", lambda paths: None)
        with pytest.raises(repair.Refused, match="live listener"):
            repair.inspect(runtime)
    assert (runtime / (ENDPOINT + ".sock")).is_socket()


@pytest.mark.parametrize("number", [13, 2, 110])
def test_unknown_connect_error_refused(runtime, monkeypatch, number):
    class Probe:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def settimeout(self, seconds):
            pass

        def connect(self, path):
            raise OSError(number, "synthetic failure")

    monkeypatch.setattr(repair.socket, "socket", lambda *args: Probe())
    with pytest.raises(repair.Refused, match="cannot be verified"):
        repair.inspect(runtime)
    assert not list(runtime.glob("quarantine-*"))


def test_restore_rejects_quarantine_symlink(runtime):
    endpoint, before = repair.inspect(runtime)
    target = repair.quarantine(runtime, endpoint, before)
    alias = runtime / "quarantine-alias"
    alias.symlink_to(target)
    with pytest.raises(repair.Refused, match="symlink"):
        repair.restore(runtime, alias)
