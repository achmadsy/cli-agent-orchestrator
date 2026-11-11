// @vitest-environment node
// Settle-driven virtual-keyboard tracking from the actual vendored gestures.js.
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

const root = '../../../vendor/tmux-webui/internal/assets/'
const template = readFileSync(new URL(root + 'templates/index.html', import.meta.url), 'utf8')
const gestures = readFileSync(new URL(root + 'static/js/gestures.js', import.meta.url), 'utf8')

function setup() {
  const dom = new JSDOM(template, { url: 'http://localhost/terminal/v/test/', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  w.matchMedia = () => ({ matches: false, addEventListener: vi.fn() })
  w.requestAnimationFrame = fn => fn()
  const timers = []
  w.setTimeout = fn => { timers.push(fn); return timers.length }
  w.clearTimeout = () => {}
  const listeners = {}
  const visualViewport = { height: 800, offsetTop: 0, scale: 1 }
  visualViewport.addEventListener = (name, fn) => { (listeners[name] ||= []).push(fn) }
  visualViewport.removeEventListener = (name, fn) => { listeners[name] = (listeners[name] || []).filter(f => f !== fn) }
  Object.defineProperty(w, 'visualViewport', { configurable: true, value: visualViewport })
  Object.defineProperty(w, 'innerHeight', { configurable: true, value: 800 })
  const fired = []
  w.addEventListener('cao:viewport', () => fired.push({ ...w.__caoViewport }))
  w.__CAO_WORKSPACE__ = true // workspace publish path; parent === window in jsdom
  w.eval(gestures)
  const doc = w.document
  const input = doc.getElementById('input')
  const focusComposer = () => {
    input.disabled = false // the real app enables the composer once connected
    input.focus()
    input.dispatchEvent(new w.Event('focusin', { bubbles: true }))
  }
  const blurComposer = () => {
    input.blur()
    input.dispatchEvent(new w.Event('focusout', { bubbles: true }))
  }
  const runTimers = () => {
    let guard = 0
    while (timers.length && guard++ < 50) timers.shift()()
  }
  const kb = () => doc.documentElement.style.getPropertyValue('--kb-height')
  const setViewport = ({ height, offsetTop = 0, scale = 1 }) => {
    visualViewport.height = height; visualViewport.offsetTop = offsetTop; visualViewport.scale = scale
  }
  const fireViewportResize = () => { for (const fn of listeners.resize || []) fn() }
  return { w, doc, fired, kb, focusComposer, blurComposer, runTimers, setViewport, fireViewportResize, timers }
}

describe('vendored gestures keyboard tracking', () => {
  it('tracks keyboard open via --kb-height and publishes one cao:viewport', () => {
    const s = setup()
    s.runTimers() // initial settle chain settles at 0 (one initial publication)
    expect(s.kb()).toBe('0px')
    expect(s.fired).toEqual([{ keyboardHeight: 0, scale: 1 }])
    s.focusComposer()
    s.setViewport({ height: 500 }) // 800-500 = 300 occluded
    s.fireViewportResize()
    expect(s.kb()).toBe('300px')
    expect(s.w.__caoViewport).toEqual({ keyboardHeight: 300, scale: 1 })
    expect(s.fired).toHaveLength(2)
    s.runTimers() // settle polls re-read unchanged state: no new publications
    expect(s.fired).toHaveLength(2)
    s.w.close()
  })
  it('recovers to 0 from settle polls alone when close events never fire', () => {
    const s = setup()
    s.focusComposer(); s.setViewport({ height: 500 }); s.fireViewportResize()
    expect(s.kb()).toBe('300px')
    const publications = s.fired.length
    s.setViewport({ height: 800 }) // keyboard closed; NO resize event arrives
    s.runTimers() // only the queued settle re-reads catch the restored viewport
    expect(s.kb()).toBe('0px')
    expect(s.w.__caoViewport).toEqual({ keyboardHeight: 0, scale: 1 })
    expect(s.fired.length).toBe(publications + 1)
    s.w.close()
  })
  it('treats not-editing, sub-noise overlaps, zoom and overshoot as no keyboard', () => {
    const s = setup()
    s.setViewport({ height: 780 }) // 20px clipping is presentation, not a keyboard
    s.fireViewportResize(); expect(s.kb()).toBe('20px')
    expect(s.w.__caoViewport.keyboardHeight).toBe(0)
    s.setViewport({ height: 500, scale: 1.5 }) // pinch zoom is not a keyboard
    s.focusComposer(); s.fireViewportResize(); expect(s.kb()).toBe('0px')
    s.setViewport({ height: 820, scale: 1 }) // iOS close overshoot
    s.fireViewportResize(); expect(s.kb()).toBe('0px')
    s.setViewport({ height: 500 }) // occluded but focus already left the composer
    s.blurComposer(); s.fireViewportResize(); s.runTimers()
    expect(s.kb()).toBe('300px')
    expect(s.w.__caoViewport.keyboardHeight).toBe(0) // focus never forged to fit
    s.w.close()
  })
  it('caps pathological occlusion and follows focusout with a delayed re-check', () => {
    const s = setup()
    s.focusComposer()
    s.setViewport({ height: 0 }) // viewport reported 0: clamp to 80% of innerHeight
    s.fireViewportResize()
    expect(s.kb()).toBe('640px')
    expect(s.w.__caoViewport.keyboardHeight).toBe(640)
    s.w.close()
  })
})
