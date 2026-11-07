// deck-rail-context.test.js — I5's pure reducer deck-rail.js agentsToPaneIndex,
// exposed on window.deckRail. It folds the GET /api/agents list into a per-pane
// context/token-burn index keyed "session\x00paneID" so the deck grid can badge
// each key with its % without a second fetch. The load-bearing rules are: only
// panes with real burn (contextPct > 0 OR tokensMax > 0) are kept, entries
// missing session/paneID are dropped, and the key groups by session — flip any
// and a test below fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function reducer() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-rail.js'));
  assert.ok(win.deckRail && typeof win.deckRail.agentsToPaneIndex === 'function');
  return win.deckRail.agentsToPaneIndex;
}
const r = reducer();
const KEY = (s, p) => s + '\x00' + p;

test('exports agentsToPaneIndex after load', () => {
  assert.strictEqual(typeof r, 'function');
});

test('keeps a pane with a real context percentage, keyed session+paneID', () => {
  const out = r([{ session: 'a', paneID: '1.0', contextPct: 12.3, tokensUsed: 32100, tokensMax: 262100, window: 1 }]);
  assert.deepStrictEqual(out, { [KEY('a', '1.0')]: { pct: 12.3, used: 32100, max: 262100, window: 1 } });
});

test('keeps a pane that has tokens but a zero (rounded) percentage', () => {
  const out = r([{ session: 'a', paneID: '2.1', contextPct: 0, tokensUsed: 50, tokensMax: 100, window: 2 }]);
  assert.deepStrictEqual(out[KEY('a', '2.1')], { pct: 0, used: 50, max: 100, window: 2 });
});

test('drops a pane with no burn at all (no status line)', () => {
  const out = r([{ session: 'a', paneID: '3.0', contextPct: 0, tokensUsed: 0, tokensMax: 0, window: 3 }]);
  assert.deepStrictEqual(out, {});
});

test('drops entries missing session or paneID', () => {
  const out = r([
    { paneID: '1.0', contextPct: 9 },
    { session: 'a', contextPct: 9 },
    { session: '', paneID: '1.0', contextPct: 9 },
    { session: 'a', paneID: '1.0', contextPct: 9, window: 1 },
  ]);
  assert.deepStrictEqual(Object.keys(out), [KEY('a', '1.0')]);
});

test('same paneID in two sessions never collides', () => {
  const out = r([
    { session: 'a', paneID: '1.0', contextPct: 10, window: 1 },
    { session: 'b', paneID: '1.0', contextPct: 80, window: 1 },
  ]);
  assert.strictEqual(out[KEY('a', '1.0')].pct, 10);
  assert.strictEqual(out[KEY('b', '1.0')].pct, 80);
});

test('window carried through (null when absent)', () => {
  const out = r([{ session: 'a', paneID: '5.2', contextPct: 4 }]);
  assert.strictEqual(out[KEY('a', '5.2')].window, null);
});

test('empty / non-array / junk input → empty map', () => {
  assert.deepStrictEqual(r([]), {});
  assert.deepStrictEqual(r(null), {});
  assert.deepStrictEqual(r(undefined), {});
  assert.deepStrictEqual(r('nope'), {});
  assert.deepStrictEqual(r([null, undefined, {}]), {});
});
