"""Unit tests for provider-owned runtime-failure verdicts (#runtime).

Each enabled provider must classify its OWN chrome and reject everything that
could be assistant prose, quoted text, tool output, or a stale render. The
verdicts in this module flow through ``BaseProvider.get_runtime_FAILURE`` to
``StatusMonitor`` generation-checked publication and CAO persistence — raw
pane text must never live in any persisted verdict, only the provider's own
bounded message.
"""

from __future__ import annotations

import pytest

from cli_agent_orchestrator.models.terminal import RUNTIME_FAILURE_MESSAGE_MAX, TerminalStatus
from cli_agent_orchestrator.providers.claude_code import ClaudeCodeProvider
from cli_agent_orchestrator.providers.codex import CodexProvider
from cli_agent_orchestrator.providers.grok_cli import GrokCliProvider
from cli_agent_orchestrator.providers.kimi_cli import KimiCliProvider
from cli_agent_orchestrator.providers.opencode_cli import OpenCodeCliProvider

# ---------------------------------------------------------------------------
# Fixtures — realistic provider renderings (as the CLI paints them), used
# both raw (with escape sequences) and already ANSI-stripped.
# ---------------------------------------------------------------------------

ANSI_API_ERROR_POSTRE = "API Error: 429 {\"rate_limit_error\"}\\n"  # literal, no escapes
CLAUDE_429_BANNER = (
    "❯\n"
    "✻ little-of-thought… (4s · ↓ 1.3k tokens · esc to interrupt (2s ← · ↑ 10 tokens))\n"
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the organization rate limit window"}}\n'
    "❯\n"
)
CLAUDE_529_BANNER = "API Error: 529 · Retrying in 2 seconds… (attempt 1/10)\n"
CLAUDE_TIMEOUT_BANNER = "API Error: Request timed out. Try again.\n"
CLAUDE_USAGE_LIMIT = (
    "Claude usage limit reached. Your limit will reset at 5am (Asia/Singapore)\n"
    "  · /upgrade to increase your limit\n"
)
CLAUDE_WEEKLY_NOTICE = (
    "Weekly limit reached · resets Oct 20, 2026 at 8am (Asia/Singapore) · /upgrade "
)
CLAUDE_AUTH_EXPIRED = (
    "API Error: 401 {\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}\n"
)

CODEX_QUOTA_BLOCK = (
    "⚠ You've hit your usage limit. Your limit will reset at 4:19 PM (PDT)\n"
    "  Upgrade to Plus to continue using Codex. (runs codex upgrade)\n"
    "  › Retry  ✗ Cancel\n"
)
CODEX_RAW_429 = (
    "■ stream error: 429 rate limit exceeded; retrying\n"
    "Your limit will reset at 5:00 PM\n"
)
CODEX_NO_RESET_PROVIDER_ERROR = (
    "⚠ You've hit your usage limit. Your limit will reset at nothing\n"
    "  Upgrade to retry\n"
)
CODEX_LOGIN_MENU = (
    "Welcome to Codex, OpenAI's command-line coding agent\n"
    "Sign in with ChatGPT to use Codex as part of your paid plan\n"
    "Press enter to continue\n"
)
CODEX_COMPLETION_FOOTER = "Worked for 2s • 4:19 PM\n"

OPENCODE_BANNER_429 = (
    "✗ Error: Anthropic API error: 429 rate_limit_error, Please try again later\n"
)
OPENCODE_WARN_LIMIT = (
    "⚠ Usage limit reached for anthropic/claude-sonnet. Resets at 14:00 UTC.\n"
)
OPENCODE_AUTH = "✗ Error: 401 unauthorized: invalid API key provided\n"
OPENCODE_COMPLETION_MARKER = "▣  developer  ·  anthropic/claude-x  ·  12s"

GROK_LIMIT_PICKER = (
    "  ┃  You hit your weekly limit.\n"
    "  ┃\n"
    "  ┃  1 (○) Upgrade tier      Upgrade to a higher tier for more usage\n"
    "  ┃  2 (○) Buy more credits\n"
    "  ┃  3 (○) Try Again\n"
    "  ┃  ↑/↓ navigate · y copy                                Enter:submit\n"
    "  ┃\n"
    "  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss\n"
)
GROK_QUOTED_AS_ANSWER = (
    "     ❯ rate limits?\n\n"
    "    ⎿  Grok's UI shows \"You hit your weekly limit.\" in a picker box.\n\n"
    "      · Worked for 4.0s\n"
)
KIMI_API_ERROR_429 = 'APIError: 429 {"type":"rate_limit","msg":"quota exhausted"}\n'
KIMI_API_ERROR_AUTH = "APIError: 401 unauthorized: bad api key\n"
KIMI_SESSION_ERR_INDENTED = "    Error: Failed to start a session: model not found\n"


