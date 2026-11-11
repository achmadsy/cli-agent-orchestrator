// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

const root = '../../../vendor/tmux-webui/internal/assets/'
const template = readFileSync(new URL(root + 'templates/index.html', import.meta.url), 'utf8')
const keys = readFileSync(new URL(root + 'static/js/keys.js', import.meta.url), 'utf8')
const hooks = readFileSync(new URL(root + 'static/js/cao-workspace.js', import.meta.url), 'utf8')
const autocomplete = readFileSync(new URL(root + 'static/js/autocomplete.js', import.meta.url), 'utf8')
const app = readFileSync(new URL(root + 'static/js/app.js', import.meta.url), 'utf8')
const quickActions = app.slice(app.indexOf('// 14. Quick-Action Buttons'), app.indexOf('// 15. Keyboard Shortcuts'))
function setup(mobile = false, blockedStorage = false) {
  const dom = new JSDOM(template, { url: 'http://localhost/terminal/v/test/', runScripts: 'outside-only' })
  const w = dom.window
  const mediaQueries = []
  w.matchMedia = query => {
    const listeners = []
    const media = { media: query, matches: mobile, addEventListener: (_type, listener) => listeners.push(listener) }
    mediaQueries.push({ media, listeners })
    return media
  }
  const setCompact = matches => {
    for (const { media, listeners } of mediaQueries) {
      if (media.media !== '(max-width:600px), (max-height:500px)') continue
      media.matches = matches
      for (const listener of listeners) listener(media)
    }
  }
  w.requestAnimationFrame = fn => fn()
  const send = vi.fn()
  w.tmuxState = { focusedPane: '%1', paneEls: {} }
  w.tmuxWs = { send, isConnected: () => true }
  w.flashInputError = vi.fn()
  if (blockedStorage) Object.defineProperty(w, 'localStorage', { get() { throw Error('blocked') } })
  // Production app.js owns qbtn clicks before keys/hooks move these same nodes.
  w.eval(`const S = window.tmuxState;\n${quickActions}`)
  w.eval(keys)
  w.eval(hooks)
  return { w, send, dom, doc: w.document, setCompact }
}

