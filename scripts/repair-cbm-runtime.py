#!/usr/bin/env python3
"""Quarantine one proven-orphan CBM 0.10.8 socket pair. Dry-run by default.

No database/cache reads or writes, daemon kill, automatic startup or lock deletion.
See docs/opencode-cli.md. Linux protocol verified against CBM v0.10.8 ipc.c,
version_cohort.c and private_file_lock.c. An active/unknown generation fails closed.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import uuid


class Refused(RuntimeError):
    """No mutation is safe with the observed runtime state."""


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def secure_path(path):
    require(path.is_absolute(), "absolute path required")
    for part in (path, *path.parents):
        require(not part.is_symlink(), "symlink path refused")


def identity(s):
    return (s.st_dev, s.st_ino, s.st_uid, s.st_mode, s.st_nlink, s.st_ctime_ns)


def check_directory(runtime):
    secure_path(runtime)
    s = runtime.stat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid(), "runtime owner/type differs")
    require(stat.S_IMODE(s.st_mode) == 0o700, "runtime must be private mode 0700")
    return identity(s)[:4]  # Creating a quarantine changes the directory's ctime.


def socket_pair(runtime, endpoint=None):
    candidates = sorted(p.name for p in runtime.iterdir() if p.name.endswith(".sock"))
    if endpoint is None:
        require(len(candidates) == 1, "exactly one endpoint required")
        endpoint = candidates[0].removesuffix(".sock")
    require(re.fullmatch(r"cbm-[a-f0-9]{16}", endpoint), "unsupported endpoint name")
    require(candidates == [endpoint + ".sock"], "unexpected endpoint sockets")
    for suffix in (".sock.identity", ".sock.pending"):
        p = runtime / (endpoint + suffix)
        require(not os.path.lexists(p), "publication record present; use upstream recovery")
    require(
        not any(p.name.startswith(endpoint + ".sock.") for p in runtime.iterdir()),
        "unknown publication artifact",
    )
    pair = [runtime / (endpoint + suffix) for suffix in (".sock", ".anc")]
    states = []
    for p in pair:
        secure_path(p)
        s = p.lstat()
        require(stat.S_ISSOCK(s.st_mode) and s.st_uid == os.getuid(), "socket owner/type differs")
        require(
            stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 2, "socket mode/link count differs"
        )
        states.append(identity(s))
    require(states[0] == states[1], "socket pair identities differ")
    return endpoint, states


def assert_unbound(paths):
    # Filesystem-only socket remnants are not entries in the kernel table.
    names = {str(p) for p in paths}
    for line in Path("/proc/net/unix").read_text().splitlines()[1:]:
        fields = line.split(maxsplit=7)
        require(not (len(fields) == 8 and fields[7] in names), "endpoint is kernel-bound")


def assert_orphan_endpoints(paths):
    """Run only while retaining every native guard; identify this endpoint, not
    unrelated same-user processes. A pathname alone or an unreadable /proc/exe
    is not ownership evidence. Require both kernel absence and ECONNREFUSED.
    Never send application bytes. All other connect outcomes fail closed.
    """
    assert_unbound(paths)
    for path in paths:
        before = identity(path.lstat())
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            try:
                probe.connect(str(path))
            except OSError as error:
                require(error.errno == errno.ECONNREFUSED, "socket absence cannot be verified")
            else:
                raise Refused("socket has a live listener")
        require(identity(path.lstat()) == before, "socket changed during liveness check")
    assert_unbound(paths)


def lock_file(runtime, name):
    path = runtime / name
    secure_path(path)
    # Require existing protocol guards. Never invent or replace a guard inode.
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid(), "guard owner/type differs")
        require(
            stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1, "guard mode/link count differs"
        )
        require(identity(s) == identity(path.lstat()), "guard inode changed")
    except BaseException:
        os.close(fd)
        raise
    return fd


@contextmanager
def guards(runtime, endpoint):
    # Mirror upstream mutation admission, then exclude startup + legacy + daemon
    # lifetime. Cohort guards use flock; endpoint lifetime is POSIX F_SETLK.
    specs = [
        ("cbm-version-cohort-maintenance-v1.lock", False),
        ("cbm-version-cohort-admission-v1.lock", False),
        ("cbm-version-cohort-lifetime-v1.lock", False),
        ("cbm-version-cohort-daemon-v1.lock", False),
        (endpoint + ".startup-v2.lock", False),
        (endpoint + ".lock", False),
        (endpoint + ".lifetime.lock", True),
    ]
    opened = []
    try:
        for name, record in specs:
            fd = lock_file(runtime, name)
            opened.append((fd, record, name, identity(os.fstat(fd))))
            try:
                if record:
                    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise Refused("native runtime guard is busy") from exc
        for fd, _, name, before in opened:
            require(
                identity(os.fstat(fd)) == before == identity((runtime / name).lstat()),
                "guard changed after locking",
            )
        yield
    finally:
        for fd, record, _, _ in reversed(opened):
            try:
                (fcntl.lockf if record else fcntl.flock)(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def inspect(runtime):
    directory = check_directory(runtime)
    endpoint, states = socket_pair(runtime)
    with guards(runtime, endpoint):
        require(check_directory(runtime) == directory, "runtime directory changed")
        require(socket_pair(runtime, endpoint)[1] == states, "socket identity changed")
        assert_orphan_endpoints([runtime / (endpoint + s) for s in (".sock", ".anc")])
        require(socket_pair(runtime, endpoint)[1] == states, "socket changed after liveness check")
    return endpoint, states


def quarantine(runtime, endpoint, expected):
    directory = check_directory(runtime)
    original = expected[0]
    with guards(runtime, endpoint):
        require(check_directory(runtime) == directory, "runtime directory changed")
        require(socket_pair(runtime, endpoint)[1] == expected, "socket identity drift")
        names = [endpoint + s for s in (".sock", ".anc")]
        assert_orphan_endpoints([runtime / n for n in names])
        require(
            socket_pair(runtime, endpoint)[1] == expected, "socket changed after liveness check"
        )
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        target = runtime / ("quarantine-" + stamp + "-" + uuid.uuid4().hex[:12])
        target.mkdir(mode=0o700)
        moved = []
        try:
            require(
                socket_pair(runtime, endpoint)[1] == expected, "socket changed before quarantine"
            )
            for name in names:
                require(
                    identity((runtime / name).lstat()) == expected[0],
                    "socket changed during quarantine",
                )
                os.rename(runtime / name, target / name)
                moved.append(name)
                # rename changes ctime for both hard links; retain and revalidate
                # exact inode/type/owner/mode/link count, with the updated ctime.
                expected = [identity((target / name).lstat())] * 2
            metadata = {
                "schema": 1,
                "endpoint": endpoint,
                "original_identity": original,
                "quarantined_identity": expected[0],
                "names": names,
                "quarantined_at": stamp,
                "database": "not accessed",
            }
            fd = os.open(
                target / "metadata.json",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            with os.fdopen(fd, "w") as f:
                json.dump(metadata, f, indent=2)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            fsync_directory(target)
            fsync_directory(runtime)
        except BaseException:
            # Still under every guard. Never overwrite another socket on rollback.
            for name in reversed(moved):
                require(not os.path.lexists(runtime / name), "rollback namespace occupied")
                os.rename(target / name, runtime / name)
            raise
    return target


def restore(runtime, target):
    """Explicit safe rollback; refuses any newly published generation."""
    check_directory(runtime)
    check_directory(target)
    require(
        target.parent == runtime and target.name.startswith("quarantine-"),
        "invalid quarantine path",
    )
    metadata_path = target / "metadata.json"
    secure_path(metadata_path)
    metadata_state = metadata_path.stat()
    require(
        stat.S_ISREG(metadata_state.st_mode)
        and metadata_state.st_uid == os.getuid()
        and stat.S_IMODE(metadata_state.st_mode) == 0o600
        and metadata_state.st_nlink == 1
        and metadata_state.st_size < 8192,
        "unsafe quarantine metadata",
    )
    metadata = json.loads(metadata_path.read_text())
    require(metadata.get("schema") == 1, "unsupported quarantine metadata")
    endpoint = metadata["endpoint"]
    require(re.fullmatch(r"cbm-[a-f0-9]{16}", endpoint), "invalid quarantined endpoint")
    names = [endpoint + s for s in (".sock", ".anc")]
    require(metadata["names"] == names, "invalid quarantine names")
    with guards(runtime, endpoint):
        require(
            not any(
                os.path.lexists(runtime / (endpoint + s))
                for s in (".sock", ".anc", ".sock.identity", ".sock.pending")
            ),
            "rollback namespace occupied",
        )
        assert_unbound([runtime / n for n in names])
        assert_orphan_endpoints([target / n for n in names])
        pair = [identity((target / n).lstat()) for n in names]
        require(
            pair[0] == pair[1] and list(pair[0]) == metadata["quarantined_identity"],
            "quarantine identity drift",
        )
        require(
            stat.S_ISSOCK(pair[0][3])
            and stat.S_IMODE(pair[0][3]) == 0o600
            and pair[0][2] == os.getuid()
            and pair[0][4] == 2,
            "unsafe quarantine pair",
        )
        for name in names:
            os.rename(target / name, runtime / name)
        fsync_directory(runtime)
        fsync_directory(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=Path(f"/tmp/cbm-daemon-{os.getuid()}"))
    parser.add_argument(
        "--binary", type=Path, default=Path.home() / ".local/bin/codebase-memory-mcp"
    )
    parser.add_argument("--expected-binary-sha256")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--restore", type=Path)
    args = parser.parse_args()
    require(sys.platform == "linux", "Linux only")
    secure_path(args.binary)
    binary = args.binary.stat()
    require(
        stat.S_ISREG(binary.st_mode) and binary.st_uid == os.getuid(), "binary owner/type differs"
    )
    digest = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    version = subprocess.check_output(
        [str(args.binary), "--version"], text=True, stderr=subprocess.PIPE, timeout=5
    ).strip()
    require(version == "codebase-memory-mcp 0.10.8", "unsupported CBM version")
    if args.apply:
        require(
            args.expected_binary_sha256 == digest,
            "explicit exact binary checksum required for apply",
        )
    if args.restore:
        require(args.apply, "restore requires --apply")
        restore(args.runtime, args.restore)
        print(json.dumps({"restored": True, "quarantine": str(args.restore)}))
        return
    endpoint, states = inspect(args.runtime)
    result = {
        "safe_orphan_pair": True,
        "endpoint": endpoint,
        "binary_sha256": digest,
        "applied": False,
    }
    if args.apply:
        result.update(applied=True, quarantine=str(quarantine(args.runtime, endpoint, states)))
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, subprocess.SubprocessError) as error:
        # Errors contain only operational paths/state, never graph/source content.
        print(f"REFUSED: {error}", file=sys.stderr)
        raise SystemExit(1)
