// link-parse.test.js — discriminating tests for link.js parsePartyCode, the
// entry validator for "join by code / QR". Exposed as window.linkParsePartyCode.
// Flip any branch (drop the URL parse, the case-fold, or the [A-Z2-9]{4,8}
// gate) and one of these fails.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { install, loadScript } = require('./helpers/fake-dom');

function parse() {
  const win = install();
  win.tmuxState = {}; // link.js: const S = window.tmuxState; then S.clientId = …
  loadScript(path.join(__dirname, '..', 'link.js'));
  return win.linkParsePartyCode;
}

test('exports parsePartyCode after load', () => {
  assert.strictEqual(typeof parse(), 'function');
});

test('bare code passes through, upper-cased', () => {
  const p = parse();
  assert.strictEqual(p('AGUJ'), 'AGUJ');
  assert.strictEqual(p('WXYZ99'), 'WXYZ99');
});

test('case-folds a lowercase bare code', () => {
  const p = parse();
  assert.strictEqual(p('aguj'), 'AGUJ');
  assert.strictEqual(p('  MiXeD9  '), 'MIXED9'); // trims + folds
});

test('extracts ?party= from a share URL (and folds it)', () => {
  const p = parse();
  assert.strictEqual(p('http://localhost:10105/?party=AGUJ'), 'AGUJ');
  assert.strictEqual(p('https://box/deck/?party=abcd&token=x'), 'ABCD');
});

test('4..8 chars only — length bounds enforced', () => {
  const p = parse();
  assert.strictEqual(p('ABC'), '');        // too short
  assert.strictEqual(p('ABCD'), 'ABCD');   // min
  assert.strictEqual(p('ABCDEFGH'), 'ABCDEFGH'); // max
  assert.strictEqual(p('ABCDEFGHI'), '');  // too long
});

test('rejects codes with excluded/illegal glyphs (0,1,punctuation,space)', () => {
  const p = parse();
  assert.strictEqual(p('AB0D'), ''); // 0 not in A-Z2-9
  assert.strictEqual(p('AB1D'), ''); // 1 not in A-Z2-9
  assert.strictEqual(p('AB-D'), '');
  assert.strictEqual(p('AB D'), '');
});

test('garbage / empty / non-code input yields empty string', () => {
  const p = parse();
  assert.strictEqual(p(''), '');
  assert.strictEqual(p('   '), '');
  assert.strictEqual(p(null), '');
  assert.strictEqual(p(undefined), '');
  assert.strictEqual(p('the quick brown fox'), '');
});

test('a URL with no party param yields empty string', () => {
  const p = parse();
  assert.strictEqual(p('https://localhost/?foo=bar'), '');
});
