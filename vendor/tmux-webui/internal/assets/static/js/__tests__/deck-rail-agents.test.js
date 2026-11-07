// deck-rail-agents.test.js — U3's pure reducer deck-rail.js agentsToSessionState,
// exposed on window.deckRail. It folds the GET /api/agents list into one
// worst-state per session so the session rail can tint which OTHER project's
// agent needs you. The load-bearing rule is the worst-of ordering
// (waiting > working > idle) and that unknown/absent states never contribute —
// flip either and a test below fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function reducer() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-rail.js'));
  assert.ok(win.deckRail && typeof win.deckRail.agentsToSessionState === 'function');
  return win.deckRail.agentsToSessionState;
}
const r = reducer();

test('exports agentsToSessionState after load', () => {
  assert.strictEqual(typeof r, 'function');
});

test('single agent → that session takes its state', () => {
  assert.deepStrictEqual(r([{ session: 'a', state: 'working' }]), { a: 'working' });
});

test('worst-of per session: waiting beats working beats idle', () => {
  const agents = [
    { session: 'a', state: 'idle' },
    { session: 'a', state: 'working' },
    { session: 'a', state: 'waiting' },
  ];
  assert.deepStrictEqual(r(agents), { a: 'waiting' });
});

test('ordering is worst-of regardless of array order', () => {
  // waiting arrives first, then working/idle — must not be overwritten downward.
  const agents = [
    { session: 'a', state: 'waiting' },
    { session: 'a', state: 'working' },
    { session: 'a', state: 'idle' },
  ];
  assert.deepStrictEqual(r(agents), { a: 'waiting' });
});

test('working beats idle (no waiting present)', () => {
  const agents = [
    { session: 'a', state: 'idle' },
    { session: 'a', state: 'working' },
  ];
  assert.deepStrictEqual(r(agents), { a: 'working' });
});

test('multiple sessions are reduced independently', () => {
  const agents = [
    { session: 'a', state: 'idle' },
    { session: 'b', state: 'waiting' },
    { session: 'b', state: 'idle' },
    { session: 'c', state: 'working' },
  ];
  assert.deepStrictEqual(r(agents), { a: 'idle', b: 'waiting', c: 'working' });
});

test('unknown state never contributes — a session of only unknown stays neutral', () => {
  assert.deepStrictEqual(r([{ session: 'a', state: 'unknown' }]), {});
});

test('unknown mixed in does not override a real state, and never adds a session', () => {
  const agents = [
    { session: 'a', state: 'unknown' },
    { session: 'a', state: 'idle' },
    { session: 'b', state: 'unknown' },
  ];
  assert.deepStrictEqual(r(agents), { a: 'idle' });
});

test('agents without a session name are skipped', () => {
  const agents = [
    { state: 'waiting' },
    { session: '', state: 'waiting' },
    { session: 'a', state: 'working' },
  ];
  assert.deepStrictEqual(r(agents), { a: 'working' });
});

test('empty / non-array / junk input → empty map', () => {
  assert.deepStrictEqual(r([]), {});
  assert.deepStrictEqual(r(null), {});
  assert.deepStrictEqual(r(undefined), {});
  assert.deepStrictEqual(r('nope'), {});
  assert.deepStrictEqual(r([null, undefined, {}]), {});
});
