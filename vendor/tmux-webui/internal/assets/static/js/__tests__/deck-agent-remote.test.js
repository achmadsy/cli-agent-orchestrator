// deck-agent-remote.test.js — I6 remote-host federation gates on
// window.deckAgent: isRemoteAgent / agentHostLabel. These decide whether an
// agent from /api/agents is a peer (STATUS ONLY, read-only) or a local pane the
// deck may focus/record. The load-bearing rule: host "local" (and an
// absent/empty host, i.e. a legacy payload) is LOCAL; anything else is remote.
// Flip the `!== 'local'` and every remote assertion below fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function api() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-agent.js'));
  assert.ok(win.deckAgent && typeof win.deckAgent.isRemoteAgent === 'function');
  assert.ok(typeof win.deckAgent.agentHostLabel === 'function');
  return win.deckAgent;
}
const A = api();

test('exports isRemoteAgent / agentHostLabel after load', () => {
  assert.strictEqual(typeof A.isRemoteAgent, 'function');
  assert.strictEqual(typeof A.agentHostLabel, 'function');
});

test('host "local" is a local agent (never remote)', () => {
  const a = { host: 'local', session: 's', paneID: '1.0', state: 'waiting' };
  assert.strictEqual(A.isRemoteAgent(a), false);
  assert.strictEqual(A.agentHostLabel(a), '');
});

test('a named peer host is remote and yields its label', () => {
  const a = { host: 'host-b', session: 's', paneID: 'host-b/1.0', state: 'working' };
  assert.strictEqual(A.isRemoteAgent(a), true);
  assert.strictEqual(A.agentHostLabel(a), 'host-b');
});

test('absent host (legacy payload) counts as local, not remote', () => {
  const a = { session: 's', paneID: '1.0', state: 'idle' };
  assert.strictEqual(A.isRemoteAgent(a), false);
  assert.strictEqual(A.agentHostLabel(a), '');
});

test('empty-string host counts as local', () => {
  assert.strictEqual(A.isRemoteAgent({ host: '', session: 's' }), false);
  assert.strictEqual(A.agentHostLabel({ host: '', session: 's' }), '');
});

test('null / undefined agent is safe and non-remote', () => {
  assert.strictEqual(A.isRemoteAgent(null), false);
  assert.strictEqual(A.isRemoteAgent(undefined), false);
  assert.strictEqual(A.agentHostLabel(null), '');
});
