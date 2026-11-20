// @vitest-environment node
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
const read = name => readFileSync(new URL('../../../' + name, import.meta.url), 'utf8')
const app = read('vendor/tmux-webui/internal/assets/static/js/app.js')
const apply = app.slice(app.indexOf('const THEME_COLOR_VARS'), app.indexOf('// ── Quick-action bar'))
describe('terminal theme ownership', () => {
  it('scopes shell palette and leaves CAO page appearance independent', () => {
    const generated = read('web/src/workspace.generated.css')
    expect(generated).toContain('.terminal-workspace, .terminal-fallback-note')
    expect(generated).not.toContain(':root')
    const page = read('web/src/index.css')
    expect(page).not.toContain('var(--workspace-')
    expect(page).toContain('--cao-shell-bg: #181E28')
    expect(read('vendor/tmux-webui/internal/assets/static/css/cao-tokens.css')).toContain('--bg: #191B1C')
  })
  it('wraps desktop navigation and keeps mobile tabs scrollable without a scrollbar', () => {
    const page = read('web/src/index.css')
    const desktop = page.slice(0, page.indexOf('@media (max-width: 600px)'))
    const mobile = page.slice(page.indexOf('@media (max-width: 600px)'), page.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(desktop).toMatch(/\.cao-shell-tabs\s*\{\s*flex-wrap:\s*wrap;/)
    expect(desktop).not.toContain('overflow-x: auto')
    expect(page).toMatch(/\.cao-shell-tabs > button\s*\{[^}]*min-height:\s*44px;[^}]*white-space:\s*nowrap;/)
    expect(mobile).toMatch(/\.cao-shell-tabs\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;/)
    expect(mobile).toMatch(/\.cao-shell-tabs::-webkit-scrollbar\s*\{\s*display:\s*none;/)
  })
  it('does not let stale runtime colors or legacy font pins override workspace chrome', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only', url: 'http://localhost' })
    const w = dom.window
    w.__CAO_WORKSPACE__ = true
    w.localStorage.setItem('tmux-webui-font-size', '8')
    w.cfgGet = (_key, fallback) => ({ bg: 'hotpink', accent: 'red' }) || fallback
    w.eval(apply + '\napplyTheme();')
    expect(w.document.documentElement.style.getPropertyValue('--bg')).toBe('')
    expect(w.document.documentElement.style.getPropertyValue('--font-size')).toBe('')
    w.__CAO_WORKSPACE__ = false
    w.cfgGet = key => key === 'theme.colors' ? { bg: 'hotpink' } : null
    w.eval('applyTheme();')
    expect(w.document.documentElement.style.getPropertyValue('--bg')).toBe('hotpink')
    w.close()
  })
  it('preserves ANSI line colors instead of applying chrome colors to transcript spans', () => {
    const css = read('vendor/tmux-webui/internal/assets/static/css/cao-workspace.css')
    expect(css).not.toMatch(/\.term-line[^{}]*\{[^}]*color:/)
    expect(css).not.toMatch(/\.pane-terminal\s+span/)
  })
})
