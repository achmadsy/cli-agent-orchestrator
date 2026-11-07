// app-history.test.js — H1 on-demand scrollback's pure viewport anchor,
// exposed on window.__histTest. After the live window is replaced by the deep
// history capture, the old content is the SUFFIX of the new content, so the
// invariant is distance-from-bottom: newTop = newHeight - (oldHeight - oldTop).
// Break the formula (e.g. anchor from the top) and the mid-read case fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function hist() {
  install();
  const win = loadScript(path.join(__dirname, '..', 'app.js'), { tolerant: true });
  assert.ok(win.__histTest, 'app.js must export window.__histTest');
  return win.__histTest;
}
const { histAnchor } = hist();

test('reader at the very top of the live window stays on the same text', () => {
  // old: 3000px tall, reading at top (0). new: 60000px tall.
  // distance-from-bottom was 3000 → newTop = 60000-3000 = 57000.
  assert.strictEqual(histAnchor(0, 3000, 60000), 57000);
});

test('reader mid-scroll keeps their distance from the bottom', () => {
  // old: top=1200 of 3000 (1800 from bottom) → new keeps 1800 from bottom.
  assert.strictEqual(histAnchor(1200, 3000, 60000), 58200);
});

test('degenerate: new content NOT taller (history empty) → clamps at 0, no negative scroll', () => {
  assert.strictEqual(histAnchor(0, 3000, 3000), 0);
  assert.strictEqual(histAnchor(0, 3000, 2000), 0);
});

test('identity: at bottom of old == at (content) bottom of new', () => {
  // old top = oldHeight (degenerate fully-scrolled) → distance 0 → newTop = newHeight.
  assert.strictEqual(histAnchor(3000, 3000, 60000), 60000);
});
