import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPanel, AUTO_PROFILE } from '../components/AgentPanel'
import { api } from '../api'

const mocks = vi.hoisted(() => ({
  createSession: vi.fn().mockResolvedValue(undefined),
  createAutoSession: vi.fn(),
}))

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listProviders: vi.fn().mockResolvedValue([{ name: 'claude_code', binary: 'claude', installed: true }]),
      listProviderProfiles: vi.fn().mockResolvedValue([]),
      listProfiles: vi.fn().mockResolvedValue([
        { name: 'code_supervisor', description: 'Supervisor', source: 'built-in' },
        { name: 'developer', description: 'Developer', source: 'built-in' },
      ]),
      getProfile: vi.fn().mockResolvedValue({ name: 'code_supervisor', role: 'supervisor' }),
      getAutoRoutingStatus: vi.fn(),
    },
  }
})

vi.mock('../store', () => ({
  useStore: () => ({
    sessions: [],
    fetchSessions: vi.fn(),
    activeSession: null,
    activeSessionDetail: null,
    selectSession: vi.fn(),
    createSession: mocks.createSession,
    createAutoSession: mocks.createAutoSession,
    deleteSession: vi.fn(),
    terminalStatuses: {},
    setTerminalStatus: vi.fn(),
    showSnackbar: vi.fn(),
  }),
}))

async function openProfileMenu() {
  render(<AgentPanel />)
  fireEvent.click(screen.getByRole('button', { name: /Spawn Agent/ }))
  fireEvent.click(await screen.findByText('Select a profile...'))
}

function spawnButton() {
  // The header button closes over the modal; the footer one is the last match.
  const buttons = screen.getAllByRole('button', { name: /Spawn Agent|Routing/ })
  return buttons[buttons.length - 1]
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('AgentPanel Auto (Jev) option', () => {
  it('is hidden when auto routing is disabled', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: false, router_model: 'm' })
    await openProfileMenu()
    const menu = await screen.findByTestId('custom-select-menu')
    expect(await within(menu).findByText('developer')).toBeInTheDocument()
    expect(within(menu).queryByText('Auto (Jev)')).not.toBeInTheDocument()
  })

  it('is hidden when the status request fails', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockRejectedValue(new Error('offline'))
    await openProfileMenu()
    const menu = await screen.findByTestId('custom-select-menu')
    expect(await within(menu).findByText('developer')).toBeInTheDocument()
    expect(within(menu).queryByText('Auto (Jev)')).not.toBeInTheDocument()
  })

  it('requires a first prompt and launches through createAutoSession only', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: true, router_model: 'm' })
    mocks.createAutoSession.mockResolvedValue({
      terminal: { id: 'abcd1234' },
      decision: { lane: 'fix_supervisor', confidence: 0.9, fallback_reason: null, router_model: 'm' },
    })
    await openProfileMenu()
    fireEvent.click(await screen.findByText('Auto (Jev)'))

    const prompt = await screen.findByLabelText('First prompt')
    expect(screen.queryByText('Delegated agent CLIs')).not.toBeInTheDocument()
    expect(spawnButton()).toBeDisabled()

    fireEvent.change(prompt, { target: { value: '   ' } })
    expect(spawnButton()).toBeDisabled()

    fireEvent.change(prompt, { target: { value: 'fix the typo in README' } })
    expect(spawnButton()).toBeEnabled()
    fireEvent.click(spawnButton())

    await waitFor(() => expect(mocks.createAutoSession).toHaveBeenCalledTimes(1))
    const request = mocks.createAutoSession.mock.calls[0][0]
    expect(request).toMatchObject({ initial_message: 'fix the typo in README' })
    // Default provider choice: the server picks the lane CLI from Settings.
    expect(request).not.toHaveProperty('provider')
    expect(request).not.toHaveProperty('agent_profile')
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(api.getProfile).not.toHaveBeenCalledWith(AUTO_PROFILE)
    await waitFor(() => expect(screen.queryByLabelText('First prompt')).not.toBeInTheDocument())
  })

  it('offers a Settings default and sends a CLI only when one is picked', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: true, router_model: 'm' })
    mocks.createAutoSession.mockResolvedValue({
      terminal: { id: 'abcd1234' },
      decision: { lane: 'fix_supervisor', confidence: 0.9, fallback_reason: null, router_model: 'm' },
    })
    await openProfileMenu()
    fireEvent.click(await screen.findByText('Auto (Jev)'))

    // In Auto mode the provider select starts on the Settings default.
    fireEvent.click(await screen.findByText('Default (from Settings)'))
    const menu = await screen.findByTestId('custom-select-menu')
    fireEvent.click(within(menu).getByText('claude code'))

    fireEvent.change(await screen.findByLabelText('First prompt'), { target: { value: 'fix it' } })
    fireEvent.click(spawnButton())

    await waitFor(() => expect(mocks.createAutoSession).toHaveBeenCalledTimes(1))
    expect(mocks.createAutoSession.mock.calls[0][0]).toMatchObject({ initial_message: 'fix it', provider: 'claude_code' })
  })

  it('keeps the modal and the typed prompt when the launch fails', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: true, router_model: 'm' })
    mocks.createAutoSession.mockResolvedValue(null)
    await openProfileMenu()
    fireEvent.click(await screen.findByText('Auto (Jev)'))

    const prompt = await screen.findByLabelText('First prompt')
    fireEvent.change(prompt, { target: { value: 'explain the auth flow' } })
    fireEvent.click(spawnButton())

    await waitFor(() => expect(mocks.createAutoSession).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(spawnButton()).toBeEnabled())
    expect(screen.getByLabelText('First prompt')).toHaveValue('explain the auth flow')
  })
})
