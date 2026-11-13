"""Approved connection-file routing: node credentials never cross origins."""
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from cli_agent_orchestrator.mcp_server import shared_client
from cli_agent_orchestrator.services import memory_gateway, code_graph_gateway


@pytest.fixture
def configured(tmp_path, monkeypatch):
    path = tmp_path / 'connection.json'
    path.write_text(json.dumps({'version': 1, 'central_url': 'http://100.64.0.10:9889',
        'local_url': 'http://127.0.0.1:9889', 'central_token': 'synthetic-central-token',
        'local_token': 'synthetic-local-token'}))
    path.chmod(0o600)
    monkeypatch.setenv('CAO_SHARED_CONNECTION_FILE', str(path))
    monkeypatch.setattr(shared_client, '_connection', None)
    return path


def test_memory_gateway_uses_operator_connection_not_node_bearer(configured):
    with patch.object(shared_client.Connection, 'request', return_value={'memories': []}) as request:
        assert memory_gateway._post('/internal/memory/recall', {}) == {'memories': []}
    assert request.call_args.args == ('POST', '/internal/memory/recall')


def test_codebase_gateway_refuses_endpoint_override(configured):
    with patch.object(shared_client.Connection, 'request', return_value={'projects': []}) as request:
        with pytest.raises(RuntimeError, match='approved'):
            code_graph_gateway._request('http://100.64.0.11:9889', '/internal/code-graph/projects')
        request.assert_not_called()
        assert code_graph_gateway._request('http://100.64.0.10:9889', '/internal/code-graph/projects') == {'projects': []}
    assert request.call_args.args == ('GET', '/internal/code-graph/projects')
