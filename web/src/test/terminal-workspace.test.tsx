import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TerminalWorkspace } from '../components/TerminalWorkspace'
import { api } from '../api'

vi.mock('../components/LegacyTerminalView', () => ({ LegacyTerminalView: () => <div>Classic PTY viewer</div> }))
vi.mock('../api', () => ({ api: { launchTerminalWorkspace: vi.fn(), revokeTerminalWorkspace: vi.fn() } }))

beforeEach(() => {
  vi.mocked(api.launchTerminalWorkspace).mockResolvedValue({url: '/terminal/v/test/', viewer_id: 'test', expires_in: 600})
  vi.mocked(api.revokeTerminalWorkspace).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

describe('TerminalWorkspace', () => {
  it('launches a credential-free same-origin viewer and closes only the view', async () => {
    const close = vi.fn()
    const view = render(<TerminalWorkspace terminalId="abcdef12" provider="codex" agentProfile="developer" onClose={close} />)
    const frame = await screen.findByTitle('CAO tmux terminal')
    expect(frame).toHaveAttribute('src', '/terminal/v/test/')
    expect(api.launchTerminalWorkspace).toHaveBeenCalledWith('abcdef12')
    fireEvent.click(screen.getByRole('button', {name: 'Back to CAO; agent keeps running'}))
    expect(close).toHaveBeenCalledOnce()
    view.unmount()
    expect(api.revokeTerminalWorkspace).toHaveBeenCalledWith('test')
  })

  it('portals outside dashboard layout and restores body scrolling on close', async () => {
    const overflow = document.body.style.overflow
    const view = render(<div style={{ transform: 'translateY(0)' }}><TerminalWorkspace terminalId="abcdef12" onClose={() => {}} /></div>)
    const dialog = screen.getByRole('dialog', {name: 'Agent terminal workspace'})
    expect(dialog.parentElement).toBe(document.body)
    expect(view.container).not.toContainElement(dialog)
    expect(document.body.style.overflow).toBe('hidden')
    await screen.findByTitle('CAO tmux terminal')
    view.unmount()
    expect(document.body.style.overflow).toBe(overflow)
  })

  it('falls back when the optional service is disabled or unavailable', async () => {
    vi.mocked(api.launchTerminalWorkspace).mockRejectedValue({detail: 'Workspace disabled'})
    render(<TerminalWorkspace terminalId="abcdef12" onClose={() => {}} />)
    expect(await screen.findByText('Classic PTY viewer')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Workspace disabled')
  })

  it('can explicitly switch to classic and revokes its lease', async () => {
    render(<TerminalWorkspace terminalId="abcdef12" onClose={() => {}} />)
    await screen.findByTitle('CAO tmux terminal')
    fireEvent.click(screen.getByRole('button', {name: /Classic terminal/}))
    expect(screen.getByText('Classic PTY viewer')).toBeVisible()
    await waitFor(() => expect(api.revokeTerminalWorkspace).toHaveBeenCalledWith('test'))
  })

  it('keeps partial UI hidden until the bound iframe reports ready', async () => {
    render(<TerminalWorkspace terminalId="abcdef12" onClose={() => {}} />)
    const frame = await screen.findByTitle('CAO tmux terminal') as HTMLIFrameElement
    expect(frame).not.toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Loading terminal controls')
    fireEvent(window, new MessageEvent('message', {origin: 'https://evil.example', source: frame.contentWindow, data: {type: 'cao:terminal-ready'}}))
    fireEvent(window, new MessageEvent('message', {origin: location.origin, source: window, data: {type: 'cao:terminal-ready'}}))
    expect(frame).not.toBeVisible()
    fireEvent(window, new MessageEvent('message', {origin: location.origin, source: frame.contentWindow, data: {type: 'cao:terminal-ready'}}))
    expect(frame).toBeVisible()
    expect(screen.queryByText('Loading terminal controls…')).not.toBeInTheDocument()
  })

  it('shows explicit recovery after asset failure and retries only on user action', async () => {
    render(<TerminalWorkspace terminalId="abcdef12" onClose={() => {}} />)
    const frame = await screen.findByTitle('CAO tmux terminal') as HTMLIFrameElement
    fireEvent(window, new MessageEvent('message', {origin: location.origin, source: frame.contentWindow, data: {type: 'cao:terminal-load-failed'}}))
    expect(screen.getByRole('heading', {name: 'Terminal could not finish loading'})).toBeVisible()
    expect(screen.queryByTitle('CAO tmux terminal')).not.toBeInTheDocument()
    expect(api.launchTerminalWorkspace).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}))
    await screen.findByTitle('CAO tmux terminal')
    expect(api.launchTerminalWorkspace).toHaveBeenCalledTimes(2)
    expect(api.revokeTerminalWorkspace).toHaveBeenCalledWith('test')
  })

  it('times out an iframe that never reports readiness', async () => {
    render(<TerminalWorkspace terminalId="abcdef12" onClose={() => {}} />)
    await screen.findByTitle('CAO tmux terminal')
    // Install fake timers after launch, then recreate the timer via a retry.
    vi.useFakeTimers()
    fireEvent(window, new MessageEvent('message', {origin: location.origin, source: (screen.getByTitle('CAO tmux terminal') as HTMLIFrameElement).contentWindow, data: {type: 'cao:terminal-load-failed'}}))
    fireEvent.click(screen.getByRole('button', {name: 'Try again'}))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30000)
    expect(screen.getByRole('heading', {name: 'Terminal could not finish loading'})).toBeVisible()
  })

  it('ignores untrusted window messages', async () => {
    render(<TerminalWorkspace terminalId="abcdef12" onClose={() => {}} />)
    await screen.findByTitle('CAO tmux terminal')
    window.dispatchEvent(new MessageEvent('message', {origin: 'https://evil.example', data: {type: 'cao:terminal-expired'}}))
    expect(screen.queryByText('Viewer expired')).not.toBeInTheDocument()
  })
})
