"""Explicit operator answers to a freshly observed native question.

No tasks, memory injection, approvals, resize, pipe changes, or provider restart.
The revision is process-local and invalid after a backend restart. Captures and
writes use pinned tmux IDs, not reusable names. External terminal clients cannot
be locked; every navigation step is re-observed and ambiguity stops submission.
"""

import hashlib
import hmac
import json
import secrets
import time
from dataclasses import asdict

from cli_agent_orchestrator.backends.registry import get_backend
from cli_agent_orchestrator.backends.tmux_backend import TmuxBackend
from cli_agent_orchestrator.clients.database import get_terminal_metadata, update_last_active
from cli_agent_orchestrator.providers.claude_question import parse_question
from cli_agent_orchestrator.services import terminal_status_store as store
from cli_agent_orchestrator.services.session_lock import session_lifecycle_lock
from cli_agent_orchestrator.services.status_monitor import status_monitor

_SECRET = secrets.token_bytes(32)


class QuestionConflict(ValueError):
    """No input is safe for this revision. Refresh or use the terminal."""


def _capture(terminal_id):
    row = store.context(terminal_id)
    if row is None:
        raise LookupError("Terminal not found")
    backend = get_backend()
    if (
        row["provider"] != "claude_code"
        or not isinstance(backend, TmuxBackend)
        or not store.recoverable(row)
        or store.input_pending(row)
    ):
        return None
    target = backend.resolve_workspace_target(terminal_id, row["tmux_session"])
    witness = backend.question_pane_witness(target)
    screen = backend.observe_terminal_exact(target)
    question = parse_question(screen)
    if question is None or question.custom_text or question.selected > question.custom_number:
        return None
    if backend.question_pane_witness(target) != witness or store.context(terminal_id) != row:
        raise QuestionConflict("Terminal changed. Refresh the question.")
    payload = json.dumps(
        [
            store.identity(row),
            row["last_active"],
            target,
            witness,
            screen,
            status_monitor.output_generation(terminal_id),
        ],
        sort_keys=True,
        default=str,
    ).encode()
    revision = hmac.new(_SECRET, payload, hashlib.sha256).hexdigest()
    return backend, row, target, witness, question, revision


def get_question(terminal_id: str) -> dict:
    """Read-only. Unsupported dialogs intentionally expose no answer controls."""
    try:
        captured = _capture(terminal_id)
    except LookupError:
        raise
    except Exception:
        captured = None
    if captured is None:
        return {"question": None, "fallback": "Open Terminal to answer this prompt."}
    _, _, _, _, question, revision = captured
    return {
        "question": {
            "revision": revision,
            "header": question.header,
            "text": question.question,
            "options": [asdict(option) for option in question.options],
            "allows_text": True,
        },
        "fallback": None,
    }


def answer_question(terminal_id: str, revision: str, option: int | None, text: str | None) -> dict:
    if (option is None) == (text is None):
        raise ValueError("Choose one option or enter a text answer.")
    if text is not None and (
        not text.strip()
        or len(text) > 2000
        or any(ord(c) < 32 or 127 <= ord(c) <= 159 or c in "  " for c in text)
    ):
        raise ValueError("Use a non-empty, single-line answer of at most 2000 characters.")
    metadata = get_terminal_metadata(terminal_id)
    if not metadata:
        raise LookupError("Terminal not found")
    with session_lifecycle_lock(metadata["tmux_session"]):
        captured = _capture(terminal_id)
        if captured is None or not hmac.compare_digest(captured[-1], revision):
            raise QuestionConflict(
                "The question changed or was already answered. Refresh before answering."
            )
        backend, row, target, witness, question, _ = captured
        destination = option if option is not None else question.custom_number
        if option is not None and option not in {o.number for o in question.options}:
            raise ValueError("Choose one of the displayed options.")
        expected_selected = question.selected
        expected_text = ""

        def observe():
            current = store.context(terminal_id)
            if (
                current is None
                or store.identity(current) != store.identity(row)
                or current["last_active"] != row["last_active"]
                or not store.recoverable(current)
                or backend.question_pane_witness(target) != witness
            ):
                raise QuestionConflict("Terminal changed. Use Open Terminal to check the prompt.")
            live = parse_question(backend.observe_terminal_exact(target))
            if live is None or live.identity() != question.identity():
                raise QuestionConflict("The question changed. No answer was submitted.")
            return live

        def check():
            live = observe()
            if live.selected != expected_selected or live.custom_text != expected_text:
                raise QuestionConflict(
                    "The prompt was edited elsewhere. Check it in Open Terminal."
                )

        def wait_for(selected, custom_text):
            deadline = time.monotonic() + 2
            while True:
                live = observe()
                if live.selected == selected and live.custom_text == custom_text:
                    return
                if time.monotonic() >= deadline:
                    raise QuestionConflict(
                        "The prompt did not confirm the input. Check it in Open Terminal."
                    )
                time.sleep(0.05)

        check()
        # Persist the existing input fence BEFORE any key; duplicates and uncertain
        # partial sends cannot fall through to normal task delivery or be retried.
        status_monitor.notify_input_sent(terminal_id)
        fenced = store.context(terminal_id)
        if fenced is None or not store.input_pending(fenced):
            raise QuestionConflict("Could not record the input boundary. No answer was sent.")
        try:
            while expected_selected != destination:
                check()
                direction = 1 if destination > expected_selected else -1
                backend.send_question_input_exact(
                    target, witness, key="Down" if direction > 0 else "Up"
                )
                expected_selected += direction
                wait_for(expected_selected, expected_text)
            if text is not None:
                check()
                backend.send_question_input_exact(target, witness, text=text)
                expected_text = text
                wait_for(expected_selected, expected_text)
            check()
            backend.send_question_input_exact(target, witness, key="Enter")
        finally:
            update_last_active(terminal_id)
            status_monitor.checkpoint_after_input(terminal_id)
    return {"success": True, "message": "Answer sent to the terminal."}
