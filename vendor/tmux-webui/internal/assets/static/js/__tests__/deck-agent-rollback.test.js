// deck-agent-rollback.test.js — regression guard for the deck editor's
// save-on-failure contract (finding: edit-sheet mutations were applied
// optimistically to the live cfg before PUT confirmed, with no rollback).
//
// Sentinel: DECK_AGENT_ROLLBACK_REGRESSION_HARNESS (used to assert this file is
// NOT bundled into the Go binary — it lives in a `_`-prefixed dir excluded by
// //go:embed static). This dir has no test framework; run it directly:
//
//     node internal/assets/static/js/__tests__/deck-agent-rollback.test.js
//
// It drives the REAL editMode → sheet → save path through a minimal fake DOM
// (no jsdom) and asserts that a failed save is a no-op on the live cfg. Every
// failure-rollback assertion here FAILS against the pre-fix deck-agent.js, so
// the harness has discriminating power (verified during the fix).
'use strict';
const fs = require('fs');
const path = require('path');

// ── minimal fake DOM ────────────────────────────────────────────────────────
function El(tag) {
  this.tagName = String(tag || '').toUpperCase();
  this._classes = new Set();
  this.attrs = {};
  this.children = [];
  this.style = {};
  this._handlers = {};
  this._text = '';
  this.parentNode = null;
  this.value = '';
  this.type = '';
  this.title = '';
  this.disabled = false;
  const self = this;
  this.classList = {
    add: function () { for (var i = 0; i < arguments.length; i++) self._classes.add(arguments[i]); },
    remove: function () { for (var i = 0; i < arguments.length; i++) self._classes.delete(arguments[i]); },
    toggle: function (c, force) {
      var has = self._classes.has(c);
      var on = (force === undefined) ? !has : !!force;
      if (on) self._classes.add(c); else self._classes.delete(c);
      return on;
    },
    contains: function (c) { return self._classes.has(c); },
  };
}
Object.defineProperty(El.prototype, 'className', {
  get() { return Array.from(this._classes).join(' '); },
  set(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
});
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this._text; },
  set(v) { this._text = v == null ? '' : String(v); this.children = []; },
});
Object.defineProperty(El.prototype, 'innerHTML', {
  get() { return ''; },
  set(v) { if (v === '') this.children = []; },
});
Object.defineProperty(El.prototype, 'offsetWidth', { get() { return 0; } });
El.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function (c) {
  var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c;
};
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return this.attrs[k]; };
El.prototype.addEventListener = function (t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); };
El.prototype.removeEventListener = function () {};
El.prototype.focus = function () {};
El.prototype.click = function () { (this._handlers.click || []).forEach(function (fn) { fn({ target: this }); }, this); };
function matchSel(node, sel) {
  if (sel[0] === '.') return node._classes.has(sel.slice(1));
  if (sel[0] === '[') { var m = sel.match(/^\[([^=]+)="([^"]*)"\]$/); return m ? node.attrs[m[1]] === m[2] : false; }
  return node.tagName === sel.toUpperCase();
}
function walk(node, sel, all, out) {
  for (var i = 0; i < node.children.length; i++) {
    var c = node.children[i];
    if (matchSel(c, sel)) { if (all) out.push(c); else return c; }
    var r = walk(c, sel, all, out);
    if (!all && r) return r;
  }
  return all ? out : null;
}
El.prototype.querySelector = function (sel) { return walk(this, sel, false, null); };
El.prototype.querySelectorAll = function (sel) { return walk(this, sel, true, []); };

// ── globals ─────────────────────────────────────────────────────────────────
var store = {};
global.localStorage = {
  getItem: function (k) { return k in store ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
};
global.location = { pathname: '/' };
// Node exposes a getter-only global.navigator (no `vibrate`); leave it as-is.
global.document = {
  createElement: function (t) { return new El(t); },
  getElementById: function () { return null; },
  body: new El('body'),
  addEventListener: function () {},
  removeEventListener: function () {},
};
var win = global.window = {};
win.tmuxState = { windows: [], sessions: [], currentSession: '', activeWindowIdx: 0, focusedPane: null };
win.tmuxWs = { isConnected: function () { return false; }, send: function () {}, connect: function () {}, disconnect: function () {} };
win.deckDetect = null;
win.confirm = function () { return true; };

// fetch stub — behavior swapped per test.
var fetchMode = 'fail';
var fetchMerged = null;
global.fetch = win.fetch = function () {
  if (fetchMode === 'fail') return Promise.reject(new Error('network blip'));
  if (fetchMode === '400') {
    return Promise.resolve({
      ok: false, status: 400,
      json: function () { return Promise.resolve({ error: 'button payload exceeds 2000 chars' }); },
    });
  }
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(fetchMerged); } });
};

