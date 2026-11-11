"""Private, bounded image uploads for an exact terminal viewer; never public files."""
from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import stat
import subprocess
import threading
import time
import warnings

from cli_agent_orchestrator.constants import CAO_HOME_DIR

MAX_IMAGE = 10 * 1024 * 1024
MAX_PIXELS = 25_000_000
MAX_PENDING = 4
MAX_VIEWER_BYTES = 40 * 1024 * 1024
MAX_TOTAL = 256 * 1024 * 1024
FORMATS = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp")}
_ID = re.compile(r"^[a-f0-9]{40}$")
_SAFE_ROOT = re.compile(r"^/[A-Za-z0-9_./-]+$")


class AttachmentError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass
class Attachment:
    id: str
    viewer: str
    terminal: str
    target: dict
    created: float
    expires: float
    size: int = 0
    extension: str = "part"
    confirmed: bool = False


def _pid_output(command: list[str]) -> str:
    """Bound both runtime and bytes, including unexpected stderr from tmux."""
    deadline = time.monotonic() + 3
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        try:
            output = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                selector.register(process.stderr, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ValueError("pane pid query timeout")
                    for key, _ in selector.select(remaining):
                        chunk = os.read(key.fd, 129)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        elif key.fileobj is process.stderr or len(output) + len(chunk) > 128:
                            raise ValueError("unexpected pane pid output")
                        else:
                            output.extend(chunk)
            if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
                raise ValueError("pane pid query failed")
            return output.decode("ascii")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=1)


def _pane_pid(target: dict) -> int:
    """Read only the pinned pane's numeric PID; never evaluate terminal output."""
    try:
        socket, pane = target["socket"], target["pane_id"]
        if not isinstance(socket, str) or not socket.startswith("/") or not isinstance(pane, str) or not re.fullmatch(r"%[0-9]+", pane):
            raise ValueError("invalid target")
        raw = _pid_output(["tmux", "-S", socket, "display-message", "-t", pane, "-p", "#{pane_pid}"]).strip()
        if len(raw) > 10 or not re.fullmatch(r"[1-9][0-9]*", raw):
            raise ValueError("invalid pane pid")
        return int(raw)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        raise AttachmentError("Terminal process is unavailable. Reopen the terminal and attach again.", 409) from exc


def _process_start(proc_fd: int) -> str:
    fd = os.open("stat", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=proc_fd)
    with os.fdopen(fd, "r") as stream:
        raw = stream.read(8193)
    # comm can contain spaces or ')' characters. Fields after its last ')' start
    # at field3; field22 is process start time. Never return/log the other fields.
    fields = raw[raw.rfind(")") + 2:].split()
    if len(raw) > 8192 or len(fields) < 20 or not fields[19].isdigit():
        raise ValueError("invalid process identity")
    return fields[19]


def _storage_identity(proc_fd: int, root: Path) -> tuple[int, int]:
    """Resolve only our fixed root inside the pane root, rejecting symlinks.

    Different mount namespaces may share this directory (e.g. shell sandboxes).
    Comparing namespace IDs is too restrictive; same UID/root inode alone is too
    weak. Walk every component relative to /proc/PID/root with O_NOFOLLOW, then
    compare the actual storage directory's device+inode with the local store.
    """
    fd = os.open("root", os.O_PATH | os.O_DIRECTORY, dir_fd=proc_fd)
    try:
        for part in root.parts[1:]:
            child = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise AttachmentError("Terminal image directory is not private to the current user.", 409)
        return info.st_dev, info.st_ino
    finally:
        os.close(fd)


