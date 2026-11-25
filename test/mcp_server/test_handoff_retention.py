"""Handoff owns the task wait, not implicit permission to destroy the worker."""

import asyncio
import inspect
from unittest.mock import Mock, patch

import pytest
import requests

from cli_agent_orchestrator.utils.orchestration import HandoffContext, _handoff_impl

MODULE = "cli_agent_orchestrator.utils.orchestration"


@pytest.fixture
def rig():
    response = Mock(status_code=200)
    response.json.return_value = {
        "terminal_id": "aabbccdd",
        "last_message": "Task finished",
        "status": "completed",
    }
    with (
        patch(
            f"{MODULE}._resolve_handoff_provider",
            return_value=HandoffContext("claude_code", None, None, None),
        ),
        patch(f"{MODULE}._resolve_remote_provider", return_value="claude_code"),
        patch(f"{MODULE}.requests.post", return_value=response) as post,
        patch(f"{MODULE}.requests.delete") as delete_http,
        patch(f"{MODULE}._delete_terminal_impl", return_value={"success": True}) as delete,
        patch(f"{MODULE}._create_terminal", return_value=("aabbccdd", "claude_code")),
    ):
        yield response, post, delete, delete_http


@pytest.mark.parametrize("placement", ["local", "early", "remote"])
@pytest.mark.parametrize("auto_delete", [False, True])
def test_worker_retained_unless_success_cleanup_explicit(rig, placement, auto_delete):
    _, post, delete, delete_http = rig
    kwargs = {"auto_delete": auto_delete}
    if placement == "early":
        kwargs["on_terminal_id"] = lambda _: None
    elif placement == "remote":
        kwargs["target_host"] = "worker.internal"
    result = asyncio.run(_handoff_impl("developer", "task", **kwargs))
    assert result.success is True
    assert result.output == "Task finished"
    # Even opt-in cleanup happens only AFTER a successful response. The server
    # cannot destroy the worker on extraction error or after a lost connection.
    assert post.call_args.kwargs["json"]["teardown"] is False
    delete_http.assert_not_called()
    if auto_delete:
        if placement == "remote":
            delete.assert_called_once_with("aabbccdd", target_host="worker.internal")
        else:
            delete.assert_called_once_with("aabbccdd")
    else:
        delete.assert_not_called()
        assert "retained" in result.message.lower()


def test_omitted_option_retains_worker(rig):
    _, post, delete, _ = rig
    result = asyncio.run(_handoff_impl("developer", "task"))
    assert result.success
    assert post.call_args.kwargs["json"]["teardown"] is False
    delete.assert_not_called()


@pytest.mark.parametrize("target_host", [None, "worker.internal"])
@pytest.mark.parametrize("auto_delete", [False, True])
@pytest.mark.parametrize(
    "outcome",
    [
        "timeout",
        "error",
        "transport",
        "malformed",
        "not_completed",
        "null_output",
        "empty_output",
        "missing_status",
    ],
)
def test_no_cleanup_on_failure_or_uncertainty(rig, target_host, auto_delete, outcome):
    response, post, delete, delete_http = rig
    if outcome in ("timeout", "error"):
        response.status_code = 504 if outcome == "timeout" else 502
        response.json.return_value = {
            "detail": {"kind": outcome, "message": "Not finished", "terminal_id": "aabbccdd"}
        }
    elif outcome == "transport":
        post.side_effect = requests.Timeout("connection lost")
    elif outcome == "malformed":
        response.json.return_value = {"terminal_id": "aabbccdd"}
    elif outcome == "null_output":
        response.json.return_value["last_message"] = None
    elif outcome == "empty_output":
        response.json.return_value["last_message"] = "  "
    elif outcome == "missing_status":
        response.json.return_value.pop("status")
    else:
        response.json.return_value["status"] = "processing"
    result = asyncio.run(
        _handoff_impl("developer", "task", target_host=target_host, auto_delete=auto_delete)
    )
    assert not result.success
    delete.assert_not_called()
    delete_http.assert_not_called()


def test_no_wait_and_auto_delete_rejected_before_creation(rig):
    _, post, delete, _ = rig
    result = asyncio.run(_handoff_impl("developer", "task", wait=False, auto_delete=True))
    assert not result.success
    assert "auto_delete" in result.message
    post.assert_not_called()
    delete.assert_not_called()


@pytest.mark.parametrize("auto_delete", [None, False, True])
def test_mcp_option_forwards_retention_default(rig, auto_delete):
    from cli_agent_orchestrator.mcp_server.server import handoff

    from pydantic.fields import FieldInfo

    _, post, delete, _ = rig
    # Framework validation resolves the other Field defaults before a real
    # tools/call. Leave only auto_delete omitted to exercise its safe wrapper.
    kwargs = {
        name: parameter.default.default
        for name, parameter in inspect.signature(handoff).parameters.items()
        if name not in ("agent_profile", "message", "auto_delete")
        and isinstance(parameter.default, FieldInfo)
    }
    if auto_delete is not None:
        kwargs["auto_delete"] = auto_delete
    result = asyncio.run(handoff("developer", "task", **kwargs))
    assert result.success
    assert post.call_args.kwargs["json"]["teardown"] is False
    assert delete.call_count == (1 if auto_delete is True else 0)


def test_cleanup_failure_does_not_claim_deleted_or_fail_task(rig):
    _, _, delete, _ = rig
    delete.return_value = {"success": False, "message": "Not confirmed"}
    result = asyncio.run(_handoff_impl("developer", "task", auto_delete=True))
    assert result.success
    assert "cleanup" in result.message.lower()
    assert "not confirmed" in result.message.lower()
