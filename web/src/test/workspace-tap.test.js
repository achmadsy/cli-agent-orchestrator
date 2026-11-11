// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
const app = readFileSync(new URL('../../../vendor/tmux-webui/internal/assets/static/js/app.js', import.meta.url), 'utf8')
const panes = app.slice(app.indexOf('function buildPaneEl('), app.indexOf('\nfunction setFocus('))
const taps = app.slice(app.indexOf('function isTapGesture('), app.indexOf('// measureCell measures'))
function setup(mouse = false) {
  const dom = new JSDOM('<div id="pane-container"></div>', { runScripts: 'outside-only' })
  const w = dom.window, send = vi.fn(), focus = vi.fn(), type = vi.fn()
  w.cfgGet = (_, f) => f; w.detectTool = () => null; w.esc = String
  w.requestAnimationFrame = fn => fn(); w.tmuxWs = { send }; w.caoDirectTapToType = type
  w.setFocus = focus
  w.eval(`const S = { paneEls: {}, paneInfo: {} }; const container = document.getElementById('pane-container');
    function eventCell() { return { col: 1, row: 1 }; }
    ${taps}\n${panes}\ncontainer.append(buildPaneEl({ id:'%1',pane:0,window_name:'test',command:'bash',mouse_mode:${mouse} }));`)
  const term = w.document.querySelector('.pane-terminal')
  let clock = 10
  const pointer = (name, overrides = {}) => {
    const e = new w.Event(name, { bubbles: true, cancelable: true })
    Object.defineProperties(e, Object.fromEntries(Object.entries({ clientX: 30, clientY: 30, button: 0,
      pointerId: 1, isPrimary: true, timeStamp: clock, ...overrides }).map(([k,v]) => [k,{ value:v }])))
    clock += 30; term.dispatchEvent(e)
  }
  return { w, term, send, focus, type, pointer }
}
describe('real terminal tap qualification', () => {
  it('plain-shell tap selects pane and requests typing without injecting input', () => {
    const s = setup(); s.pointer('pointerdown'); s.pointer('pointerup'); s.pointer('click')
    expect(s.focus).toHaveBeenCalledWith('%1'); expect(s.type).toHaveBeenCalledOnce()
    expect(s.send).not.toHaveBeenCalled(); s.w.close()
  })
  it('mouse-mode tap still injects exactly one press/release pair', () => {
    const s = setup(true); s.pointer('pointerdown'); s.pointer('pointerup'); s.pointer('click')
    expect(s.type).toHaveBeenCalledOnce()
    expect(s.send.mock.calls.map(([m]) => m.mphase)).toEqual(['press','release'])
    s.w.close()
  })
  it('area mode never injects a TUI click or summons Direct typing', () => {
    const s = setup(true); s.w.caoSelection = { owns: () => true }
    s.pointer('pointerdown'); s.pointer('pointerup'); s.pointer('click')
    expect(s.send).not.toHaveBeenCalled(); expect(s.type).not.toHaveBeenCalled(); s.w.close()
  })
  it.each(['drag', 'cancel', 'long', 'right', 'multi', 'selection'])('does not focus typing on %s', kind => {
    const s = setup()
    s.pointer('pointerdown', kind === 'right' ? { button: 2 } : {})
    if (kind === 'drag') s.pointer('pointermove', { clientY: 100 })
    if (kind === 'cancel') s.pointer('pointercancel')
    if (kind === 'multi') s.pointer('pointerdown', { pointerId: 2, isPrimary: false })
    if (kind === 'selection') {
      s.term.textContent = 'selected text'; const r = s.w.document.createRange(); r.selectNodeContents(s.term)
      s.w.getSelection().addRange(r)
    }
    s.pointer('pointerup', kind === 'long' ? { timeStamp: 900 } : {})
    s.pointer('click')
    expect(s.type).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled(); s.w.close()
  })
})
