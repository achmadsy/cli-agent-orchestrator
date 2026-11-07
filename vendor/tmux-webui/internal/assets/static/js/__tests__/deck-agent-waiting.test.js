// deck-agent-waiting.test.js — deck-agent.js countWaiting(), the pure lift of
// waitingCount() exposed on window.deckAgent. It powers the "N 等你回覆"
// attention badge. The load-bearing behaviour: when the backend ships the
// per-pane map (panePaneStates) it is authoritative EVEN IF it holds zero
// waiters; only a totally-empty per-pane map falls back to the window aggregate.
// Flip that precedence and the zero-vs-fallback tests fail.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function countWaiting() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-agent.js'));
  assert.ok(win.deckAgent && typeof win.deckAgent.countWaiting === 'function');
  return win.deckAgent.countWaiting;
}
const cw = countWaiting();

test('counts waiting entries in the per-pane map', () => {
  const panePane = { '1.0': 'working', '1.1': 'waiting', '2.0': 'waiting', '2.1': 'idle' };
  assert.strictEqual(cw(panePane, {}), 2);
});

test('zero when no pane is waiting (per-pane map present but none waiting)', () => {
  assert.strictEqual(cw({ '1.0': 'working', '1.1': 'idle' }, {}), 0);
});

test('per-pane map wins even when it has zero waiters — no aggregate fallback', () => {
  // aggregate says a window is waiting, but the finer per-pane truth says none.
  // The per-pane map is authoritative once present, so the answer is 0, not 1.
  const panePane = { '1.0': 'working' };
  const paneAgg = { 1: 'waiting' };
  assert.strictEqual(cw(panePane, paneAgg), 0);
});

test('falls back to the window aggregate only when the per-pane map is empty', () => {
  const paneAgg = { 0: 'idle', 1: 'waiting', 2: 'waiting' };
  assert.strictEqual(cw({}, paneAgg), 2);
});

test('both maps empty → zero', () => {
  assert.strictEqual(cw({}, {}), 0);
});
