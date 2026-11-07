// deck-agent-replay.test.js — I4's pure client helpers on window.deckAgent:
//   • clampIdx(idx, n): keeps a scrub index inside [0, n-1]; an empty ring (n<=0)
//     pins to 0. This is what stops the draggable replay axis from indexing past
//     the ends of the captured-frames array (a blank/undefined frame render).
//   • replayAgentLabel(a): formats one /api/agents entry as "session · 1:name ⌗2"
//     for the picker rows and the replay panel title.
// Flip the clamp bounds or the label composition and a case below fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function api() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-agent.js'), { tolerant: true });
  assert.ok(win.deckAgent && typeof win.deckAgent.clampIdx === 'function');
  assert.ok(typeof win.deckAgent.replayAgentLabel === 'function');
  return win.deckAgent;
}
const { clampIdx, replayAgentLabel } = api();

test('clampIdx: empty ring pins to 0 regardless of index', () => {
  assert.strictEqual(clampIdx(0, 0), 0);
  assert.strictEqual(clampIdx(5, 0), 0);
  assert.strictEqual(clampIdx(-3, 0), 0);
});

test('clampIdx: in-range index is returned unchanged', () => {
  assert.strictEqual(clampIdx(0, 3), 0);
  assert.strictEqual(clampIdx(1, 3), 1);
  assert.strictEqual(clampIdx(2, 3), 2);
});

test('clampIdx: below 0 clamps to 0, above n-1 clamps to the last frame', () => {
  assert.strictEqual(clampIdx(-1, 3), 0);
  assert.strictEqual(clampIdx(3, 3), 2);   // one past the end
  assert.strictEqual(clampIdx(99, 3), 2);
});

test('replayAgentLabel: full entry → "session · win:name ⌗pane"', () => {
  assert.strictEqual(
    replayAgentLabel({ session: 'zzObsA', window: 1, windowName: 'agent', pane: 2 }),
    'zzObsA · 1:agent ⌗2'
  );
});

test('replayAgentLabel: missing window/pane degrade without throwing', () => {
  assert.strictEqual(
    replayAgentLabel({ session: 's', window: null, windowName: '', pane: null }),
    's · ' + ' ⌗'
  );
  assert.strictEqual(replayAgentLabel(null), '');
});
