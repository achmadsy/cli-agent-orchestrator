// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
const code = readFileSync(new URL('../../../vendor/tmux-webui/internal/assets/static/js/cao-screen.js', import.meta.url), 'utf8')
function setup({ padding = 0 } = {}) {
  const dom = new JSDOM('<div id="term"></div><button id="jump"></button>', { runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, term = w.document.getElementById('term'), jump = w.document.getElementById('jump')
  term.style.padding = `${padding}px`
  let height = 200, resize, top = 0, id = 0
  const queue = new Map(), timers = new Map()
  Object.defineProperties(term, {
    clientHeight: { get: () => height },
    scrollHeight: { get: () => Math.max(height, term.children.length * 20 + padding * 2) },
    scrollTop: { get: () => Math.max(0, Math.min(top, term.scrollHeight - height)), set: value => { top = Math.max(0, Math.min(value, term.scrollHeight - height)) } },
  })
  w.requestAnimationFrame = fn => { queue.set(++id, fn); return id }
  w.cancelAnimationFrame = id => queue.delete(id)
  w.setTimeout = fn => { timers.set(++id, fn); return id }
  w.clearTimeout = id => timers.delete(id)
  w.ResizeObserver = class { constructor(fn) { resize = fn } observe() {} disconnect() {} }
  w.caoCell = { measure: () => ({ w: 10, h: 20 }) }
  w.tmuxState = { paneInfo: { '%1': { mouse_mode: 0 } } }
  w.caoLineDiffUpdate = (el, text) => { el.replaceChildren(...text.split('\n').map(s => { const d = w.document.createElement('div'); d.textContent = s; return d })) }
  w.fetch = vi.fn()
  w.eval(code)
  const controller = w.createCaoScreen(term, '%1', jump)
  const snapshot = (opts = {}) => ({ content: Array.from({ length: 20 }, (_, i) => 'LIVE_' + i).join('\n'), rows: 20, cols: 80, cursor_y: 19, alternate: false, seq: 1, epoch: 1, boundary: '80x20:false:500', ...opts })
  const tick = () => { const q = [...queue.values()]; queue.clear(); q.forEach(f => f()) }
  const touch = (name, y) => { const e = new w.Event(name); Object.defineProperty(e, 'touches', { value: y == null ? [] : [{ clientY: y }] }); term.dispatchEvent(e) }
  const settle = () => { const q = [...timers.values()]; timers.clear(); q.forEach(f => f()); tick() }
  const keyboard = (height, scale = 1) => { w.__caoViewport = { keyboardHeight: height, scale }; w.dispatchEvent(new w.Event('cao:viewport')); tick() }
  return { w, term, jump, controller, snapshot, tick, touch, settle, keyboard, grow: h => { height = h; resize() } }
}
describe('active screen controller', () => {
  it.each([false, true])('follows the full grid bottom below the cursor during keyboard shrink, alternate=%s', alternate => {
    const s = setup({ padding: 12 }); s.controller.apply(s.snapshot({ alternate, cursor_y: 16 })); s.tick()
    expect(s.term.scrollTop).toBe(164) // unchanged closed cursor anchoring
    s.keyboard(300)
    expect(s.term.scrollTop).toBe(224)
    expect(12 + 20 * 20 - s.term.scrollTop).toBeLessThanOrEqual(200 - 12)
    s.controller.apply(s.snapshot({ seq: 2, alternate, cursor_y: 14 })); s.tick()
    expect(s.term.scrollTop).toBe(224) // cursor movement cannot hide tail
    s.controller.destroy(); s.w.close()
  })
  it('keeps arbitrary and blank grid tails without output-specific classification', () => {
    const s = setup({ padding: 8 }); s.keyboard(300)
    for (const [i, tail] of ['ANY_STATUS', '', 'DIFFERENT_CONTENT'].entries()) {
      s.controller.apply(s.snapshot({ seq: i + 1, cursor_y: 0, content: ['PROMPT', ...Array(18).fill(''), tail].join('\n') })); s.tick()
      expect(s.term.children).toHaveLength(20); expect(s.term.scrollTop).toBe(216)
    }
    s.controller.destroy(); s.w.close()
  })
  it('retains closed and zoom cursor behavior and resets a fitting grid to the top', () => {
    const s = setup({ padding: 12 }); s.controller.apply(s.snapshot({ cursor_y: 16 })); s.tick()
    expect(s.term.scrollTop).toBe(164); s.keyboard(300); expect(s.term.scrollTop).toBe(224)
    s.keyboard(300, 1.5); expect(s.term.scrollTop).toBe(164)
    s.keyboard(0); expect(s.term.scrollTop).toBe(164)
    s.grow(700); s.tick(); s.keyboard(300); expect(s.term.scrollTop).toBe(0)
    s.controller.destroy(); s.w.close()
  })
  it('does not yank a reader but explicit and settled live return restore the grid bottom', () => {
    const s = setup({ padding: 12 }); s.controller.apply(s.snapshot({ cursor_y: 15 })); s.keyboard(300)
    s.touch('touchstart', 40); s.touch('touchmove', 90); s.term.scrollTop -= 50; s.touch('touchend')
    const top = s.term.scrollTop
    s.controller.apply(s.snapshot({ seq: 2, cursor_y: 12 })); s.keyboard(280); expect(s.term.scrollTop).toBe(top)
    s.jump.click(); s.tick(); expect(s.term.scrollTop).toBe(224)
    s.touch('touchstart', 40); s.touch('touchmove', 90); s.term.scrollTop -= 50; s.touch('touchend')
    s.term.scrollTop = 224; s.touch('touchstart', 90); s.touch('touchmove', 40); s.touch('touchend'); s.settle()
    expect(s.controller.reading).toBe(false); expect(s.term.scrollTop).toBe(224)
    s.controller.destroy(); s.w.close()
  })
  it('preserves a live native selection across keyboard viewport changes', () => {
    const s = setup(); s.controller.apply(s.snapshot({ cursor_y: 15 })); s.tick()
    const range = s.w.document.createRange(); range.selectNodeContents(s.term.children[15]); s.w.getSelection().addRange(range)
    const top = s.term.scrollTop; s.keyboard(300)
    expect(s.term.scrollTop).toBe(top); expect(s.w.getSelection().toString()).toBe('LIVE_15')
    s.w.getSelection().removeAllRanges(); s.jump.click(); s.tick(); expect(s.term.scrollTop).toBe(200)
    s.controller.destroy(); s.w.close()
  })
  it('recomputes the live endpoint across buffer, connection, target and keyboard changes', () => {
    const s = setup({ padding: 12 }); s.keyboard(300)
    s.controller.apply(s.snapshot({ cursor_y: 8 })); s.tick(); expect(s.term.scrollTop).toBe(224)
    s.controller.apply(s.snapshot({ seq: 2, epoch: 2, alternate: true, cursor_y: 3 })); s.tick(); expect(s.term.scrollTop).toBe(224)
    s.w.dispatchEvent(new s.w.CustomEvent('cao:connection', { detail: 'connected' }))
    s.controller.apply(s.snapshot({ cursor_y: 10 })); s.tick(); expect(s.term.scrollTop).toBe(224)
    s.controller.resetTarget(); s.keyboard(0)
    s.controller.apply(s.snapshot({ seq: 2, cursor_y: 2 })); s.tick(); expect(s.term.scrollTop).toBe(0)
    s.controller.destroy(); s.keyboard(300); expect(s.term.scrollTop).toBe(0); s.w.close()
  })
  it('keeps a whole bottom cursor row above both terminal paddings with an open keyboard', () => {
    const s = setup({ padding: 12 }); s.controller.apply(s.snapshot()); s.tick()
    const cursorBottom = 12 + 20 * 20 - s.term.scrollTop
    expect(cursorBottom).toBeLessThanOrEqual(s.term.clientHeight - 12)
    expect(s.term.scrollTop).toBe(224)
    s.controller.destroy(); s.w.close()
  })
  it('freezes explicit in-grid reading before another output can pull the viewport back', () => {
    const s = setup(); s.controller.apply(s.snapshot()); s.tick()
    s.touch('touchstart', 50); s.touch('touchmove', 90); s.term.scrollTop -= 40
    s.touch('touchend'); const top = s.term.scrollTop
    s.controller.apply(s.snapshot({ seq: 2, content: s.snapshot().content.replace('LIVE_0', 'NEW_0') })); s.tick()
    expect(s.controller.reading).toBe(true); expect(s.jump.hidden).toBe(false)
    expect(s.term.scrollTop).toBe(top); expect(s.term.textContent).not.toContain('NEW_0')
    s.controller.live(); s.tick(); expect(s.controller.reading).toBe(false); expect(s.term.textContent).toContain('NEW_0')
    s.controller.destroy(); s.w.close()
  })
  it('does not replace history at the bottom while a touch gesture is still active', async () => {
    const s = setup(); s.w.fetch.mockResolvedValue({ ok: true, json: async () => ({ content: Array.from({ length: 50 }, (_, i) => 'HISTORY_' + i).join('\n'), boundary: s.snapshot().boundary }) })
    s.controller.apply(s.snapshot()); s.tick(); s.term.scrollTop = 0
    s.term.dispatchEvent(new s.w.WheelEvent('wheel', { deltaY: -20 })); await new Promise(r => setTimeout(r, 0))
    s.term.scrollTop = s.term.scrollHeight - s.term.clientHeight
    s.touch('touchstart', 120); s.touch('touchmove', 80); s.tick()
    expect(s.controller.reading).toBe(true); expect(s.term.textContent).toContain('HISTORY_')
    s.touch('touchend'); s.settle()
    expect(s.controller.reading).toBe(false); expect(s.term.textContent).not.toContain('HISTORY_')
    s.controller.destroy(); s.w.close()
  })
  it('cancels pending return to live when the gesture reverses and cleans up on destroy', () => {
    const s = setup(); s.controller.apply(s.snapshot()); s.tick()
    s.touch('touchstart', 100); s.touch('touchmove', 140); s.term.scrollTop -= 40; s.touch('touchend')
    s.term.scrollTop = s.term.scrollHeight - s.term.clientHeight
    s.touch('touchstart', 140); s.touch('touchmove', 100); s.touch('touchend')
    s.touch('touchstart', 100); s.touch('touchmove', 140); s.term.scrollTop -= 40; s.touch('touchend'); s.settle()
    expect(s.controller.reading).toBe(true)
    s.controller.destroy(); s.settle(); s.w.close()
  })
  it('preserves manual alternate-grid reading without loading shell history', () => {
    const s = setup({ padding: 8 }); s.controller.apply(s.snapshot({ alternate: true })); s.tick()
    s.touch('touchstart', 30); s.touch('touchmove', 90); s.term.scrollTop -= 50; s.touch('touchend')
    const top = s.term.scrollTop
    s.controller.apply(s.snapshot({ alternate: true, seq: 2, content: 'NEW_ALT\n' + '\n'.repeat(18) })); s.tick()
    expect(s.controller.reading).toBe(true); expect(s.term.scrollTop).toBe(top); expect(s.w.fetch).not.toHaveBeenCalled()
    s.grow(700); s.tick(); expect(s.controller.reading).toBe(true)
    s.jump.click(); s.tick(); expect(s.controller.reading).toBe(false); expect(s.term.textContent).toContain('NEW_ALT')
    s.controller.destroy(); s.w.close()
  })
  it('leaves mouse-mode gestures to the existing program-input owner', () => {
    const s = setup(); s.w.tmuxState.paneInfo['%1'].mouse_mode = 1
    s.controller.apply(s.snapshot()); s.tick()
    s.touch('touchstart', 30); s.touch('touchmove', 90); s.touch('touchend'); s.settle()
    expect(s.controller.reading).toBe(false); expect(s.w.fetch).not.toHaveBeenCalled()
    s.controller.destroy(); s.w.close()
  })
  it('does not resume live after touchcancel or timer teardown', () => {
    const s = setup(); s.controller.apply(s.snapshot()); s.tick()
    s.touch('touchstart', 50); s.touch('touchmove', 90); s.term.scrollTop -= 40; s.touch('touchend')
    s.term.scrollTop = s.term.scrollHeight - s.term.clientHeight
    s.touch('touchstart', 90); s.touch('touchmove', 50); s.touch('touchcancel'); s.settle()
    expect(s.controller.reading).toBe(true)
    s.term.dispatchEvent(new s.w.WheelEvent('wheel', { deltaY: 20 })); s.controller.destroy(); s.settle()
    expect(s.controller.reading).toBe(true); s.w.close()
  })
  it('keeps native selection while a return-to-live timer is pending', () => {
    const s = setup(); s.controller.apply(s.snapshot()); s.tick()
    s.touch('touchstart', 50); s.touch('touchmove', 90); s.term.scrollTop -= 40; s.touch('touchend')
    s.term.scrollTop = s.term.scrollHeight - s.term.clientHeight
    s.term.dispatchEvent(new s.w.WheelEvent('wheel', { deltaY: 20 }))
    const selection = s.w.getSelection(), range = s.w.document.createRange()
    range.selectNodeContents(s.term.firstChild); selection.addRange(range); s.settle()
    expect(s.controller.reading).toBe(true); expect(selection.toString()).toContain('LIVE_0')
    selection.removeAllRanges(); s.jump.click(); s.tick(); expect(s.controller.reading).toBe(false)
    s.controller.destroy(); s.w.close()
  })
  it('does not reuse a previous buffer return timer after a mode transition', () => {
    const s = setup(); s.controller.apply(s.snapshot()); s.tick()
    s.touch('touchstart', 50); s.touch('touchmove', 90); s.term.scrollTop -= 40; s.touch('touchend')
    s.term.scrollTop = s.term.scrollHeight - s.term.clientHeight
    s.term.dispatchEvent(new s.w.WheelEvent('wheel', { deltaY: 20 }))
    s.controller.apply(s.snapshot({ seq: 2, alternate: true, epoch: 2 })); s.tick()
    s.touch('touchstart', 50); s.touch('touchmove', 90); s.touch('touchend'); s.settle()
    expect(s.controller.reading).toBe(true)
    s.controller.destroy(); s.w.close()
  })
  it('retains blank screen rows and never pulls history into keyboard-close growth', () => {
    const s = setup(); s.controller.apply(s.snapshot({ content: 'PROMPT\n' + '\n'.repeat(18), cursor_y: 0 })); s.tick()
    expect(s.term.children).toHaveLength(20); expect(s.term.scrollTop).toBe(0)
    s.grow(700); s.tick(); expect(s.term.scrollTop).toBe(0); expect(s.w.fetch).not.toHaveBeenCalled()
    s.controller.destroy(); s.w.close()
  })
  it('loads history only for explicit upward intent, ignores late same-pane history', async () => {
    const s = setup(); let resolve
    s.w.fetch.mockImplementation(() => new Promise(r => { resolve = r }))
    s.controller.apply(s.snapshot()); s.tick(); s.term.scrollTop = 0
    s.term.dispatchEvent(new s.w.Event('scroll')); expect(s.w.fetch).not.toHaveBeenCalled()
    s.term.dispatchEvent(new s.w.WheelEvent('wheel', { deltaY: -20 })); expect(s.w.fetch).toHaveBeenCalledTimes(1)
    s.controller.live(); resolve({ ok: true, json: async () => ({content:'OLD_SHELL',boundary:s.snapshot().boundary}) })
    await new Promise(r => setTimeout(r, 0)); s.tick()
    expect(s.term.textContent).not.toContain('OLD_SHELL'); expect(s.controller.reading).toBe(false)
    s.controller.destroy(); s.w.close()
  })
  it('never prepends a new history boundary onto a frozen old reader', async () => {
    const s = setup();
    s.w.fetch.mockResolvedValueOnce({ok:true,json:async()=>({content:'OLD_HISTORY',boundary:s.snapshot().boundary})})
    s.controller.apply(s.snapshot());s.term.scrollTop=0;s.term.dispatchEvent(new s.w.WheelEvent('wheel',{deltaY:-20}));await new Promise(r=>setTimeout(r,0))
    s.controller.apply(s.snapshot({seq:2,boundary:'new-boundary'}));s.tick();expect(s.term.textContent).toContain('OLD_HISTORY')
    s.w.fetch.mockResolvedValueOnce({ok:true,json:async()=>({content:'NEW_HISTORY',boundary:'new-boundary'})})
    s.term.scrollTop=0;s.term.dispatchEvent(new s.w.WheelEvent('wheel',{deltaY:-20}));await new Promise(r=>setTimeout(r,0))
    expect(s.w.fetch.mock.calls.at(-1)[0]).toContain('offset=0');expect(s.term.textContent).toBe('NEW_HISTORY')
    s.controller.destroy();s.w.close()
  })
  it('alternate transition bypasses frozen history and blocks paging', async () => {
    const s = setup(); s.w.fetch.mockResolvedValue({ok:true,json:async()=>({content:'SHELL_HISTORY',boundary:s.snapshot().boundary})})
    s.controller.apply(s.snapshot()); s.term.scrollTop = 0
    s.term.dispatchEvent(new s.w.WheelEvent('wheel',{deltaY:-20})); await new Promise(r=>setTimeout(r,0))
    s.controller.apply(s.snapshot({seq:2,epoch:2,alternate:true,content:'TUI\n'+ '\n'.repeat(18)}));s.tick()
    expect(s.term.textContent).not.toContain('SHELL_HISTORY'); const count=s.w.fetch.mock.calls.length
    s.term.dispatchEvent(new s.w.WheelEvent('wheel',{deltaY:-20}));expect(s.w.fetch).toHaveBeenCalledTimes(count)
    s.w.dispatchEvent(new s.w.CustomEvent('cao:connection',{detail:'connected'}))
    s.controller.apply(s.snapshot({seq:1,content:'RECONNECTED'}));s.tick();expect(s.term.textContent).toBe('RECONNECTED')
    s.controller.destroy();s.w.close()
  })
})
