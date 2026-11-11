// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
const code = readFileSync(new URL('../../../vendor/tmux-webui/internal/assets/static/js/cao-autofit.js', import.meta.url), 'utf8')
function setup() {
  const dom = new JSDOM('<div id="pane-container"></div>', { runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window, sends = [], statuses = []
  let timer, heartbeat, resize, connected = true, focused = true, dims = { cols: 120, rows: 35 }
  w.document.hasFocus = () => focused
  w.matchMedia = () => ({ matches: false })
  w.setTimeout = fn => { timer = fn; return 1 }
  w.clearTimeout = () => { timer = null }
  w.setInterval = fn => { heartbeat = fn; return 2 }
  w.clearInterval = () => { heartbeat = null }
  w.ResizeObserver = class { observe() { resize = () => this.fn() } disconnect() { resize = null } constructor(fn) { this.fn = fn } }
  w.tmuxState = { focusedPane: '%1', paneInfo: { '%1': { window_panes: 1 } } }
  w.tmuxWs = { isConnected: () => connected, send: msg => sends.push(JSON.parse(JSON.stringify(msg))) }
  w.eval(code)
  const controller = w.createCaoAutoFit({ measure: () => dims, report: s => statuses.push(s) })
  const fire = (name, detail) => w.dispatchEvent(new w.CustomEvent(name, { detail }))
  const tick = () => { const fn = timer; timer = null; fn?.() }
  const ack = state => fire('cao:sizing', { state, resize_seq: sends.at(-1)?.resize_seq })
  return { w, controller, sends, statuses, tick, fire, ack,
    resize: () => resize?.(), heartbeat: () => heartbeat?.(),
    setDims: d => { dims = d }, setFocus: f => { focused = f }, setConnected: c => { connected = c } }
}

describe('actual workspace auto-fit controller', () => {
  it('fits on stable initial layout and deduplicates observer events', () => {
    const s = setup(); s.tick()
    expect(s.sends.map(m => [m.auto, m.cols, m.rows])).toEqual([[true, 120, 35]])
    s.ack('owned')
    s.resize(); s.resize(); s.tick()
    expect(s.sends.length).toBe(1)
    s.setDims({ cols: 150, rows: 40 }); s.resize(); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 150, rows: 40, auto: true })
    expect(s.sends.every(m => m.type === 'resize')).toBe(true)
    s.controller.destroy(); s.w.close()
  })
  it('invalidates retained touch rows for intentional composer layout changes only', () => {
    const s = setup(); s.w.matchMedia = () => ({ matches: true }); s.tick(); s.ack('owned')
    s.setDims({ cols: 120, rows: 38 }); s.resize(); s.tick()
    expect(s.sends).toHaveLength(1) // ordinary same-width jitter retains rows
    s.fire('cao:terminal-layout'); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 120, rows: 38 })
    s.ack('owned')
    s.w.__caoViewport = { keyboardHeight: 250, scale: 1 }; s.fire('cao:viewport'); s.tick()
    const count = s.sends.length
    s.setDims({ cols: 120, rows: 42 }); s.fire('cao:terminal-layout'); s.tick()
    expect(s.sends).toHaveLength(count) // hide/show never bypasses keyboard pause
    s.controller.destroy(); s.w.close()
  })
  it('measures intentional Direct layout synchronously before a keyboard resize can arrive', () => {
    const s = setup(); s.tick(); s.ack('owned')
    s.setDims({ cols: 120, rows: 38 }); s.fire('cao:terminal-layout')
    expect(s.sends.at(-1)).toMatchObject({ cols: 120, rows: 38, auto: true, takeover: false })
    s.controller.destroy(); s.w.close()
  })
  it('never lets synchronous Direct layout bypass focus, composition, disabled or topology gates', () => {
    for (const gate of ['focus','composition','disabled','shared','zoom','keyboard']) {
      const s = setup(); s.tick(); s.ack('owned')
      if (gate === 'focus') s.setFocus(false)
      if (gate === 'composition') s.w.document.dispatchEvent(new s.w.Event('compositionstart'))
      if (gate === 'disabled') s.controller.setEnabled(false)
      if (gate === 'shared') s.w.tmuxState.paneInfo['%1'].window_panes = 2
      if (gate === 'zoom') s.w.__caoViewport = { keyboardHeight: 0, scale: 1.5 }
      if (gate === 'keyboard') s.w.__caoViewport = { keyboardHeight: 250, scale: 1 }
      const n = s.sends.filter(m => m.cols).length
      s.setDims({ cols: 120, rows: 38 }); s.fire('cao:terminal-layout')
      expect(s.sends.filter(m => m.cols)).toHaveLength(n)
      s.controller.destroy(); s.w.close()
    }
  })
  it('renews claims without replaying geometry and fits after acquiring ownership', () => {
    const s = setup(); s.tick(); s.ack('other_viewer')
    s.heartbeat()
    expect(s.sends.at(-1).cols).toBeUndefined()
    s.ack('owned'); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ auto: true, cols: 120, rows: 35 })
    s.controller.destroy(); s.w.close()
  })
  it('freezes sizing for keyboard/zoom/IME and resumes from current measurement', () => {
    const s = setup(); s.tick(); s.ack('owned')
    s.w.__caoViewport = { keyboardHeight: 250, scale: 1 }; s.fire('cao:viewport'); s.tick()
    expect(s.sends.at(-1).release).toBe(true)
    const n = s.sends.length
    s.resize(); s.heartbeat(); s.tick(); expect(s.sends.length).toBe(n)
    s.w.__caoViewport = { keyboardHeight: 0, scale: 1.5 }; s.fire('cao:viewport'); s.tick()
    expect(s.sends.length).toBe(n)
    s.w.__caoViewport.scale = 1
    s.w.document.dispatchEvent(new s.w.Event('compositionstart')); s.tick()
    expect(s.sends.length).toBe(n)
    s.setDims({ cols: 90, rows: 25 })
    s.w.document.dispatchEvent(new s.w.Event('compositionend')); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 90, rows: 25 })
    s.controller.destroy(); s.w.close()
  })
  it('ignores small touch URL-bar jitter but applies rotation and font changes', () => {
    const s = setup(); s.w.matchMedia = () => ({ matches: true }); s.tick(); s.ack('owned')
    const n = s.sends.length
    Object.defineProperty(s.w, 'innerHeight', { configurable: true, value: s.w.innerHeight - 35 })
    s.setDims({ cols: 120, rows: 33 }); s.resize(); s.tick()
    expect(s.sends.length).toBe(n)
    s.setDims({ cols: 180, rows: 20 }); s.fire('orientationchange'); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 180, rows: 20 })
    s.ack('owned'); s.setDims({ cols: 180, rows: 19 }); s.fire('cao:font-size'); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 180, rows: 19 })
    s.controller.destroy(); s.w.close()
  })
  it('fits fresh geometry right after the keyboard closes, then restores jitter retention', () => {
    const s = setup(); s.w.matchMedia = () => ({ matches: true }); s.tick(); s.ack('owned')
    // Keyboard opens: sizing pauses and the claim is released.
    s.w.__caoViewport = { keyboardHeight: 250, scale: 1 }; s.fire('cao:viewport'); s.tick()
    expect(s.sends.at(-1).release).toBe(true)
    // Keyboard closes: the toolbar/URL bar keeps settling (<80px), rows dropped.
    const realNow = s.w.Date.now
    let now = realNow()
    s.w.Date.now = () => now
    const base = s.w.innerHeight
    Object.defineProperty(s.w, 'innerHeight', { configurable: true, value: base - 40 })
    s.w.__caoViewport = { keyboardHeight: 0, scale: 1 }
    s.setDims({ cols: 120, rows: 33 })
    s.fire('cao:viewport'); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 120, rows: 33, auto: true })
    s.ack('owned')
    // Still inside the grace window: another sub-80px change fits measured rows.
    s.setDims({ cols: 120, rows: 32 }); s.fire('resize'); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 120, rows: 32 })
    s.ack('owned')
    // After the grace window, small jitter is retained again: no further send.
    const settled = s.sends.length
    now += 1200
    s.setDims({ cols: 120, rows: 30 }); s.fire('resize'); s.tick()
    expect(s.sends.length).toBe(settled)
    s.w.Date.now = realNow
    s.controller.destroy(); s.w.close()
  })
  it('refuses multi-pane auto-fit but supports explicit bounded Fit here', () => {
    const s = setup(); s.w.tmuxState.paneInfo['%1'].window_panes = 2; s.fire('cao:panes'); s.tick()
    expect(s.sends.length).toBe(0); expect(s.statuses.at(-1)).toBe('shared_window')
    s.controller.fitHere()
    expect(s.sends.at(-1)).toMatchObject({ takeover: true, auto: false, cols: 120, rows: 35 })
    s.controller.destroy(); s.w.close()
  })
  it('releases on disable/hidden focus loss and cleans observers on destruction', () => {
    const s = setup(); s.tick(); s.ack('owned')
    s.setFocus(false); s.fire('blur'); s.tick()
    expect(s.sends.at(-1).release).toBe(true)
    s.controller.setEnabled(false); const count = s.sends.length
    s.resize(); s.heartbeat(); s.tick(); expect(s.sends.length).toBe(count)
    s.setFocus(true); s.controller.setEnabled(true); s.tick()
    expect(s.sends.at(-1).cols).toBe(120)
    s.controller.destroy(); const end = s.sends.length
    s.resize(); s.fire('resize'); s.heartbeat(); s.tick(); expect(s.sends.length).toBe(end)
    s.w.close()
  })
  it('does not keep acquiring a claim when the viewport cannot fit minimum cells', () => {
    const s = setup(); s.setDims(null); s.tick(); const n = s.sends.length
    s.heartbeat(); s.tick(); expect(s.sends.length).toBe(n)
    expect(s.statuses.at(-1)).toBe('viewport_small')
    s.setDims({ cols: 100, rows: 25 }); s.resize(); s.tick()
    expect(s.sends.at(-1)).toMatchObject({ cols: 100, rows: 25 })
    s.controller.destroy(); s.w.close()
  })
  it('releases an in-flight dimensionless acquisition before a late ACK', () => {
    const s = setup(); s.tick(); s.ack('other_viewer'); s.heartbeat()
    const old = s.sends.at(-1).resize_seq
    s.setFocus(false); s.fire('blur'); s.tick()
    expect(s.sends.at(-1).release).toBe(true)
    s.fire('cao:sizing', { state: 'owned', resize_seq: old })
    expect(s.statuses.at(-1)).not.toBe('owned')
    s.controller.destroy(); s.w.close()
  })
  it('drops obsolete sizing acknowledgments and old geometry on reconnect', () => {
    const s = setup(); s.tick(); const old = s.sends.at(-1).resize_seq
    s.setConnected(false); s.fire('cao:connection', 'reconnecting')
    s.setConnected(true); s.setDims({ cols: 180, rows: 50 }); s.fire('cao:connection', 'connected'); s.tick()
    const count = s.sends.length
    s.fire('cao:sizing', { state: 'owned', resize_seq: old }); s.tick()
    expect(s.sends.length).toBe(count)
    expect(s.sends.at(-1)).toMatchObject({ cols: 180, rows: 50 })
    s.controller.destroy(); s.w.close()
  })
})
