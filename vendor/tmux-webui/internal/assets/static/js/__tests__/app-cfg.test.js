// app-cfg.test.js — the window.__UI_CONFIG__ reader (cfgGet) and the UI-config
// pure builders exposed on window.__cfgTest. cfgGet is the single fallback
// gate: a null/partial blob must always resolve to the caller's default so an
// unconfigured install stays byte-identical. app.js is DOM-entangled below the
// export, so it loads tolerantly (the export runs first).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function load() {
  install();
  const win = loadScript(path.join(__dirname, '..', 'app.js'), { tolerant: true });
  assert.ok(win.__cfgTest, 'app.js must export window.__cfgTest');
  return win;
}
const win = load();
const { cfgGet } = win.__cfgTest;

test('cfgGet: a null blob returns the fallback', () => {
  win.__UI_CONFIG__ = null;
  assert.strictEqual(cfgGet('theme.colors.bg', '#000'), '#000');
  assert.strictEqual(cfgGet('keys.quickBar', null), null);
});

test('cfgGet: a missing segment returns the fallback', () => {
  win.__UI_CONFIG__ = { theme: { colors: {} } };
  assert.strictEqual(cfgGet('theme.colors.bg', '#000'), '#000');
  assert.strictEqual(cfgGet('scroll.followGatePx', 60), 60);
});

test('cfgGet: a present value wins, including falsy 0 / false / ""', () => {
  win.__UI_CONFIG__ = {
    theme: { colors: { bg: '#123456' } },
    scroll: { followGatePx: 0 },
    notify: { ttsDefaultEnabled: false },
    relay: { autoPrefixText: '' },
  };
  assert.strictEqual(cfgGet('theme.colors.bg', '#000'), '#123456');
  assert.strictEqual(cfgGet('scroll.followGatePx', 60), 0);
  assert.strictEqual(cfgGet('notify.ttsDefaultEnabled', true), false);
  assert.strictEqual(cfgGet('relay.autoPrefixText', 'x'), '');
});

test('cfgGet: descending through a non-object leaf falls back', () => {
  win.__UI_CONFIG__ = { theme: 'dark' };
  assert.strictEqual(cfgGet('theme.colors.bg', '#000'), '#000');
});

test('cfgGet: an explicit null leaf falls back', () => {
  win.__UI_CONFIG__ = { theme: { fontSize: null } };
  assert.strictEqual(cfgGet('theme.fontSize', 12), 12);
});
