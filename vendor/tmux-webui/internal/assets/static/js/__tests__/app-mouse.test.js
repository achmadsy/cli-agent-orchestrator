// app-mouse.test.js — posToCell (pixel → 1-based terminal cell) exposed on
// window.__mouseTest. This is the mapping that turns a wheel/click position into
// the (col,row) an SGR mouse report carries. floor+1 (pixel 0 = col 1), floored
// at 1; a wrong offset here means clicks land on the wrong TUI row.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function load() {
  install();
  const win = loadScript(path.join(__dirname, '..', 'app.js'), { tolerant: true });
  assert.ok(win.__mouseTest && typeof win.__mouseTest.posToCell === 'function');
  assert.ok(typeof win.__mouseTest.isTapGesture === 'function');
  return win.__mouseTest;
}
const { posToCell, isTapGesture } = load();

test('top-left pixel maps to cell (1,1)', () => {
  assert.deepStrictEqual(posToCell(0, 0, 8, 18), { col: 1, row: 1 });
});

test('mid-cell rounds down to the containing cell', () => {
  // x=19 with 8px cells → floor(19/8)=2 → col 3; y=40 with 18px → floor(2.2)=2 → row 3
  assert.deepStrictEqual(posToCell(19, 40, 8, 18), { col: 3, row: 3 });
});

test('exact cell boundary belongs to the next cell', () => {
  // x=16 (=2*8) → floor(2)=2 → col 3
  assert.strictEqual(posToCell(16, 0, 8, 18).col, 3);
  assert.strictEqual(posToCell(15, 0, 8, 18).col, 2); // 15/8=1.875 → col 2
});

test('negative / zero cell size never divides-by-zero or goes below 1', () => {
  assert.deepStrictEqual(posToCell(-5, -5, 8, 18), { col: 1, row: 1 });
  assert.deepStrictEqual(posToCell(100, 100, 0, 0), { col: 101, row: 101 }); // cell→1 fallback
});

test('isTapGesture: small + quick = tap', () => {
  assert.ok(isTapGesture(0, 0, 50));
  assert.ok(isTapGesture(8, -8, 700)); // boundary inclusive
});

test('isTapGesture: a swipe (moved) is not a tap', () => {
  assert.ok(!isTapGesture(40, 0, 100));   // horizontal drag
  assert.ok(!isTapGesture(0, 60, 100));   // vertical scroll
  assert.ok(!isTapGesture(9, 0, 100));    // just past the move threshold
});

test('isTapGesture: a long-press is not a tap', () => {
  assert.ok(!isTapGesture(0, 0, 900));
});
