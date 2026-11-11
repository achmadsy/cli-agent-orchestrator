"""Workspace resolution must use ownership, never a reusable window label."""
import os
import subprocess
from unittest.mock import MagicMock, patch

import libtmux
import pytest
from cli_agent_orchestrator.clients.tmux import TmuxClient


@pytest.fixture
def client():
    with patch('cli_agent_orchestrator.clients.tmux.libtmux'):
        yield TmuxClient()


def identity_commands(client, rows, owners, *, changed_rows=None, error=False):
    """Model tmux's command queue; never format inherited user options."""
    def command(*args):
        if args[0] == 'list-panes':
            return MagicMock(returncode=0, stderr=[], stdout=rows)
        output = []
        chunks = [[]]
        for arg in args:
            if arg == ';':
                chunks.append([])
            else:
                chunks[-1].append(arg)
        for chunk in chunks:
            if chunk[0] == 'display-message':
                assert chunk[1:3] == ['-t', rows[0].split('\t')[2]]
                output.append(chunk[-1])
            elif chunk[0] == 'show-options':
                assert '-A' not in chunk
                value = owners.get((chunk[1], chunk[3]))
                if value is not None:
                    output.append('@cao_terminal_id ' + value)
            else:
                assert chunk[0] == 'list-panes'
                output.extend(rows if changed_rows is None else changed_rows)
        return MagicMock(returncode=1 if error else 0, stderr=['failed'] if error else [], stdout=output)
    client.server.cmd.side_effect = command


def test_window_anchor_excludes_sibling_terminal(client):
    rows = ['cao-test\t@1\t%2\t/tmp/cao-test.sock', 'cao-test\t@1\t%1\t/tmp/cao-test.sock']
    identity_commands(client, rows, {('-w', '@1'): 'abcdef12', ('-p', '%2'): 'other'})
    result = client.resolve_workspace_target('abcdef12', 'cao-test')
    assert result['pane_id'] == '%1'
    assert result['mode'] == 'window'
    assert client.server.cmd.call_count == 2


def test_pane_target_uses_its_own_stable_id(client):
    identity_commands(client, ['cao-test\t@2\t%7\t/tmp/cao-test.sock'], {('-p', '%7'): 'abcdef12'})
    result = client.resolve_workspace_target('abcdef12', 'cao-test')
    assert result['pane_id'] == '%7' and result['window_id'] == '@2'
    assert result['mode'] == 'pane'


@pytest.mark.parametrize('owners', [{}, {('-w', '@2'): 'abcdef12', ('-p', '%7'): 'abcdef12'}])
def test_missing_or_ambiguous_identity_fails(client, owners):
    identity_commands(client, ['cao-test\t@2\t%7\t/tmp/cao-test.sock'], owners)
    with pytest.raises(ValueError):
        client.resolve_workspace_target('abcdef12', 'cao-test')


def test_personal_session_is_refused_before_scanning(client):
    with pytest.raises(ValueError):
        client.resolve_workspace_target('abcdef12', 'personal')
    client.server.cmd.assert_not_called()


@pytest.mark.parametrize('terminal', ['12345678', 'on', 'off'])
def test_terminal_option_is_not_type_coerced(client, terminal):
    identity_commands(client, ['cao-test\t@2\t%7\t/tmp/cao-test.sock'], {('-p', '%7'): terminal})
    assert client.resolve_workspace_target(terminal, 'cao-test')['terminal'] == terminal


@pytest.mark.parametrize('row', [
    'cao-other\t@2\t%7\t/tmp/cao-test.sock',
    'cao-test\tname\t%7\t/tmp/cao-test.sock',
    'cao-test\t@2\tname\t/tmp/cao-test.sock',
    'cao-test\t@2\t%7\trelative.sock',
    'cao-test\t@2\t%7\t/tmp/cao-test.sock\textra',
])
def test_invalid_identity_listing_fails_before_options(client, row):
    identity_commands(client, [row], {})
    with pytest.raises(ValueError):
        client.resolve_workspace_target('abcdef12', 'cao-test')
    assert client.server.cmd.call_count == 1


@pytest.mark.parametrize('changed', [[], ['cao-test\t@3\t%7\t/tmp/cao-test.sock'], ['cao-test\t@2\t%8\t/tmp/cao-test.sock'], ['cao-test\t@2\t%7\t/tmp/other.sock']])
def test_topology_or_socket_change_fails(client, changed):
    identity_commands(client, ['cao-test\t@2\t%7\t/tmp/cao-test.sock'], {('-p', '%7'): 'abcdef12'}, changed_rows=changed)
    with pytest.raises(ValueError):
        client.resolve_workspace_target('abcdef12', 'cao-test')


def test_partial_command_failure_is_not_authorized(client):
    identity_commands(client, ['cao-test\t@2\t%7\t/tmp/cao-test.sock'], {('-p', '%7'): 'abcdef12'}, error=True)
    with pytest.raises(ValueError):
        client.resolve_workspace_target('abcdef12', 'cao-test')


def test_duplicate_pane_listing_fails(client):
    row = 'cao-test\t@2\t%7\t/tmp/cao-test.sock'
    identity_commands(client, [row, row], {('-p', '%7'): 'abcdef12'})
    with pytest.raises(ValueError):
        client.resolve_workspace_target('abcdef12', 'cao-test')