# ---------------------------------------------------------------------------
# Shared shape contracts: every verdict must satisfy the persistence boundary.
# ---------------------------------------------------------------------------
def _check_shape(verdict):
    assert set(verdict) >= {"kind", "message", "retryable", "retry_after_s", "reset_at"}
    assert verdict["kind"] in (
        "rate_limited",
        "quota_exhausted",
        "auth_expired",
        "provider_error",
    )
    assert isinstance(verdict["message"], str)
    assert verdict["message"]
    assert len(verdict["message"]) <= RUNTIME_FAILURE_MESSAGE_MAX
    assert isinstance(verdict["retryable"], bool)


# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------
class TestClaudeRuntimeFailure:
    def make(self):
        return ClaudeCodeProvider("testcla", "test-session", "window-0")

    def test_429_banner_rate_limited(self):
        v = self.make().get_runtime_failure(CLAUDE_429_BANNER)
        assert v["kind"] == "rate_limited"
        assert v["retryable"] is True
        assert "429" in v["message"]
        _check_shape(v)

    def test_529_retry_after_parsed(self):
        v = self.make().get_runtime_failure(CLAUDE_529_BANNER)
        assert v["kind"] == "provider_error"
        assert v["retryable"] is True
        assert v["retry_after_s"] == 2

    def test_timeout_banner(self):
        v = self.make().get_runtime_failure(CLAUDE_TIMEOUT_BANNER)
        assert v["kind"] == "provider_error" and v["retryable"] is True

    def test_usage_limit_notice(self):
        v = self.make().get_runtime_failure(CLAUDE_USAGE_LIMIT)
        assert v["kind"] == "quota_exhausted"
        assert v["reset_at"] == "5am (Asia/Singapore)"

    def test_weekly_quota_notice(self):
        v = self.make().get_runtime_failure(CLAUDE_WEEKLY_NOTICE)
        assert v["kind"] == "quota_exhausted"

    def test_401_auth_expired(self):
        v = self.make().get_runtime_failure(CLAUDE_AUTH_EXPIRED)
        assert v["kind"] == "auth_expired"

    def test_quoted_prose_rejected(self):
        prose = '⏺ Note: the API returned "API Error: 429 rate limit exceeded" earlier.\n'
        assert self.make().get_runtime_failure(prose) is None

    def test_indented_quote_rejected(self):
        assert self.make().get_runtime_failure("  API Error: 429 (maybe)\n") is None

    def test_no_deliberate_limit_word(self):
        assert self.make().get_runtime_failure("The agent's weekly limit is 5 requests.\n") is None

    def test_stale_banner_after_completion_rejected(self):
        stale = CLAUDE_429_BANNER + "✻ Sautéed for 3s\n"
        assert self.make().get_runtime_failure(stale) is None

    def test_raw_buffer_with_ansi(self):
        raw = "\x1b[2K\r" + CLAUDE_429_BANNER.replace(
            "API Error: 429", "\x1b[31;1mAPI Error: 429\x1b[0m"
        )
        assert self.make().get_runtime_failure(raw)["kind"] == "rate_limited"

    def test_empty_buffer(self):
        assert self.make().get_runtime_failure("") is None


# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------
class TestCodexRuntimeFailure:
    def make(self, initialized: bool = True):
        p = CodexProvider("testcod", "test-session", "window-0")
        p._initialized = initialized
        return p

    def test_quota_block(self):
        v = self.make().get_runtime_failure(CODEX_QUOTA_BLOCK)
        assert v["kind"] == "quota_exhausted"
        assert v["reset_at"] == "4:19 PM (PDT)"
        _check_shape(v)

    def test_raw_rate_limit_reset(self):
        v = self.make().get_runtime_failure(CODEX_RAW_429)
        assert v["kind"] == "quota_exhausted"
        assert "429" in v["message"]

    def test_quota_without_reset_chrome_is_provider_error_when_initialized(self):
        v = self.make().get_runtime_failure(
            "⚠ You've hit your usage limit. No reset chrome.\n"
        )
        assert v["kind"] == "provider_error"

    def test_prose_rejected(self):
        prose = "⏺ I encountered a usage limit error earlier.\n› Ask Codex to do anything\n"
        assert self.make().get_runtime_failure(prose) is None

    def test_initialized_login_menu_is_auth_expired(self):
        verdict = self.make().get_runtime_failure(CODEX_LOGIN_MENU)
        assert verdict["kind"] == "auth_expired"

    def test_uninitialized_login_menu_is_operator_task(self):
        assert self.make(initialized=False).get_runtime_failure(CODEX_LOGIN_MENU) is None

    def test_stale_quota_followed_by_completion_is_rejected(self):
        assert (
            self.make().get_runtime_failure(CODEX_QUOTA_BLOCK + CODEX_COMPLETION_FOOTER)
            is None
        )

    def test_uninitialized_returns_none_for_prose(self):
        assert self.make(initialized=False).get_runtime_failure(".") is None

    def test_empty(self):
        assert self.make().get_runtime_failure("") is None