// deckEditor stub — captures the opts the deck hands the sheet.
var lastButtonOpts = null, lastPageOpts = null;
win.deckEditor = {
  showButton: function (opts) { lastButtonOpts = opts; return new El('div'); },
  showPage: function (opts) { lastPageOpts = opts; return new El('div'); },
};

// ── load the real module under test ──────────────────────────────────────────
var target = process.argv[2] || path.join(__dirname, '..', 'deck-agent.js');
var src = fs.readFileSync(target, 'utf8');
(0, eval)(src);

// ── helpers ───────────────────────────────────────────────────────────────
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function ctxStub() { return { closed: false, err: null, close: function () { this.closed = true; }, error: function (m) { this.err = m; }, busy: function () {} }; }
function findRailBtn(root) {
  var all = root.querySelectorAll('.dka-railbtn');
  for (var i = 0; i < all.length; i++) {
    if (!all[i]._classes.has('dka-railbtn-add') && !all[i]._classes.has('dka-railedit')) return all[i];
  }
  return null;
}
function railEditToggle(root) {
  var all = root.querySelectorAll('.dka-railbtn');
  for (var i = 0; i < all.length; i++) if (all[i]._classes.has('dka-railedit')) return all[i];
  return null;
}
function railAddPage(root) {
  var all = root.querySelectorAll('.dka-railbtn');
  for (var i = 0; i < all.length; i++) if (all[i]._classes.has('dka-railbtn-add')) return all[i];
  return null;
}

var failures = [];
function assert(cond, msg) { if (!cond) { failures.push(msg); console.log('  FAIL: ' + msg); } else { console.log('  ok:   ' + msg); } }

function freshCfg() {
  return {
    version: 2, panels: [],
    pages: [
      { id: 'x', type: 'buttons', glyph: '*', label: 'X頁', label_en: 'X',
        buttons: [{ label: 'B0', label_en: 'b0', icon: '»', action: { type: 'input', payload: 'hello' } }] },
      { id: 'y', type: 'buttons', glyph: '#', label: 'Y頁', label_en: 'Y', buttons: [] },
    ],
  };
}

function startEditMode(cfg) {
  var root = new El('div');
  window.deckAgent.start(root, cfg, { compact: true });
  railEditToggle(root).click(); // enter edit mode → grid + rail rebuild
  return root;
}

// ── T1: button REPLACE, save fails → live cfg must be untouched ──────────────
function testButtonReplaceFail() {
  console.log('\n[T1] button edit save-failure rollback');
  var cfg = freshCfg();
  var root = startEditMode(cfg);
  var grid = root.querySelector('.dka-grid');
  var before = clone(cfg.pages);
  grid.children[0].click();          // tap button 0 in edit mode → openButtonSheet('x',0)
  assert(lastButtonOpts, 'button sheet opened');
  fetchMode = 'fail';
  var ctx = ctxStub();
  lastButtonOpts.onSave({ label: 'MUTATED', action: { type: 'input', payload: 'x'.repeat(9999) } }, ctx);
  assert(JSON.stringify(cfg.pages) === JSON.stringify(before),
    'cfg.pages unchanged synchronously after failed save (no optimistic mutation)');
  return new Promise(function (res) {
    setTimeout(function () {
      assert(JSON.stringify(cfg.pages) === JSON.stringify(before), 'cfg.pages still unchanged after failed fetch settles');
      assert(!ctx.closed, 'sheet kept open on failure');
      res();
    }, 20);
  });
}

