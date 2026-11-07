// deck-agent-timeline.test.js — I3's pure client helpers on window.deckAgent:
//   • splitDurations(recent, nowSec): folds a pane's recent[] transition ring into
//     seconds per state, the LAST transition open until nowSec (client clock), so
//     the split ticks live between polls. Mirrors the Go stateDurations reference.
//   • fmtDuration(secs): the compact "1h2m" / "4m12s" / "45s" in-state label.
// Flip the open-segment handling, the clamp, or the format thresholds and a case
// below fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function api() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-agent.js'), { tolerant: true });
  assert.ok(win.deckAgent && typeof win.deckAgent.splitDurations === 'function');
  assert.ok(typeof win.deckAgent.fmtDuration === 'function');
  return win.deckAgent;
}
const { splitDurations, fmtDuration } = api();

test('empty / non-array recent → zeroed split', () => {
  assert.deepStrictEqual(splitDurations([], 100), { working: 0, waiting: 0, idle: 0 });
  assert.deepStrictEqual(splitDurations(null, 100), { working: 0, waiting: 0, idle: 0 });
  assert.deepStrictEqual(splitDurations('x', 100), { working: 0, waiting: 0, idle: 0 });
});

test('folds per state; last transition stays open until nowSec', () => {
  const recent = [
    { state: 'working', atUnix: 100 },
    { state: 'waiting', atUnix: 160 },
    { state: 'idle', atUnix: 180 },
  ];
  // working 160-100=60, waiting 180-160=20, idle (open) 250-180=70
  assert.deepStrictEqual(splitDurations(recent, 250), { working: 60, waiting: 20, idle: 70 });
});

test('re-entered state accumulates across segments', () => {
  const recent = [
    { state: 'working', atUnix: 0 },
    { state: 'waiting', atUnix: 10 },
    { state: 'working', atUnix: 15 },
  ];
  // working (10-0)+(20-15)=15, waiting 15-10=5
  const out = splitDurations(recent, 20);
  assert.strictEqual(out.working, 15);
  assert.strictEqual(out.waiting, 5);
});

test('open segment grows with the client clock (live split)', () => {
  const recent = [{ state: 'waiting', atUnix: 1000 }];
  assert.strictEqual(splitDurations(recent, 1000).waiting, 0);
  assert.strictEqual(splitDurations(recent, 1252).waiting, 252); // 4m12s later
});

test('negative spans (clock skew / out-of-order) clamp to 0', () => {
  const recent = [{ state: 'working', atUnix: 100 }, { state: 'waiting', atUnix: 90 }];
  assert.deepStrictEqual(splitDurations(recent, 80), { working: 0, waiting: 0, idle: 0 });
});

test('fmtDuration: seconds / minutes+seconds / hours+minutes thresholds', () => {
  assert.strictEqual(fmtDuration(0), '0s');
  assert.strictEqual(fmtDuration(45), '45s');
  assert.strictEqual(fmtDuration(59), '59s');
  assert.strictEqual(fmtDuration(60), '1m00s');
  assert.strictEqual(fmtDuration(252), '4m12s'); // the spec's "waiting 4m12s"
  assert.strictEqual(fmtDuration(605), '10m05s'); // seconds zero-padded
  assert.strictEqual(fmtDuration(3600), '1h0m');
  assert.strictEqual(fmtDuration(3720), '1h2m');
});

test('fmtDuration clamps junk / negatives to 0s', () => {
  assert.strictEqual(fmtDuration(-5), '0s');
  assert.strictEqual(fmtDuration(NaN), '0s');
  assert.strictEqual(fmtDuration('nope'), '0s');
  assert.strictEqual(fmtDuration(12.9), '12s'); // floored
});
