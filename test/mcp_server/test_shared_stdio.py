"""Real stdio MCP initialize/tools/call against a synthetic loopback API.

The foreground harness owns its HTTP/MCP children and tears both down; no model
requests, production config, real memory data or security scans are involved.
"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import sys

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from cli_agent_orchestrator.mcp_server.shared_client import TOOL_NAMES


@asynccontextmanager
async def fake_cao(seen):
    async def handler(reader, writer):
        try:
            header = await reader.readuntil(b'\r\n\r\n')
            lines = header.decode().split('\r\n')
            method, path, _ = lines[0].split(' ')
            headers = dict(line.split(': ', 1) for line in lines[1:] if ': ' in line)
            body = await reader.readexactly(int(headers.get('Content-Length', '0')))
            assert headers.get('Authorization') == 'Bearer synthetic-cao-token'
            seen.append((method, path, json.loads(body) if body else None))
            payload = {'/health': {'status': 'ok'}, '/settings/memory': {'enabled': True},
                       '/internal/code-graph/projects': {'projects': []},
                       '/internal/code-graph/query': {'results': [], 'source_node': 'fixture'},
                       '/internal/memory/recall': {'memories': []}}[path]
            data = json.dumps(payload).encode()
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + str(len(data)).encode() + b'\r\nConnection: close\r\n\r\n' + data)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
    server = await asyncio.start_server(handler, '127.0.0.1', 0)
    try: yield server.sockets[0].getsockname()[1]
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_real_protocol_without_local_fallback(tmp_path):
    seen = []
    async with fake_cao(seen) as port:
        endpoint = f'http://127.0.0.1:{port}'
        connection = tmp_path / 'client.json'
        connection.write_text(json.dumps({'version': 1, 'central_url': endpoint, 'local_url': endpoint,
            'central_token': 'synthetic-cao-token', 'local_token': 'synthetic-cao-token'}))
        connection.chmod(0o600)
        env = {k: v for k, v in os.environ.items() if not any(marker in k for marker in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'CAO_', 'AGENTMEMORY_'))}
        env.update({'CAO_HOME_DIR': str(tmp_path / 'cao'), 'HOME': str(tmp_path)})
        params = StdioServerParameters(command=sys.executable,
            args=['-m', 'cli_agent_orchestrator.mcp_server.shared', '--connection', str(connection)],
            cwd=str(Path(__file__).resolve().parents[2]), env=env)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                result = await session.initialize()
                assert result.serverInfo.name == 'cao-mcp-server'
                assert {tool.name for tool in (await session.list_tools()).tools} == TOOL_NAMES
                denied = await session.call_tool('send_message', {'message': 'must not run'})
                assert denied.isError
                projects = await session.call_tool('codebase_projects', {})
                assert not projects.isError
                recall = await session.call_tool('memory_recall', {'scope': 'project', 'query': 'synthetic'})
                assert not recall.isError
                assert json.loads(recall.content[0].text)['memories'] == []
    assert any(path == '/internal/memory/recall' and body['terminal_context'].get('project_id') for _, path, body in seen)
    assert not (tmp_path / 'cao/db').exists()