// ── T2: button DELETE, save fails → live cfg must be untouched ───────────────
function testButtonDeleteFail() {
  console.log('\n[T2] button delete save-failure rollback');
  var cfg = freshCfg();
  var root = startEditMode(cfg);
  var grid = root.querySelector('.dka-grid');
  var before = clone(cfg.pages);
  grid.children[0].click();
  fetchMode = 'fail';
  var ctx = ctxStub();
  lastButtonOpts.onDelete(ctx);
  assert(JSON.stringify(cfg.pages) === JSON.stringify(before), 'cfg.pages unchanged after failed delete (cancelled delete not persisted)');
  return Promise.resolve();
}

// ── T3: page DELETE, save fails → live cfg must be untouched ─────────────────
function testPageDeleteFail() {
  console.log('\n[T3] page delete save-failure rollback');
  var cfg = freshCfg();
  var root = startEditMode(cfg);
  var before = clone(cfg.pages);
  findRailBtn(root).click();         // tap page tab in edit mode → openPageSheet('x')
  assert(lastPageOpts, 'page sheet opened');
  fetchMode = 'fail';
  var ctx = ctxStub();
  lastPageOpts.onDelete(ctx);
  assert(JSON.stringify(cfg.pages) === JSON.stringify(before), 'cfg.pages unchanged after failed page delete');
  return Promise.resolve();
}

// ── T4: NEW page, save fails → live cfg must be untouched ────────────────────
function testNewPageFail() {
  console.log('\n[T4] new page save-failure rollback');
  var cfg = freshCfg();
  var root = startEditMode(cfg);
  var before = clone(cfg.pages);
  railAddPage(root).click();         // tap ＋新頁 → openNewPageSheet
  assert(lastPageOpts, 'new page sheet opened');
  fetchMode = 'fail';
  var ctx = ctxStub();
  lastPageOpts.onSave({ glyph: '§', label: 'New', label_en: '', hidden: false }, ctx);
  assert(cfg.pages.length === before.length, 'cfg.pages count unchanged after failed new-page save');
  return Promise.resolve();
}

// ── T5: 400 (validateDeckConfig) rejects → editor not wedged, cfg untouched ──
function testValidationRejectFail() {
  console.log('\n[T5] server 400 (payload > 2000) rollback — editor not bricked');
  var cfg = freshCfg();
  var root = startEditMode(cfg);
  var grid = root.querySelector('.dka-grid');
  var before = clone(cfg.pages);
  grid.children[0].click();
  fetchMode = '400';
  var ctx = ctxStub();
  lastButtonOpts.onSave({ label: 'HUGE', action: { type: 'input', payload: 'z'.repeat(3000) } }, ctx);
  assert(JSON.stringify(cfg.pages) === JSON.stringify(before), 'cfg.pages has no over-limit button lodged after 400');
  return new Promise(function (res) {
    setTimeout(function () {
      assert(ctx.err && /2000/.test(ctx.err), 'server error surfaced to sheet');
      assert(JSON.stringify(cfg.pages) === JSON.stringify(before), 'a later unrelated save would not re-send the rejected button');
      res();
    }, 20);
  });
}

// ── T6: SUCCESS path still commits the merged server config ──────────────────
function testSuccessCommits() {
  console.log('\n[T6] success path commits merged config');
  var cfg = freshCfg();
  var root = startEditMode(cfg);
  var grid = root.querySelector('.dka-grid');
  grid.children[0].click();
  fetchMode = 'ok';
  fetchMerged = { version: 2, panels: [], pages: [
    { id: 'x', type: 'buttons', glyph: '*', label: 'X頁', buttons: [{ label: 'SERVER', action: { type: 'input', payload: 'ok' } }] },
  ] };
  var ctx = ctxStub();
  lastButtonOpts.onSave({ label: 'CLIENT', action: { type: 'input', payload: 'z' } }, ctx);
  return new Promise(function (res) {
    setTimeout(function () {
      assert(ctx.closed, 'sheet closed on success');
      res();
    }, 20);
  });
}

(async function () {
  await testButtonReplaceFail();
  await testButtonDeleteFail();
  await testPageDeleteFail();
  await testNewPageFail();
  await testValidationRejectFail();
  await testSuccessCommits();
  console.log('\n' + (failures.length ? ('RESULT: ' + failures.length + ' assertion(s) FAILED') : 'RESULT: ALL PASSED'));
  process.exit(failures.length ? 1 : 0);
})();
