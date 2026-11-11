"""Exercise the real directory proof; OS seams only for exceptional states."""
import os
from pathlib import Path
import subprocess
from unittest.mock import Mock

import pytest

from cli_agent_orchestrator.services import terminal_attachment_service as images

TARGET = {"socket": "/tmp/private-fixture.sock", "pane_id": "%7"}


@pytest.fixture
def proof(tmp_path, monkeypatch):
    store = images.AttachmentStore(tmp_path / "images")
    run = Mock(return_value=f"{os.getpid()}\n")
    monkeypatch.setattr(images, "_pid_output", run)
    try:
        yield store, run
    finally:
        os.close(store.fd)


def check(proof):
    store, _ = proof
    images.shared_filesystem(TARGET, store.root, store.fd)


def test_exact_private_directory_succeeds_without_namespace_inference(proof, monkeypatch):
    # No ns/mnt equality (or parent/server namespace) is needed: the directory
    # identity is direct evidence. Fail if the old namespace probe is restored.
    readlink = os.readlink
    def guard(path, *args, **kwargs):
        if str(path).endswith("/ns/mnt"):
            raise AssertionError("namespace inference")
        return readlink(path, *args, **kwargs)
    monkeypatch.setattr(images.os, "readlink", guard)
    check(proof)
    run = proof[1]
    assert run.call_count == 2
    assert run.call_args.args[0] == ["tmux", "-S", TARGET["socket"], "display-message", "-t", "%7", "-p", "#{pane_pid}"]


@pytest.mark.parametrize("raw", ["", "0", "-3", "1\n2", "pid", "9" * 11])
def test_invalid_pid_rejected(proof, raw):
    proof[1].return_value = raw
    with pytest.raises(images.AttachmentError, match="process is unavailable"):
        check(proof)


@pytest.mark.parametrize("failure", [subprocess.TimeoutExpired("tmux", 3), subprocess.CalledProcessError(1, "tmux"), FileNotFoundError()])
def test_tmux_failure_rejected(proof, failure):
    proof[1].side_effect = failure
    with pytest.raises(images.AttachmentError, match="process is unavailable"):
        check(proof)


@pytest.mark.parametrize("target", [{}, {"socket": "relative", "pane_id": "%7"}, {"socket": "/tmp/x", "pane_id": "-a"}])
def test_invalid_target_never_queries_tmux(proof, target):
    with pytest.raises(images.AttachmentError):
        images.shared_filesystem(target, proof[0].root, proof[0].fd)
    proof[1].assert_not_called()


@pytest.mark.parametrize("script", ["import sys;sys.stderr.write('error')", "print('9'*4096)", "import sys;sys.exit(1)"])
def test_bounded_subprocess_rejects_errors(script):
    import sys
    with pytest.raises(ValueError):
        images._pid_output([sys.executable, "-I", "-c", script])


def test_bounded_subprocess_accepts_only_bounded_output():
    import sys
    assert images._pid_output([sys.executable, "-I", "-c", "print(123)"]) == "123\n"


def test_bounded_subprocess_timeout_reaps_query_process():
    import sys
    import time
    started = time.monotonic()
    with pytest.raises(ValueError, match="timeout"):
        images._pid_output([sys.executable, "-I", "-c", "import time;time.sleep(20)"])
    assert time.monotonic() - started < 5


def test_dead_process_rejected(proof):
    proof[1].return_value = "2147483647"
    with pytest.raises(images.AttachmentError, match="unavailable or cannot be verified"):
        check(proof)


def test_foreign_uid_rejected(proof, monkeypatch):
    monkeypatch.setattr(images.os, "getuid", lambda: os.stat("/proc/self").st_uid + 1)
    with pytest.raises(images.AttachmentError, match="different user"):
        check(proof)


@pytest.mark.parametrize("failure", [PermissionError(13, "denied"), FileNotFoundError(2, "gone")])
def test_inspection_unknown_fails_closed(proof, monkeypatch, failure):
    monkeypatch.setattr(images, "_storage_identity", Mock(side_effect=failure))
    with pytest.raises(images.AttachmentError) as error:
        check(proof)
    assert error.value.status == 409


def test_same_uid_and_root_but_different_store_fails(proof, monkeypatch):
    # Identical process/root metadata cannot stand in for storage equivalence.
    info = proof[0].root.stat()
    monkeypatch.setattr(images, "_storage_identity", lambda *_: (info.st_dev, info.st_ino + 1))
    with pytest.raises(images.AttachmentError, match="same image directory"):
        check(proof)


