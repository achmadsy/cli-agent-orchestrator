// deck-slider.js — Claude Code permission-mode picker (4 tap pills).
//
// Replaces the earlier horizontal drag-slider. On a touch deck, dragging a thumb
// across a horizontal track to pick one of 4 DISCRETE modes is unintuitive and
// violated the "no horizontal scrollbar on mobile" rule. Now it's 4 tap targets:
// tapping a mode sends the minimal number of Shift-Tab presses to cycle CC there
// from the current mode, and the active mode is highlighted.
//
// Pills left→right follow CC's Shift-Tab cycle order:
//   default(0)  accept(1)  plan(2)  auto(3)
//
// window.deckSlider = { render(container, currentMode), setMode(mode) } — the
// interface is kept stable so deck.js's mount + poll wiring is unchanged.
(function () {
  'use strict';

  var MODES = ['default', 'accept', 'plan', 'auto'];
  var LABEL = { default: 'default', accept: 'accept', plan: 'plan', auto: 'auto' };

  // State shared across the single rendered instance (one picker per page).
  var _currentMode = 'default';
  var _container = null;

  function modeIdx(m) {
    var i = MODES.indexOf(m);
    return i >= 0 ? i : 0;
  }

  // sendTo — cycle CC from the current mode to targetIdx via the minimal number
  // of Shift-Tab presses, then optimistically reflect it (poll's setMode will
  // correct the highlight if detection later disagrees).
  function sendTo(targetIdx) {
    var curIdx = modeIdx(_currentMode);
    var presses = (targetIdx - curIdx + MODES.length) % MODES.length;
    if (presses > 0) {
      var pane = window.tmuxState && window.tmuxState.focusedPane;
      var ws = window.tmuxWs;
      if (ws && ws.isConnected() && pane) {
        for (var i = 0; i < presses; i++) {
          ws.send({ type: 'key', pane: pane, key: 'Tab', modifiers: ['S'] });
        }
      }
    }
    _currentMode = MODES[targetIdx];
    highlight();
  }

  function highlight() {
    if (!_container) return;
    var pills = _container.querySelectorAll('.deck-mode-pill');
    for (var i = 0; i < pills.length; i++) {
      var on = pills[i].getAttribute('data-mode') === _currentMode;
      pills[i].classList.toggle('active', on);
      pills[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  function render(container, currentMode) {
    _currentMode = MODES.indexOf(currentMode) >= 0 ? currentMode : 'default';
    _container = container;
    container.innerHTML = '';
    container.className = 'deck-mode-pills';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'permission mode');

    MODES.forEach(function (m, idx) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'deck-mode-pill mode-' + m + (m === _currentMode ? ' active' : '');
      pill.setAttribute('data-mode', m);
      pill.setAttribute('aria-pressed', m === _currentMode ? 'true' : 'false');
      pill.textContent = LABEL[m] || m;
      pill.title = m + ' mode';
      (function (i) {
        pill.addEventListener('click', function () { sendTo(i); });
      }(idx));
      container.appendChild(pill);
    });
  }

  function setMode(modeStr) {
    // Authoritative update from deckDetect each poll tick.
    var idx = modeIdx(modeStr);
    _currentMode = MODES[idx];
    highlight();
  }

  window.deckSlider = { render: render, setMode: setMode };
})();
