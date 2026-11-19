"""Built-in model choices per CLI, offered by the Settings page.

These are suggestions, not an allow-list. A route may name any model its CLI
accepts, and users add their own under Settings › Auto (Jev) defaults (stored
in ``auto_routing.custom_models``). Update this list when a CLI ships new
models.

Sources, checked 2026-11-19:

- ``claude_code``: the aliases ``claude --help`` names (Claude Code 2.1.328),
  plus ``haiku``. An alias always starts the latest model of that family.
- ``codex``: the models ``codex debug models`` marks visible (codex-cli
  0.162.1), in that catalog's priority order.

Other CLIs have no built-in entries because their model names depend on how
each machine configures the CLI.
"""

from typing import Dict, List

BUILTIN_MODELS: Dict[str, List[str]] = {
    "claude_code": ["opus", "sonnet", "haiku", "fable"],
    "codex": [
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
    ],
}
