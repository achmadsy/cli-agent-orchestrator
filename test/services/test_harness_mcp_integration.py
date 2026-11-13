import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
import tomlkit
import yaml

from cli_agent_orchestrator.services import harness_mcp_integration as integration

LAUNCHER = '/home/fixture/.local/bin/cao-shared-mcp'
OLD = {'command': '/home/fixture/.local/bin/codebase-memory-mcp'}


@pytest.mark.parametrize('text', ['{}', '{"keep":1}', '{"keep":1,}', '{/*comment*/"keep":1 // tail\n}', '{"keep":1 /* tail */, /*last*/}'])
def test_jsonc_insert_preserves_unrelated(text):
    updated = integration.JsonDocument(text).updated({'mcp': {'test': True}})
    assert integration.JsonDocument(updated).value['mcp'] == {'test': True}
    assert '"keep":1' in updated if 'keep' in text else True


def test_claude_capture_cleanup_preserves_other_hooks_and_secrets():
    value = {'env': {'AGENTMEMORY_SECRET': 'old', 'OTHER': 'keep'}, 'permissions': {'allow': ['Read']},
             'hooks': {'SessionStart': [{'hooks': [
                 {'command': '"$HOME/.claude/hooks/cbm-session-reminder"'},
                 {'command': 'node "/fixture/node_modules/@agentmemory/agentmemory/plugin/scripts/session-start.mjs"'},
                 {'command': 'unrelated-command'}]}]}}
    updated = json.loads(integration.transform('claude-settings', json.dumps(value).encode(), LAUNCHER))
    assert updated['permissions'] == value['permissions']
    assert updated['env'] == {'OTHER': 'keep'}
    assert updated['hooks']['SessionStart'][0]['hooks'] == [{'command': 'unrelated-command'}]


@pytest.mark.parametrize('kind', ['claude', 'opencode', 'mimo', 'codex', 'hermes', 'strix'])
def test_native_schemas_and_idempotence(kind):
    if kind == 'codex': data = ('# keep comment\n[tui]\nkeep=true\n[mcp_servers.codebase-memory-mcp]\ncommand="/bin/codebase-memory-mcp"\n').encode()
    elif kind == 'hermes': data = b'# keep comment\nmodel: keep\nmcp_servers:\n  codebase-memory-mcp:\n    command: /bin/codebase-memory-mcp\nhooks:\n  pre_llm_call:\n    - id: codebase-memory-mcp\n      command: "\'/bin/codebase-memory-mcp\' hook-augment --dialect hermes"\nplugins:\n  enabled: [mood_reply]\n'
    elif kind == 'strix': data = json.dumps([{'name': 'codebase-memory-mcp', 'transport': 'stdio', **OLD}, {'name': 'other', 'transport': 'stdio', 'command': '/bin/other'}]).encode()
    else:
        key = 'mcpServers' if kind == 'claude' else 'mcp'
        old = {'type': 'local', 'command': [OLD['command']]} if kind != 'claude' else OLD
        data = ('{/*keep comment*/"provider":{"keep":true},"' + key + '":' + json.dumps({'codebase-memory-mcp': old, 'other': {'command': '/bin/other'}}) + '}').encode()
    updated = integration.transform(kind, data, LAUNCHER)
    assert b'codebase-memory-mcp' not in updated
    assert LAUNCHER.encode() in updated
    assert integration.transform(kind, updated, LAUNCHER) == updated
    if kind == 'codex': assert tomlkit.parse(updated.decode())['tui']['keep'] is True
    elif kind == 'hermes':
        parsed = yaml.safe_load(updated)
        assert parsed['plugins'] == {'enabled': ['mood_reply']}
        assert parsed['hooks']['pre_llm_call'] == []
    elif kind != 'strix': assert b'"provider":{"keep":true}' in updated
    if kind != 'strix': assert b'keep comment' in updated


