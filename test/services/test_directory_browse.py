"""Read-only directory explorer contract using synthetic folders."""
from pathlib import Path
from unittest.mock import patch

import pytest

from cli_agent_orchestrator.services.workspace_mcp_service import WorkspaceMcpService


def test_paging_filter_sort_and_no_mutation(tmp_path):
    folder = tmp_path / 'workspace'
    folder.mkdir()
    for name in ['zebra', 'Beta', 'alpha', '.hidden']:
        (folder / name).mkdir()
    (folder / 'file.txt').write_text('not read')
    service = WorkspaceMcpService(tmp_path / 'state')
    with patch('subprocess.run', side_effect=AssertionError('No shell/tmux')):
        first = service.browse_directories(str(folder), limit=2)
        assert [x['name'] for x in first['directories']] == ['alpha', 'Beta']
        assert first['next_offset'] == 2 and first['total'] == 3
        last = service.browse_directories(str(folder), offset=2, limit=2)
        assert [x['name'] for x in last['directories']] == ['zebra']
        assert last['next_offset'] is None
        filtered = service.browse_directories(str(folder), query='BET')
        assert [x['name'] for x in filtered['directories']] == ['Beta']
        assert not service._registry_path.exists()


def test_sensitive_symlinks_hidden_targets_and_parent_not_offered(tmp_path):
    (tmp_path / 'safe').mkdir()
    (tmp_path / 'system-link').symlink_to('/etc', target_is_directory=True)
    (tmp_path / '.private').mkdir()
    (tmp_path / 'private-link').symlink_to(tmp_path / '.private', target_is_directory=True)
    (tmp_path / 'loop').symlink_to(tmp_path / 'loop')
    service = WorkspaceMcpService(tmp_path / 'state')
    result = service.browse_directories(str(tmp_path))
    assert not {'system-link', 'private-link', 'loop'} & {x['name'] for x in result['directories']}
    # A synthetic top-level tmp descendant cannot advertise forbidden /tmp.
    with patch('cli_agent_orchestrator.services.workspace_mcp_service._canonicalize') as canonical:
        def resolve(path):
            value = Path(path)
            if value in (Path('/tmp'), Path('/')): raise ValueError('forbidden')
            return tmp_path if value == tmp_path else value
        canonical.side_effect = resolve
        # Existing ancestors remain subject to validation on every request.
        service.browse_directories(str(tmp_path))
    with pytest.raises(ValueError): service.browse_directories('/etc')
    with pytest.raises(ValueError): service.browse_directories(str(tmp_path / 'system-link'))


def test_nonexistent_unreadable_and_huge_listing(tmp_path):
    service = WorkspaceMcpService(tmp_path / 'state')
    with pytest.raises(ValueError): service.browse_directories(str(tmp_path / 'missing'))
    with patch('cli_agent_orchestrator.services.workspace_mcp_service.os.access', return_value=False):
        with pytest.raises(PermissionError, match='cannot be listed'):
            service.browse_directories(str(tmp_path))
    from contextlib import contextmanager
    class Hidden:
        name = '.hidden'
    @contextmanager
    def huge(*args): yield iter([Hidden()] * 10001)
    with patch('cli_agent_orchestrator.services.workspace_mcp_service.os.scandir', huge):
        with pytest.raises(ValueError, match='too many entries'):
            service.browse_directories(str(tmp_path))


@pytest.mark.parametrize('options', [{'offset': -1}, {'limit': 0}, {'limit': 501}, {'query': 'a' * 256}])
def test_invalid_range(tmp_path, options):
    with pytest.raises(ValueError): WorkspaceMcpService(tmp_path / 'state').browse_directories(str(tmp_path), **options)
