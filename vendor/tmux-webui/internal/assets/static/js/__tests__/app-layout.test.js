// app-layout.test.js — app.js layout data + pure helpers, exposed on
// window.__layoutTest. Covers: LAYOUT_PRESETS/LAYOUT_META geometry sanity,
// layoutIcon() SVG per preset, and selectVisible() slot/overflow math (the
// pure lift of applyLayout's visible-pane selection). app.js is DOM-entangled
// far below the export, so it is loaded tolerantly (the export runs first).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function layout() {
  install();
  const win = loadScript(path.join(__dirname, '..', 'app.js'), { tolerant: true });
  assert.ok(win.__layoutTest, 'app.js must export window.__layoutTest');
  return win.__layoutTest;
}

const { LAYOUT_PRESETS, LAYOUT_META, layoutIcon, selectVisible } = layout();

test('LAYOUT_META and LAYOUT_PRESETS cover the same preset keys', () => {
  assert.deepStrictEqual(Object.keys(LAYOUT_META).sort(), Object.keys(LAYOUT_PRESETS).sort());
});

test('every LAYOUT_META rect fits the 24x16 canvas with positive size', () => {
  for (const [key, m] of Object.entries(LAYOUT_META)) {
    assert.ok(Array.isArray(m.rects) && m.rects.length > 0, `${key} has rects`);
    for (const [x, y, w, h] of m.rects) {
      assert.ok(w > 0 && h > 0, `${key} rect has positive w/h`);
      assert.ok(x >= 0 && y >= 0, `${key} rect origin non-negative`);
      assert.ok(x + w <= 24.001, `${key} rect within width 24`);
      assert.ok(y + h <= 16.001, `${key} rect within height 16`);
    }
  }
});

test('non-auto presets: META rect count mirrors PRESET slot count', () => {
  for (const [key, preset] of Object.entries(LAYOUT_PRESETS)) {
    if (!preset.cols) continue; // auto is adaptive, no fixed slot geometry
    const slots = preset.placement ? preset.placement.length : preset.cols.length * preset.rows.length;
    assert.strictEqual(LAYOUT_META[key].rects.length, slots, `${key}: ${slots} slots ↔ rects`);
  }
});

test('layoutIcon renders one <rect> per slot and embeds real geometry', () => {
  for (const [key, m] of Object.entries(LAYOUT_META)) {
    const svg = layoutIcon(key);
    assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'), `${key} is an <svg>`);
    const rectCount = (svg.match(/<rect/g) || []).length;
    // adaptive presets prepend one dashed frame rect on top of the slot rects
    assert.strictEqual(rectCount, m.rects.length + (m.adaptive ? 1 : 0), `${key} rect count`);
  }
  // geometry actually flows through (single full-canvas cell)
  const single = layoutIcon('1x1');
  assert.ok(single.includes('width="24"') && single.includes('height="16"'));
  assert.ok(layoutIcon('auto').includes('stroke-dasharray'), 'auto gets the dashed adaptive frame');
});

test('layoutIcon returns empty string for an unknown preset', () => {
  assert.strictEqual(layoutIcon('does-not-exist'), '');
});

test('selectVisible: everything visible when count <= slots', () => {
  assert.deepStrictEqual(selectVisible(['a', 'b', 'c'], 4, -1), ['a', 'b', 'c']);
  assert.deepStrictEqual(selectVisible(['a', 'b', 'c', 'd'], 4, 2), ['a', 'b', 'c', 'd']);
});

test('selectVisible: overflow keeps the first `slots` when focus is unset', () => {
  assert.deepStrictEqual(selectVisible(['a', 'b', 'c', 'd', 'e'], 4, -1), ['a', 'b', 'c', 'd']);
});

test('selectVisible: a focused pane past the cut replaces the last visible slot', () => {
  // 'e' (focusIdx 4) would be cut; it displaces the last visible 'd'
  assert.deepStrictEqual(selectVisible(['a', 'b', 'c', 'd', 'e'], 4, 4), ['a', 'b', 'c', 'e']);
});

test('selectVisible: an already-visible focus leaves the window untouched', () => {
  assert.deepStrictEqual(selectVisible(['a', 'b', 'c', 'd', 'e'], 4, 1), ['a', 'b', 'c', 'd']);
});

test('selectVisible: single-slot layout keeps the focused pane, not the first', () => {
  assert.deepStrictEqual(selectVisible(['a', 'b', 'c'], 1, 2), ['c']);
  assert.deepStrictEqual(selectVisible(['a', 'b', 'c'], 1, -1), ['a']);
});

test('selectVisible: does not mutate the input order array', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  selectVisible(order, 4, 4);
  assert.deepStrictEqual(order, ['a', 'b', 'c', 'd', 'e']);
});