def test_all_window_panes_foreign_fails(client):
    identity_commands(client, ['cao-test\t@2\t%7\t/tmp/cao-test.sock'], {('-w', '@2'): 'abcdef12', ('-p', '%7'): 'other'})
    with pytest.raises(ValueError):
        client.resolve_workspace_target('abcdef12', 'cao-test')


@pytest.mark.skipif(os.getenv('CAO_TMUX_INTEGRATION') != '1', reason='private tmux opt-in')
def test_real_private_socket_own_options_and_identity_parity(tmp_path):
    socket = str(tmp_path / 'identity.sock')
    env = {key: value for key, value in os.environ.items() if key != 'TMUX'}

    def tmux(*args):
        return subprocess.check_output(
            ['tmux', '-S', socket, *args], env=env, text=True,
            stderr=subprocess.STDOUT, timeout=10,
        ).strip()

    try:
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'cao-test', '/bin/sh')
        tmux('new-session', '-d', '-s', 'personal-sentinel', '/bin/sh')
        real = TmuxClient.__new__(TmuxClient)
        real.server = libtmux.Server(socket_path=socket)
        real.pane_mode = False
        pane_id = tmux('list-panes', '-s', '-t', '=cao-test', '-F', '#{pane_id}')
        window_id = tmux('display-message', '-t', pane_id, '-p', '#{window_id}')

        def resolve():
            return real.resolve_workspace_target('abcdef12', 'cao-test')

        def parity():
            result = resolve()
            assert result == real._resolve_workspace_unbatched('abcdef12', 'cao-test')
            assert result['socket'] == socket
            return result

        # Inherited marks cannot create an owned object.
        tmux('set-option', '-g', '@cao_terminal_id', 'abcdef12')
        with pytest.raises(ValueError):
            resolve()
        tmux('set-option', '-w', '-t', window_id, '@cao_terminal_id', 'abcdef12')
        assert parity()['mode'] == 'window'
        sibling = tmux('split-window', '-d', '-h', '-t', pane_id, '-P', '-F', '#{pane_id}', '/bin/sh')
        tmux('set-option', '-p', '-t', sibling, '@cao_terminal_id', 'other')
        assert parity()['pane_id'] == pane_id

        # Duplicate own marks, even across scopes/windows, refuse authorization.
        tmux('set-option', '-p', '-t', pane_id, '@cao_terminal_id', 'abcdef12')
        with pytest.raises(ValueError):
            resolve()
        tmux('set-option', '-wu', '-t', window_id, '@cao_terminal_id')
        assert parity()['mode'] == 'pane'
        second = tmux('new-window', '-d', '-t', '=cao-test', '-P', '-F', '#{window_id}', '/bin/sh')
        tmux('set-option', '-w', '-t', second, '@cao_terminal_id', 'abcdef12')
        with pytest.raises(ValueError):
            resolve()
        tmux('set-option', '-wu', '-t', second, '@cao_terminal_id')

        # An old lease must differ after the owned pane moves to another window.
        before = resolve()
        tmux('break-pane', '-d', '-s', pane_id, '-t', '=cao-test:')
        assert parity()['window_id'] != before['window_id']
        tmux('rename-session', '-t', '=cao-test', 'cao-renamed')
        with pytest.raises(ValueError):
            resolve()
        assert tmux('has-session', '-t', '=personal-sentinel') == ''
    finally:
        # This socket was created only by this test, never the default server.
        subprocess.run(['tmux', '-S', socket, 'kill-server'], env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=10, check=False)


@pytest.fixture
def observed_target():
    return dict(terminal='abcdef12', session='cao-test', pane_id='%7',
                window_id='@2', socket='/tmp/private.sock', mode='pane')


def test_observe_rejects_changed_target_before_command(client, observed_target):
    client.resolve_workspace_target = MagicMock(return_value={**observed_target, 'pane_id': '%8'})
    with patch('cli_agent_orchestrator.clients.tmux.subprocess.run') as run:
        with pytest.raises(ValueError): client.observe_terminal_exact(observed_target, '/tmp/test.fifo')
        run.assert_not_called()


def test_observe_refuses_unverified_existing_pipe(client, observed_target):
    client.resolve_workspace_target = MagicMock(return_value=observed_target)
    with patch('cli_agent_orchestrator.clients.tmux.subprocess.run', side_effect=[
        MagicMock(stdout='foreign'), MagicMock(stdout='1'),
    ]) as run:
        with pytest.raises(ValueError): client.observe_terminal_exact(observed_target, '/tmp/test.fifo')
        assert run.call_count == 2
        assert not any('pipe-pane' in call.args[0] for call in run.call_args_list)


def test_observe_uses_pinned_socket_and_pane_never_names(client, observed_target):
    client.resolve_workspace_target = MagicMock(return_value=observed_target)
    with patch('cli_agent_orchestrator.clients.tmux.subprocess.run', side_effect=[
        MagicMock(stdout='abcdef12'), MagicMock(stdout='1'), MagicMock(stdout=''),
        MagicMock(stdout=''), MagicMock(stdout=''),
    ]) as run:
        client.observe_terminal_exact(observed_target, '/tmp/test.fifo')
        commands = [c.args[0] for c in run.call_args_list]
        assert all(c[:3] == ['tmux', '-S', '/tmp/private.sock'] for c in commands)
        assert all('%7' in c for c in commands)
        assert sum('pipe-pane' in c for c in commands) == 2
        assert not any('send-keys' in c for c in commands)
