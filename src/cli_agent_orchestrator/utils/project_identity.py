"""Pure, bounded project identity primitives (no database/settings imports)."""
import re
import subprocess
from pathlib import Path
from typing import Optional


def normalize_git_remote(url: str) -> str:
    if not url:
        return "unknown"
    value = url.strip().lower()
    for protocol in ("git+ssh://", "ssh://", "git://", "https://", "http://"):
        if value.startswith(protocol):
            value = value[len(protocol):]
            break
    if "@" in value:
        value = value.split("@", 1)[1]
    if ":" in value:
        head, _, tail = value.partition(":")
        if "/" not in head:
            value = f"{head}/{tail}"
    if value.endswith(".git"):
        value = value[:-4]
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-") or "unknown"


def git_remote_identity(cwd: Path) -> Optional[str]:
    try:
        result = subprocess.run(["git", "-C", str(cwd), "config", "--get", "remote.origin.url"],
                                capture_output=True, text=True, timeout=2, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None if result.returncode == 0 else None
