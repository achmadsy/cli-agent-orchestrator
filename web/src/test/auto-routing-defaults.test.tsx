import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoRoutingDefaultsCard } from '../components/AutoRoutingDefaultsCard'
import { api } from '../api'

const mocks = vi.hoisted(() => ({ showSnackbar: vi.fn() }))

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getAutoRoutingRoutes: vi.fn(),
      setAutoRoutingRoutes: vi.fn(),
      listProviders: vi.fn().mockResolvedValue([
        { name: 'claude_code', binary: 'claude', installed: true },
        { name: 'codex', binary: 'codex', installed: true },
        { name: 'kiro_cli', binary: 'kiro-cli', installed: false },
      ]),
    },
  }
})

vi.mock('../store', () => ({ useStore: () => ({ showSnackbar: mocks.showSnackbar }) }))

const ROUTES = {
  enabled: true,
  lane_names: ['architect_supervisor', 'feature_supervisor', 'fix_supervisor', 'probe_supervisor'],
  fallback_provider: 'kiro_cli',
  lanes: { fix_supervisor: { provider: 'codex', model: 'gpt-5.5' } },
  workers: {},
}

function pickCli(row: string, label: string) {
  const scope = within(screen.getByTestId(`auto-route-${row}`))
  fireEvent.click(scope.getByRole('button', { name: `${row} CLI` }))
  fireEvent.click(within(screen.getByTestId('custom-select-menu')).getByText(label))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getAutoRoutingRoutes).mockResolvedValue(structuredClone(ROUTES))
})

afterEach(cleanup)

describe('AutoRoutingDefaultsCard', () => {
  it('lists the four lanes in order with saved values and the fallback CLI', async () => {
    render(<AutoRoutingDefaultsCard />)
    expect(await screen.findByTestId('auto-route-probe_supervisor')).toBeInTheDocument()
    const rows = screen.getAllByTestId(/^auto-route-.*_supervisor$/).map(el => el.dataset.testid)
    expect(rows).toEqual([
      'auto-route-probe_supervisor',
      'auto-route-fix_supervisor',
      'auto-route-feature_supervisor',
      'auto-route-architect_supervisor',
    ])
    expect(screen.getByLabelText('fix_supervisor model')).toHaveValue('gpt-5.5')
    expect(within(screen.getByTestId('auto-route-probe_supervisor')).getByText('Default (kiro cli)')).toBeInTheDocument()
    expect(screen.getByTestId('auto-routing-save')).toBeDisabled()
  })

  it('saves only routes that pick a CLI and clears a model when the CLI changes', async () => {
    vi.mocked(api.setAutoRoutingRoutes).mockImplementation(async data => ({ ...ROUTES, lanes: data.lanes!, workers: data.workers! }))
    render(<AutoRoutingDefaultsCard />)
    await screen.findByTestId('auto-route-probe_supervisor')

    pickCli('fix_supervisor', 'claude code')
    expect(screen.getByLabelText('fix_supervisor model')).toHaveValue('')
    pickCli('developer', 'codex')
    fireEvent.change(screen.getByLabelText('developer model'), { target: { value: ' gpt-5.5 ' } })

    fireEvent.click(screen.getByTestId('auto-routing-save'))
    await waitFor(() => expect(api.setAutoRoutingRoutes).toHaveBeenCalledTimes(1))
    expect(api.setAutoRoutingRoutes).toHaveBeenCalledWith({
      lanes: { fix_supervisor: { provider: 'claude_code' } },
      workers: { developer: { provider: 'codex', model: 'gpt-5.5' } },
    })
    await waitFor(() => expect(screen.getByTestId('auto-routing-save')).toBeDisabled())
  })

  it('blocks saving a model with characters the server rejects', async () => {
    render(<AutoRoutingDefaultsCard />)
    await screen.findByTestId('auto-route-probe_supervisor')
    fireEvent.change(screen.getByLabelText('fix_supervisor model'), { target: { value: 'gpt 5' } })
    expect(screen.getByTestId('auto-routing-save')).toBeDisabled()
  })

  it('adds and removes a custom worker route', async () => {
    render(<AutoRoutingDefaultsCard />)
    await screen.findByTestId('auto-route-probe_supervisor')
    fireEvent.change(screen.getByLabelText('New worker profile name'), { target: { value: 'tester' } })
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    expect(screen.getByTestId('auto-route-tester')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove tester' }))
    expect(screen.queryByTestId('auto-route-tester')).not.toBeInTheDocument()
  })

  it('shows the server error and keeps the edits when saving fails', async () => {
    vi.mocked(api.setAutoRoutingRoutes).mockRejectedValue(Object.assign(new Error('400'), { detail: 'lanes: unknown lane' }))
    render(<AutoRoutingDefaultsCard />)
    await screen.findByTestId('auto-route-probe_supervisor')
    pickCli('probe_supervisor', 'codex')
    fireEvent.click(screen.getByTestId('auto-routing-save'))
    await waitFor(() => expect(mocks.showSnackbar).toHaveBeenCalledWith({ type: 'error', message: 'lanes: unknown lane' }))
    expect(screen.getByTestId('auto-routing-save')).toBeEnabled()
  })

  it('shows a note instead of the form on a server without the endpoint', async () => {
    vi.mocked(api.getAutoRoutingRoutes).mockResolvedValue({} as never)
    render(<AutoRoutingDefaultsCard />)
    expect(await screen.findByText(/does not offer Auto \(Jev\) defaults/)).toBeInTheDocument()
  })

  it('warns when Auto routing is off on the server', async () => {
    vi.mocked(api.getAutoRoutingRoutes).mockResolvedValue({ ...structuredClone(ROUTES), enabled: false })
    render(<AutoRoutingDefaultsCard />)
    expect(await screen.findByTestId('auto-routing-off')).toBeInTheDocument()
  })
})
