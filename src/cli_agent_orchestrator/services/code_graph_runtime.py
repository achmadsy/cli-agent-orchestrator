"""Lifecycle task publishing current local Codebase Memory indexes."""

from __future__ import annotations

import asyncio
import logging
import os

from cli_agent_orchestrator.services.code_graph_coordinator import refresh_local_registry
from cli_agent_orchestrator.services.code_graph_gateway import publish_heartbeat, remote_code_graph_url

logger = logging.getLogger(__name__)


async def code_graph_heartbeat_loop() -> None:
    interval = max(15, int(os.getenv("CAO_CODEBASE_HEARTBEAT_SECONDS", "60")))
    while True:
        try:
            heartbeat = await refresh_local_registry()
            if remote_code_graph_url():
                await publish_heartbeat(heartbeat.model_dump(mode="json"))
            logger.debug(
                "Code graph heartbeat published: node=%s projects=%d",
                heartbeat.node_id,
                len(heartbeat.projects),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Code graph heartbeat failed (%s)", type(exc).__name__)
        await asyncio.sleep(interval)
