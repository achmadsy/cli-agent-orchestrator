"""Original document delivery, private storage, and bounded Auto launch bodies."""

import base64
import io
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from cli_agent_orchestrator.api import terminal_workspace as routes
from cli_agent_orchestrator.api.main import AutoAttachmentBody
from cli_agent_orchestrator.services import terminal_attachment_service as files
from cli_agent_orchestrator.services import terminal_workspace_service as workspace
from cli_agent_orchestrator.services.auto_router import LaneDecision
from test.api.test_auto_routing_api import _cfg, _terminal, SETTINGS, CLASSIFY, SESSION_SVC

TARGET = {
    "session": "cao-fixture",
    "terminal": "abcd1234",
    "window_id": "@1",
    "pane_id": "%2",
    "mode": "pane",
    "socket": "/tmp/test-socket",
}


@pytest.fixture
def file_store(tmp_path, monkeypatch):
    store = files.AttachmentStore(tmp_path / "files")
    monkeypatch.setattr(files, "_store", store)
    monkeypatch.setattr(files, "_pid_output", lambda _: str(os.getpid()))
    monkeypatch.setattr(workspace, "resolve_target", lambda _: TARGET.copy())
    yield store
    os.close(store.fd)


def encoded(name="report.pdf", data=b"%PDF-1.7\nfixture", mime="application/pdf"):
    return {"filename": name, "content_type": mime, "data_base64": base64.b64encode(data).decode()}


def test_batch_json_document_and_legacy_images_reload(file_store):
    data = b'{"original":"content"}'
    batch = file_store.stage_initial(
        [AutoAttachmentBody(**encoded("data.json", data, "application/json"))]
    )
    paths = batch.prepare("abcd1234")
    batch.retain()
    assert Path(paths[0]).read_bytes() == data
    assert paths[0].endswith(".data.json")
    assert (Path(paths[0]).stat().st_mode & 0o777) == 0o600
    item = batch.items[0]
    assert (file_store.root / (item.id + ".json")).exists()
    reloaded = files.AttachmentStore(file_store.root)
    assert reloaded.items[item.id].namespaced
    os.close(reloaded.fd)
    batch.discard()
    assert Path(paths[0]).exists()  # possibly delivered, retained


@pytest.mark.parametrize(
    "name", ["../report.pdf", "a/b.txt", "a\\b.txt", "a\n.txt", "\x00bad", ".."]
)
def test_bad_names_never_leave_files(file_store, name):
    with pytest.raises(files.AttachmentError):
        file_store.stage_initial([AutoAttachmentBody(**encoded(name))])
    assert not list(file_store.root.iterdir())


def test_failed_batch_is_all_or_nothing(file_store):
    with pytest.raises(files.AttachmentError):
        file_store.stage_initial(
            [
                AutoAttachmentBody(**encoded()),
                AutoAttachmentBody(filename="bad.pdf", data_base64="not base64!"),
            ]
        )
    assert not file_store.items
    assert not list(file_store.root.iterdir())


def test_hidden_raster_still_runs_pillow(file_store, monkeypatch):
    stream = io.BytesIO()
    Image.new("RGB", (3, 4)).save(stream, format="PNG")
    monkeypatch.setattr(files, "MAX_PIXELS", 1)
    with pytest.raises(files.AttachmentError):
        file_store.stage_initial(
            [
                AutoAttachmentBody(
                    **encoded("image.bin", stream.getvalue(), "application/octet-stream")
                )
            ]
        )
    assert not file_store.items


def test_target_failure_discards_entire_pending_batch(file_store, monkeypatch):
    batch = file_store.stage_initial([AutoAttachmentBody(**encoded())])
    monkeypatch.setattr(
        files,
        "shared_filesystem",
        lambda *args: (_ for _ in ()).throw(files.AttachmentError("inaccessible")),
    )
    with pytest.raises(files.AttachmentError):
        batch.prepare("abcd1234")
    batch.discard()
    assert not list(file_store.root.iterdir())


def test_manual_documents_are_opaque_private_and_confirmed(file_store, monkeypatch):
    for key in ("AUTH0_DOMAIN", "CAO_AUTH_JWKS_URI", "CAO_AUTH_LOCAL_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(routes, "WS_ALLOWED_CLIENTS", ["127.0.0.1"])
    monkeypatch.setattr(workspace, "_viewers", {})
    monkeypatch.setattr(workspace, "health", AsyncMock())
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 42)) as client:
        viewer = client.post(
            "/terminal/viewers",
            json={"terminal_id": "abcd1234"},
            headers={"Origin": "http://localhost"},
        ).json()
        for name, data, mime in [
            ("report.pdf", b"%PDF-original", "application/pdf"),
            ("report.docx", b"PK\x03\x04original", "application/octet-stream"),
            ("data.json", b'{"a": 1}', "application/json"),
        ]:
            url = viewer["url"] + "attachments"
            response = client.post(
                url,
                content=data,
                headers={
                    "Origin": "http://localhost",
                    "Content-Type": mime,
                    "X-CAO-Filename": quote(name),
                },
            )
            assert response.status_code == 200, response.text
            ident = response.json()["id"]
            assert "path" not in response.json()
            confirmed = client.post(
                url + "/" + ident + "/confirm", headers={"Origin": "http://localhost"}
            )
            assert Path(confirmed.json()["path"]).read_bytes() == data
            assert client.get(url + "/" + ident).status_code == 404


