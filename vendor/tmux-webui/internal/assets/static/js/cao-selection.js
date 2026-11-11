/* Local rectangular selection of the rendered grid. Never sends terminal input. */
(() => {
  const controllers = new Map();
  let enabled = false, active = null, composing = false, revision = 0;
  const notice = text => window.caoClipboardStatus?.(text);
  const changed = () => window.dispatchEvent(new Event('cao:selection'));
  const editable = target => target instanceof Element && target.id !== 'cao-direct-funnel'
    && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  function clear() {
    enabled = false; active = null; revision++;
    for (const controller of controllers.values()) controller.clear();
    notice(''); changed();
  }
  function valid(controller) {
    return controller.pane === window.tmuxState?.focusedPane
      && window.tmuxWs?.isConnected?.() !== false
      && controller.connection === window.tmuxWs?.connectionId?.();
  }
  function read() {
    if (!active) return null;
    if (!valid(active)) { clear(); return null; }
    if (active.text == null) return null;
    const ticket = revision, controller = active;
    return { text: controller.text, clear: () => { if (revision === ticket && active === controller) clear(); } };
  }
  function setEnabled(value) {
    if (composing) { notice('Finish composing text before selecting an area.'); return; }
    clear(); enabled = !!value;
    for (const controller of controllers.values()) controller.term.classList.toggle('cao-area-mode', enabled);
    if (enabled) {
      if (document.activeElement?.id === 'cao-direct-funnel') document.activeElement.blur();
      notice('Drag an area, or tap two opposite corners on touch screens. Escape cancels.');
    }
    changed();
  }
  // DOM ranges provide actual glyph advances (CJK, emoji, combining marks and
  // styled/symbol spans). UTF-16 offsets locate text only, never terminal columns.
  function extract(lines, left, right) {
    if (!Intl.Segmenter || lines.length > 5000) throw Error('Area is too large or text selection is unsupported.');
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let total = 0, units = 0;
    const output = [];
    for (const line of lines) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT), nodes = [];
      let node, text = '';
      while ((node = walker.nextNode())) {
        if (units + text.length + node.length > 512 * 1024) throw Error('Select a smaller area (maximum 512 KiB of rendered text).');
        nodes.push({ node, start: text.length, end: text.length + node.length }); text += node.data;
      }
      units += text.length;
      if (units > 512 * 1024) throw Error('Select a smaller area (maximum 512 KiB of rendered text).');
      if (text === '​') text = ''; // renderer's otherwise-empty line placeholder
      let result = '', first = 0, last = 0;
      for (const { segment, index } of segmenter.segment(text)) {
        while (nodes[first]?.end <= index) first++;
        last = Math.max(last, first);
        while (nodes[last] && nodes[last].end < index + segment.length) last++;
        if (!nodes[first] || !nodes[last]) continue;
        const range = document.createRange();
        range.setStart(nodes[first].node, index - nodes[first].start);
        range.setEnd(nodes[last].node, index + segment.length - nodes[last].start);
        const rects = [...range.getClientRects()].filter(r => r.width > .01);
        // A grapheme crossing an edge is excluded as a whole, never split.
        if (rects.length && rects.every(r => r.left >= left - .5 && r.right <= right + .5)) result += segment;
      }
      result = result.replace(/ +$/, '');
      total += result.length;
      if (total > 512 * 1024) throw Error('Select a smaller area.');
      output.push(result);
    }
    return output.join('\n');
  }
  function create(term, pane) {
    const box = term.parentElement, listeners = [];
    const listen = (el, name, fn, options) => {
      el.addEventListener(name, fn, options); listeners.push(() => el.removeEventListener(name, fn, options));
    };
    const overlay = document.createElement('div'); overlay.className = 'cao-area-overlay';
    overlay.setAttribute('aria-hidden', 'true'); overlay.hidden = true;
    const highlight = document.createElement('div'); highlight.className = 'cao-area-highlight'; overlay.append(highlight); box.append(overlay);
    let start = null, end = null, pointer = null, firstCorner = false, disposed = false;
    const rows = () => [...term.children].filter(el => el.classList.contains('term-line'));
    const owned = () => enabled || active === controller;
    let suppressClick = false;
    const geometry = () => {
      const lines = rows(); if (!lines.length || lines.length > 5000) return null;
      const rect = term.getBoundingClientRect(), first = lines[0].getBoundingClientRect();
      const cell = window.caoCell?.measure(term);
      if (!cell?.w || !cell?.h) return null;
      const style = getComputedStyle(term);
      return { lines, rect, cell, x: rect.left + (parseFloat(style.paddingLeft) || 0) - term.scrollLeft, y: first.top };
    };
    function point(event) {
      const g = geometry(); if (!g) return null;
      const maxCol = Math.max(0, (window.tmuxState?.paneInfo?.[pane]?.width || Math.floor((term.scrollWidth || g.rect.width) / g.cell.w)) - 1);
      return { col: Math.max(0, Math.min(maxCol, Math.floor((event.clientX - g.x) / g.cell.w))),
        row: Math.max(0, Math.min(g.lines.length - 1, Math.floor((event.clientY - g.y) / g.cell.h))) };
    }
    function bounds() {
      const g = geometry(); if (!g || !start || !end) return null;
      const top = Math.min(start.row, end.row), bottom = Math.max(start.row, end.row);
      const left = g.x + Math.min(start.col, end.col) * g.cell.w;
      const right = g.x + (Math.max(start.col, end.col) + 1) * g.cell.w;
      return { ...g, top, bottom, left, right };
    }
    function draw() {
      const g = bounds(); if (!g) { overlay.hidden = true; return; }
      const parent = box.getBoundingClientRect();
      const width = term.clientWidth || g.rect.width, height = term.clientHeight || g.rect.height;
      Object.assign(overlay.style, { left: `${g.rect.left - parent.left}px`, top: `${g.rect.top - parent.top}px`, width: `${width}px`, height: `${height}px` });
      Object.assign(highlight.style, { left: `${g.left - g.rect.left}px`, top: `${g.y + g.top * g.cell.h - g.rect.top}px`, width: `${g.right - g.left}px`, height: `${(g.bottom - g.top + 1) * g.cell.h}px` });
      overlay.hidden = false;
    }
    function begin(at) {
      observer.takeRecords(); // mutations from before this gesture are not invalidations
      if (active && active !== controller) active.clear();
      revision++; active = controller; controller.text = null;
      controller.connection = window.tmuxWs?.connectionId?.();
      start = end = at; term.classList.add('cao-area-mode');
      // Alt-drag prevents native focus changes. Move focus out of the composer
      // so the same Ctrl/Cmd+C gesture copies this area, not the message draft.
      term.tabIndex = -1; term.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges(); changed(); draw();
    }
    function finish() {
      if (!valid(controller)) { clear(); return; }
      const g = bounds(); if (!g) return;
      try { controller.text = extract(g.lines.slice(g.top, g.bottom + 1), g.left, g.right); notice('Area selected. Use Copy or Ctrl/Cmd+C. Escape cancels.'); }
      catch (error) { clear(); notice(error.message); }
      changed();
    }
    function releasePointer() {
      const id = pointer?.id; pointer = null;
      if (id != null && term.hasPointerCapture?.(id)) term.releasePointerCapture(id);
    }
    const controller = { term, pane, text: null, connection: null,
      clear() { releasePointer(); start = end = null; firstCorner = false; controller.text = null; overlay.hidden = true; term.classList.toggle('cao-area-mode', enabled); },
      destroy() { if (disposed) return; disposed = true; if (active === controller) clear(); controller.clear(); listeners.forEach(remove => remove()); observer.disconnect(); resize?.disconnect(); overlay.remove(); controllers.delete(term); },
    };
    controllers.set(term, controller);
    term.classList.toggle('cao-area-mode', enabled);
    listen(term, 'pointerdown', event => {
      suppressClick = false;
      if (composing || event.isPrimary === false || event.button !== 0 || (!owned() && !event.altKey)) return;
      if (pane !== window.tmuxState?.focusedPane) return;
      if (pointer) { clear(); return; }
      if (window.tmuxWs?.isConnected?.() === false) return;
      const at = point(event); if (!at) return;
      suppressClick = true;
      if (!event.altKey && owned() && !active && document.activeElement?.id === 'cao-direct-funnel') document.activeElement.blur();
      const touch = event.pointerType === 'touch';
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, touch };
      if (!touch) { begin(at); event.preventDefault(); term.setPointerCapture?.(event.pointerId); }
      event.stopImmediatePropagation();
    }, true);
    listen(window, 'pointermove', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (pointer.touch) return; // touch scroll is native; corners are qualified taps
      end = point(event) || end; draw(); event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    listen(window, 'pointerup', event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const down = pointer; releasePointer();
      const at = point(event);
      if (down.touch) {
        if (!at || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8 || event.timeStamp - down.time > 700) return;
        if (!firstCorner) { begin(at); firstCorner = true; notice('Tap the opposite corner of the area.'); }
        else { end = at; firstCorner = false; revision++; draw(); finish(); }
      } else { end = at || end; finish(); }
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    listen(window, 'pointercancel', event => {
      if (pointer?.id !== event.pointerId) return;
      if (pointer.touch) releasePointer(); // native touch scrolling may cancel a pointer
      else clear();
    }, true);
    listen(term, 'lostpointercapture', () => { if (pointer && !pointer.touch) clear(); });
    listen(window, 'blur', () => { if (pointer && !pointer.touch) clear(); });
    listen(term, 'click', event => { if (owned() || suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    listen(term, 'selectstart', event => { if (owned()) event.preventDefault(); });
    listen(term, 'scroll', draw, { passive: true });
    const observer = new MutationObserver(records => {
      const gridChanged = records.some(record => record.target !== term
        ? record.target.parentElement?.closest('.term-line') || record.target instanceof Element && record.target.closest('.term-line')
        : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && node.classList.contains('term-line')));
      if (gridChanged && active === controller) clear();
    });
    observer.observe(term, { childList: true, subtree: true, characterData: true });
    let size = '';
    const resize = window.ResizeObserver && new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect; if (!rect) return;
      const next = `${rect.width}:${rect.height}`;
      if (size && next !== size && active === controller) clear();
      size = next;
    });
    resize?.observe(term);
    return controller;
  }
  window.caoSelection = {
    create, read, setEnabled, clear, get enabled() { return enabled; },
    active: term => !!active && (!term || active.term === term),
    owns: term => enabled || !!active && (!term || active.term === term),
    extract,
  };
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || composing || editable(event.target)) return;
    const native = window.getSelection();
    const anchor = native?.anchorNode instanceof Element ? native.anchorNode : native?.anchorNode?.parentElement;
    if (native?.toString() && !anchor?.closest('.pane-terminal')?.contains(native.focusNode)) return;
    if ((enabled || active) && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); clear(); }
    else if ((enabled || active) && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
      event.preventDefault(); event.stopImmediatePropagation(); window.caoCopySelection?.();
    }
  }, true);
  for (const name of ['cao:connection', 'cao:terminal-reset', 'pagehide', 'cao:font-size']) window.addEventListener(name, clear);
  window.addEventListener('cao:panes', () => { if (active && !valid(active)) clear(); });
})();
