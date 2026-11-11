// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
const root = '../../../vendor/tmux-webui/internal/assets/'
const source = name => readFileSync(new URL(root + 'static/js/' + name + '.js', import.meta.url), 'utf8')
const template = readFileSync(new URL(root + 'templates/index.html', import.meta.url), 'utf8')
function setup() {
  const dom = new JSDOM(template, { runScripts: 'outside-only', url: 'http://localhost/terminal/v/test/' })
  const w = dom.window, doc = w.document
  const box = doc.createElement('div'), term = doc.createElement('div')
  box.className = 'pane-box'; term.className = 'pane-terminal'; box.append(term); doc.getElementById('pane-container').replaceChildren(box)
  const texts = ['LEFT_A    RIGHT_1', 'LEFT_B    RIGHT_2', 'LEFT_C    RIGHT_3']
  const lines = texts.map(text => { const line = doc.createElement('div'); line.className = 'term-line'; line.textContent = text; term.append(line); return line })
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height })
  box.getBoundingClientRect = () => rect(0, 0, 200, 160)
  term.style.padding = '10px'
  term.getBoundingClientRect = () => rect(0, 0, 200, 160)
  Object.defineProperties(term, { clientWidth: { value: 200 }, clientHeight: { value: 160 } })
  lines.forEach((line, i) => { line.getBoundingClientRect = () => rect(10 - term.scrollLeft, 10 + i * 20 - term.scrollTop, 180, 20) })
  // JSDOM has no layout. Supply measured grapheme geometry explicitly, including
  // double-width CJK/emoji, rather than testing UTF-16-as-columns arithmetic.
  w.Range.prototype.getClientRects = function () {
    const line = this.startContainer.parentElement.closest('.term-line')
    const walker = doc.createTreeWalker(line, w.NodeFilter.SHOW_TEXT)
    let prefix = '', node
    while ((node = walker.nextNode()) && node !== this.startContainer) prefix += node.data
    prefix += this.startContainer.data.slice(0, this.startOffset)
    const cells = text => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
      .reduce((n, { segment }) => n + (/\p{Extended_Pictographic}|[一-鿿]/u.test(segment) ? 2 : 1), 0)
    const left = line.getBoundingClientRect().left + cells(prefix) * 10
    return [rect(left, line.getBoundingClientRect().top, cells(this.toString()) * 10, 20)]
  }
  let captured = false
  term.setPointerCapture = () => { captured = true }
  term.hasPointerCapture = () => captured
  term.releasePointerCapture = () => { captured = false }
  w.caoCell = { measure: () => ({ w: 10, h: 20 }) }
  w.tmuxState = { focusedPane: '%1', paneEls: {} }
  const send = vi.fn(), write = vi.fn().mockResolvedValue(undefined)
  w.tmuxWs = { isConnected: () => true, connectionId: () => 1, send }
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: write } })
  w.eval(source('cao-selection'))
  const controller = w.caoSelection.create(term, '%1')
  w.eval(source('cao-clipboard'))
  let clock = 10
  const pointer = (type, col, row, options = {}) => {
    const event = new w.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, Object.fromEntries(Object.entries({
      clientX: 15 + col * 10 - term.scrollLeft, clientY: 15 + row * 20 - term.scrollTop,
      pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, timeStamp: clock, ...options,
    }).map(([key, value]) => [key, { value }])))
    clock += 30; term.dispatchEvent(event); return event
  }
  const drag = (a = [0, 0], b = [5, 2], alt = false) => {
    if (!alt) w.caoSelection.setEnabled(true)
    pointer('pointerdown', ...a, { altKey: alt }); pointer('pointermove', ...b); pointer('pointerup', ...b)
  }
  const tap = (col, row) => { pointer('pointerdown', col, row, { pointerType: 'touch' }); pointer('pointerup', col, row, { pointerType: 'touch' }) }
  const key = (key, options = {}, target = doc.body) => {
    const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }); target.dispatchEvent(event); return event
  }
  return { w, doc, term, lines, controller, send, write, pointer, drag, tap, key }
}
describe('generic terminal area selection', () => {
  it.each([false, true])('copies only the selected left column, reversed=%s', reversed => {
    const s = setup(); s.drag(reversed ? [5, 2] : [0, 0], reversed ? [0, 0] : [5, 2])
    expect(s.w.caoSelection.read().text).toBe('LEFT_A\nLEFT_B\nLEFT_C')
    expect(s.term.querySelector('.cao-area-overlay')).toBeNull()
    expect(s.doc.querySelector('.cao-area-overlay').hidden).toBe(false)
    expect(s.send).not.toHaveBeenCalled(); s.w.close()
  })
  it('supports right columns, partial text and a temporarily Alt-drag selection', () => {
    const s = setup(); s.drag([10, 0], [16, 2], true)
    expect(s.w.caoSelection.enabled).toBe(false)
    expect(s.w.caoSelection.read().text).toBe('RIGHT_1\nRIGHT_2\nRIGHT_3')
    s.w.caoSelection.clear(); s.drag([1, 0], [3, 1])
    expect(s.w.caoSelection.read().text).toBe('EFT\nEFT'); s.w.close()
  })
  it('preserves internal spaces, blank rows and styled Unicode graphemes without splitting them', () => {
    const s = setup()
    s.lines[0].innerHTML = '<span>A中</span><b>é👩‍💻</b><span> Z</span>'
    s.lines[1].textContent = '​'; s.lines[2].textContent = 'A  B  '
    s.drag([0, 0], [6, 2])
    expect(s.w.caoSelection.read().text).toBe('A中é👩‍💻\n\nA  B')
    // A box containing only half a wide grapheme excludes it, not a surrogate.
    s.w.caoSelection.clear(); s.drag([1, 0], [1, 0])
    expect(s.w.caoSelection.read().text).toBe(''); s.w.close()
  })
  it('Alt-drag moves keyboard focus out of the composer so Ctrl+C copies the selected area', async () => {
    const s = setup(), input = s.doc.getElementById('input')
    input.disabled = false; input.value = 'unsent message'; input.focus()
    s.drag([0, 0], [5, 2], true)
    expect(s.doc.activeElement).toBe(s.term)
    const event = s.key('c', { ctrlKey: true }, s.doc.activeElement)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(s.write).toHaveBeenCalledWith('LEFT_A\nLEFT_B\nLEFT_C'))
    expect(input.value).toBe('unsent message'); expect(s.send).not.toHaveBeenCalled(); s.w.close()
  })
  it('maps scrolled coordinates against rendered row bounds', () => {
    const s = setup(); s.term.scrollTop = 20; s.term.scrollLeft = 10
    s.drag([0, 1], [5, 2]); expect(s.w.caoSelection.read().text).toBe('LEFT_B\nLEFT_C'); s.w.close()
  })
  it('uses two qualified touch corners and leaves scroll gestures unclaimed', () => {
    const s = setup(); s.w.caoSelection.setEnabled(true); s.tap(0, 0)
    expect(s.w.caoSelection.active(s.term)).toBe(true); expect(s.w.caoSelection.read()).toBeNull()
    s.pointer('pointerdown', 0, 0, { pointerType: 'touch' }); s.pointer('pointerup', 0, 2, { pointerType: 'touch' })
    expect(s.w.caoSelection.read()).toBeNull()
    s.tap(5, 2); expect(s.w.caoSelection.read().text).toBe('LEFT_A\nLEFT_B\nLEFT_C')
    expect(s.send).not.toHaveBeenCalled(); s.w.close()
  })
  it.each(['toolbar', 'keyboard', 'native'])('uses identical text for %s copy and clears only after success', async method => {
    const s = setup(); s.drag()
    if (method === 'native') {
      const setData = vi.fn(), event = new s.w.Event('copy', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { setData } }); s.doc.body.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true); expect(setData).toHaveBeenCalledWith('text/plain', 'LEFT_A\nLEFT_B\nLEFT_C')
    } else {
      if (method === 'keyboard') expect(s.key('c', { ctrlKey: true }).defaultPrevented).toBe(true)
      else [...s.doc.querySelectorAll('button')].find(b => b.textContent === 'Copy').click()
      await vi.waitFor(() => expect(s.w.caoSelection.active()).toBe(false))
      expect(s.write).toHaveBeenCalledWith('LEFT_A\nLEFT_B\nLEFT_C')
    }
    expect(s.w.caoSelection.active()).toBe(false); expect(s.send).not.toHaveBeenCalled(); s.w.close()
  })
  it('preserves an area on clipboard failure and never clears a newer selection after async copy', async () => {
    const s = setup(); s.drag(); s.write.mockRejectedValueOnce(Error('denied'))
    await s.w.caoCopySelection(); expect(s.w.caoSelection.active()).toBe(true)
    let resolve; s.write.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const copying = s.w.caoCopySelection(); s.drag([10, 0], [16, 2]); resolve(); await copying
    expect(s.w.caoSelection.read().text).toContain('RIGHT_1'); s.w.close()
  })
  it('does not take composer copy, normal native selection or composing Escape', () => {
    const s = setup(); s.drag()
    expect(s.key('c', { ctrlKey: true }, s.doc.getElementById('input')).defaultPrevented).toBe(false)
    expect(s.key('Escape', { isComposing: true }).defaultPrevented).toBe(false)
    expect(s.w.caoSelection.active()).toBe(true)
    expect(s.key('Escape').defaultPrevented).toBe(true); expect(s.w.caoSelection.active()).toBe(false)
    const range = s.doc.createRange(); range.selectNodeContents(s.lines[0]); s.w.getSelection().addRange(range)
    s.pointer('pointerdown', 0, 0); expect(s.w.getSelection().toString()).toBe('LEFT_A    RIGHT_1'); s.w.close()
  })
  it.each(['cao:connection', 'cao:terminal-reset', 'cao:font-size', 'pagehide'])('clears on %s', name => {
    const s = setup(); s.drag(); s.w.dispatchEvent(new s.w.Event(name)); expect(s.w.caoSelection.read()).toBeNull(); s.w.close()
  })
  it('does not invalidate a completed selection when the iframe loses focus to its parent toolbar', () => {
    const s = setup(); s.drag(); s.w.dispatchEvent(new s.w.Event('blur'))
    expect(s.w.caoSelection.read().text).toContain('LEFT_A'); s.w.close()
  })
  it('cancels an active drag on pointer cancellation without leaking the following click', () => {
    const s = setup(); s.w.caoSelection.setEnabled(true)
    const clicked = vi.fn(); s.term.addEventListener('click', clicked)
    s.pointer('pointerdown', 0, 0); s.pointer('pointercancel', 0, 0); s.pointer('click', 0, 0)
    expect(s.w.caoSelection.active()).toBe(false); expect(clicked).not.toHaveBeenCalled(); s.w.close()
  })
  it('retains the first touch corner when native scrolling cancels its pointer', () => {
    const s = setup(); s.w.caoSelection.setEnabled(true); s.tap(0, 0)
    s.pointer('pointerdown', 0, 1, { pointerType: 'touch' }); s.pointer('pointercancel', 0, 1, { pointerType: 'touch' })
    s.tap(5, 2); expect(s.w.caoSelection.read().text).toBe('LEFT_A\nLEFT_B\nLEFT_C'); s.w.close()
  })
  it('refuses stale pane/connection state and destroys overlays and listeners', () => {
    const s = setup(); s.drag(); s.w.tmuxWs.connectionId = () => 2; expect(s.w.caoSelection.read()).toBeNull()
    s.drag(); s.w.tmuxState.focusedPane = '%2'; s.w.dispatchEvent(new s.w.Event('cao:panes'))
    expect(s.w.caoSelection.active()).toBe(false)
    s.controller.destroy(); expect(s.doc.querySelector('.cao-area-overlay')).toBeNull(); s.w.close()
  })
  it('invalidates on rendered row changes but ignores temporary measurement probes', async () => {
    const s = setup(); s.drag(); await Promise.resolve()
    const probe = s.doc.createElement('span'); probe.textContent = 'XXXXXXXX'; s.term.append(probe); probe.remove(); await Promise.resolve()
    expect(s.w.caoSelection.active()).toBe(true)
    s.lines[0].textContent = 'replacement'; await Promise.resolve(); expect(s.w.caoSelection.active()).toBe(false); s.w.close()
  })
  it('bounds extraction and never interprets selected text as HTML', () => {
    const s = setup(); s.lines[0].textContent = '<img> & text'; s.drag([0, 0], [11, 0])
    expect(s.w.caoSelection.read().text).toBe('<img> & text'); expect(s.term.querySelector('img')).toBeNull()
    expect(() => s.w.caoSelection.extract(Array(5001).fill(s.lines[0]), 0, 100)).toThrow(); s.w.close()
  })
})