def test_auto_stages_before_classification_but_routes_text_only(client, file_store):
    async def create(**kwargs):
        batch = kwargs["initial_attachments"]
        assert kwargs["initial_message"] == "inspect the report"
        assert "attachments" not in kwargs["metadata"]
        assert batch.items[0].extension == "pdf"
        batch.claim("abcd1234")
        return _terminal()

    with (
        patch(SETTINGS, return_value=_cfg()),
        patch(CLASSIFY, return_value=LaneDecision("fix_supervisor", 0.9, None, "m")) as classify,
        patch(SESSION_SVC) as svc,
    ):
        svc.create_session = AsyncMock(side_effect=create)
        response = client.post(
            "/auto-routing/sessions",
            json={
                "initial_message": "inspect the report",
                "provider": "claude_code",
                "attachments": [encoded()],
            },
        )
        assert response.status_code == 201, response.text
        classify.assert_called_once_with("inspect the report", _cfg())
        batch = svc.create_session.await_args.kwargs["initial_attachments"]
        batch.discard()


@pytest.mark.parametrize(
    "attachment",
    [
        encoded("../bad.pdf"),
        {"filename": "x", "data_base64": "secret-invalid-base64"},
        {**encoded(), "extra": "private-value"},
    ],
)
def test_auto_rejects_before_spawn_and_never_echoes_payload(client, file_store, attachment):
    with patch(SETTINGS, return_value=_cfg()), patch(CLASSIFY) as classify:
        response = client.post(
            "/auto-routing/sessions",
            json={"initial_message": "inspect", "attachments": [attachment]},
        )
    assert response.status_code in (400, 422)
    assert attachment["data_base64"] not in response.text
    assert "private-value" not in response.text
    assert not file_store.items
    classify.assert_not_called()


def test_auto_create_failure_cleans_staged_files(client, file_store):
    with (
        patch(SETTINGS, return_value=_cfg()),
        patch(CLASSIFY, return_value=LaneDecision("fix_supervisor", 0.9, None, "m")),
        patch(SESSION_SVC) as svc,
    ):
        svc.create_session = AsyncMock(side_effect=ValueError("bad directory"))
        response = client.post(
            "/auto-routing/sessions",
            json={"initial_message": "inspect", "attachments": [encoded()]},
        )
    assert response.status_code == 400
    assert not file_store.items
    assert not list(file_store.root.iterdir())


def test_batch_limits_and_unknown_extension(file_store, monkeypatch):
    monkeypatch.setattr(files, "MAX_IMAGE", 8)
    monkeypatch.setattr(files, "MAX_BASE64", 12)
    monkeypatch.setattr(files, "MAX_VIEWER_BYTES", 32)
    batch = file_store.stage_initial(
        [
            AutoAttachmentBody(**encoded("unknown.exe", b"opaque")),
            AutoAttachmentBody(**encoded("same.pdf", b"12345678")),
            AutoAttachmentBody(**encoded("same.pdf", b"12345678")),
            AutoAttachmentBody(**encoded("four.pdf", b"12345678")),
        ]
    )
    assert batch.items[0].extension == "bin"
    assert len({item.id for item in batch.items}) == 4
    batch.discard()
    for payloads in ([encoded(data=b"123456789")], [encoded()] * 5, [encoded(data=b"")]):
        with pytest.raises(ValueError):
            file_store.stage_initial([AutoAttachmentBody(**item) for item in payloads])
        assert not file_store.items
    monkeypatch.setattr(files, "MAX_TOTAL", 7)
    with pytest.raises(files.AttachmentError, match="quota"):
        file_store.stage_initial([AutoAttachmentBody(**encoded(data=b"x"))])
    assert not file_store.items


def test_prepared_but_not_dispatched_batch_is_removed(file_store):
    batch = file_store.stage_initial([AutoAttachmentBody(**encoded())])
    batch.prepare("abcd1234")
    batch.discard()
    assert not list(file_store.root.iterdir())


