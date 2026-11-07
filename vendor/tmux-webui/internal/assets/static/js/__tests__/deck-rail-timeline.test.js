// deck-rail-timeline.test.js — I3's pure reducer deck-rail.js agentsToTimelineIndex,
// exposed on window.deckRail. It folds the GET /api/agents list into a per-pane
// timeline index keyed "session\x00paneID" so the deck can show each pane's live
// "waiting Xm" (from sinceUnix) + working/waiting/idle split (from recent[])
// without a second fetch. Load-bearing rules: only classified agent panes (a
// real, non-empty state) are kept, entries missing session/paneID are dropped,
// the key groups by session, and sinceUnix/recent are carried through. Flip any
// and a test below fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function reducer() {
  const win = install();
  loadScript(path.join(__dirname, '..', 'deck-rail.js'));
  assert.ok(win.deckRail && typeof win.deckRail.agentsToTimelineIndex === 'function');
  return win.deckRail.agentsToTimelineIndex;
}
const r = reducer();
const KEY = (s, p) => s + '\x00' + p;

test('exports agentsToTimelineIndex after load', () => {
  assert.strictEqual(typeof r, 'function');
});

test('keeps an agent pane, keyed session+paneID, carrying state/sinceUnix/recent', () => {
  const recent = [{ state: 'working', atUnix: 100 }, { state: 'waiting', atUnix: 160 }];
  const out = r([{ session: 'a', paneID: '1.0', state: 'waiting', sinceUnix: 160, recent }]);
  assert.deepStrictEqual(out, { [KEY('a', '1.0')]: { state: 'waiting', sinceUnix: 160, recent } });
});

test('drops a pane with no state (not a classified agent)', () => {
  const out = r([{ session: 'a', paneID: '3.0', state: '', sinceUnix: 5 }]);
  assert.deepStrictEqual(out, {});
});

test('drops entries missing session or paneID', () => {
  const out = r([
    { paneID: '1.0', state: 'idle' },
    { session: 'a', state: 'idle' },
    { session: '', paneID: '1.0', state: 'idle' },
    { session: 'a', paneID: '1.0', state: 'idle', sinceUnix: 9 },
  ]);
  assert.deepStrictEqual(Object.keys(out), [KEY('a', '1.0')]);
});

test('same paneID in two sessions never collides', () => {
  const out = r([
    { session: 'a', paneID: '1.0', state: 'working', sinceUnix: 1 },
    { session: 'b', paneID: '1.0', state: 'waiting', sinceUnix: 2 },
  ]);
  assert.strictEqual(out[KEY('a', '1.0')].state, 'working');
  assert.strictEqual(out[KEY('b', '1.0')].state, 'waiting');
});

test('missing sinceUnix → 0; missing/non-array recent → []', () => {
  const out = r([{ session: 'a', paneID: '5.2', state: 'idle' }]);
  assert.strictEqual(out[KEY('a', '5.2')].sinceUnix, 0);
  assert.deepStrictEqual(out[KEY('a', '5.2')].recent, []);
});

test('empty / non-array / junk input → empty map', () => {
  assert.deepStrictEqual(r([]), {});
  assert.deepStrictEqual(r(null), {});
  assert.deepStrictEqual(r(undefined), {});
  assert.deepStrictEqual(r('nope'), {});
  assert.deepStrictEqual(r([null, undefined, {}]), {});
});
