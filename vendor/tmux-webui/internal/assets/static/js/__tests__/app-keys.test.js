// app-keys.test.js — buildQuickBar (§3.5), the DOM-pure builder behind the
// ui.keys.quickBar override. It must reproduce the server-rendered .qbtn shape
// (class + data-key + label + optional .qico span) so keys wiring and the
// data-key color CSS keep matching. app.js loads tolerantly (export runs first).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function load() {
  install();
  const win = loadScript(path.join(__dirname, '..', 'app.js'), { tolerant: true });
  assert.ok(win.__cfgTest && win.__cfgTest.buildQuickBar, 'app.js must export buildQuickBar');
  return win.__cfgTest.buildQuickBar;
}
const buildQuickBar = load();

test('buildQuickBar: one .qbtn per item, carrying key/label/title', () => {
  const btns = buildQuickBar([
    { key: 'Escape', label: 'Esc', icon: '⎋', title: 'Escape' },
    { key: 'Enter', label: 'Enter' },
  ]);
  assert.strictEqual(btns.length, 2);
  assert.strictEqual(btns[0].className, 'qbtn');
  assert.strictEqual(btns[0].type, 'button');
  assert.strictEqual(btns[0].dataset.key, 'Escape');
  assert.strictEqual(btns[0].title, 'Escape');
  assert.strictEqual(btns[0].textContent, 'Esc');
});

test('buildQuickBar: icon becomes a trailing .qico span; absent icon = no child', () => {
  const btns = buildQuickBar([
    { key: 'Escape', label: 'Esc', icon: '⎋' },
    { key: 'Enter', label: 'Enter' },
  ]);
  assert.strictEqual(btns[0].children.length, 1);
  assert.strictEqual(btns[0].children[0].className, 'qico');
  assert.strictEqual(btns[0].children[0].textContent, '⎋');
  assert.strictEqual(btns[1].children.length, 0);
});

test('buildQuickBar: label falls back to key when omitted', () => {
  const btns = buildQuickBar([{ key: 'Tab' }]);
  assert.strictEqual(btns[0].textContent, 'Tab');
  assert.strictEqual(btns[0].dataset.key, 'Tab');
});

test('buildQuickBar: empty array renders nothing', () => {
  assert.deepStrictEqual(buildQuickBar([]), []);
});
