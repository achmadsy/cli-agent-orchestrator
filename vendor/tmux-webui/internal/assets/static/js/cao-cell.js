/* Shared fixed-cell metrics for fitting and pointer mapping. */
(() => {
  let cache = new WeakMap();
  function measure(term) {
    const found = cache.get(term); if (found) return found;
    const style = getComputedStyle(term), probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none';
    probe.style.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    probe.style.letterSpacing = style.letterSpacing; probe.textContent = 'XXXXXXXXXXXXXXXXXXXX'; term.append(probe);
    const w = probe.getBoundingClientRect().width / 20; probe.remove();
    const h = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const value = {w:w || 8,h:h || 21}; if (w > 0) cache.set(term,value); return value;
  }
  const invalidate = () => {cache = new WeakMap(); document.querySelectorAll('.pane-terminal').forEach(t => delete t.__cell);};
  window.addEventListener('cao:font-size', invalidate);
  document.fonts?.addEventListener('loadingdone', () => {invalidate();window.dispatchEvent(new Event('cao:font-size'));});
  window.caoCell = {measure,invalidate};
})();
