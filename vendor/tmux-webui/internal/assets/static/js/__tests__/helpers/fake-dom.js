// fake-dom.js — a tiny, permissive DOM/window shim for loading the browser
// IIFE modules (link.js, app.js, deck-agent.js) inside `node --test` without
// jsdom. It is NOT a test file (no `*.test.js` suffix) so the runner ignores it.
//
// Each module is a plain <script> that assigns its public surface onto `window`
// (window.linkParsePartyCode, window.__layoutTest, window.deckAgent). loadScript
// evals the real source against these stubs and returns `window`, so a test can
// exercise the SHIPPED function — not a copy.
'use strict';
const fs = require('fs');

function El(tag) {
  this.tagName = String(tag || '').toUpperCase();
  this._classes = new Set();
  this.attrs = {};
  this.dataset = {};
  this.children = [];
  this.style = {};
  this._handlers = {};
  this._text = '';
  this.parentNode = null;
  this.value = '';
  this.type = '';
  this.title = '';
  this.hidden = true;
  this.disabled = false;
  const self = this;
  this.classList = {
    add() { for (let i = 0; i < arguments.length; i++) self._classes.add(arguments[i]); },
    remove() { for (let i = 0; i < arguments.length; i++) self._classes.delete(arguments[i]); },
    toggle(c, force) {
      const has = self._classes.has(c);
      const on = (force === undefined) ? !has : !!force;
      if (on) self._classes.add(c); else self._classes.delete(c);
      return on;
    },
    contains(c) { return self._classes.has(c); },
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
El.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
El.prototype.append = function () { for (let i = 0; i < arguments.length; i++) this.appendChild(arguments[i]); };
El.prototype.removeChild = function (c) {
  const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c;
};
El.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
El.prototype.getAttribute = function (k) { return this.attrs[k]; };
El.prototype.addEventListener = function (t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); };
El.prototype.removeEventListener = function () {};
El.prototype.after = function () {};
El.prototype.focus = function () {};
El.prototype.getBoundingClientRect = function () { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; };
El.prototype.querySelector = function () { return null; };
El.prototype.querySelectorAll = function () { return []; };

// Install fresh globals. `getById` controls whether getElementById returns null
// (default — the modules guard `if (el)`) or a fresh stub element.
function install(opts) {
  opts = opts || {};
  const store = {};
  global.localStorage = {
    getItem(k) { return k in store ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  global.location = { pathname: '/', href: 'http://localhost/', origin: 'http://localhost', search: '' };
  global.document = {
    cookie: '',
    createElement(t) { return new El(t); },
    getElementById() { return opts.getById ? new El('div') : null; },
    addEventListener() {},
    removeEventListener() {},
    body: new El('body'),
    head: new El('head'),
  };
  const win = global.window = {};
  win.addEventListener = function () {};
  win.removeEventListener = function () {};
  win.requestAnimationFrame = function () {};
  win.matchMedia = function () { return { matches: false, addEventListener() {}, addListener() {} }; };
  return win;
}

// Eval a browser script against the installed globals. `tolerant` swallows a
// post-export throw (app.js dereferences real DOM refs far below its exported
// layout section — the export has already run by then).
function loadScript(file, opts) {
  opts = opts || {};
  const src = fs.readFileSync(file, 'utf8');
  try {
    (0, eval)(src);
  } catch (e) {
    if (!opts.tolerant) throw e;
  }
  return global.window;
}

module.exports = { El, install, loadScript };
