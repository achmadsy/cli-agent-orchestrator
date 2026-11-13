"""Transactional CLI-only MCP configuration. No harness starts, DBs or indexing.

Inventory/prepare are read-only. Apply uses exact snapshots and private backups;
rollback never overwrites intervening edits. Shared by local setup and installer.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import tempfile
import uuid

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate configuration key')
        result[key] = value
    return result

SERVER = "cao-mcp-server"
MAX_FILE = 16 * 1024 * 1024
OLD_SERVERS = {"agentmemory": "agentmemory-mcp", "codebase-memory-mcp": "codebase-memory-mcp"}
GUIDANCE = """# CAO shared knowledge

Use only `cao-mcp-server` for persistent memory and codebase discovery.
Before nontrivial work use `memory_recall`; save settled decisions/preferences
with `memory_store`. Never store credentials. `memory_forget` needs explicit
confirmation. These tools use the shared CAO host, not a local memory store.
For structural questions start with `codebase_projects` / `codebase_status`, then
`codebase_search_graph`, `codebase_trace_path`, and `codebase_get_code_snippet`.
Check `codebase_check_index_coverage` for all evidence paths; read local source
for gaps/staleness. Do not claim completeness from a clean coverage response.
Use source search if CAO is unavailable; do not install raw upstream MCPs/hooks.
Manual CLI launches use their cwd for project scope. Session/agent scopes need a
real CAO terminal. Do not fabricate identities. Do not index without permission.
"""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def snapshot(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def private_group(gid: int) -> bool:
    """Accept owner-private primary groups, not group-writable shared trees."""
    import grp
    import pwd
    uid = os.getuid()
    if gid != os.getgid(): return False
    try:
        own = pwd.getpwuid(uid).pw_name
        return (not (set(grp.getgrgid(gid).gr_mem) - {own, 'root'})
                and not any(user.pw_gid == gid and user.pw_uid not in (0, uid) for user in pwd.getpwall()))
    except KeyError:
        return False


def safe_path(path: Path):
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Absolute integration path required")
    for parent in (path.parent, *path.parent.parents):
        if not parent.exists():
            if parent.is_symlink(): raise ValueError("Symlink integration ancestor")
            continue
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()):
            raise ValueError("Unsafe integration ancestor")
        sticky_root = info.st_uid == 0 and info.st_mode & stat.S_ISVTX
        unsafe_write = info.st_mode & 0o002 or (info.st_mode & 0o020 and not private_group(info.st_gid))
        if unsafe_write and not sticky_root:
            raise ValueError("Writable integration ancestor")


def read_owned(path: Path):
    safe_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > MAX_FILE:
            raise ValueError("Integration config must be an owned regular single-link file")
        with os.fdopen(fd, "rb", closefd=False) as stream: data = stream.read(MAX_FILE + 1)
        if len(data) > MAX_FILE or snapshot(info) != snapshot(path.lstat()):
            raise ValueError("Integration config changed during read")
        return data, snapshot(info), stat.S_IMODE(info.st_mode)
    finally:
        os.close(fd)


class JsonDocument:
    """Small strict JSONC reader with value spans for surgical top-level edits.

    Supports comments/trailing commas, not arbitrary JS or JSON5. Duplicate keys
    at every depth are rejected; unrelated source text/comments stay untouched.
    """
    def __init__(self, text):
        self.text = text
        self.index = 0
        self.top = {}
        self.value = self.parse(())
        self.close = self.index - 1
        self.space()
        if self.index != len(text) or not isinstance(self.value, dict):
            raise ValueError("Expected one JSON object")

    def space(self):
        while self.index < len(self.text):
            if self.text[self.index].isspace(): self.index += 1
            elif self.text.startswith('//', self.index):
                end = self.text.find('\n', self.index)
                self.index = len(self.text) if end < 0 else end
            elif self.text.startswith('/*', self.index):
                end = self.text.find('*/', self.index + 2)
                if end < 0: raise ValueError("Unclosed JSONC comment")
                self.index = end + 2
            else: break

    def parse(self, path):
        self.space()
        if self.index >= len(self.text): raise ValueError("Truncated JSONC")
        token = self.text[self.index]
        if token in '{[':
            mapping = token == '{'
            close = '}' if mapping else ']'
            self.index += 1
            value = {} if mapping else []
            self.space()
            while self.index < len(self.text) and self.text[self.index] != close:
                if mapping:
                    key, end = json.JSONDecoder().raw_decode(self.text, self.index)
                    if not isinstance(key, str) or key in value: raise ValueError("Duplicate/invalid JSONC key")
                    self.index = end
                    self.space()
                    if self.text[self.index:self.index+1] != ':': raise ValueError("Expected JSONC colon")
                    self.index += 1
                else: key = len(value)
                self.space()
                start = self.index
                child = self.parse((*path, key))
                if mapping: value[key] = child
                else: value.append(child)
                if not path and mapping: self.top[key] = (start, self.index)
                self.space()
                if self.text[self.index:self.index+1] != ',': break
                self.index += 1
                self.space()
            if self.text[self.index:self.index+1] != close: raise ValueError("Invalid JSONC container")
            self.index += 1
            return value
        value, self.index = json.JSONDecoder().raw_decode(self.text, self.index)
        if isinstance(value, float) and not __import__('math').isfinite(value): raise ValueError("Invalid JSON number")
        return value

    def updated(self, values):
        text = self.text
        changes = []
        additions = []
        for key, value in values.items():
            if key in self.top:
                if self.value[key] != value:
                    start, end = self.top[key]
                    changes.append((start, end, json.dumps(value, indent=2, ensure_ascii=False)))
            else:
                # Insert before the final object close; a leading comma is
                # required unless the object was empty or had a trailing comma.
                end = self.close
                # Parse position of last value, ignoring intervening comments.
                separator = ''
                if self.top:
                    last_end = max(end for _, end in self.top.values())
                    suffix = self.text[last_end:end]
                    suffix = re.sub(r'/\*.*?\*/|//[^\n]*', '', suffix, flags=re.S)
                    separator = '' if ',' in suffix else ','
                additions.append(json.dumps(key) + ': ' + json.dumps(value, indent=2))
        if additions:
            changes.append((self.close, self.close, separator + '\n' + ',\n'.join(additions) + '\n'))
        for start, end, replacement in sorted(changes, reverse=True): text = text[:start] + replacement + text[end:]
        JsonDocument(text)  # validate the result before it can become a write plan
        return text


def yaml_parse(text):
    import yaml
    class UniqueYamlLoader(yaml.SafeLoader):
        pass
    def mapping(loader, node, deep=False):
        return unique_object(loader.construct_pairs(node, deep=deep))
    UniqueYamlLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    return yaml.load(text, Loader=UniqueYamlLoader)


def remove_old_servers(mapping):
    if not isinstance(mapping, dict): raise ValueError("MCP server map must be an object")
    value = copy.deepcopy(mapping)
    for name, executable in OLD_SERVERS.items():
        entry = value.get(name)
        if entry is None: continue
        if not isinstance(entry, dict): raise ValueError("Unfamiliar memory MCP entry")
        command = entry.get('command')
        if isinstance(command, list): command = command[0] if command else ''
        if not isinstance(command, str) or Path(command).name != executable:
            raise ValueError("Memory MCP identity requires operator review")
        del value[name]
    # A raw engine under an unexpected alias is ambiguous, never silently left.
    for name, entry in value.items():
        if not isinstance(entry, dict): continue
        command = entry.get('command')
        if isinstance(command, list): command = command[0] if command else ''
        if isinstance(command, str) and Path(command).name in OLD_SERVERS.values():
            raise ValueError("Aliased standalone memory MCP requires operator review")
    return value


def register(mapping, entry, launcher):
    value = remove_old_servers(mapping)
    previous = value.get(SERVER)
    if previous is not None and previous != entry:
        command = previous.get('command') if isinstance(previous, dict) else None
        if isinstance(command, list): command = command[0] if command else ''
        if not isinstance(command, str) or Path(command).name not in ('cao-mcp-server', Path(launcher).name):
            raise ValueError("Existing CAO server ownership is ambiguous")
    value[SERVER] = entry
    return value


def standalone_hook(command):
    if not isinstance(command, str): return False
    try: args = shlex.split(command)
    except ValueError: raise ValueError("Unparseable hook command") from None
    if len(args) == 1 and Path(args[0]).name in {
        'cbm-code-discovery-gate', 'cbm-session-reminder', 'cbm-subagent-reminder'}:
        return True
    if len(args) == 2 and args[0] == 'node' and re.fullmatch(
        r'.*/node_modules/@agentmemory/agentmemory/plugin/scripts/[a-z-]+\.mjs', args[1]): return True
    return False


def clean_claude_settings(value):
    result = copy.deepcopy(value)
    if 'env' in result:
        result['env'] = {k: v for k, v in result['env'].items() if not k.startswith('AGENTMEMORY_')}
    if 'hooks' in result:
        events = {}
        for event, groups in result['hooks'].items():
            remaining = []
            for group in groups:
                new = dict(group)
                new['hooks'] = [hook for hook in group['hooks'] if not standalone_hook(hook.get('command'))]
                if new['hooks']: remaining.append(new)
            if remaining: events[event] = remaining
        result['hooks'] = events
    for kind, entries in result.get('permissions', {}).items():
        if isinstance(entries, list):
            result['permissions'][kind] = [entry for entry in entries if not (
                isinstance(entry, str) and (entry.startswith(('mcp__agentmemory__', 'mcp__codebase-memory-mcp__'))
                or re.fullmatch(r'Bash\([^\n]*(?:/codebase-memory-mcp|/agentmemory(?:-mcp)?|@agentmemory/agentmemory)[^\n]*\)', entry)))]
    return result


def transform(kind, data: bytes, launcher: str) -> bytes:
    text = data.decode('utf-8')
    stdio = {'command': launcher, 'args': []}
    if kind == 'codex':
        import tomlkit
        value = tomlkit.parse(text)
        value['mcp_servers'] = register(value.get('mcp_servers', {}).unwrap() if 'mcp_servers' in value else {}, stdio, launcher)
        return tomlkit.dumps(value).encode()
    if kind == 'hermes':
        import yaml
        value = yaml_parse(text) or {}
        if not isinstance(value, dict): raise ValueError('Hermes config must be a mapping')
        updated = {'mcp_servers': register(value.get('mcp_servers', {}), stdio, launcher)}
        skills = copy.deepcopy(value.get('skills') or {})
        platform_disabled = skills.setdefault('platform_disabled', {})
        disabled = platform_disabled.setdefault('cli', [])
        for name in sorted(STANDALONE_SKILLS):
            if name not in disabled: disabled.append(name)
        updated['skills'] = skills
        if 'hooks' in value:
            hooks = copy.deepcopy(value['hooks'])
            for event, items in hooks.items():
                kept = []
                for item in items:
                    if item.get('id') == 'codebase-memory-mcp':
                        args = shlex.split(item.get('command', ''))
                        if not args or Path(args[0]).name != 'codebase-memory-mcp' or args[1:] != ['hook-augment', '--dialect', 'hermes']:
                            raise ValueError('Unfamiliar Hermes memory hook')
                    else: kept.append(item)
                hooks[event] = kept
            updated['hooks'] = hooks
        # YAML node spans preserve all unrelated top-level blocks and comments.
        tree = yaml.compose(text)
        spans = {key.value: (val.start_mark.index, val.end_mark.index) for key, val in tree.value} if tree else {}
        replacements = []
        for key, new in updated.items():
            if value.get(key) == new: continue
            rendered = yaml.safe_dump({key: new}, sort_keys=False, allow_unicode=True)
            if key not in spans:
                text += '\n' + rendered
            else:
                start, end = spans[key]
                # Replace the value only (keeping its existing key line).
                replacement = '\n' + '\n'.join('  ' + line if line else '' for line in yaml.safe_dump(new, sort_keys=False, allow_unicode=True).rstrip().splitlines()) + '\n'
                replacements.append((start, end, replacement))
        for start, end, new in sorted(replacements, reverse=True): text = text[:start] + new + text[end:]
        yaml_parse(text)
        return text.encode()
    if kind == 'strix':
        value = json.loads(text, object_pairs_hook=unique_object)
        if not isinstance(value, list): raise ValueError('Strix MCP config must be an array')
        names = [item.get('name') for item in value if isinstance(item, dict)]
        if len(names) != len(value) or len(set(names)) != len(names): raise ValueError('Duplicate/invalid Strix server')
        mapping = register({item['name']: {k:v for k,v in item.items() if k != 'name'} for item in value},
                           {'transport': 'stdio', **stdio}, launcher)
        return (json.dumps([{'name': name, **entry} for name, entry in mapping.items()], indent=2) + '\n').encode()
    document = JsonDocument(text or '{}\n')
    value = document.value
    if kind == 'claude-settings':
        updated = clean_claude_settings(value)
        return document.updated({k: updated[k] for k in ('env', 'hooks', 'permissions') if k in updated}).encode()
    if kind == 'claude':
        entry = {'type': 'stdio', **stdio}
        updated = {'mcpServers': register(value.get('mcpServers', {}), entry, launcher)}
        projects = copy.deepcopy(value.get('projects', {}))
        for project in projects.values():
            if isinstance(project, dict) and 'mcpServers' in project:
                project['mcpServers'] = remove_old_servers(project['mcpServers'])
        if projects != value.get('projects', {}): updated['projects'] = projects
    elif kind in ('opencode', 'mimo'):
        entry = {'type': 'local', 'command': [launcher]}
        original = value.get('mcp', {})
        if kind == 'opencode':
            if 'servers' in original:
                extra = remove_old_servers({key: val for key, val in original.items() if key != 'servers'})
                if SERVER in extra: raise ValueError('Duplicate OpenCode CAO entry requires review')
                updated = {'mcp': {**extra, 'servers': register(original['servers'], entry, launcher)}}
            else:
                # Keep unrelated legacy entries byte/semantically intact. A
                # deprecated direct map is not reliably loaded by v2 diagnostics.
                legacy = remove_old_servers(original)
                legacy.pop(SERVER, None)
                updated = {'mcp': {**legacy, 'servers': {SERVER: entry}}}
        else:
            updated = {'mcp': register(original, {**entry, 'enabled': True}, launcher)}
    else: raise ValueError('Unsupported CLI config type')
    return document.updated(updated).encode()


def inventory(home: Path, *, installed=None, xdg: Path | None = None):
    """Bounded user scopes, not caches, transcripts, databases or IDE settings."""
    xdg = xdg or home / '.config'
    specs = [
        ('claude', home / '.claude.json', 'claude'),
        ('claude-settings', home / '.claude/settings.json', 'claude'),
        ('codex', home / '.codex/config.toml', 'codex'),
        ('opencode', xdg / 'opencode/opencode.jsonc', 'opencode'),
        ('hermes', home / '.hermes/config.yaml', 'hermes'),
        ('mimo', xdg / 'mimocode/mimocode.jsonc', 'mimo'),
        ('strix', home / '.strix/mcp-servers.json', 'strix'),
    ]
    result = []
    for kind, path, cli in specs:
        present = (installed or {}).get(cli, bool(shutil.which(cli)))
        # Existing config remnants are cleaned even if executable is unavailable.
        if present or os.path.lexists(path): result.append((kind, path))
    # OpenCode honors .json as well; simultaneous files are a conflict to surface.
    other = xdg / 'opencode/opencode.json'
    if os.path.lexists(other): result.append(('opencode', other))
    return result


def prepare(home: Path, launcher: Path, *, installed=None, xdg=None):
    home, launcher = Path(home), Path(launcher)
    safe_path(home / 'placeholder')
    if not launcher.is_absolute(): raise ValueError('Stable absolute launcher required')
    changes = []
    examined = []
    for kind, path in inventory(home, installed=installed, xdg=xdg):
        examined.append(str(path))
        if os.path.lexists(path): old, before, mode = read_owned(path)
        else:
            safe_path(path)
            old, before, mode = None, None, 0o600
        baseline = old if old is not None else (b'[]\n' if kind == 'strix' else b'' if kind in ('codex', 'hermes') else b'{}\n')
        new = transform(kind, baseline, str(launcher))
        if old != new: changes.append({'path': str(path), 'old': old, 'before': before, 'mode': mode, 'new': new})
    return {'version': 1, 'home': str(home), 'changes': changes, 'examined': examined,
            'quarantines': [],
            'limitations': ['Project overrides require explicit bounded inventory',
                            'Mimo/Strix runtime loader verification is separate from schema migration']}


def add_file(plan, path: Path, data: bytes, *, mode=0o600):
    if any(item['path'] == str(path) for item in plan['changes']):
        raise ValueError('Duplicate integration write')
    if os.path.lexists(path): old, before, old_mode = read_owned(path)
    else:
        safe_path(path)
        old, before, old_mode = None, None, mode
    plan['examined'].append(str(path))
    if old != data:
        plan['changes'].append({'path': str(path), 'old': old, 'before': before,
                                'mode': old_mode, 'new': data})


def discovery_digest(path: Path) -> str:
    """Hash a quarantined discovery tree without following any symlink."""
    records = []
    def visit(item, relative):
        info = item.lstat()
        if len(records) > 2000: raise ValueError('Discovery tree exceeds review bound')
        if info.st_uid != os.getuid(): raise ValueError('Unowned discovery tree')
        if stat.S_ISLNK(info.st_mode):
            value = ('link', os.readlink(item))
        elif stat.S_ISREG(info.st_mode):
            data, _, _ = read_owned(item)
            value = ('file', digest(data), stat.S_IMODE(info.st_mode))
        elif stat.S_ISDIR(info.st_mode):
            value = ('directory', stat.S_IMODE(info.st_mode))
        else: raise ValueError('Unsupported discovery tree entry')
        records.append((relative, value))
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(item.iterdir()): visit(child, relative + '/' + child.name)
    visit(path, '')
    return digest(json.dumps(records, sort_keys=True).encode())


def quarantine(plan, path: Path):
    """Only a reviewed harness-owned discovery entry, never its symlink source."""
    safe_path(path)
    info = path.lstat()
    if info.st_uid != os.getuid(): raise ValueError('Unowned discovery entry')
    if stat.S_ISREG(info.st_mode): read_owned(path)
    elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
        raise ValueError('Unsupported discovery entry type')
    plan['examined'].append(str(path))
    plan['quarantines'].append({'path': str(path), 'before': snapshot(info),
                                'sha256': discovery_digest(path)})


STANDALONE_SKILLS = frozenset({
    'agentmemory-agents', 'agentmemory-architecture', 'agentmemory-config',
    'agentmemory-hooks', 'agentmemory-mcp-tools', 'agentmemory-rest-api',
    'commit-history', 'forget', 'lesson', 'memory-discipline', 'recall',
    'remember', 'write-agentmemory-skill',
})


def knowledge_instructions(text: str) -> str:
    """Only known memory/graph instruction vocabulary, not arbitrary user prose."""
    if text.count('<!-- codebase-memory-mcp:start -->') == 1 and text.count('<!-- codebase-memory-mcp:end -->') == 1:
        text = re.sub(r'<!-- codebase-memory-mcp:start -->.*?<!-- codebase-memory-mcp:end -->', GUIDANCE.rstrip(), text, flags=re.S)
    replacements = {
        'memory_smart_search` / `memory_recall': 'memory_recall',
        'memory_smart_search': 'memory_recall', 'memory_lesson_save': 'memory_store',
        'memory_save': 'memory_store', 'memory_lesson_recall': 'memory_recall',
        'codebase-memory-mcp': 'cao-mcp-server',
    }
    names = {'list_projects': 'codebase_projects', 'index_status': 'codebase_status',
             **{name: 'codebase_' + name for name in ('search_graph', 'trace_path', 'get_code_snippet',
                 'get_architecture', 'detect_changes', 'query_graph', 'search_code', 'get_graph_schema', 'check_index_coverage')}}
    for old, new in replacements.items(): text = text.replace(old, new)
    for old, new in names.items(): text = re.sub(r'(?<![a-zA-Z0-9_])' + old + r'(?![a-zA-Z0-9_])', new, text)
    text = text.replace('Never block route/work if agentmemory is down.', 'Never block route/work if CAO shared memory is unavailable.')
    text = text.replace('**agentmemory (when `memory_*` tools are available):**', '**CAO shared memory (when `memory_*` tools are available):**')
    text = text.replace('with `content`, 2–5 `concepts`, real `files`', 'with `content`, an appropriate `scope`/`memory_type`, and 2–5 `tags`')
    text = text.replace('(content + reason, 2–5 concepts, real file paths)', '(content + reason, appropriate scope/type, 2–5 tags)')
    text = text.replace('(confidence-weighted), not a plain memory.', '(memory_type="feedback", content with the rule and its reason).')
    text = text.replace('(cbm gate hooks those tools)', '(use source fallback when CAO graph coverage is insufficient)')
    return text


def prepare_project_scopes(plan, roots):
    """Explicit registered workspaces only; never recursive repository scans."""
    for root in sorted(set(Path(value) for value in roots)):
        if not root.is_absolute() or not root.is_dir(): continue
        for relative in ('.mcp.json', '.claude/settings.json', '.claude/settings.local.json',
                         'opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'):
            path = root / relative
            if not path.is_file() or any(c['path'] == str(path) for c in plan['changes']): continue
            old, _, _ = read_owned(path)
            doc = JsonDocument(old.decode())
            updated = {}
            if relative.startswith('.claude/'):
                cleaned = clean_claude_settings(doc.value)
                updated.update({key: cleaned[key] for key in ('env', 'hooks', 'permissions') if key in cleaned})
            elif relative == '.mcp.json':
                if 'mcpServers' in doc.value: updated['mcpServers'] = remove_old_servers(doc.value['mcpServers'])
            else:
                if 'mcp' in doc.value:
                    original = doc.value['mcp']
                    updated['mcp'] = ({'servers': remove_old_servers(original['servers'])}
                                      if set(original) == {'servers'} else remove_old_servers(original))
            add_file(plan, path, doc.updated(updated).encode())
    return plan


def prepare_instructions(plan, *, xdg=None):
    home = Path(plan['home']); xdg = Path(xdg) if xdg else home / '.config'
    targets = [home / '.claude/CLAUDE.md', home / '.claude/hooks/graph-first-session-reminder',
               home / '.claude/skills/route/SKILL.md', xdg / 'opencode/AGENTS.md']
    targets.extend(home / '.claude/agents' / (name + '.md') for name in
                   ('route-implementer', 'route-planner', 'route-probe', 'route-reviewer'))
    for path in targets:
        if not path.is_file(): continue
        old, _, _ = read_owned(path)
        text = knowledge_instructions(old.decode())
        add_file(plan, path, text.encode())
    return plan


def prepare_cao_profiles(plan, launcher: Path):
    """Keep the full orchestration surface for existing CAO supervisor profiles."""
    home = Path(plan['home'])
    for relative in ('.aws/cli-agent-orchestrator/agent-store/code_supervisor.md',
                     '.aws/cli-agent-orchestrator/agent-context/code_supervisor.md'):
        path = home / relative
        if not path.is_file(): continue
        old, _, _ = read_owned(path)
        text = old.decode()
        if text.count('    command: cao-mcp-server\n') == 1 and text.count('    args: []\n') == 1:
            text = text.replace('    command: cao-mcp-server\n', '    command: ' + json.dumps(str(launcher)) + '\n')
            text = text.replace('    args: []\n', '    args: ["--full"]\n')
        elif str(launcher) not in text:
            raise ValueError('Unfamiliar CAO supervisor MCP declaration')
        add_file(plan, path, text.encode())
    path = home / '.kiro/agents/code_supervisor.json'
    if path.is_file():
        old, _, _ = read_owned(path)
        doc = JsonDocument(old.decode())
        mapping = copy.deepcopy(doc.value.get('mcpServers', {}))
        entry = mapping.get(SERVER)
        if not isinstance(entry, dict) or Path(entry.get('command', '')).name not in ('cao-mcp-server', launcher.name):
            raise ValueError('Unfamiliar Kiro CLI CAO declaration')
        mapping[SERVER] = {**entry, 'command': str(launcher), 'args': ['--full']}
        add_file(plan, path, doc.updated({'mcpServers': mapping}).encode())
    return plan


def prepare_discovery(plan, *, xdg=None):
    """Known harness-owned names only; shared skill source is never modified."""
    home = Path(plan['home']); xdg = Path(xdg) if xdg else home / '.config'
    for root in (home / '.claude/skills', home / '.hermes/skills'):
        for name in sorted(STANDALONE_SKILLS):
            path = root / name
            if not os.path.lexists(path): continue
            source = path.resolve() / 'SKILL.md'
            if not source.is_file() or source.stat().st_size > 128 * 1024:
                raise ValueError('Unfamiliar standalone skill discovery entry')
            text = source.read_text()
            if not any(marker in text for marker in ('agentmemory', 'memory_lesson_save')):
                raise ValueError('Standalone skill identity requires review')
            quarantine(plan, path)
    for root, suffix in ((home / '.claude/agents', '.md'), (xdg / 'opencode/agents', '.md'),
                         (home / '.kiro/agents', '.json')):
        for name in ('codebase-memory', 'codebase-memory-scout', 'codebase-memory-auditor'):
            path = root / (name + suffix)
            if not os.path.lexists(path): continue
            old, _, _ = read_owned(path)
            if b'codebase-memory-mcp' not in old:
                raise ValueError('Unfamiliar codebase agent identity')
            quarantine(plan, path)
    for name in ('cbm-code-discovery-gate', 'cbm-session-reminder', 'cbm-subagent-reminder'):
        path = home / '.claude/hooks' / name
        if path.is_file():
            old, _, _ = read_owned(path)
            if b'codebase-memory-mcp' not in old:
                raise ValueError('Unfamiliar standalone CBM wrapper')
            quarantine(plan, path)
    plugin = xdg / 'opencode/plugins/cbm-augment.ts'
    if plugin.exists():
        old, _, _ = read_owned(plugin)
        # Exact reviewed adapter; never remove an unrelated plugin by filename.
        if digest(old) != 'db724ef9a7f127b2adafd158390e2f22ea496674756ae1a7be83d9db3ca34d79':
            raise ValueError('OpenCode plugin requires identity review')
        quarantine(plan, plugin)
    for root in (home / '.claude/skills', home / '.hermes/skills', xdg / 'opencode/skills'):
        path = root / 'codebase-memory/SKILL.md'
        if path.is_file():
            old, _, _ = read_owned(path)
            if not (b'codebase-memory-mcp' in old or (b'name: codebase-memory\n' in old
                    and b'`search_graph`' in old and b'`index_repository`' in old)):
                raise ValueError('Codebase skill identity requires review')
            quarantine(plan, path.parent)
    # Per-CLI overrides prevent re-exposure through ~/.agents/skills discovery.
    codex_path = home / '.codex/config.toml'
    item = next((c for c in plan['changes'] if c['path'] == str(codex_path)), None)
    if item is not None or codex_path.is_file():
        import tomlkit
        old_codex = read_owned(codex_path)[0] if item is None else None
        value = tomlkit.parse((item['new'] if item is not None else old_codex).decode())
        skills = value.setdefault('skills', {})
        configs = skills.setdefault('config', [])
        for name in sorted(STANDALONE_SKILLS):
            source = home / '.agents/skills' / name / 'SKILL.md'
            if source.is_file():
                existing = next((c for c in configs if str(c.get('path')) == str(source)), None)
                if existing is None: configs.append({'path': str(source), 'enabled': False})
                else: existing['enabled'] = False
        data = tomlkit.dumps(value).encode()
        if item is not None: item['new'] = data
        else: add_file(plan, codex_path, data)
    # OpenCode also auto-discovers ~/.agents/skills. Same-name CLI-local
    # overrides replace upstream instructions without changing shared sources.
    for name in sorted(STANDALONE_SKILLS):
        shared = home / '.agents/skills' / name / 'SKILL.md'
        if shared.is_file():
            override = xdg / 'opencode/skills' / name / 'SKILL.md'
            body = ('---\nname: ' + name + '\ndescription: CAO shared knowledge only; standalone integration retired for this CLI.\n---\n\n' + GUIDANCE)
            add_file(plan, override, body.encode())
    # Add replacement guidance only in harness-owned instruction locations.
    for path in (home / '.claude/skills/cao-shared-knowledge/SKILL.md',
                 home / '.hermes/skills/cao-shared-knowledge/SKILL.md',
                 xdg / 'opencode/skills/cao-shared-knowledge/SKILL.md'):
        add_file(plan, path, ('---\nname: cao-shared-knowledge\ndescription: Use CAO-hosted memory and Fleet codebase tools.\n---\n\n' + GUIDANCE).encode())
    return plan


def assert_before(path, before):
    safe_path(path)
    if before is None:
        if os.path.lexists(path): raise ValueError('Integration target appeared after preflight')
    elif not os.path.lexists(path) or snapshot(path.lstat()) != tuple(before):
        raise ValueError('Integration target changed after preflight')


def ensure_dirs(path, created):
    missing = []
    while not path.exists():
        safe_path(path)
        missing.append(path)
        path = path.parent
    safe_path(path / 'placeholder')
    for item in reversed(missing):
        item.mkdir(mode=0o700)
        created.append(str(item))


def atomic(path, data, mode, before):
    safe_path(path)
    fd, temporary = tempfile.mkstemp(prefix='.cao-mcp-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        assert_before(path, before)
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def apply(plan):
    for item in [*plan['changes'], *plan.get('quarantines', [])]:
        assert_before(Path(item['path']), item['before'])
    root = Path(plan['home']) / '.local/share/cao-deploy-backups' / ('shared-mcp-' + uuid.uuid4().hex)
    ensure_dirs(root, [])
    receipt = {'version': 1, 'root': str(root), 'changes': [], 'quarantines': [], 'created_dirs': [],
               'examined': plan['examined'], 'limitations': plan['limitations']}
    def persist():
        path = root / 'receipt.json'
        before = snapshot(path.lstat()) if path.exists() else None
        atomic(path, (json.dumps(receipt, indent=2) + '\n').encode(), 0o600, before)
    persist()
    try:
        for index, item in enumerate(plan.get('quarantines', [])):
            target = Path(item['path'])
            backup = root / f'{index:04d}.quarantined'
            record = {'path': str(target), 'backup': str(backup), 'before': item['before'],
                      'sha256': item['sha256'], 'after': None, 'applied': False}
            receipt['quarantines'].append(record)
            persist()
            assert_before(target, item['before'])
            if discovery_digest(target) != item['sha256']: raise ValueError('Discovery tree changed after review')
            os.rename(target, backup)
            record['after'] = snapshot(backup.lstat())
            record['applied'] = True
            persist()
        for index, item in enumerate(plan['changes']):
            target = Path(item['path'])
            backup = None
            if item['old'] is not None:
                backup = root / f'{index:04d}.before'
                atomic(backup, item['old'], 0o600, None)
            ensure_dirs(target.parent, receipt['created_dirs'])
            change = {'path': str(target), 'backup': str(backup) if backup else None,
                      'old_sha256': digest(item['old']) if item['old'] is not None else None,
                      'mode': item['mode'], 'new_sha256': digest(item['new']), 'applied': False}
            receipt['changes'].append(change)
            persist()  # durable intent before replacement
            atomic(target, item['new'], item['mode'], item['before'])
            change['applied'] = True
            persist()
    except BaseException:
        rollback(receipt)
        raise
    return receipt


def rollback(receipt):
    # Includes an interrupted last write whose receipt was not yet marked applied.
    for item in reversed(receipt['changes']):
        target = Path(item['path'])
        if not os.path.lexists(target):
            if item['applied']: raise ValueError('Rollback target removed by another writer')
            continue
        data, before, _ = read_owned(target)
        if digest(data) == item['old_sha256']: continue
        if digest(data) != item['new_sha256']:
            raise ValueError('Rollback refused: integration config changed')
        if item['backup']:
            old, _, _ = read_owned(Path(item['backup']))
            if digest(old) != item['old_sha256']: raise ValueError('Rollback backup checksum mismatch')
            atomic(target, old, item['mode'], before)
        else:
            assert_before(target, before)
            target.unlink()
    for item in reversed(receipt.get('quarantines', [])):
        target, backup = Path(item['path']), Path(item['backup'])
        if not os.path.lexists(backup):
            if item['applied']: raise ValueError('Quarantine backup missing')
            continue
        if os.path.lexists(target): raise ValueError('Rollback refused: discovery entry appeared')
        if discovery_digest(backup) != item['sha256']:
            raise ValueError('Rollback refused: quarantine contents changed')
        expected = item['after']
        if expected is not None and snapshot(backup.lstat()) != tuple(expected):
            raise ValueError('Rollback refused: quarantine changed')
        safe_path(target)
        os.rename(backup, target)
    for directory in reversed(receipt['created_dirs']):
        path = Path(directory)
        safe_path(path / 'placeholder')
        try: path.rmdir()
        except OSError: pass