@pytest.mark.parametrize('kind,data', [('claude', b'{"a":1,"a":2}'), ('hermes', b'model: a\nmodel: b\n'), ('codex', b'a=1\na=2\n'), ('strix', b'[{"name":"a"},{"name":"a"}]')])
def test_duplicate_config_refused(kind, data):
    with pytest.raises(Exception): integration.transform(kind, data, LAUNCHER)


def test_unknown_alias_or_unfamiliar_identity_refused():
    with pytest.raises(ValueError, match='review'):
        integration.remove_old_servers({'alias': OLD})
    with pytest.raises(ValueError, match='review'):
        integration.remove_old_servers({'agentmemory': {'command': '/bin/not-agentmemory'}})


def prepare(home):
    return integration.prepare(home, Path(LAUNCHER), installed={name: True for name in ['claude', 'codex', 'opencode', 'hermes', 'mimo', 'strix']})


def test_transaction_exact_backup_rollback_and_no_shared_skill_edits(tmp_path):
    home = tmp_path / 'home'; home.mkdir(mode=0o700)
    config = home / '.claude.json'; config.write_bytes(b'{"keep": 1}\n'); config.chmod(0o640)
    shared = home / '.agents/skills/remember/SKILL.md'; shared.parent.mkdir(parents=True); shared.write_bytes(b'unchanged upstream')
    receipt = integration.apply(prepare(home))
    assert config.read_bytes() != b'{"keep": 1}\n'
    assert shared.read_bytes() == b'unchanged upstream'
    assert prepare(home)['changes'] == []
    integration.rollback(receipt)
    assert config.read_bytes() == b'{"keep": 1}\n' and config.stat().st_mode & 0o777 == 0o640
    assert not (home / '.codex').exists()
    assert shared.read_bytes() == b'unchanged upstream'


def test_rollback_preserves_intervening_edits(tmp_path):
    receipt = integration.apply(prepare(tmp_path))
    target = Path(receipt['changes'][-1]['path']); target.write_bytes(b'user edit')
    with pytest.raises(ValueError, match='changed'): integration.rollback(receipt)
    assert target.read_bytes() == b'user edit'


@pytest.mark.parametrize('kind', ['symlink', 'hardlink', 'fifo', 'parent-link', 'changed'])
def test_preflight_safety(tmp_path, kind):
    path = tmp_path / '.claude.json'
    if kind == 'symlink': path.symlink_to(tmp_path / 'outside')
    elif kind == 'hardlink':
        path.write_text('{}'); os.link(path, tmp_path / 'other')
    elif kind == 'fifo': os.mkfifo(path)
    elif kind == 'parent-link':
        directory = tmp_path / '.codex'; directory.symlink_to(tmp_path / 'outside')
    else:
        path.write_text('{}'); plan = prepare(tmp_path); path.write_text('{"changed":true}')
        with pytest.raises(ValueError, match='changed'): integration.apply(plan)
        return
    with pytest.raises((ValueError, OSError)): prepare(tmp_path)


def test_quarantine_symlink_preserves_shared_source(tmp_path):
    shared = tmp_path / 'shared/SKILL.md'; shared.parent.mkdir(mode=0o700); shared.write_bytes(b'upstream')
    link = tmp_path / 'skill'; link.symlink_to(shared.parent)
    plan = {'home': str(tmp_path), 'changes': [], 'quarantines': [], 'examined': [], 'limitations': []}
    integration.quarantine(plan, link)
    receipt = integration.apply(plan)
    assert not link.is_symlink() and shared.read_bytes() == b'upstream'
    integration.rollback(receipt)
    assert link.is_symlink() and shared.read_bytes() == b'upstream'


