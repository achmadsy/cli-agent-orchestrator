// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

// Run the actual pane scroll controller + renderer. jsdom has no layout, so
// emulate only clamped geometry; real asynchronous scroll is covered in Chrome.
const app = readFileSync(new URL('../../../vendor/tmux-webui/internal/assets/static/js/app.js', import.meta.url), 'utf8')
const paneCode = app.slice(app.indexOf('function buildPaneEl('), app.indexOf('\nfunction setFocus('))
const anchorCode = app.slice(app.indexOf('function histAnchor('), app.indexOf('// posToCell maps'))
const rendererCode = app.slice(app.indexOf('function lineDiffUpdate('), app.indexOf('// 12. WebSocket'))
function setup() {
  const dom = new JSDOM('<div id="pane-container"></div>', { runScripts: 'outside-only' })
  const w = dom.window
  w.__CAO_WORKSPACE__ = true
  w.cfgGet = (_key, fallback) => fallback
  w.detectTool = () => null
  w.esc = value => value
  w.ansiToHtml = value => value
  w.requestAnimationFrame = fn => fn()
  w.eval(`const S = { paneEls: {}, paneInfo: {} };
    const container = document.getElementById('pane-container');
    ${anchorCode}\n${rendererCode}\n${paneCode}
    const box = buildPaneEl({ id: '%1', pane: 0, window_name: 'test', command: 'bash' });
    container.append(box);
    window.scrollTest = { pane: S.paneEls['%1'], setTerminalScroll, lineDiffUpdate };
  `)
  const { pane, setTerminalScroll, lineDiffUpdate } = w.scrollTest
  const terminal = pane.terminal
  let top = 0
  const maximum = () => Math.max(0, terminal.scrollHeight - terminal.clientHeight)
  Object.defineProperties(terminal, {
    clientHeight: { get: () => 600 },
    scrollHeight: { get: () => Math.max(600, terminal.children.length * 24) },
    scrollTop: {
      get: () => (top = Math.min(top, maximum())),
      set: value => { top = Math.max(0, Math.min(value, maximum())) },
    },
  })
  const scroll = () => terminal.dispatchEvent(new w.Event('scroll'))
  const render = lines => lineDiffUpdate(terminal, Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n'))
  render(220)
  setTerminalScroll(terminal, terminal.scrollHeight)
  scroll()
  return { w, pane, terminal, setTerminalScroll, scroll, render }
}

describe('actual terminal scroll controller', () => {
  it('omits only unused blank tail rows after a clear, not internal spacing', () => {
    const { w, terminal } = setup()
    w.scrollTest.lineDiffUpdate(terminal, 'Header\n\nPrompt>\n \t\n\n')
    expect(terminal.children.length).toBe(3)
    expect(terminal.lastChild.textContent).toBe('Prompt>')
    w.__CAO_WORKSPACE__ = false
    w.scrollTest.lineDiffUpdate(terminal, 'Prompt>\n\n')
    expect(terminal.children.length).toBe(3)
    w.close()
  })
  it('does not tag repeated already-at-bottom assignments', () => {
    const { w, pane, terminal, setTerminalScroll, scroll } = setup()
    setTerminalScroll(terminal, terminal.scrollHeight)
    expect(terminal.dataset.caoScrollProg).toBeUndefined()
    terminal.scrollTop -= 200
    scroll()
    expect(pane.scrolledByUser()).toBe(true)
    w.close()
  })
  it('lets reader movement win over an outstanding programmatic event', () => {
    const { w, pane, terminal, setTerminalScroll, scroll } = setup()
    setTerminalScroll(terminal, terminal.scrollTop - 50)
    terminal.scrollTop -= 200
    scroll()
    expect(pane.scrolledByUser()).toBe(true)
    expect(terminal.dataset.caoScrollProg).toBeUndefined()
    w.close()
  })
  it('anchors a /clear-style full rebuild without rearming auto-follow', () => {
    const { w, pane, terminal, scroll, render } = setup()
    terminal.scrollTop -= 200
    scroll()
    const distance = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight
    render(90)
    scroll()
    expect(pane.scrolledByUser()).toBe(true)
    expect(terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight).toBe(distance)
    w.close()
  })
  it('anchors small diffs that otherwise clamp the reader to the bottom', () => {
    const { w, pane, terminal, scroll, render } = setup()
    terminal.scrollTop -= 200
    scroll()
    render(210) // only ten removed rows: takes the incremental diff path
    scroll()
    expect(pane.scrolledByUser()).toBe(true)
    expect(terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight).toBe(200)
    w.close()
  })
  it('preserves paused intent even if a clear clamps all the way to zero', () => {
    const { w, pane, terminal, scroll, render } = setup()
    terminal.scrollTop -= 200
    scroll()
    render(5)
    scroll()
    expect(terminal.scrollTop).toBe(0)
    expect(pane.scrolledByUser()).toBe(true)
    pane.jumpToLive()
    expect(pane.scrolledByUser()).toBe(false)
    w.close()
  })
  it('explicit Jump to live returns to bottom and clears paused intent', () => {
    const { w, pane, terminal, scroll } = setup()
    terminal.scrollTop -= 200
    scroll()
    pane.jumpToLive()
    scroll() // delayed native event after the synchronous jump notification
    expect(pane.scrolledByUser()).toBe(false)
    expect(terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight).toBe(0)
    terminal.scrollTop -= 200
    scroll()
    expect(pane.scrolledByUser()).toBe(true)
    w.close()
  })
})