def shared_filesystem(target: dict, root: Path, storage_fd: int) -> None:
    """Prove this exact private store is visible to the pinned same-UID process.

    No inference from tmux-server/parent namespace and no permission-denied
    fallback. /proc directory fd pins the process, starttime+pane recheck fences
    replacement. Caller repeats this proof before publication/confirmation.
    """
    if not root.is_absolute() or not _SAFE_ROOT.fullmatch(str(root)) or ".." in root.parts:
        raise AttachmentError("Attachment storage path cannot be verified.", 503)
    pid = _pane_pid(target)
    proc_fd = None
    try:
        proc_fd = os.open(f"/proc/{pid}", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        if os.fstat(proc_fd).st_uid != os.getuid():
            raise AttachmentError("Terminal process belongs to a different user; image upload is unavailable.", 409)
        before = _process_start(proc_fd)
        local = root.lstat()
        opened = os.fstat(storage_fd)
        if not stat.S_ISDIR(local.st_mode) or local.st_uid != os.getuid() or local.st_mode & 0o077:
            raise AttachmentError("Attachment storage must be a private owned directory.", 503)
        if (opened.st_dev, opened.st_ino) != (local.st_dev, local.st_ino):
            raise AttachmentError("Image directory changed. Reopen the terminal after checking storage.", 409)
        if _storage_identity(proc_fd, root) != (local.st_dev, local.st_ino):
            raise AttachmentError("Terminal cannot see the same image directory. Use a shared local filesystem.", 409)
        if _process_start(proc_fd) != before or _pane_pid(target) != pid:
            raise AttachmentError("Terminal process changed. Reopen the terminal and attach again.", 409)
        after = root.lstat()
        if (after.st_dev, after.st_ino) != (local.st_dev, local.st_ino):
            raise AttachmentError("Image directory changed. Attach again after checking storage.", 409)
    except PermissionError as exc:
        raise AttachmentError("Cannot verify terminal image directory permissions. Image upload is unavailable for this process.", 409) from exc
    except (OSError, ValueError) as exc:
        if isinstance(exc, AttachmentError):
            raise
        raise AttachmentError("Terminal image directory is unavailable or cannot be verified. Reopen the terminal or check shared storage.", 409) from exc
    finally:
        if proc_fd is not None:
            os.close(proc_fd)


def verify_image(path: Path, content_type: str) -> str:
    from PIL import Image, UnidentifiedImageError

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                fmt = image.format
                if fmt not in FORMATS or image.width * image.height > MAX_PIXELS or min(image.size) < 1:
                    raise AttachmentError("Use PNG, JPEG or WebP up to 25 megapixels.")
                if FORMATS[fmt][1] != content_type or getattr(image, "n_frames", 1) != 1:
                    raise AttachmentError("Image type mismatch or animation is not supported.")
                image.verify()
            with Image.open(path) as image:
                image.load()
        return FORMATS[fmt][0]
    except AttachmentError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise AttachmentError("Invalid or oversized image.") from exc


class AttachmentStore:
    def __init__(self, root: Path):
        if not _SAFE_ROOT.fullmatch(str(root)) or ".." in root.parts:
            raise AttachmentError("Attachment storage path is not safe for terminal insertion.", 503)
        if root.parent.resolve() != root.parent:
            raise AttachmentError("Attachment storage parent must not use symlinks.", 503)
        root.mkdir(mode=0o700, parents=False, exist_ok=True)
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise AttachmentError("Attachment storage must be a private owned directory.", 503)
        self.root = root
        self.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.items: dict[str, Attachment] = {}
        self.inflight: set[str] = set()
        self.lock = threading.RLock()
        self._load()

    def _load(self):
        # Only recognized, exclusive generated names; never follow arbitrary paths.
        for name in os.listdir(self.fd):
            if len(self.items) >= 1024:
                raise AttachmentError("Attachment storage requires cleanup.", 503)
            if name.endswith(".json") and _ID.fullmatch(name[:-5]):
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
                    with os.fdopen(fd, "r") as stream:
                        metadata = os.fstat(stream.fileno())
                        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
                            continue
                        raw = stream.read(8193)
                    if len(raw) > 8192:
                        continue
                    item = Attachment(**json.loads(raw))
                    if (
                        item.id != name[:-5]
                        or item.extension not in {"png", "jpg", "webp", "part"}
                        or not isinstance(item.viewer, str)
                        or not isinstance(item.terminal, str)
                        or not isinstance(item.target, dict)
                        or type(item.expires) not in (int, float)
                        or not 0 < item.expires < time.time() + 86401
                        or type(item.confirmed) is not bool
                    ):
                        continue
                    info = os.stat(f"{item.id}.{item.extension}", dir_fd=self.fd, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > MAX_IMAGE:
                        continue
                    item.size = info.st_size
                    self.items[item.id] = item
                except (OSError, ValueError, TypeError):
                    continue
        self.cleanup()
        # Reclaim interrupted publish/manifest writes as well as partial uploads.
        # Only generated owned regular entries are removable; unrelated names,
        # directories and symlinks are never followed or deleted.
        for name in os.listdir(self.fd):
            ident, dot, extension = name.rpartition(".")
            if not dot or not _ID.fullmatch(ident) or extension not in {"part", "png", "jpg", "webp", "json", "tmp"}:
                continue
            item = self.items.get(ident)
            if item is not None and extension in {item.extension, "json"}:
                continue
            with suppress(FileNotFoundError):
                info = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid():
                    os.unlink(name, dir_fd=self.fd)

    def _save(self, item: Attachment):
        temp = item.id + ".tmp"
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(asdict(item), stream)
            os.rename(temp, item.id + ".json", src_dir_fd=self.fd, dst_dir_fd=self.fd)
        finally:
            with suppress(FileNotFoundError):
                os.unlink(temp, dir_fd=self.fd)

    def cleanup(self):
        with self.lock:
            for item in list(self.items.values()):
                if item.expires <= time.time() and item.id not in self.inflight:
                    self._remove(item)

    def _remove(self, item: Attachment):
        for name in (item.id + "." + item.extension, item.id + ".json"):
            with suppress(FileNotFoundError):
                os.unlink(name, dir_fd=self.fd)
        self.items.pop(item.id, None)
        self.inflight.discard(item.id)

    def reserve(self, viewer) -> tuple[Attachment, int]:
        with self.lock:
            self.cleanup()
            own = [x for x in self.items.values() if x.viewer == viewer.id]
            used = lambda x: x.size if x.extension != "part" else MAX_IMAGE
            if len(self.inflight) >= 2 or len(self.items) >= 1024 or sum(not x.confirmed for x in own) >= MAX_PENDING or sum(map(used, own)) + MAX_IMAGE > MAX_VIEWER_BYTES or sum(map(used, self.items.values())) + MAX_IMAGE > MAX_TOTAL:
                raise AttachmentError("Image storage quota reached. Remove pending images or wait for expiry.", 429)
            item = Attachment(secrets.token_hex(20), viewer.id, viewer.terminal_id, dict(viewer.target), time.time(), time.time() + min(600, max(0, viewer.expires - time.monotonic())))
            fd = os.open(item.id + ".part", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            self.items[item.id] = item
            self.inflight.add(item.id)
            return item, fd

    def publish(self, item: Attachment, extension: str, size: int):
        with self.lock:
            if item.id not in self.items or item.expires <= time.time():
                raise AttachmentError("Upload expired. Nothing was inserted.", 410)
            os.link(item.id + ".part", item.id + "." + extension, src_dir_fd=self.fd, dst_dir_fd=self.fd, follow_symlinks=False)
            os.unlink(item.id + ".part", dir_fd=self.fd)
            item.extension = extension
            item.size = size
            self._save(item)
            self.inflight.discard(item.id)

    def owned(self, ident: str, viewer) -> Attachment:
        if not _ID.fullmatch(ident):
            raise AttachmentError("Image not found.", 404)
        with self.lock:
            self.cleanup()
            item = self.items.get(ident)
            if item is None or item.viewer != viewer.id or item.terminal != viewer.terminal_id or item.target != viewer.target or item.extension == "part":
                raise AttachmentError("Image unavailable for this viewer.", 404)
            try:
                info = os.stat(f"{item.id}.{item.extension}", dir_fd=self.fd, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size != item.size:
                    raise OSError("attachment changed")
            except OSError as exc:
                raise AttachmentError("Image file is no longer available. Attach it again.", 410) from exc
            return item

    def confirm(self, ident: str, viewer) -> dict:
        with self.lock:
            item = self.owned(ident, viewer)
            if not item.confirmed:
                item.confirmed = True
                item.expires = time.time() + 86400
            self._save(item)
            return {"id": item.id, "path": str(self.root / (item.id + "." + item.extension)), "expires_at": item.expires}

    def cancel(self, ident: str, viewer):
        with self.lock:
            item = self.owned(ident, viewer)
            if not item.confirmed:
                self._remove(item)

    def discard(self, item: Attachment):
        with self.lock:
            if item.id in self.items:
                self._remove(item)


_store: AttachmentStore | None = None
_decode_slots = asyncio.Semaphore(2)


def store() -> AttachmentStore:
    global _store
    if _store is None:
        _store = AttachmentStore(CAO_HOME_DIR / "terminal-images")
    return _store
