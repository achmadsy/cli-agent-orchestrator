// deck-agent-ctxtone.test.js — the two obs-gap fixes exposed on window.deckAgent:
//   • ctxPctStr: a real-but-tiny burn (0<pct<1) must read '<1%', NOT '0%'
//     (the Math.round bug) and NOT '' (absent). Absent/zero still blank.
//   • sessionTone: U3 grid session-key tint — worst cross-session state → tone,
//     'accent' when neutral so idle/unknown sessions keep the plain look.
// Both are load-bearing: flip either mapping and a case below fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function load() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-agent.js'));
  assert.ok(win.deckAgent && typeof win.deckAgent.ctxPctStr === 'function');
  assert.ok(typeof win.deckAgent.sessionTone === 'function');
  return win.deckAgent;
}
const da = load();

test('ctxPctStr: tiny real burn reads <1%, not 0% and not blank', () => {
  assert.strictEqual(da.ctxPctStr({ pct: 0.3 }), '<1%');
  assert.strictEqual(da.ctxPctStr({ pct: 0.99 }), '<1%');
});

test('ctxPctStr: normal burn rounds to a percent', () => {
  assert.strictEqual(da.ctxPctStr({ pct: 12.3 }), '12%');
  assert.strictEqual(da.ctxPctStr({ pct: 1 }), '1%');
  assert.strictEqual(da.ctxPctStr({ pct: 87.6 }), '88%');
});

test('ctxPctStr: absent / zero / null stays blank (never 0%)', () => {
  assert.strictEqual(da.ctxPctStr(null), '');
  assert.strictEqual(da.ctxPctStr({}), '');
  assert.strictEqual(da.ctxPctStr({ pct: 0 }), '');
  assert.strictEqual(da.ctxPctStr({ pct: -5 }), '');
});

test('sessionTone: worst state maps to a grid-key tone', () => {
  assert.strictEqual(da.sessionTone('waiting'), 'red');
  assert.strictEqual(da.sessionTone('working'), 'green');
});

test('sessionTone: idle / unknown / null stays neutral accent', () => {
  assert.strictEqual(da.sessionTone('idle'), 'accent');
  assert.strictEqual(da.sessionTone('unknown'), 'accent');
  assert.strictEqual(da.sessionTone(null), 'accent');
  assert.strictEqual(da.sessionTone(undefined), 'accent');
});
