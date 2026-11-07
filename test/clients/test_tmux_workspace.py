"""Workspace resolution must use ownership, never a reusable window label."""
from unittest.mock import MagicMock, patch
import pytest
from cli_agent_orchestrator.clients.tmux import TmuxClient


@pytest.fixture
def client():
    with patch('cli_agent_orchestrator.clients.tmux.libtmux'):
        yield TmuxClient()


def pane(identifier, owner=None):
    obj = MagicMock(pane_id=identifier)
    def command(*args):
        return MagicMock(returncode=0, stderr=[], stdout=[f'@cao_terminal_id {owner}'] if args[0] == 'show-options' and owner else ([] if args[0] == 'show-options' else ['/tmp/cao-test.sock']))
    obj.cmd.side_effect = command
    return obj


def test_window_anchor_excludes_sibling_terminal(client):
    own, foreign = pane('%1'), pane('%2', 'other')
    window = MagicMock(window_id='@1', panes=[foreign, own])
    client._sessions_for_identity_scan = MagicMock(return_value=[MagicMock()])
    client._scan_terminal_identity = MagicMock(return_value=([('window', window)], False))
    result = client.resolve_workspace_target('abcdef12', 'cao-test')
    assert result['pane_id'] == '%1'
    assert result['mode'] == 'window'
    window.kill.assert_not_called()


def test_pane_target_uses_its_own_stable_id(client):
    own = pane('%7', 'abcdef12')
    own.window.window_id = '@2'
    client._sessions_for_identity_scan = MagicMock(return_value=[MagicMock()])
    client._scan_terminal_identity = MagicMock(return_value=([('pane', own)], False))
    result = client.resolve_workspace_target('abcdef12', 'cao-test')
    assert result['pane_id'] == '%7' and result['window_id'] == '@2'
    assert result['mode'] == 'pane'


@pytest.mark.parametrize('matches', [[], [('pane', MagicMock()), ('window', MagicMock())]])
def test_missing_or_ambiguous_identity_fails(client, matches):
    client._sessions_for_identity_scan = MagicMock(return_value=[MagicMock()])
    client._scan_terminal_identity = MagicMock(return_value=(matches, False))
    with pytest.raises(ValueError): client.resolve_workspace_target('abcdef12', 'cao-test')


def test_personal_session_is_refused_before_scanning(client):
    client._sessions_for_identity_scan = MagicMock()
    with pytest.raises(ValueError): client.resolve_workspace_target('abcdef12', 'personal')
    client._sessions_for_identity_scan.assert_not_called()