def test_target_replaced_between_prepare_and_dispatch(file_store, monkeypatch):
    batch = file_store.stage_initial([AutoAttachmentBody(**encoded())])
    batch.prepare("abcd1234")
    monkeypatch.setattr(workspace, "resolve_target", lambda _: {**TARGET, "pane_id": "%9"})
    with pytest.raises(files.AttachmentError, match="target changed"):
        batch.retain()
    batch.discard()
    assert not list(file_store.root.iterdir())


def test_expired_pending_document_reclaimed_after_restart(file_store, monkeypatch):
    batch = file_store.stage_initial([AutoAttachmentBody(**encoded())])
    future = batch.items[0].expires + 1
    monkeypatch.setattr(files.time, "time", lambda: future)
    reloaded = files.AttachmentStore(file_store.root)
    try:
        assert not reloaded.items
        assert not list(file_store.root.iterdir())
    finally:
        os.close(reloaded.fd)


def test_partial_retention_failure_cleans_whole_batch(file_store, monkeypatch):
    batch = file_store.stage_initial(
        [AutoAttachmentBody(**encoded()), AutoAttachmentBody(**encoded())]
    )
    batch.prepare("abcd1234")
    original = file_store._save
    count = 0

    def fail_second(item):
        nonlocal count
        count += 1
        if count == 2:
            raise OSError("storage failure")
        original(item)

    monkeypatch.setattr(file_store, "_save", fail_second)
    with pytest.raises(OSError):
        batch.retain()
    batch.discard()
    assert not list(file_store.root.iterdir())


@pytest.mark.asyncio
async def test_wire_timeout_and_busy_slots_release(monkeypatch):
    import asyncio
    from cli_agent_orchestrator.api import attachment_limits
    from cli_agent_orchestrator.api.attachment_limits import AutoAttachmentBodyLimit

    app = AsyncMock()
    middleware = AutoAttachmentBodyLimit(app)
    scope = {"type": "http", "method": "POST", "path": "/auto-routing/sessions", "headers": []}
    send = AsyncMock()
    receive = AsyncMock()
    middleware.slots.acquire()
    middleware.slots.acquire()
    await middleware(scope, receive, send)
    assert send.call_args_list[0].args[0]["status"] == 429
    middleware.slots.release()
    middleware.slots.release()
    send.reset_mock()
    monkeypatch.setattr(attachment_limits, "UPLOAD_TIMEOUT", 0.01)

    async def stalled():
        await asyncio.Event().wait()

    await middleware(scope, stalled, send)
    assert send.call_args_list[0].args[0]["status"] == 408
    assert middleware.slots.acquire(blocking=False)
    assert middleware.slots.acquire(blocking=False)
    app.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancelled_request_reclaims_completed_staging(file_store, monkeypatch):
    import asyncio
    import threading
    from fastapi import BackgroundTasks, Request
    from cli_agent_orchestrator.api import main

    entered = asyncio.Event()
    release = threading.Event()
    cleaned = asyncio.Event()
    loop = asyncio.get_running_loop()
    original_stage = file_store.stage_initial
    original_discard = files.InitialAttachmentBatch.discard

    def stage(payload):
        batch = original_stage(payload)
        loop.call_soon_threadsafe(entered.set)
        release.wait(timeout=5)
        return batch

    def discard(batch):
        original_discard(batch)
        loop.call_soon_threadsafe(cleaned.set)

    monkeypatch.setattr(file_store, "stage_initial", stage)
    monkeypatch.setattr(files.InitialAttachmentBatch, "discard", discard)
    body = main.AutoSessionBody(
        initial_message="inspect", attachments=[AutoAttachmentBody(**encoded())]
    )
    request = Request(
        {"type": "http", "method": "POST", "path": "/auto-routing/sessions", "headers": []}
    )
    with patch(SETTINGS, return_value=_cfg()), patch(CLASSIFY) as classify:
        task = asyncio.create_task(
            main.create_auto_session(request, BackgroundTasks(), body, ["write"])
        )
        try:
            await asyncio.wait_for(entered.wait(), timeout=5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            release.set()
        await asyncio.wait_for(cleaned.wait(), timeout=5)
        classify.assert_not_called()
    assert not list(file_store.root.iterdir())


def test_wire_limit_content_length_compression_and_chunked(client, monkeypatch):
    from cli_agent_orchestrator.api import attachment_limits

    monkeypatch.setattr(attachment_limits, "MAX_AUTO_BODY", 32)
    assert (
        client.post(
            "/auto-routing/sessions", content=b"{}", headers={"Content-Length": "33"}
        ).status_code
        == 413
    )
    assert (
        client.post(
            "/auto-routing/sessions", content=b"{}", headers={"Content-Encoding": "gzip"}
        ).status_code
        == 415
    )
    assert (
        client.post("/auto-routing/sessions", content=iter([b"a" * 20, b"b" * 20])).status_code
        == 413
    )
