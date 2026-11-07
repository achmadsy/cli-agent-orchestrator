// app-slashpalette.test.js — applySlashPalette (§3.5): ui.slashPalette per-tool
// action override. Replacement is wholesale (not deep-merged), scoped to known
// tools; an unknown toolKey is warned + ignored. app.js loads tolerantly.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function load() {
  install();
  const win = loadScript(path.join(__dirname, '..', 'app.js'), { tolerant: true });
  assert.ok(win.__cfgTest && win.__cfgTest.applySlashPalette, 'app.js must export applySlashPalette');
  return win.__cfgTest.applySlashPalette;
}
const applySlashPalette = load();

test('applySlashPalette: replaces a known tool actions wholesale, leaving others', () => {
  const profiles = {
    claude: { actions: [{ l: '/compact', s: '/compact' }, { l: '/clear', s: '/clear' }] },
    codex: { actions: [{ l: '/diff', s: '/diff' }] },
  };
  const out = applySlashPalette(profiles, { claude: { actions: [{ l: '/only', s: '/only' }] } });
  assert.strictEqual(out, profiles); // mutates + returns the same object
  assert.deepStrictEqual(profiles.claude.actions, [{ l: '/only', s: '/only' }]);
  assert.deepStrictEqual(profiles.codex.actions, [{ l: '/diff', s: '/diff' }]);
});

test('applySlashPalette: an empty actions array replaces (clears) the tool', () => {
  const profiles = { claude: { actions: [{ l: '/x', s: '/x' }] } };
  applySlashPalette(profiles, { claude: { actions: [] } });
  assert.deepStrictEqual(profiles.claude.actions, []);
});

test('applySlashPalette: unknown toolKey is warned and ignored', () => {
  const profiles = { claude: { actions: [{ l: '/x', s: '/x' }] } };
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    applySlashPalette(profiles, { bogus: { actions: [{ l: '/z', s: '/z' }] } });
  } finally {
    console.warn = orig;
  }
  assert.ok(!('bogus' in profiles), 'unknown tool is not added');
  assert.deepStrictEqual(profiles.claude.actions, [{ l: '/x', s: '/x' }], 'known tool untouched');
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /bogus/);
});

test('applySlashPalette: null/non-object palette is a no-op', () => {
  const profiles = { claude: { actions: [{ l: '/x', s: '/x' }] } };
  assert.strictEqual(applySlashPalette(profiles, null), profiles);
  assert.strictEqual(applySlashPalette(profiles, 'nope'), profiles);
  assert.deepStrictEqual(profiles.claude.actions, [{ l: '/x', s: '/x' }]);
});

test('applySlashPalette: a tool entry without an actions array is skipped', () => {
  const profiles = { claude: { actions: [{ l: '/x', s: '/x' }] } };
  applySlashPalette(profiles, { claude: { name: 'renamed' } });
  assert.deepStrictEqual(profiles.claude.actions, [{ l: '/x', s: '/x' }]);
});
