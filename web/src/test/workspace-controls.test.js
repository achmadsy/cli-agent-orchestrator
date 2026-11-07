// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

const root = '../../../vendor/tmux-webui/internal/assets/'
const template = readFileSync(new URL(root + 'templates/index.html', import.meta.url), 'utf8')
const keys = readFileSync(new URL(root + 'static/js/keys.js', import.meta.url), 'utf8')
const hooks = readFileSync(new URL(root + 'static/js/cao-workspace.js', import.meta.url), 'utf8')
const autocomplete = readFileSync(new URL(root + 'static/js/autocomplete.js', import.meta.url), 'utf8')
function setup(mobile = false, blockedStorage = false) {
  const dom = new JSDOM(template, { url: 'http://localhost/terminal/v/test/', runScripts: 'outside-only' })
  const w = dom.window
  w.matchMedia = () => ({ matches: mobile, addEventListener: vi.fn() })
  w.requestAnimationFrame = fn => fn()
  const send = vi.fn()
  w.tmuxState = { focusedPane: '%1', paneEls: {} }
  w.tmuxWs = { send, isConnected: () => true }
  w.flashInputError = vi.fn()
  if (blockedStorage) Object.defineProperty(w, 'localStorage', { get() { throw Error('blocked') } })
  w.eval(keys)
  w.eval(hooks)
  return { w, send, dom, doc: w.document }
}

describe('actual vendored workspace controls', () => {
  it('sends all four visible arrows once', () => {
    const { doc, send, w } = setup()
    for (const key of ['Left', 'Up', 'Down', 'Right']) doc.querySelector(`[data-ek="${key}"]`).click()
    expect(send.mock.calls.map(([m]) => m.key)).toEqual(['Left', 'Up', 'Down', 'Right'])
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
  it('fit requests one bounded resize of the focused pane', () => {
    const { doc, w, send } = setup()
    doc.querySelector('[aria-label="Fit the tmux window to this viewer"]').click()
    w.__caoSendResize(1000, 3)
    w.__caoSendResize(150, 40)
    const resizes = send.mock.calls.filter(([m]) => m.type === 'resize').map(([m]) => [m.cols, m.rows])
    expect(resizes).toEqual([[400, 6], [150, 40]])
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
