"""Bound Auto launch JSON before framework parsing; never echo upload bytes."""

import threading

import anyio
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from cli_agent_orchestrator.services.terminal_attachment_service import MAX_AUTO_BODY

UPLOAD_TIMEOUT = 180


class AutoAttachmentBodyLimit:
    """Two bounded request bodies at a time, including chunked requests."""

    def __init__(self, app: ASGIApp):
        self.app = app
        self.slots = threading.BoundedSemaphore(2)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path", "").rstrip("/") != "/auto-routing/sessions"
        ):
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        encoding = headers.get(b"content-encoding", b"identity").lower()
        if encoding != b"identity":
            return await JSONResponse(
                {"detail": "Compressed Auto launch bodies are not supported."}, 415
            )(scope, receive, send)
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_AUTO_BODY:
            return await JSONResponse(
                {"detail": "Auto launch request exceeds its size limit."}, 413
            )(scope, receive, send)
        if not self.slots.acquire(blocking=False):
            return await JSONResponse(
                {"detail": "Auto launch uploads are busy. Retry shortly."}, 429
            )(scope, receive, send)
        try:
            body = bytearray()
            deadline = anyio.current_time() + UPLOAD_TIMEOUT
            while True:
                try:
                    with anyio.fail_after(max(0, deadline - anyio.current_time())):
                        message = await receive()
                except TimeoutError:
                    return await JSONResponse({"detail": "Auto upload timed out."}, 408)(
                        scope, receive, send
                    )
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                if len(body) + len(chunk) > MAX_AUTO_BODY:
                    return await JSONResponse(
                        {"detail": "Auto launch request exceeds its size limit."}, 413
                    )(scope, receive, send)
                body.extend(chunk)
                if not message.get("more_body", False):
                    break
            payload = bytes(body)
            del body
            supplied = False

            async def replay():
                nonlocal supplied, payload
                if not supplied:
                    supplied = True
                    message = {"type": "http.request", "body": payload, "more_body": False}
                    payload = b""
                    return message
                return await receive()

            await self.app(scope, replay, send)
        finally:
            self.slots.release()
