// deck-confirm.js — slide-to-confirm gate for irreversible deck actions (v2 Slice 1).
//
// Replaces window.confirm for buttons with confirm:"slide". The DRAG itself is the
// confidence gate (V2-VISION): you must slide a thumb to >=90% of the track to
// commit; releasing earlier springs back and cancels. This removes the
// "tap = irreversible send" risk by interaction design, so no false-positive
// detection matrix is needed downstream.
//
// Pointer Events + setPointerCapture so the drag survives the finger leaving the
// thumb. touch-action:none on the thumb (CSS) is the hard prerequisite on iPad
// Safari, else the browser steals the gesture to scroll.
(function () {
  'use strict';

  var COMMIT_THRESHOLD = 0.9;

  function teardown(overlay) {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // i18n：跟 deck-agent 讀同一把 localStorage 'deck-lang'（繁中預設）
  function TT(zh, en) {
    var en_ = null;
    try { en_ = localStorage.getItem('deck-lang') === 'en'; } catch (e) {}
    return en_ ? en : zh;
  }

  function show(label, onCommit) {
    var overlay = document.createElement('div');
    overlay.className = 'deck-confirm';

    var panel = document.createElement('div');
    panel.className = 'deck-confirm-panel';

    var title = document.createElement('div');
    title.className = 'deck-confirm-title';
    title.textContent = TT('滑動送出：', 'Slide to send: ') + (label || '');
    panel.appendChild(title);

    var track = document.createElement('div');
    track.className = 'deck-confirm-track';
    var hint = document.createElement('span');
    hint.className = 'deck-confirm-hint';
    hint.textContent = TT('▶▶ 滑到底送出', '▶▶ slide all the way');
    track.appendChild(hint);
    var thumb = document.createElement('div');
    thumb.className = 'deck-confirm-thumb';
    thumb.textContent = '▶';
    track.appendChild(thumb);
    panel.appendChild(track);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'deck-confirm-cancel';
    cancelBtn.textContent = TT('取消', 'Cancel');
    panel.appendChild(cancelBtn);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    var dragging = false, startX = 0, maxX = 0;

    function railWidth() {
      // track inner travel = width - thumb - left/right insets (4px each)
      return Math.max(0, track.clientWidth - thumb.offsetWidth - 8);
    }
    function progressFromX(x) {
      var m = railWidth();
      return m <= 0 ? 0 : Math.max(0, Math.min(1, x / m));
    }
    function setThumb(x) {
      thumb.style.transform = 'translateX(' + x + 'px)';
      var p = progressFromX(x);
      track.style.setProperty('--p', p);
      thumb.classList.toggle('armed', p >= COMMIT_THRESHOLD);
    }
    function springBack() {
      thumb.classList.add('springing');
      setThumb(0);
      thumb.classList.remove('armed');
      window.setTimeout(function () { thumb.classList.remove('springing'); }, 220);
    }

    thumb.addEventListener('pointerdown', function (e) {
      dragging = true;
      startX = e.clientX;
      maxX = railWidth();
      try { thumb.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    thumb.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var x = Math.max(0, Math.min(maxX, e.clientX - startX));
      setThumb(x);
    });
    function close() {
      teardown(overlay);
      document.removeEventListener('keydown', onKey);
    }
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      var x = Math.max(0, Math.min(maxX, (e.clientX || 0) - startX));
      if (progressFromX(x) >= COMMIT_THRESHOLD) {
        close();
        if (typeof onCommit === 'function') onCommit();
      } else {
        springBack();
      }
    }
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', function () { dragging = false; springBack(); });

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);

    return overlay;
  }

  window.deckConfirm = { show: show, COMMIT_THRESHOLD: COMMIT_THRESHOLD };
})();