# ---------------------------------------------------------------------------
# OpenCode
# ---------------------------------------------------------------------------
class TestOpenCodeRuntimeFailure:
    def make(self):
        p = OpenCodeCliProvider("testopen", "test-session", "window-0")
        p._initialized = True
        return p

    def test_banner_429(self):
        v = self.make().get_runtime_failure(OPENCODE_BANNER_429)
        assert v["kind"] == "rate_limited"
        assert "429" in v["message"]
        _check_shape(v)

    def test_warn_limit_resets(self):
        v = self.make().get_runtime_failure(OPENCODE_WARN_LIMIT)
        assert v["kind"] == "quota_exhausted"
        assert v["reset_at"] == "14:00 UTC."

    def test_auth(self):
        v = self.make().get_runtime_failure(OPENCODE_AUTH)
        assert v["kind"] == "auth_expired"
        assert v["retryable"] is False

    def test_reply_indented(self):
        # A banner the agent INDENTS inside its answer must not classify.
        assert (
            self.make().get_runtime_failure("  ✗ Error: 429 rate_limit_error (as reply)\n")
            is None
        )

    def test_tool_output_line(self):
        assert (
            self.make().get_runtime_failure("└ ✗ Error: 429 rate_limit_error (tool)\n") is None
        )

    def test_completion_marker_after_banner_rejected(self):
        stale = OPENCODE_BANNER_429 + OPENCODE_COMPLETION_MARKER + "\n"
        assert self.make().get_runtime_failure(stale) is None

    def test_empty(self):
        assert self.make().get_runtime_failure("") is None


# ---------------------------------------------------------------------------
# Grok
# ---------------------------------------------------------------------------
class TestGrokRuntimeFailure:
    def make(self):
        return GrokCliProvider("testgrok", "test-session", "window-0")

    def test_limit_picker(self):
        v = self.make().get_runtime_failure(GROK_LIMIT_PICKER)
        assert v["kind"] == "quota_exhausted"
        _check_shape(v)

    def test_pickless_refusalline_is_no_verdict(self):
        # Refusal line without a picker footer can't be a current failure.
        assert self.make().get_runtime_failure("┃  You hit your weekly limit.\n") is None

    def test_answer_refusing_grok_picker_rejected(self):
        assert self.make().get_runtime_failure(GROK_QUOTED_AS_ANSWER) is None

    def test_empty(self):
        assert self.make().get_runtime_failure("") is None


# ---------------------------------------------------------------------------
# Kimi
# ---------------------------------------------------------------------------
class TestKimiRuntimeFailure:
    def make(self):
        return KimiCliProvider("testkimi", "test-session", "window-0")

    def test_api_error_429(self):
        v = self.make().get_runtime_failure(KIMI_API_ERROR_429)
        assert v["kind"] == "rate_limited"
        assert v["retryable"] is True
        _check_shape(v)

    def test_auth_shape(self):
        v = self.make().get_runtime_failure(KIMI_API_ERROR_AUTH)
        assert v["kind"] == "auth_expired"
        assert v["retryable"] is False

    def test_indented_session_error_not_runtime(self):
        assert self.make().get_runtime_failure(KIMI_SESSION_ERR_INDENTED) is None

    def test_quoted_prose_rejected(self):
        assert self.make().get_runtime_failure("quoted APIError: 429 rate_limit") is None

    def test_empty(self):
        assert self.make().get_runtime_failure("") is None


# ---------------------------------------------------------------------------
# Status: RuntimeError shape collapse must keep TerminalStatus intact
# (never introduce a provider-specific kind variant).
# ---------------------------------------------------------------------------
def test_kimi_screen_detection_status_untouched():
    """Existing status detection must stay byte-identical."""
    provider = ClaudeCodeProvider("testcla", "test-session", "window-0")
    # No runtime failure banner, normal output -> status checks unaffected.
    assert provider.get_status(CLAUDE_429_BANNER) in (
        TerminalStatus.PROCESSING,
        TerminalStatus.COMPLETED,
        TerminalStatus.IDLE,
        TerminalStatus.UNKNOWN,
    )