describe('actual vendored workspace controls', () => {
  it('hides only the separate composer while preserving drafts in Direct mode', () => {
    for (const mobile of [false, true]) {
      const { doc, w, send } = setup(mobile)
      const input = doc.getElementById('input'); input.value = 'unsent draft'
      const funnel = doc.getElementById('cao-direct-funnel')
      const layout = vi.fn(); w.addEventListener('cao:terminal-layout', layout)
      const toggle = doc.querySelector('.cao-direct-toggle')
      toggle.click()
      expect(doc.getElementById('app').classList.contains('cao-direct-active')).toBe(true)
      expect(doc.querySelector('.ac-wrap').contains(funnel)).toBe(false)
      toggle.click()
      expect(doc.getElementById('app').classList.contains('cao-direct-active')).toBe(false)
      expect(input.value).toBe('unsent draft')
      expect(doc.getElementById('cao-direct-funnel')).toBe(funnel)
      expect(layout).toHaveBeenCalledTimes(2)
      expect(send).not.toHaveBeenCalled()
      w.close()
    }
  })
  it('tap-to-type reopens a dismissed focused keyboard without toggling or sending input', () => {
    const { doc, w, send } = setup(true)
    const toggle = doc.querySelector('.cao-direct-toggle'); toggle.click()
    const funnel = doc.getElementById('cao-direct-funnel')
    const focus = vi.spyOn(funnel, 'focus'), blur = vi.spyOn(funnel, 'blur')
    w.__caoViewport = { keyboardHeight: 0, scale: 1 }
    w.caoDirectTapToType('%1')
    expect(blur).toHaveBeenCalledTimes(1); expect(focus).toHaveBeenCalledTimes(1)
    expect(doc.activeElement).toBe(funnel)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    focus.mockClear(); blur.mockClear()
    w.__caoViewport.keyboardHeight = 250
    w.caoDirectTapToType('%1')
    expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled()
    funnel.blur(); focus.mockClear(); blur.mockClear()
    w.caoDirectTapToType('%1')
    expect(focus).toHaveBeenCalledTimes(1)
    w.tmuxWs.isConnected = () => false; focus.mockClear()
    w.caoDirectTapToType('%1'); expect(focus).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    w.close()
  })
  it('ignores stale composition commits after Direct mode is turned off', () => {
    const { doc, w, send } = setup(true)
    const toggle = doc.querySelector('.cao-direct-toggle'); toggle.click()
    const funnel = doc.getElementById('cao-direct-funnel')
    funnel.dispatchEvent(new w.Event('compositionstart'))
    funnel.value = 'draft'; toggle.click()
    funnel.value = 'late'; funnel.dispatchEvent(new w.Event('compositionend'))
    expect(send).not.toHaveBeenCalled(); expect(funnel.value).toBe('')
    w.close()
  })
  it('sends all four visible arrows once', () => {
    const { doc, send, w } = setup()
    for (const key of ['Left', 'Up', 'Down', 'Right']) doc.querySelector(`[data-ek="${key}"]`).click()
    expect(send.mock.calls.map(([m]) => m.key)).toEqual(['Left', 'Up', 'Down', 'Right'])
    w.close()
  })
  it('keeps all four root shortcuts outside Keys on desktop and compact layouts', () => {
    for (const mobile of [false, true]) {
      const { doc, w, send, setCompact } = setup(mobile)
      const toolbar = doc.querySelector('.quick-actions')
      const originalKeys = ['Escape', 'Tab', 'BTab', 'C-c', 'BSpace', 'Enter', 'C-p']
      const buttons = originalKeys.map(key => doc.querySelector(`.qbtn[data-key="${key}"]`))
      for (const compact of [mobile, !mobile, mobile, false, true, false]) {
        setCompact(compact)
        for (const key of ['Tab', 'BTab', 'Enter', 'C-p']) {
          const button = doc.querySelector(`.qbtn[data-key="${key}"]`)
          expect(button.parentElement).toBe(toolbar)
          expect(button.closest('#extra-keys')).toBeNull()
          expect(doc.querySelectorAll(`.qbtn[data-key="${key}"]`)).toHaveLength(1)
        }
        expect([...toolbar.querySelectorAll('.qbtn[data-key]')].map(button => button.dataset.key))
          .toEqual(compact ? ['Tab', 'BTab', 'Enter', 'C-p'] : originalKeys)
        for (const [i, key] of originalKeys.entries()) {
          expect(doc.querySelector(`.qbtn[data-key="${key}"]`)).toBe(buttons[i])
        }
      }
      expect(doc.getElementById('extra-keys').classList.contains('visible')).toBe(false)
      expect(send).not.toHaveBeenCalled()
      w.close()
    }
  })
  it('root shortcuts each send exactly one canonical key after layout changes', () => {
    for (const mobile of [false, true]) {
      const { doc, w, send, setCompact } = setup(mobile)
      setCompact(!mobile); setCompact(mobile)
      for (const key of ['Tab', 'BTab', 'Enter', 'C-p']) {
        doc.querySelector(`.quick-actions > .qbtn[data-key="${key}"]`).click()
      }
      expect(send.mock.calls.map(([frame]) => ({ ...frame, modifiers: [...frame.modifiers] }))).toEqual([
        { type: 'key', pane: '%1', key: 'Tab', modifiers: [] },
        { type: 'key', pane: '%1', key: 'BTab', modifiers: [] },
        { type: 'key', pane: '%1', key: 'Enter', modifiers: [] },
        { type: 'key', pane: '%1', key: 'p', modifiers: ['C'] },
      ])
      w.close()
    }
  })
  it('fixed root chords ignore virtual modifiers but plain keys still accept them', () => {
    const { doc, w, send } = setup(true)
    const shift = doc.querySelector('[data-mod="Shift"]')
    shift.click(); shift.click()
    for (const key of ['BTab', 'C-p', 'Tab', 'Enter']) doc.querySelector(`.qbtn[data-key="${key}"]`).click()
    expect(send.mock.calls.map(([frame]) => [frame.key, [...frame.modifiers]])).toEqual([
      ['BTab', []], ['p', ['C']], ['Tab', ['Shift']], ['Enter', ['Shift']],
    ])
    expect(shift.dataset.state).toBe('locked')
    w.close()
  })
  it('root shortcuts respect connection, target and follow-lock gates without replay', () => {
    const { doc, w, send } = setup(true)
    const clickAll = () => {
      for (const key of ['Tab', 'BTab', 'Enter', 'C-p']) doc.querySelector(`.qbtn[data-key="${key}"]`).click()
    }
    w.tmuxWs.isConnected = () => false; clickAll()
    w.tmuxWs.isConnected = () => true
    w.tmuxState.focusedPane = ''; clickAll()
    w.tmuxState.focusedPane = '%1'
    w.linkSendBlocked = () => true; clickAll()
    expect(send).not.toHaveBeenCalled()
    w.linkSendBlocked = () => false
    expect(send).not.toHaveBeenCalled()
    clickAll()
    expect(send).toHaveBeenCalledTimes(4)
    w.close()
  })
  it('keeps composer Shift/IME text untouched while a modifier is armed', () => {
    const { doc, send, w } = setup()
    doc.querySelector('[data-mod="C"]').click()
    const input = doc.getElementById('input')
    input.value = 'draft'
    const event = new w.KeyboardEvent('keydown', { key: 'P', shiftKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    input.dispatchEvent(new w.InputEvent('input', { data: '文', isComposing: true }))
    expect(event.defaultPrevented).toBe(false)
    expect(input.value).toBe('draft')
    expect(send).not.toHaveBeenCalled()
    w.close()
  })
  it('IME Enter never submits and normal composer Enter submits once', () => {
    const { doc, w } = setup()
    w.eval(autocomplete)
    w.sendInput = vi.fn()
    const input = doc.getElementById('input')
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
    expect(w.sendInput).not.toHaveBeenCalled()
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(w.sendInput).toHaveBeenCalledTimes(1)
    w.close()
  })
  it('merges physical and virtual modifiers, consumes once, clears on disconnect', () => {
    const { doc, send, w } = setup()
    const ctrl = doc.querySelector('[data-mod="C"]')
    ctrl.click()
    expect(ctrl.getAttribute('aria-pressed')).toBe('true')
    const capture = doc.getElementById('cao-key-capture')
    const sibling = vi.fn()
    capture.addEventListener('keydown', sibling)
    capture.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ key: 'P', modifiers: ['C', 'Shift'] })
    expect(sibling).not.toHaveBeenCalled()
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    ctrl.click(); ctrl.click()
    w.dispatchEvent(new w.Event('cao:terminal-reset'))
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    w.close()
  })
  it('does not send composing keys and fixed Interrupt ignores virtual Shift', () => {
    const { doc, send, w } = setup()
    doc.querySelector('[data-mod="Shift"]').click()
    doc.getElementById('cao-key-capture').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Process', isComposing: true, bubbles: true }))
    expect(send).not.toHaveBeenCalled()
    w.sendEk('C-c', [], true)
    expect(send.mock.calls[0][0]).toMatchObject({ key: 'c', modifiers: ['C'] })
    w.close()
  })
  it('keeps legacy/shared and per-layout preferences isolated and validates values', () => {
    const { doc, w } = setup()
    w.localStorage.setItem('tmux-webui-font-size', '12')
    w.localStorage.setItem('cao-terminal-font-v2-mobile', '20')
    doc.querySelector('[aria-label="Larger text"]').click()
    expect(w.localStorage.getItem('cao-terminal-font-v2-desktop')).toBe('17')
    expect(w.localStorage.getItem('cao-terminal-font-v2-mobile')).toBe('20')
    doc.querySelector('[aria-label="Reset text size"]').click()
    expect(w.localStorage.getItem('cao-terminal-font-v2-desktop')).toBeNull()
    expect(doc.documentElement.style.getPropertyValue('--font-size')).toBe('16px')
    w.close()
  })
  it('expires one-shot modifiers and preserves locked ones until reset', () => {
    vi.useFakeTimers()
    const { doc, w } = setup()
    const ctrl = doc.querySelector('[data-mod="C"]')
    ctrl.click()
    w.sendEk('p')
    expect(ctrl.getAttribute('aria-pressed')).toBe('false')
    ctrl.click(); ctrl.click()
    expect(ctrl.dataset.state).toBe('locked')
    w.sendEk('p')
    expect(ctrl.dataset.state).toBe('locked')
    w.clearTerminalModifiers()
    expect(ctrl.dataset.state).toBe('idle')
    w.close()
    vi.useRealTimers()
  })
  it('cancels a multi-step model chord on disconnect without replay', async () => {
    const { doc, w, send } = setup()
    w.dispatchEvent(new w.MessageEvent('message', { origin: w.location.origin, source: w.parent,
      data: { type: 'cao:terminal-context', provider: 'opencode_cli' } }))
    const models = [...doc.querySelectorAll('#cao-provider-keys button')].find(b => b.textContent.startsWith('Models'))
    models.click()
    w.dispatchEvent(new w.Event('cao:terminal-reset'))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(send.mock.calls.map(([m]) => m.key)).toEqual(['x'])
    w.close()
  })
  it('types /model once per click for Claude Code and Codex contexts', async () => {
    for (const provider of ['claude_code', 'codex']) {
      const { doc, w, send } = setup()
      w.dispatchEvent(new w.MessageEvent('message', { origin: w.location.origin, source: w.parent,
        data: { type: 'cao:terminal-context', provider } }))
      const models = [...doc.querySelectorAll('#cao-provider-keys button')].find(b => b.textContent.startsWith('Models'))
      models.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(send).toHaveBeenCalledTimes(1)
      const frame = send.mock.calls[0][0]
      expect(frame.type).toBe('input')
      expect(frame.text).toBe('/model')
      expect(frame.nonce).toBeTruthy()
      w.close()
    }
  })
  it('offers safe generic keys for providers without verified model bindings', () => {
    for (const provider of ['hermes', 'kimi_cli', 'gemini_cli', 'q_cli', 'cursor_cli', 'grok_cli', 'copilot_cli']) {
      const { doc, w } = setup()
      w.dispatchEvent(new w.MessageEvent('message', { origin: w.location.origin, source: w.parent,
        data: { type: 'cao:terminal-context', provider } }))
      const names = [...doc.querySelectorAll('#cao-provider-keys button')].map(b => b.textContent)
      expect(names).toEqual(['Interrupt · Esc', 'Stop · Ctrl+C'])
      w.close()
    }
  })
  it('keeps Direct keys and its active hint outside the closed Keys drawer', () => {
    for (const mobile of [false, true]) {
      const { doc, w } = setup(mobile)
      const toggle = doc.querySelector(mobile ? '.header-controls > .cao-direct-toggle' : '.footer-top > .cao-direct-toggle')
      const hint = doc.getElementById(toggle.getAttribute('aria-describedby'))
      expect(toggle?.textContent).toBe('Direct keys')
      expect(doc.querySelector('#extra-keys .cao-direct-toggle')).toBeNull()
      expect(hint.closest('#extra-keys')).toBeNull()
      expect(hint.hidden).toBe(true)
      toggle.click()
      expect(hint.hidden).toBe(false)
      expect(doc.getElementById('extra-keys').classList.contains('visible')).toBe(false)
      w.close()
    }
  })
  it('direct keyboard mode sends physical keys once and never touches the composer', () => {
    const { doc, w, send } = setup()
    const toggle = doc.querySelector('.cao-direct-toggle')
    toggle.click()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const kd = (key, opts = {}) => doc.body.dispatchEvent(new w.KeyboardEvent('keydown', { key, ...opts, bubbles: true, cancelable: true }))
    kd('P', { shiftKey: true })
    kd('p', { ctrlKey: true })
    kd('ArrowUp')
    kd('Backspace')
    kd('Tab')
    kd('F2')
    kd('w', { ctrlKey: true })
    kd('t', { ctrlKey: true })
    kd('r', { metaKey: true })
    kd('F5')
    kd('Process', { isComposing: true })
    kd('Enter', { keyCode: 229 })
    const frames = send.mock.calls.filter(([m]) => m.type === 'key').map(([m]) => [m.key, [...(m.modifiers ?? [])]])
    expect(JSON.stringify(frames)).toBe(JSON.stringify([
      ['P', []], ['p', ['C']], ['Up', []], ['BSpace', []], ['Tab', []], ['F2', []],
    ]))
    const input = doc.getElementById('input')
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true }))
    expect(send.mock.calls.filter(([m]) => m.type === 'key').length).toBe(6)
    doc.body.focus()
    toggle.click()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    kd('q')
    expect(send.mock.calls.filter(([m]) => m.type === 'key').length).toBe(6)
    w.close()
  })
  it('direct mode preserves keyboard activation and editable targets', () => {
    const { doc, w, send } = setup()
    doc.querySelector('.cao-direct-toggle').click()
    for (const target of [doc.querySelector('.cao-direct-toggle'), doc.createElement('a'), doc.createElement('div')]) {
      if (target.tagName === 'DIV') target.setAttribute('contenteditable', 'plaintext-only')
      doc.body.append(target)
      const event = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
    w.close()
  })
  it('mobile Direct keys focuses the typing funnel; desktop does not', () => {
    for (const mobile of [true, false]) {
      const { doc, w } = setup(mobile)
      const toggle = doc.querySelector('.cao-direct-toggle')
      const funnel = doc.getElementById('cao-direct-funnel')
      expect(funnel).toBeTruthy()
      toggle.click()
      if (mobile) {
        expect(doc.activeElement).toBe(funnel)
        expect(funnel.getAttribute('aria-label')).toBe('Terminal direct typing')
      } else {
        expect(doc.activeElement).not.toBe(funnel)
      }
      toggle.click()
      expect(doc.activeElement).not.toBe(funnel)
      expect(funnel.value).toBe('')
      w.close()
    }
  })
  it('funnel keydowns send exactly one terminal key each', () => {
    const { doc, w, send } = setup(true)
    doc.querySelector('.cao-direct-toggle').click()
    const funnel = doc.getElementById('cao-direct-funnel')
    for (const [key, sent] of [['p', 'p'], ['Enter', 'Enter'], ['ArrowUp', 'Up'], ['Backspace', 'BSpace']]) {
      funnel.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      expect(send.mock.calls.at(-1)[0]).toMatchObject({ type: 'key', key: sent })
    }
    // The capture handler classified and preventDefault'ed: no input mirror ran.
    expect(send.mock.calls.filter(([m]) => m.type === 'key')).toHaveLength(4)
    expect(funnel.value).toBe('')
    w.close()
  })
  it('funnel input mirror handles 229-keyboard text, newline, backspace and IME once', () => {
    const { doc, w, send } = setup(true)
    doc.querySelector('.cao-direct-toggle').click()
    const funnel = doc.getElementById('cao-direct-funnel')
    const inputEvent = (inputType, data) => funnel.dispatchEvent(
      new w.InputEvent('input', { bubbles: true, cancelable: true, inputType, data }))
    funnel.value = 'hi'; inputEvent('insertText', 'hi')
    expect(send.mock.calls.filter(([m]) => m.type === 'key').map(([m]) => m.key)).toEqual(['h', 'i'])
    expect(funnel.value).toBe('')
    funnel.value = ''; inputEvent('insertLineBreak', '\n') // value sanitization drops \n; Enter is the input type
    expect(send.mock.calls.at(-1)[0]).toMatchObject({ type: 'key', key: 'Enter' })
    funnel.value = ''; inputEvent('deleteContentBackward')
    expect(send.mock.calls.at(-1)[0]).toMatchObject({ type: 'key', key: 'BSpace' })
    funnel.dispatchEvent(new w.Event('compositionstart'))
    funnel.value = ' interim'; funnel.dispatchEvent(new w.Event('input', { bubbles: true }))
    expect(send.mock.calls.filter(([m]) => m.type === 'key')).toHaveLength(4)
    funnel.value = '文'; funnel.dispatchEvent(new w.Event('compositionend'))
    expect(send.mock.calls.at(-1)[0]).toMatchObject({ type: 'key', key: '文' })
    expect(send.mock.calls.filter(([m]) => m.type === 'key')).toHaveLength(5)
    expect(funnel.value).toBe('')
    w.close()
  })
  it('funnel goes inert when Direct keys is off', () => {
    const { doc, w, send } = setup(true)
    const toggle = doc.querySelector('.cao-direct-toggle')
    toggle.click(); toggle.click()
    const funnel = doc.getElementById('cao-direct-funnel')
    funnel.value = 'x'
    funnel.dispatchEvent(new w.Event('input', { bubbles: true }))
    funnel.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }))
    expect(send).not.toHaveBeenCalled()
    expect(funnel.value).toBe('')
    // A focus while off is dropped immediately: the keyboard never opens.
    funnel.focus()
    funnel.dispatchEvent(new w.Event('focus'))
    expect(doc.activeElement).not.toBe(funnel)
    w.close()
  })
  it('Jump to live uses the pane scroll controller', () => {
    const { doc, w } = setup()
    const jumpToLive = vi.fn()
    w.tmuxState.paneEls['%1'] = { jumpToLive }
    doc.querySelector('.cao-jump-live').click()
    expect(jumpToLive).toHaveBeenCalledTimes(1)
    w.close()
  })
  it('View toggles accessibly and Escape returns focus without terminal input', () => {
    const { doc, w, send } = setup()
    const toggle = doc.querySelector('.cao-view-toggle')
    const panel = doc.getElementById('cao-view-panel')
    expect(panel.hidden).toBe(true)
    toggle.click()
    expect(panel.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    doc.querySelector('.cao-direct-toggle').click()
    doc.getElementById('cao-key-capture').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(panel.hidden).toBe(true)
    expect(doc.activeElement.className).toContain('cao-view-toggle')
    expect(send).not.toHaveBeenCalled()
    toggle.click()
    doc.getElementById('ek-toggle').click()
    expect(panel.hidden).toBe(true)
    w.close()
  })
  it('fit requests one bounded resize of the focused pane', () => {
    const { doc, w, send } = setup()
    doc.querySelector('[aria-label="Fit the tmux window to this viewer"]').click()
    w.__caoSendResize(1000, 3) // too small: never coerce an invalid viewport
    w.__caoSendResize(NaN, 40)
    w.__caoSendResize(1000, 10)
    w.__caoSendResize(150.9, 40.9)
    const resizes = send.mock.calls.filter(([m]) => m.type === 'resize').map(([m]) => [m.cols, m.rows])
    expect(resizes).toEqual([[400, 10], [150, 40]])
    w.close()
  })
  it('uses separate defaults and survives blocked storage', () => {
    for (const [mobile, size] of [[false, '16px'], [true, '14px']]) {
      const { doc, w } = setup(mobile, true)
      expect(doc.documentElement.style.getPropertyValue('--font-size')).toBe(size)
      doc.querySelector('[aria-label="Larger text"]').click()
      doc.querySelector('[aria-label="Reset text size"]').click()
      expect(doc.documentElement.style.getPropertyValue('--font-size')).toBe(size)
      w.close()
    }
  })
})
