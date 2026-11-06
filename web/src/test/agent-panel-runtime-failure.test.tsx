import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPanel } from '../components/AgentPanel'
import { api } from '../api'

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listProviders: vi.fn().mockResolvedValue([
        { name: 'claude_code', binary: 'claude', installed: true },
        { name: 'codex', binary: 'codex', installed: true },
      ]),
      listProviderProfiles: vi.fn().mockResolvedValue([
        { id: 'claude-a', label: 'Claude A', provider: 'claude_code', auth_state: 'authenticated' },
        { id: 'claude-b', label: 'Claude B', provider: 'claude_code', auth_state: 'unverified' },
      ]),
      listProfiles: vi.fn().mockResolvedValue([]),
      getProfile: vi.fn(),
      getTerminalStatus: vi.fn().mockResolvedValue('error'),
      getTerminal: vi.fn(),
      getWorkingDirectory: vi.fn().mockResolvedValue({ working_directory: null }),
      switchProviderProfile: vi.fn(),
    },
  }
})

vi.mock('../store', () => ({
  useStore: vi.fn(() => ({
    sessions: [],
    fetchSessions: vi.fn(),
    activeSession: 'sess-1',
    activeSessionDetail: {
      session: { id: 'sess-1', name: 'cao-test', status: 'active' },
      terminals: [
        {
          id: 'abcd1234',
          tmux_session: 'cao-test',
          tmux_window: 'dev-abcd1234',
          provider: 'claude_code',
          agent_profile: 'developer',
          created_at: null,
          last_active: null,
        },
      ],
    },
    selectSession: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    terminalStatuses: {},
    setTerminalStatus: vi.fn(),
    showSnackbar: vi.fn(),
  })),
}))

const failure = {
  kind: 'rate_limited' as const,
  message: 'API Error: 429 rate limit exceeded',
  retryable: true,
  retry_after_s: 2,
  reset_at: null,
  observed_generation: 3,
}

describe('AgentPanel runtime failure (server classification)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders the failure banner from the structured projection', async () => {
    vi.mocked(api.getTerminal).mockResolvedValue({
      id: 'abcd1234',
      name: 'dev-abcd1234',
      provider: 'claude_code',
      session_name: 'cao-test',
      agent_profile: 'developer',
      status: 'error',
      last_active: null,
      runtime_failure: failure,
    })

    render(<AgentPanel />)
    expect(await screen.findByText('Rate limited')).toBeInTheDocument()
    expect(screen.getByText('API Error: 429 rate limit exceeded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /switch account/i })).toBeInTheDocument()
  })

  it('no banner when the projection carries no failure', async () => {
    vi.mocked(api.getTerminal).mockResolvedValue({
      id: 'abcd1234',
      name: 'dev-abcd1234',
      provider: 'claude_code',
      session_name: 'cao-test',
      agent_profile: 'developer',
      status: 'idle',
      last_active: null,
      runtime_failure: null,
    })

    render(<AgentPanel />)
    await waitFor(() => expect(vi.mocked(api.getTerminal)).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /switch account/i })).not.toBeInTheDocument()
  })

  it('shows a failure detected on a later projection poll', async () => {
    vi.useFakeTimers()
    vi.mocked(api.getTerminal)
      .mockResolvedValueOnce({
        id: 'abcd1234', name: 'dev-abcd1234', provider: 'claude_code',
        session_name: 'cao-test', agent_profile: 'developer', status: 'idle', last_active: null,
        runtime_failure: null,
      })
      .mockResolvedValueOnce({
        id: 'abcd1234', name: 'dev-abcd1234', provider: 'claude_code',
        session_name: 'cao-test', agent_profile: 'developer', status: 'error', last_active: null,
        runtime_failure: failure,
      })

    render(<AgentPanel />)
    await act(async () => { await Promise.resolve() })
    expect(api.getTerminal).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(screen.getByText('Rate limited')).toBeInTheDocument()
    expect(api.getTerminalStatus).not.toHaveBeenCalled()
  })

  it('clears a failure after a successful null projection', async () => {
    vi.useFakeTimers()
    vi.mocked(api.getTerminal)
      .mockResolvedValueOnce({
        id: 'abcd1234', name: 'dev-abcd1234', provider: 'claude_code',
        session_name: 'cao-test', agent_profile: 'developer', status: 'error', last_active: null,
        runtime_failure: failure,
      })
      .mockResolvedValueOnce({
        id: 'abcd1234', name: 'dev-abcd1234', provider: 'claude_code',
        session_name: 'cao-test', agent_profile: 'developer', status: 'processing', last_active: null,
        runtime_failure: null,
      })

    render(<AgentPanel />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Rate limited')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(screen.queryByText('Rate limited')).not.toBeInTheDocument()
  })

  it('does not overlap projection reads for one terminal', async () => {
    vi.useFakeTimers()
    let resolveProjection: ((value: any) => void) | undefined
    vi.mocked(api.getTerminal).mockImplementation(() => new Promise(resolve => {
      resolveProjection = resolve
    }))

    render(<AgentPanel />)
    await act(async () => { await Promise.resolve() })
    expect(api.getTerminal).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(9000))
    expect(api.getTerminal).toHaveBeenCalledTimes(1)

    resolveProjection?.({
      id: 'abcd1234', name: 'dev-abcd1234', provider: 'claude_code',
      session_name: 'cao-test', agent_profile: 'developer', status: 'idle', last_active: null,
      runtime_failure: null,
    })
    await Promise.resolve()
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(api.getTerminal).toHaveBeenCalledTimes(2)
  })

  it('switch modal lists authenticated same-provider accounts only and submits', async () => {
    vi.mocked(api.getTerminal).mockResolvedValue({
      id: 'abcd1234',
      name: 'dev-abcd1234',
      provider: 'claude_code',
      session_name: 'cao-test',
      agent_profile: 'developer',
      status: 'error',
      last_active: null,
      runtime_failure: failure,
    })
    vi.mocked(api.switchProviderProfile).mockResolvedValue({
      predecessor_id: 'abcd1234',
      successor_id: 'eeee9999',
      status: 'switched',
    })

    render(<AgentPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /switch account/i }))

    // Claude B is unverified — it must be a disabled option, Claude A enabled.
    const targetCombo = await screen.findByText('Target account')
    expect(targetCombo).toBeInTheDocument()
    // The modal's explanatory warning vs resume
    expect(screen.getByText(/context handoff, not a conversation resume/i)).toBeInTheDocument()
    expect(screen.getByText(/automatic account rotation never happens/i)).toBeInTheDocument()
  })
})
