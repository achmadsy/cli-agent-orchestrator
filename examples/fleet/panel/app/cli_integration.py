"""Trusted target-side CAO shared-CLI integration contract, no raw adapters."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path

INTEGRATION_KEY = 'cao_shared_cli_v1'
ARTIFACT_NAME = 'cao-harness-integration.py'
PROOF = 'CAO_SHARED_CLI_READY_V1'
REQUIRED_MODULES = {
    'cli_agent_orchestrator/mcp_server/shared.py',
    'cli_agent_orchestrator/mcp_server/shared_client.py',
    'cli_agent_orchestrator/services/harness_mcp_integration.py',
    'cli_agent_orchestrator/models/memory_contracts.py',
}


def helper(manifest, blobs):
    spec = manifest.get('integrations', {}).get(INTEGRATION_KEY)
    if not spec or spec.get('file') != ARTIFACT_NAME:
        raise ValueError('node release lacks required CAO shared CLI integration')
    data = blobs[ARTIFACT_NAME]
    if hashlib.sha256(data).hexdigest() != spec['sha256']:
        raise ValueError('CAO integration checksum mismatch')
    root = Path(__file__).absolute().parent
    path = root / ARTIFACT_NAME
    if path.is_symlink() or path.read_bytes() != data:
        raise ValueError('CAO integration artifact changed')
    loader = importlib.util.spec_from_file_location('cao_harness_integration', path)
    module = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(module)
    return module


def prepare(manifest, blobs, *, home=None):
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(blobs[manifest['wheel']['file']])) as wheel:
        if not REQUIRED_MODULES.issubset(wheel.namelist()):
            raise ValueError('CAO wheel lacks shared client implementation')
        if wheel.read('cli_agent_orchestrator/services/harness_mcp_integration.py') != blobs[ARTIFACT_NAME]:
            raise ValueError('CAO policy helper differs from reviewed wheel')
    module = helper(manifest, blobs)
    home = Path.home() if home is None else Path(home)
    launcher = home / '.local/bin/cao-shared-mcp'
    # Parse/transform all installed CLI config before package/service changes.
    # Missing parser dependencies fail preflight clearly; never skip validation.
    try:
        plan = module.prepare(home, launcher)
        module.prepare_discovery(plan)
    except ImportError:
        raise ValueError('CLI config preflight requires tomlkit/PyYAML in the selected Python; no installation changes made') from None
    for relative in ('.config/cao/cli-integration-receipt.json',):
        path = home / relative
        if os.path.lexists(path): raise ValueError('Existing CAO client state requires controlled update')
    connection_path = home / '.config/cao/mcp-client.json'
    if not connection_path.is_file():
        raise ValueError('Operator must provision a private CAO client connection on the target before Add Machine')
    raw, _, _ = module.read_owned(connection_path)
    if connection_path.stat().st_mode & 0o077:
        raise ValueError('CAO target connection must be private')
    value = json.loads(raw, object_pairs_hook=module.unique_object)
    if (not isinstance(value, dict) or value.get('version') != 1
            or set(value) != {'version', 'central_url', 'local_url', 'central_token', 'local_token'}
            or value.get('central_url') != 'http://100.78.240.36:9889'):
        raise ValueError('Target connection must use the approved central CAO origin')
    for key in ('central_token', 'local_token'):
        token = value.get(key)
        if not isinstance(token, str) or len(token) < 16 or any(c.isspace() for c in token):
            raise ValueError('Invalid private target connection credential')
    return module, plan


def apply(module, plan):
    return module.apply(plan)


def rollback(module, receipt):
    module.rollback(receipt)


def preflight_connection(module, *, home, local_url, local_token):
    """Authenticate only the fixed central origin before package/service writes."""
    import urllib.request
    import urllib.error
    raw, _, _ = module.read_owned(home / '.config/cao/mcp-client.json')
    value = json.loads(raw, object_pairs_hook=module.unique_object)
    if value.get('local_url') != local_url or value.get('local_token') != local_token:
        raise ValueError('Operator target connection does not match the selected node identity')
    if value.get('central_url') != 'http://100.78.240.36:9889':
        raise ValueError('Unapproved central CAO origin')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    for path in ('/health', '/settings/memory', '/internal/code-graph/projects', '/openapi.json'):
        request = urllib.request.Request(value['central_url'] + path,
                    headers={'Authorization': 'Bearer ' + value['central_token']})
        try:
            with opener.open(request, timeout=40) as response:
                data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024: raise ValueError('CAO metadata response exceeds limit')
                payload = json.loads(data)
        except (OSError, ValueError):
            raise ValueError('Shared CAO authentication/metadata preflight failed') from None
        if path == '/health' and payload.get('status') != 'ok':
            raise ValueError('Shared CAO is unhealthy')
        if path == '/settings/memory' and payload.get('enabled') is not True:
            raise ValueError('Hosted CAO memory is disabled')
        if path == '/openapi.json':
            fields = payload.get('components', {}).get('schemas', {}).get('InternalMemoryContext', {}).get('properties', {})
            if 'project_id' not in fields:
                raise ValueError('Central CAO needs shared project identity API before worker provisioning')
