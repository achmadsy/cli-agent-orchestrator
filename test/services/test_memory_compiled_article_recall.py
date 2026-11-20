"""Recall of topics an LLM compile rewrote without ``## <timestamp>`` headings.

The background compile may reorganise an article under topical headings
("## Status", "## Fix") and drop every timestamp line. Recall, BM25 search and
terminal context used to skip such files silently. These tests pin that they
are read again, and that a new compile always keeps one timestamp heading.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest
from sqlalchemy import create_engine

from cli_agent_orchestrator.clients.database import Base
from cli_agent_orchestrator.services import wiki_compiler
from cli_agent_orchestrator.services.memory_service import (
    MemoryService,
    _keep_section_timestamp,
)

_TIMESTAMP_HEADING = re.compile(r"^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", re.MULTILINE)


def _run(coro):
    return asyncio.run(coro)


def _ctx() -> dict:
    return {
        "terminal_id": "term-001",
        "session_name": "test-session",
        "agent_profile": "developer",
        "provider": "claude_code",
        "cwd": "/home/user/project",
    }


@pytest.fixture
def svc(tmp_path: Path) -> MemoryService:
    engine = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(bind=engine)
    return MemoryService(base_dir=tmp_path, db_engine=engine)


def _rewrite_as_compiled(svc: MemoryService, key: str, body: str) -> Path:
    """Replace a global topic's sections with a compiled-style body."""
    wiki_file = svc.get_wiki_path("global", None, key)
    lines = wiki_file.read_text(encoding="utf-8").splitlines()
    header = [line for line in lines[:2]]
    assert header[0] == f"# {key}" and header[1].startswith("<!-- id:")
    wiki_file.write_text("\n".join([*header, "", body]) + "\n", encoding="utf-8")
    return wiki_file


COMPILED_BODY = (
    "## Status (2026-11-18)\n"
    "The fix is committed and deployed.\n"
    "\n"
    "## Root cause\n"
    "parsedToolInput throws when no input fragment arrived."
)


class TestRecallReadsCompiledArticles:
    def _store_and_compile(self, svc: MemoryService) -> Path:
        _run(
            svc.store(
                content="first observation",
                scope="global",
                memory_type="project",
                key="kiro-noarg",
                tags="kiro,fix",
                terminal_context=_ctx(),
            )
        )
        return _rewrite_as_compiled(svc, "kiro-noarg", COMPILED_BODY)

    def test_unfiltered_recall_returns_compiled_article(self, svc):
        self._store_and_compile(svc)

        memories = _run(svc.recall(scope="global", terminal_context=_ctx()))

        assert [m.key for m in memories] == ["kiro-noarg"]
        memory = memories[0]
        assert memory.content == COMPILED_BODY
        assert "<!-- id:" not in memory.content
        assert memory.tags == "kiro,fix"
        assert memory.memory_type == "project"

    def test_compiled_article_is_dated_from_its_index_entry(self, svc):
        self._store_and_compile(svc)
        index_text = svc.get_index_path("global", None).read_text(encoding="utf-8")
        updated = re.search(r"\[kiro-noarg\].* updated:(\S+)$", index_text, re.MULTILINE)
        assert updated is not None

        memory = _run(svc.recall(scope="global", terminal_context=_ctx()))[0]

        assert memory.updated_at.strftime("%Y-%m-%dT%H:%M:%SZ") == updated.group(1)
        assert memory.created_at == memory.updated_at

    def test_query_recall_matches_compiled_article(self, svc):
        self._store_and_compile(svc)

        for mode in ("metadata", "bm25", "hybrid"):
            memories = _run(
                svc.recall(
                    query="parsedToolInput",
                    scope="global",
                    search_mode=mode,
                    terminal_context=_ctx(),
                )
            )
            assert [m.key for m in memories] == ["kiro-noarg"], mode

    def test_article_with_only_a_header_is_still_skipped(self, svc):
        _run(
            svc.store(
                content="body",
                scope="global",
                memory_type="project",
                key="empty-topic",
                terminal_context=_ctx(),
            )
        )
        _rewrite_as_compiled(svc, "empty-topic", "")

        assert _run(svc.recall(scope="global", terminal_context=_ctx())) == []


class TestKeepSectionTimestamp:
    HEADER = "# k\n<!-- id: abc | scope: global | type: project | tags: t -->\n"

    def test_unchanged_when_a_timestamp_heading_survives(self):
        compiled = self.HEADER + "\n## 2026-11-18T10:00:00Z\nmerged\n"

        assert _keep_section_timestamp(compiled, "") == compiled

    def test_inserts_latest_source_timestamp_under_the_header(self):
        source = (
            self.HEADER
            + "\n## 2026-11-17T09:00:00Z\nold\n\n## 2026-11-18T10:58:56Z\nnew observation\n"
        )
        compiled = self.HEADER + "\n## Status\nmerged body\n"

        result = _keep_section_timestamp(compiled, source)

        assert result == self.HEADER + "\n## 2026-11-18T10:58:56Z\n## Status\nmerged body\n"

    def test_uses_now_when_the_source_has_no_timestamp(self):
        result = _keep_section_timestamp(self.HEADER + "\n## Status\nbody\n", self.HEADER)

        assert len(_TIMESTAMP_HEADING.findall(result)) == 1
        assert result.startswith(self.HEADER + "\n## ")


class TestBackgroundCompileKeepsTimestamp:
    def test_compiled_write_back_has_a_timestamp_heading(self, svc, monkeypatch):
        monkeypatch.setattr(wiki_compiler, "_build_llm_client", lambda *a, **k: object())

        async def fake_llm(_client, system, user, *, timeout_s):
            if "wiki compiler" not in system.lower():
                return "[]"  # find_related: no cross-references
            id_line = next(
                line.strip()
                for line in user.splitlines()
                if wiki_compiler._ID_HEADER_RE.match(line.strip())
            )
            # A compile that reorganises everything and drops the timestamps.
            return f"# topic\n{id_line}\n\n## Summary\nfirst and second, merged\n"

        monkeypatch.setattr(wiki_compiler, "_llm_call", fake_llm)

        async def scenario():
            await svc.store(content="first", scope="global", memory_type="project", key="topic")
            monkeypatch.setenv("CAO_MEMORY_COMPILE_MODE", "llm")
            await svc.store(content="second", scope="global", memory_type="project", key="topic")
            pending = list(svc._compile_tasks)
            assert pending, "store() did not schedule a background compile"
            await asyncio.gather(*pending)

        _run(scenario())

        text = svc.get_wiki_path("global", None, "topic").read_text(encoding="utf-8")
        assert "first and second, merged" in text, "compile write-back did not land"
        assert len(_TIMESTAMP_HEADING.findall(text)) == 1
        recalled = _run(svc.recall(scope="global"))
        assert [m.key for m in recalled] == ["topic"]
        assert recalled[0].content == "## Summary\nfirst and second, merged"
