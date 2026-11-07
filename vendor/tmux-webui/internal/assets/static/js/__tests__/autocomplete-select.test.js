// autocomplete-select.test.js — buildReplacement (picked suggestion → input
// text) exposed on window.__acTest. A "builtin" item's name arrives WITHOUT
// the leading slash (builtin.go strips it, same as skill/command), so the
// picker must add "/" back — a bare name silently turns the user's typed
// "/compact" into "compact" and the send becomes a plain chat message.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function load() {
  install({ getById: true });
  const win = loadScript(path.join(__dirname, '..', 'autocomplete.js'), { tolerant: true });
  assert.ok(win.__acTest && typeof win.__acTest.buildReplacement === 'function');
  assert.ok(typeof win.__acTest.tokenAt === 'function');
  return win.__acTest;
}
const { buildReplacement, tokenAt } = load();

test('skill and command complete to /name with trailing space', () => {
  assert.strictEqual(buildReplacement({ type: 'skill', name: 'image-prompt' }), '/image-prompt ');
  assert.strictEqual(buildReplacement({ type: 'command', name: 'zoom-out' }), '/zoom-out ');
});

test('builtin completes to /name — the typed slash must survive the pick', () => {
  assert.strictEqual(buildReplacement({ type: 'builtin', name: 'compact' }), '/compact ');
  assert.strictEqual(buildReplacement({ type: 'builtin', name: 'model' }), '/model ');
});

test('agent and mcp complete to @name with trailing space', () => {
  assert.strictEqual(buildReplacement({ type: 'agent', name: 'reviewer' }), '@reviewer ');
  assert.strictEqual(buildReplacement({ type: 'mcp', name: 'mcpproxy' }), '@mcpproxy ');
});

test('file completes to @relative/path — resolved by the CLI in the pane', () => {
  assert.strictEqual(
    buildReplacement({ type: 'file', name: 'internal/server/server.go' }),
    '@internal/server/server.go '
  );
});

test('path inserts verbatim (no prefix, no trailing space)', () => {
  assert.strictEqual(buildReplacement({ type: 'path', name: '~/workshop/' }), '~/workshop/');
});

test('shortcut inserts its insert payload verbatim, falling back to name', () => {
  assert.strictEqual(
    buildReplacement({ type: 'shortcut', name: 'uc', insert: 'ultracode ' }),
    'ultracode '
  );
  assert.strictEqual(buildReplacement({ type: 'shortcut', name: 'yazi' }), 'yazi');
});

test('tokenAt: bare first word of 2+ chars triggers shortcut lookup', () => {
  assert.deepStrictEqual(tokenAt('laz', 3), { type: 'shortcut', query: 'laz', start: 0, end: 3 });
});

test('tokenAt: single char, mid-sentence words, and slashy tokens stay silent', () => {
  assert.strictEqual(tokenAt('l', 1), null);                       // too short
  assert.strictEqual(tokenAt('run laz', 7), null);                 // not first token
  assert.strictEqual(tokenAt('foo/bar', 7), null);                 // path-ish, not a keyword
});

test('tokenAt: sigil triggers keep precedence over the bare-word branch', () => {
  assert.strictEqual(tokenAt('/laz', 4).type, 'slash');
  assert.strictEqual(tokenAt('@laz', 4).type, 'at');
  assert.strictEqual(tokenAt('~/la', 4).type, 'path');
});