@pytest.mark.parametrize("replace", ["pane", "starttime"])
def test_process_replacement_fails(proof, monkeypatch, replace):
    if replace == "pane":
        proof[1].side_effect = [str(os.getpid()), str(os.getpid() + 1)]
    else:
        monkeypatch.setattr(images, "_process_start", Mock(side_effect=["10", "11"]))
    with pytest.raises(images.AttachmentError, match="process changed"):
        check(proof)


def test_directory_replaced_after_store_open_fails(proof):
    store = proof[0]
    store.root.rename(store.root.with_name("old"))
    store.root.mkdir(mode=0o700)
    with pytest.raises(images.AttachmentError, match="directory changed"):
        check(proof)


def test_directory_replaced_during_proof_fails(proof, monkeypatch):
    original = images._storage_identity
    def replace(*args):
        identity = original(*args)
        root = proof[0].root
        root.rename(root.with_name("old"))
        root.mkdir(mode=0o700)
        return identity
    monkeypatch.setattr(images, "_storage_identity", replace)
    with pytest.raises(images.AttachmentError, match="directory changed"):
        check(proof)


@pytest.mark.parametrize("component", ["parent", "leaf"])
def test_proc_root_walk_rejects_symlinks(proof, tmp_path, component):
    store = proof[0]
    alias = tmp_path / "alias"
    if component == "parent":
        alias.symlink_to(tmp_path, target_is_directory=True)
        root = alias / "images"
    else:
        alias.symlink_to(store.root, target_is_directory=True)
        root = alias
    with pytest.raises(images.AttachmentError):
        images.shared_filesystem(TARGET, root, store.fd)


def test_non_private_store_rejected(proof):
    proof[0].root.chmod(0o755)
    with pytest.raises(images.AttachmentError, match="private owned directory"):
        check(proof)


def test_process_stat_parser_handles_parentheses(tmp_path):
    root = tmp_path / "proc"
    root.mkdir()
    # field3 through field21 (19 fields), then field22 starttime.
    (root / "stat").write_text("123 (name with ) parentheses) " + " ".join(["S"] + ["0"] * 18 + ["987654", "0"]))
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        assert images._process_start(fd) == "987654"
        (root / "stat").write_text("invalid")
        with pytest.raises(ValueError):
            images._process_start(fd)
    finally:
        os.close(fd)


def test_path_in_another_process_root_resolves_a_different_directory(proof, tmp_path):
    # Real dirfd walk through a fixture process-root symlink: same absolute path
    # can name a different private directory, even for the same user.
    root = proof[0].root
    proc = tmp_path / "fixture-proc"
    alternate = tmp_path / "alternate-root"
    proc.mkdir()
    mapped = alternate.joinpath(*root.parts[1:])
    mapped.mkdir(parents=True, mode=0o700)
    (proc / "root").symlink_to(alternate, target_is_directory=True)
    fd = os.open(proc, os.O_RDONLY | os.O_DIRECTORY)
    try:
        actual = images._storage_identity(fd, root)
        assert actual == (mapped.stat().st_dev, mapped.stat().st_ino)
        assert actual != (root.stat().st_dev, root.stat().st_ino)
    finally:
        os.close(fd)


def test_nondumpable_same_user_child_is_not_silently_authorized(proof, monkeypatch):
    import sys
    process = subprocess.Popen([sys.executable, "-I", "-c",
        "import ctypes,time; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print('ready',flush=True); time.sleep(30)"],
        stdout=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == "ready"
        proof[1].return_value = str(process.pid)
        with pytest.raises(images.AttachmentError):
            check(proof)
    finally:
        process.terminate()
        process.wait(timeout=5)
        process.stdout.close()


def test_actual_private_tmux_process_and_gate(tmp_path):
    """No gate/PID/proc mocks; never connects to the default tmux server."""
    socket = str(tmp_path / "tmux.sock")
    store = images.AttachmentStore(tmp_path / "images")
    def tmux(*args):
        return subprocess.check_output(["tmux", "-S", socket, *args], text=True, timeout=5).strip()
    try:
        pane = tmux("-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "private", "sleep 90")
        target = {"socket": socket, "pane_id": pane}
        images.shared_filesystem(target, store.root, store.fd)
        tmux("kill-pane", "-t", pane)
        with pytest.raises(images.AttachmentError):
            images.shared_filesystem(target, store.root, store.fd)
    finally:
        subprocess.run(["tmux", "-S", socket, "kill-server"], capture_output=True, timeout=5)
        os.close(store.fd)
