"""Synthetic operator-preprovisioned connections; never export real bearers."""
import io
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from app import cli_integration as integration
from cli_agent_orchestrator.services import harness_mcp_integration as helper
from test.test_node_release import sample_bundle


@pytest.fixture
def target(tmp_path, monkeypatch):
    payload = tmp_path / 'payload'; payload.mkdir(mode=0o700)
    _, manifest = sample_bundle(payload, with_adapter=False)
    blobs = {spec['file']: (payload / spec['file']).read_bytes()
             for spec in [manifest['wheel'], *manifest['integrations'].values()]}
    home = tmp_path / 'home'; home.mkdir(mode=0o700)
    path = home / '.config/cao/mcp-client.json'; path.parent.mkdir(parents=True, mode=0o700)
    value = {'version': 1, 'central_url': 'http://100.78.240.36:9889', 'local_url': 'http://100.64.0.42:9889',
             'central_token': 'synthetic-central-token', 'local_token': 'synthetic-local-token'}
    path.write_text(json.dumps(value)); path.chmod(0o600)
    monkeypatch.setattr(integration, 'helper', lambda *a: helper)
    monkeypatch.setattr(helper.shutil, 'which', lambda *a: None)
    return home, path, value, manifest, blobs


def test_prepare_keeps_operator_connection_and_creates_no_files(target):
    home, path, value, manifest, blobs = target
    before = path.read_bytes()
    module, plan = integration.prepare(manifest, blobs, home=home)
    assert module is helper
    assert path.read_bytes() == before
    assert not (home / '.claude.json').exists()
    assert not any('agentmemory' in str(c['path']) for c in plan['changes'])


@pytest.mark.parametrize('change', ['absent', 'mode', 'central', 'duplicate'])
def test_bad_connection_refused(target, change):
    home, path, value, manifest, blobs = target
    if change == 'absent': path.unlink()
    elif change == 'mode': path.chmod(0o644)
    elif change == 'central':
        value['central_url'] = 'http://other:9889'; path.write_text(json.dumps(value))
    else: path.write_text('{"version":1,"version":1}')
    with pytest.raises(ValueError): integration.prepare(manifest, blobs, home=home)


def test_metadata_proof_routes_only_to_fixed_origin(target, monkeypatch):
    home, path, value, *_ = target
    seen = []
    class Response:
        def __init__(self, payload): self.payload = payload
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def read(self, *a): return json.dumps(self.payload).encode()
    class Opener:
        def open(self, request, **kwargs):
            seen.append(request)
            assert request.full_url.startswith(value['central_url'] + '/')
            assert request.headers['Authorization'] == 'Bearer synthetic-central-token'
            return Response({'/health': {'status': 'ok'}, '/settings/memory': {'enabled': True},
                '/internal/code-graph/projects': {'projects': []},
                '/openapi.json': {'components': {'schemas': {'InternalMemoryContext': {'properties': {'project_id': {}}}}}}}[request.full_url[len(value['central_url']):]])
    import urllib.request
    monkeypatch.setattr(urllib.request, 'build_opener', lambda *a: Opener())
    integration.preflight_connection(helper, home=home, local_url=value['local_url'], local_token=value['local_token'])
    assert len(seen) == 4
    with pytest.raises(ValueError, match='identity'):
        integration.preflight_connection(helper, home=home, local_url=value['local_url'], local_token='wrong-local-token')
    assert len(seen) == 4
