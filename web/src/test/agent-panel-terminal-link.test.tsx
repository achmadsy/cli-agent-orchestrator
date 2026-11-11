import { StrictMode, useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPanel } from '../components/AgentPanel'
import { api } from '../api'
import type { TerminalLink } from '../terminalLink'

const mocks = vi.hoisted(() => ({ selectSession: vi.fn().mockResolvedValue(undefined), terminal: vi.fn() }))
vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api: { ...actual.api,
    listProviders: vi.fn().mockResolvedValue([]), listProviderProfiles: vi.fn().mockResolvedValue([]),
    listProfiles: vi.fn().mockResolvedValue([]), getSession: vi.fn(),
  } }
})
vi.mock('../store', () => ({ useStore: () => ({ sessions: [], fetchSessions: vi.fn(), activeSession: null,
  activeSessionDetail: null, selectSession: mocks.selectSession, createSession: vi.fn(), deleteSession: vi.fn(),
  terminalStatuses: {}, setTerminalStatus: vi.fn(), showSnackbar: vi.fn(),
}) }))
vi.mock('../components/TerminalView', () => ({ TerminalView: (props: any) => {
  mocks.terminal(props)
  return <div data-testid="real-viewer">{props.terminalId}<button onClick={props.onClose}>Close viewer</button></div>
} }))
const link: TerminalLink = { request: { session: 'cao-demo', terminalId: 'abcd1234' } }
const detail = { session: { id: 'cao-demo', name: 'cao-demo', status: 'active' }, terminals: [
  { id: 'abcd1234', tmux_session: 'cao-demo', tmux_window: 'dev', provider: 'codex', agent_profile: 'developer', created_at: null, last_active: null },
] }
function Harness() {
  const [pending, setPending] = useState<TerminalLink | null>(link)
  const consume = useCallback(() => setPending(null), [])
  return <AgentPanel terminalLink={pending} onTerminalLinkConsumed={consume} />
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.getSession).mockResolvedValue(detail) })
afterEach(cleanup)
describe('one-shot fleet terminal launch', () => {
  it('uses the exact existing TerminalView with resolved provider metadata, and stays closed', async () => {
    render(<StrictMode><Harness /></StrictMode>)
    expect(await screen.findByTestId('real-viewer')).toHaveTextContent('abcd1234')
    expect(mocks.terminal.mock.calls[mocks.terminal.mock.calls.length - 1]?.[0]).toMatchObject({ terminalId: 'abcd1234', provider: 'codex', agentProfile: 'developer' })
    expect(mocks.selectSession).toHaveBeenCalledWith('cao-demo')
    fireEvent.click(screen.getByText('Close viewer'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('real-viewer')).not.toBeInTheDocument()
  })
  it('opens nothing for a terminal belonging to a different session', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ ...detail, terminals: [{ ...detail.terminals[0], tmux_session: 'cao-other' }] })
    render(<Harness />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot open')
    expect(mocks.terminal).not.toHaveBeenCalled()
  })
  it('invalid query metadata is visible and never launches', async () => {
    render(<AgentPanel terminalLink={{ error: 'Invalid terminal link' }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid terminal link')
    expect(api.getSession).not.toHaveBeenCalled(); expect(mocks.terminal).not.toHaveBeenCalled()
  })
  it('cancel invalidates a late response, even before the parent rerenders', async () => {
    let resolve!: (value: typeof detail) => void
    vi.mocked(api.getSession).mockReturnValue(new Promise(r => { resolve = r }))
    render(<Harness />)
    fireEvent.click(screen.getByText('Cancel'))
    await act(async () => { resolve(detail); await Promise.resolve() })
    expect(mocks.terminal).not.toHaveBeenCalled()
  })
  it('unmount invalidates a pending launch', async () => {
    let resolve!: (value: typeof detail) => void
    vi.mocked(api.getSession).mockReturnValue(new Promise(r => { resolve = r }))
    const view = render(<Harness />)
    view.unmount()
    await act(async () => { resolve(detail); await Promise.resolve() })
    expect(mocks.terminal).not.toHaveBeenCalled()
  })
  it('auth/network lookup errors are visible instead of selecting another terminal', async () => {
    vi.mocked(api.getSession).mockRejectedValue(new Error('401'))
    render(<Harness />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('sign in'))
    expect(mocks.terminal).not.toHaveBeenCalled()
  })
})
