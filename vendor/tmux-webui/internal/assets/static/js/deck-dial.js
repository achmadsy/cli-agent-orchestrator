/* deck-dial.js — vertical SCRUB STRIP for focused pane terminal scrollback.
 *
 * CHOSEN: option (b) — vertical scrub strip replacing the rotation dial.
 * WHY: Stream Deck+ community verdict — dials suit continuous values (volume,
 * brightness); text scroll is positional, not rotational. A tall touch track
 * where absolute finger Y maps to scrollTop fraction matches the mental model
 * of a scrollbar you can fling. The dial's "nudge 3 lines per 30° detent"
 * problem (fiddly, no sense of position) disappears: you touch at 80% height
 * and the terminal jumps to 80% of scrollHeight. Fling to top = touch near
 * top label; jump-to-bottom = tap the bottom "⬇" label (preserved intent).
 *
 * PURE FRONTEND DOM SCROLL — zero WS calls, zero key events.
 * IIFE; exports window.deckDial = { render(container) }
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* constants                                                            */
  /* ------------------------------------------------------------------ */

  var STRIP_W      = 44;    /* px — touch-friendly width */
  var STRIP_H      = 200;   /* px — tall track */
  var THUMB_H      = 32;    /* px — draggable knob height */
  var THUMB_HALF   = THUMB_H / 2;
  var TRACK_TOP    = 20;    /* px — space for top label */
  var TRACK_BOT    = 20;    /* px — space for bottom label */
  var TRACK_H      = STRIP_H - TRACK_TOP - TRACK_BOT;
  /* usable travel for thumb centre */
  var TRAVEL       = TRACK_H - THUMB_H;
  var TAP_MAX_PX   = 8;     /* max travel to count as a tap on label */

  /* ------------------------------------------------------------------ */
  /* dom helpers                                                          */
  /* ------------------------------------------------------------------ */

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var k in attrs) {
      if (attrs.hasOwnProperty(k)) {
        if (k === 'class') { node.className = attrs[k]; }
        else { node.setAttribute(k, attrs[k]); }
      }
    }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* state access                                                         */
  /* ------------------------------------------------------------------ */

  function getFocusedTerminal() {
    var ts = global.tmuxState;
    if (!ts || !ts.focusedPane) return null;
    var pane = ts.paneEls && ts.paneEls[ts.focusedPane];
    if (!pane || !pane.terminal) return null;
    return pane;
  }

  /* 0..1 — how far scrolled (0 = top, 1 = bottom) */
  function getScrollFraction(term) {
    var max = term.scrollHeight - term.clientHeight;
    if (max <= 0) return 1;
    return Math.min(1, term.scrollTop / max);
  }

  /* ------------------------------------------------------------------ */
  /* build widget DOM                                                     */
  /* ------------------------------------------------------------------ */

  function buildStrip() {
    var wrap = el('div', {
      'class': 'deck-scrub-wrap',
      style: [
        'position:relative',
        'width:'  + STRIP_W + 'px',
        'height:' + STRIP_H + 'px',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'user-select:none',
        '-webkit-user-select:none',
        'touch-action:none'
      ].join(';')
    });

    /* top label — tap = jump to top */
    var lblTop = el('div', {
      'class': 'deck-scrub-lbl deck-scrub-lbl--top',
      style: [
        'height:' + TRACK_TOP + 'px',
        'line-height:' + TRACK_TOP + 'px',
        'font-size:10px',
        'color:var(--dial-tick,rgba(255,255,255,0.45))',
        'text-align:center',
        'width:100%',
        'cursor:pointer'
      ].join(';')
    }, '▲'); /* ▲ */

    /* track background */
    var track = el('div', {
      'class': 'deck-scrub-track',
      style: [
        'position:relative',
        'width:12px',
        'height:' + TRACK_H + 'px',
        'border-radius:6px',
        'background:var(--dial-ring,rgba(255,255,255,0.14))',
        'flex-shrink:0'
      ].join(';')
    });

    /* fill bar — shows how far DOWN we are (grows from top) */
    var fill = el('div', {
      'class': 'deck-scrub-fill',
      style: [
        'position:absolute',
        'top:0',
        'left:0',
        'right:0',
        'border-radius:6px',
        'background:var(--dial-thumb,rgba(255,255,255,0.55))',
        'height:0%',
        'transition:height 0.08s ease',
        'pointer-events:none'
      ].join(';')
    });

    /* thumb knob — floating over the track */
    var thumb = el('div', {
      'class': 'deck-scrub-thumb',
      style: [
        'position:absolute',
        'left:50%',
        'transform:translateX(-50%)',
        'width:' + STRIP_W + 'px',
        'height:' + THUMB_H + 'px',
        'border-radius:8px',
        'background:var(--dial-center,rgba(255,255,255,0.12))',
        'border:1.5px solid var(--dial-thumb,rgba(255,255,255,0.70))',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'box-sizing:border-box',
        'cursor:grab',
        'top:0px'
      ].join(';')
    });
    /* grip lines inside thumb */
    thumb.appendChild(el('div', {
      style: [
        'width:18px',
        'height:2px',
        'border-radius:1px',
        'background:var(--dial-thumb,rgba(255,255,255,0.65))',
        'box-shadow:0 4px 0 var(--dial-thumb,rgba(255,255,255,0.65)),0 -4px 0 var(--dial-thumb,rgba(255,255,255,0.65))'
      ].join(';')
    }));

    track.appendChild(fill);
    track.appendChild(thumb);

    /* bottom label — tap = jump to bottom */
    var lblBot = el('div', {
      'class': 'deck-scrub-lbl deck-scrub-lbl--bot',
      style: [
        'height:' + TRACK_BOT + 'px',
        'line-height:' + TRACK_BOT + 'px',
        'font-size:10px',
        'color:var(--dial-tick,rgba(255,255,255,0.45))',
        'text-align:center',
        'width:100%',
        'cursor:pointer'
      ].join(';')
    }, '▼'); /* ▼ */

    wrap.appendChild(lblTop);
    wrap.appendChild(track);
    wrap.appendChild(lblBot);

    return { wrap: wrap, track: track, thumb: thumb, fill: fill, lblTop: lblTop, lblBot: lblBot };
  }

  /* ------------------------------------------------------------------ */
  /* position thumb + fill from fraction 0..1                            */
  /* ------------------------------------------------------------------ */

  function applyFraction(thumb, fill, frac) {
    var clamped = Math.max(0, Math.min(1, frac));
    /* thumb top relative to track */
    var thumbTop = clamped * TRAVEL;
    thumb.style.top = thumbTop + 'px';
    /* fill height = fraction of track */
    fill.style.height = (clamped * 100).toFixed(1) + '%';
  }

  /* ------------------------------------------------------------------ */
  /* attach interaction                                                   */
  /* ------------------------------------------------------------------ */

  function attachHandlers(parts) {
    var track  = parts.track;
    var thumb  = parts.thumb;
    var fill   = parts.fill;
    var lblTop = parts.lblTop;
    var lblBot = parts.lblBot;

    var dragging  = false;
    var startY    = 0;
    var startFrac = 0;

    /* convert clientY to fraction along TRAVEL */
    function clientYToFrac(clientY) {
      var rect = track.getBoundingClientRect();
      /* finger position relative to track origin, then subtract half-thumb */
      var y    = clientY - rect.top - THUMB_HALF;
      return Math.max(0, Math.min(1, y / TRAVEL));
    }

    /* apply fraction → scroll terminal */
    function seekToFrac(frac) {
      var pane = getFocusedTerminal();
      if (!pane) return;
      var term = pane.terminal;
      var max  = term.scrollHeight - term.clientHeight;
      if (max <= 0) return;
      term.scrollTop = frac * max;
      applyFraction(thumb, fill, frac);
    }

    /* ---- drag on the track / thumb ---- */
    track.addEventListener('pointerdown', function (e) {
      dragging  = true;
      startY    = e.clientY;
      startFrac = clientYToFrac(e.clientY);
      track.setPointerCapture(e.pointerId);
      thumb.style.cursor = 'grabbing';
      /* immediate seek on touch */
      seekToFrac(startFrac);
      e.preventDefault();
    });

    track.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      seekToFrac(clientYToFrac(e.clientY));
      e.preventDefault();
    });

    function onEnd(e) {
      if (!dragging) return;
      dragging = false;
      track.releasePointerCapture(e.pointerId);
      thumb.style.cursor = 'grab';
    }
    track.addEventListener('pointerup',     onEnd);
    track.addEventListener('pointercancel', onEnd);

    /* ---- tap labels ---- */
    lblTop.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      /* track tap travel to avoid false fires on scroll-then-release */
      var sy = e.clientY;
      function onUp(ev) {
        lblTop.removeEventListener('pointerup',     onUp);
        lblTop.removeEventListener('pointercancel', onUp);
        var dy = Math.abs(ev.clientY - sy);
        if (dy < TAP_MAX_PX) {
          var pane = getFocusedTerminal();
          if (pane) { pane.terminal.scrollTop = 0; }
          applyFraction(thumb, fill, 0);
        }
      }
      lblTop.addEventListener('pointerup',     onUp);
      lblTop.addEventListener('pointercancel', onUp);
      e.preventDefault();
    });

    lblBot.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      var sy = e.clientY;
      function onUp(ev) {
        lblBot.removeEventListener('pointerup',     onUp);
        lblBot.removeEventListener('pointercancel', onUp);
        var dy = Math.abs(ev.clientY - sy);
        if (dy < TAP_MAX_PX) {
          var pane = getFocusedTerminal();
          if (pane) {
            pane.terminal.scrollTop = pane.terminal.scrollHeight;
            if (typeof pane.resetScroll === 'function') { pane.resetScroll(); }
          }
          applyFraction(thumb, fill, 1);
        }
      }
      lblBot.addEventListener('pointerup',     onUp);
      lblBot.addEventListener('pointercancel', onUp);
      e.preventDefault();
    });
  }

  /* ------------------------------------------------------------------ */
  /* live sync — poll scrollTop to keep thumb in sync when content       */
  /* scrolls outside this widget (e.g., auto-scroll on new output)       */
  /* ------------------------------------------------------------------ */

  function startSyncLoop(thumb, fill) {
    var lastFrac = -1;
    function tick() {
      var pane = getFocusedTerminal();
      if (pane) {
        var frac = getScrollFraction(pane.terminal);
        if (Math.abs(frac - lastFrac) > 0.005) {
          applyFraction(thumb, fill, frac);
          lastFrac = frac;
        }
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                           */
  /* ------------------------------------------------------------------ */

  function render(container) {
    var parts = buildStrip();
    attachHandlers(parts);
    startSyncLoop(parts.thumb, parts.fill);
    container.appendChild(parts.wrap);
  }

  global.deckDial = { render: render };

}(window));
