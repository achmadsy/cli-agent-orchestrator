// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Exercise the actual inline bootstrap embedded in the Go sidecar.
// This Node-only test is JS because the browser TS project has no @types/node.
const template = readFileSync(new URL('../../../vendor/tmux-webui/internal/assets/templates/index.html', import.meta.url), 'utf8')
const bootstrap = template.match(/<script id="cao-workspace-bootstrap">([\s\S]*?)<\/script>/)[1]

async function boot(outcome) {
  const attempts = [], executed = []
  const listeners = new Map()
  const postMessage = vi.fn()
  const window = {
    __CAO_WORKSPACE_READY__: false,
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
  }
  runInNewContext(bootstrap, {
    window, parent: { postMessage }, location: { origin: 'http://localhost' },
    setTimeout: callback => queueMicrotask(callback),
    document: {
      createElement: () => ({ remove: vi.fn() }),
      body: {
        append: script => {
          const name = script.src.match(/\/([^/]+)\.js/)[1]
          attempts.push(name)
          const attempt = attempts.filter(item => item === name).length
          queueMicrotask(() => {
            const result = outcome(name, attempt)
            if (result === 'network') { script.onerror(); return }
            executed.push(name)
            if (result === 'runtime') listeners.get('error')?.({ message: 'script execution failed' })
            script.onload()
          })
        },
      },
    },
  })
  // Each script awaits one microtask; bounded to 15×3 attempts.
  for (let i = 0; i < 200; i++) await Promise.resolve()
  return { attempts, executed, postMessage, window }
}

describe('Workspace asset bootstrap', () => {
  it('loads dependencies in order and announces readiness only after the CAO hooks', async () => {
    const run = await boot(() => 'ok')
    expect(run.executed.slice(0, 6)).toEqual(['terminal', 'cao-cell', 'cao-screen', 'metrics', 'app', 'keys'])
    expect(run.executed.slice(-3)).toEqual(['cao-workspace', 'cao-clipboard', 'cao-attachments'])
    expect(run.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'cao:terminal-ready' }, 'http://localhost')
    expect(run.window.__CAO_WORKSPACE_READY__).toBe(true)
  })

  it('retries only failed downloads without re-executing earlier modules', async () => {
    const run = await boot((name, attempt) => name === 'deck-editor' && attempt < 3 ? 'network' : 'ok')
    expect(run.attempts.filter(name => name === 'deck-editor')).toHaveLength(3)
    expect(run.executed.filter(name => name === 'app')).toHaveLength(1)
    expect(run.executed.filter(name => name === 'deck-editor')).toHaveLength(1)
    expect(run.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'cao:terminal-ready' }, 'http://localhost')
  })

  it('stops after three failed downloads and reports an actionable load failure', async () => {
    const run = await boot(name => name === 'keys' ? 'network' : 'ok')
    expect(run.attempts.filter(name => name === 'keys')).toHaveLength(3)
    expect(run.attempts).not.toContain('cao-workspace')
    expect(run.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'cao:terminal-load-failed' }, 'http://localhost')
    expect(run.window.__CAO_WORKSPACE_READY__).toBe(false)
  })

  it('never retries a module that has started executing and then throws', async () => {
    const run = await boot(name => name === 'app' ? 'runtime' : 'ok')
    expect(run.attempts.filter(name => name === 'app')).toHaveLength(1)
    expect(run.attempts).not.toContain('keys')
    expect(run.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'cao:terminal-load-failed' }, 'http://localhost')
  })
})
