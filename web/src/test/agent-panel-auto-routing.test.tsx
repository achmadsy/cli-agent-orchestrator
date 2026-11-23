import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const CLAUDE_WORK = {
  id: 'claude-work', label: 'Claude Work', provider: 'claude_code', auth_state: 'authenticated',
  login_method: 'isolated_home', settings: {}, is_default: false, created_at: '', updated_at: '',
}

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

describe('AgentPanel session name input', () => {
  async function openSessionName() {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: false, router_model: 'm' })
    await openProfileMenu()
    await act(async () => {
      fireEvent.click(within(await screen.findByTestId('custom-select-menu')).getByText('developer'))
    })
    return screen.getByRole('textbox', { name: /Session Name/ }) as HTMLInputElement
  }

  it('ignores Space without replacing selected text or moving the caret', async () => {
    const input = await openSessionName()
    fireEvent.change(input, { target: { value: 'my-session' } })
    input.focus()
    input.setSelectionRange(2, 5)

    expect(fireEvent.keyDown(input, { key: ' ', code: 'Space' })).toBe(false)
    expect(input).toHaveValue('my-session')
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(5)
  })

  it.each([
    ['my session', 'mysession'],
    ['  my  session  ', 'mysession'],
    ['my\t\nsession\r name', 'mysessionname'],
    ['my session name', 'mysessionname'],
    ['my-session_123', 'my-session_123'],
    [' \t  ', ''],
  ])('filters whitespace from inserted text %j', async (value, expected) => {
    const input = await openSessionName()
    // Change covers the resulting value from typing, paste, or mobile input.
    fireEvent.change(input, { target: { value } })
    expect(input).toHaveValue(expected)
  })

  it('keeps navigation and editing keys available', async () => {
    const input = await openSessionName()
    for (const key of ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Tab']) {
      expect(fireEvent.keyDown(input, { key })).toBe(true)
    }
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('submits the filtered name with Enter on a manual launch', async () => {
    const input = await openSessionName()
    fireEvent.change(input, { target: { value: 'my session' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
    expect(mocks.createSession.mock.calls[0][3]).toBe('mysession')
    expect(mocks.createAutoSession).not.toHaveBeenCalled()
  })

  it('keeps a whitespace-only name optional', async () => {
    const input = await openSessionName()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(spawnButton())

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
    expect(mocks.createSession.mock.calls[0][3]).toBeUndefined()
  })

  it('submits the filtered name on an Auto launch without filtering the prompt', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: true, router_model: 'm' })
    mocks.createAutoSession.mockResolvedValue({ terminal: { id: 'abcd1234' } })
    await openProfileMenu()
    fireEvent.click(await screen.findByText('Auto (Jev)'))
    fireEvent.change(await screen.findByLabelText('First prompt'), { target: { value: 'fix the typo' } })
    const input = screen.getByRole('textbox', { name: /Session Name/ })
    fireEvent.change(input, { target: { value: 'my auto session' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mocks.createAutoSession).toHaveBeenCalledTimes(1))
    expect(mocks.createAutoSession.mock.calls[0][0]).toMatchObject({
      initial_message: 'fix the typo', session_name: 'myautosession',
    })
    expect(mocks.createSession).not.toHaveBeenCalled()
  })
})

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

  it('attaches original document bytes and retains the task/files when launch fails', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: true, router_model: 'm' })
    mocks.createAutoSession.mockResolvedValue(null)
    await openProfileMenu()
    fireEvent.click(await screen.findByText('Auto (Jev)'))
    const prompt = await screen.findByLabelText('First prompt')
    fireEvent.change(prompt, { target: { value: 'inspect this PDF' } })
    const file = new File(['%PDF-fixture'], 'report.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Attach files to first prompt'), { target: { files: [file] } })
    expect(screen.getByLabelText('Prompt attachments')).toHaveTextContent('report.pdf')
    fireEvent.click(spawnButton())
    await waitFor(() => expect(mocks.createAutoSession).toHaveBeenCalledTimes(1))
    expect(mocks.createAutoSession.mock.calls[0][0]).toMatchObject({ initial_message: 'inspect this PDF', attachments: [{ filename: 'report.pdf', content_type: 'application/pdf', data_base64: btoa('%PDF-fixture') }] })
    await waitFor(() => expect(spawnButton()).toBeEnabled())
    expect(prompt).toHaveValue('inspect this PDF')
    fireEvent.click(screen.getByLabelText('Remove attachment report.pdf'))
    expect(screen.queryByLabelText('Prompt attachments')).not.toBeInTheDocument()
  })

  it('accepts document drops and rejects a fifth pending attachment', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: true, router_model: 'm' })
    await openProfileMenu()
    fireEvent.click(await screen.findByText('Auto (Jev)'))
    const prompt = await screen.findByLabelText('First prompt')
    const files = Array.from({ length: 4 }, (_, i) => new File(['text'], `note-${i}.txt`, { type: 'text/plain' }))
    fireEvent.drop(prompt, { dataTransfer: { files } })
    expect(screen.getByLabelText('Prompt attachments').querySelectorAll('li')).toHaveLength(4)
    fireEvent.paste(prompt, { clipboardData: { files: [new File(['extra'], 'extra.txt')] } })
    expect(screen.getByRole('alert')).toHaveTextContent('up to four')
    expect(screen.getByLabelText('Prompt attachments').querySelectorAll('li')).toHaveLength(4)
    expect(spawnButton()).toBeDisabled() // typed task is still required
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

  it('lists accounts by name in the CLI menu and sends the picked account', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: true, router_model: 'm' })
    vi.mocked(api.listProviderProfiles).mockResolvedValueOnce([CLAUDE_WORK] as never)
    mocks.createAutoSession.mockResolvedValue({
      terminal: { id: 'abcd1234' },
      decision: { lane: 'fix_supervisor', confidence: 0.9, fallback_reason: null, router_model: 'm' },
    })
    await openProfileMenu()
    fireEvent.click(await screen.findByText('Auto (Jev)'))

    fireEvent.click(screen.getByRole('button', { name: 'Spawn CLI' }))
    const menu = await screen.findByTestId('custom-select-menu')
    fireEvent.click(await within(menu).findByText('Claude Work'))
    expect(screen.getByRole('button', { name: 'Spawn CLI' })).toHaveTextContent('Claude Work')

    fireEvent.change(await screen.findByLabelText('First prompt'), { target: { value: 'fix it' } })
    fireEvent.click(spawnButton())
    await waitFor(() => expect(mocks.createAutoSession).toHaveBeenCalledTimes(1))
    expect(mocks.createAutoSession.mock.calls[0][0]).toMatchObject({
      provider: 'claude_code',
      provider_profile: 'claude-work',
    })
  })

  it('sends the account picked in the CLI menu with a manual launch', async () => {
    vi.mocked(api.getAutoRoutingStatus).mockResolvedValue({ enabled: false, router_model: 'm' })
    vi.mocked(api.listProviderProfiles).mockResolvedValueOnce([CLAUDE_WORK] as never)
    render(<AgentPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Spawn Agent/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Spawn CLI' }))
    const cliMenu = await screen.findByTestId('custom-select-menu')
    fireEvent.click(await within(cliMenu).findByText('Claude Work'))
    fireEvent.click(await screen.findByText('Select a profile...'))
    fireEvent.click(within(await screen.findByTestId('custom-select-menu')).getByText('developer'))
    fireEvent.click(spawnButton())

    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1))
    const args = mocks.createSession.mock.calls[0]
    expect(args[0]).toBe('claude_code')
    expect(args[5]).toBe('claude-work')
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