def test_multiple_jsonc_additions_and_guidance_preserve_route_rules():
    document = integration.JsonDocument('{"keep":true}\n')
    assert integration.JsonDocument(document.updated({'a': 1, 'b': 2})).value == {'keep': True, 'a': 1, 'b': 2}
    source = '# Rules\nSTRICT STOP, never kill tmux\nUse `memory_smart_search` and `codebase-memory-mcp` `search_graph`.\n'
    converted = integration.knowledge_instructions(source)
    assert 'STRICT STOP, never kill tmux' in converted
    assert '`memory_recall`' in converted and '`codebase_search_graph`' in converted
    assert 'memory_smart_search' not in converted


def test_discovery_overrides_preserve_shared_source_and_are_idempotent(tmp_path):
    shared = tmp_path / '.agents/skills/remember/SKILL.md'
    shared.parent.mkdir(parents=True, mode=0o700)
    shared.write_text('---\nname: remember\n---\nUse agentmemory memory_save.\n')
    plan = prepare(tmp_path)
    integration.prepare_discovery(plan)
    receipt = integration.apply(plan)
    override = tmp_path / '.config/opencode/skills/remember/SKILL.md'
    assert 'cao-mcp-server' in override.read_text() and 'memory_save' not in override.read_text()
    assert 'memory_save' in shared.read_text()
    second = prepare(tmp_path)
    integration.prepare_discovery(second)
    assert second['changes'] == [] and second['quarantines'] == []
    integration.rollback(receipt)
    assert not override.exists() and shared.exists()


def test_global_settings_remove_permissions_with_hooks_in_one_pass(tmp_path):
    home = tmp_path / 'home'; home.mkdir(mode=0o700)
    settings = home / '.claude/settings.json'; settings.parent.mkdir(mode=0o700)
    original = {
        'env': {'AGENTMEMORY_SECRET': 'retired', 'OTHER': 'keep'},
        'hooks': {'SessionStart': [{'hooks': [
            {'command': '"$HOME/.claude/hooks/cbm-session-reminder"'},
            {'command': 'unrelated-command'}]}]},
        'permissions': {
            'allow': ['Read', 'mcp__agentmemory__memory_recall',
                      'mcp__codebase-memory-mcp__search_graph',
                      'Bash(/bin/codebase-memory-mcp status)',
                      'mcp__cao-mcp-server__codebase_projects'],
            'deny': ['Edit(/protected/**)'],
            'defaultMode': 'default',
        },
    }
    settings.write_text(json.dumps(original))
    plan = prepare(home)
    integration.prepare_project_scopes(plan, [home])
    assert sum(c['path'] == str(settings) for c in plan['changes']) == 1
    receipt = integration.apply(plan)
    cleaned = json.loads(settings.read_text())
    assert cleaned['permissions'] == {
        'allow': ['Read', 'mcp__cao-mcp-server__codebase_projects'],
        'deny': ['Edit(/protected/**)'], 'defaultMode': 'default',
    }
    assert cleaned['env'] == {'OTHER': 'keep'}
    assert cleaned['hooks']['SessionStart'][0]['hooks'] == [{'command': 'unrelated-command'}]
    second = prepare(home)
    integration.prepare_project_scopes(second, [home])
    assert second['changes'] == []
    integration.rollback(receipt)
    assert json.loads(settings.read_text()) == original


def test_private_group_ancestor_check(tmp_path):
    parent = tmp_path / 'group-dir'; parent.mkdir(mode=0o775); parent.chmod(0o775)
    with patch.object(integration, 'private_group', return_value=False):
        with pytest.raises(ValueError, match='Writable'): integration.safe_path(parent / 'config')
    with patch.object(integration, 'private_group', return_value=True): integration.safe_path(parent / 'config')


def test_partial_failure_rolls_back(tmp_path):
    plan = prepare(tmp_path)
    real = integration.atomic
    def fail(path, *args):
        if str(path).endswith('/.codex/config.toml'): raise OSError('fixture failure')
        return real(path, *args)
    with patch.object(integration, 'atomic', fail):
        with pytest.raises(OSError): integration.apply(plan)
    assert not (tmp_path / '.claude.json').exists()
