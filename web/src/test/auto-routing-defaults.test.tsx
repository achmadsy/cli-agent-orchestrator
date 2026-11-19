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
      listProviders: vi.fn(),
      listProfiles: vi.fn(),
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
  builtin_models: { claude_code: ['opus', 'sonnet'], codex: ['gpt-6-sol', 'gpt-5.5'] },
  custom_models: {},
}

const PROFILES = [
  'architect_supervisor', 'feature_supervisor', 'fix_supervisor', 'probe_supervisor',
  'developer', 'reviewer', 'planner', 'code_supervisor', 'workflow_scout',
].map(name => ({ name, description: `${name} profile`, source: 'built-in' }))

function openMenu(row: string, field: 'CLI' | 'model') {
  const scope = within(screen.getByTestId(`auto-route-${row}`))
  fireEvent.click(scope.getByRole('button', { name: `${row} ${field}` }))
  return within(screen.getByTestId('custom-select-menu'))
}

function pickCli(row: string, label: string) {
  fireEvent.click(openMenu(row, 'CLI').getByText(label))
}

function pickModel(row: string, label: string) {
  fireEvent.click(openMenu(row, 'model').getByText(label))
}

const modelTrigger = (row: string) => screen.getByRole('button', { name: `${row} model` })

async function renderCard() {
  render(<AutoRoutingDefaultsCard />)
  await screen.findByTestId('auto-route-probe_supervisor')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getAutoRoutingRoutes).mockResolvedValue(structuredClone(ROUTES))
  vi.mocked(api.listProviders).mockResolvedValue([
    { name: 'claude_code', binary: 'claude', installed: true },
    { name: 'codex', binary: 'codex', installed: true },
    { name: 'kiro_cli', binary: 'kiro-cli', installed: false },
  ] as never)
  vi.mocked(api.listProfiles).mockResolvedValue(PROFILES as never)
  vi.mocked(api.setAutoRoutingRoutes).mockImplementation(async data => ({
    ...structuredClone(ROUTES),
    lanes: data.lanes!,
    workers: data.workers!,
    custom_models: data.custom_models ?? {},
  }))
})

afterEach(cleanup)

describe('AutoRoutingDefaultsCard', () => {
  it('lists the four lanes in order with saved values and the fallback CLI', async () => {
    await renderCard()
    const rows = screen.getAllByTestId(/^auto-route-.*_supervisor$/)
      .map(el => el.dataset.testid)
      .filter(id => id !== 'auto-route-code_supervisor')
    expect(rows).toEqual([
      'auto-route-probe_supervisor',
      'auto-route-fix_supervisor',
      'auto-route-feature_supervisor',
      'auto-route-architect_supervisor',
    ])
    expect(modelTrigger('fix_supervisor')).toHaveTextContent('gpt-5.5')
    expect(within(screen.getByTestId('auto-route-probe_supervisor')).getByText('Default (kiro cli)')).toBeInTheDocument()
    expect(screen.getByTestId('auto-routing-save')).toBeDisabled()
  })

  it('offers the CLI default, the built-in models and an add option for the picked CLI', async () => {
    await renderCard()
    expect(modelTrigger('probe_supervisor')).toBeDisabled()
    const menu = openMenu('fix_supervisor', 'model')
    expect(menu.getByText("CLI's default model")).toBeInTheDocument()
    expect(menu.getByText('gpt-6-sol')).toBeInTheDocument()
    expect(menu.getByText('Add a model…')).toBeInTheDocument()
    expect(menu.queryByText('opus')).not.toBeInTheDocument()
  })

  it('saves only routes that pick a CLI and clears a model when the CLI changes', async () => {
    await renderCard()
    pickCli('fix_supervisor', 'claude code')
    expect(modelTrigger('fix_supervisor')).toHaveTextContent("CLI's default model")
    pickCli('developer', 'codex')
    pickModel('developer', 'gpt-6-sol')

    fireEvent.click(screen.getByTestId('auto-routing-save'))
    await waitFor(() => expect(api.setAutoRoutingRoutes).toHaveBeenCalledTimes(1))
    expect(api.setAutoRoutingRoutes).toHaveBeenCalledWith({
      lanes: { fix_supervisor: { provider: 'claude_code' } },
      workers: { developer: { provider: 'codex', model: 'gpt-6-sol' } },
      custom_models: {},
    })
    await waitFor(() => expect(screen.getByTestId('auto-routing-save')).toBeDisabled())
  })

  it('adds a model, picks it, and offers it on every row with the same CLI', async () => {
    await renderCard()
    pickModel('fix_supervisor', 'Add a model…')
    fireEvent.change(screen.getByLabelText('New model for fix_supervisor'), { target: { value: ' gpt-7-preview ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
    expect(modelTrigger('fix_supervisor')).toHaveTextContent('gpt-7-preview')
    expect(screen.getByTestId('auto-routing-added-models')).toHaveTextContent('gpt-7-preview')

    pickCli('reviewer', 'codex')
    expect(openMenu('reviewer', 'model').getByText('gpt-7-preview')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('auto-routing-save'))
    await waitFor(() => expect(api.setAutoRoutingRoutes).toHaveBeenCalledTimes(1))
    expect(api.setAutoRoutingRoutes).toHaveBeenCalledWith({
      lanes: { fix_supervisor: { provider: 'codex', model: 'gpt-7-preview' } },
      workers: { reviewer: { provider: 'codex' } },
      custom_models: { codex: ['gpt-7-preview'] },
    })
  })

  it('rejects a model ID with characters the server rejects', async () => {
    await renderCard()
    pickModel('fix_supervisor', 'Add a model…')
    fireEvent.change(screen.getByLabelText('New model for fix_supervisor'), { target: { value: 'gpt 7' } })
    expect(screen.getByRole('button', { name: 'Add model' })).toBeDisabled()
    expect(screen.getByText(/may only use letters, digits/)).toBeInTheDocument()
  })

  it('removes an added model and keeps a route that still names it', async () => {
    vi.mocked(api.getAutoRoutingRoutes).mockResolvedValue({
      ...structuredClone(ROUTES),
      lanes: { fix_supervisor: { provider: 'codex', model: 'gpt-7' } },
      custom_models: { codex: ['gpt-7'] },
    })
    await renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Remove model gpt-7 from codex' }))
    expect(screen.queryByTestId('auto-routing-added-models')).not.toBeInTheDocument()
    expect(modelTrigger('fix_supervisor')).toHaveTextContent('gpt-7')
    fireEvent.click(screen.getByTestId('auto-routing-save'))
    await waitFor(() => expect(api.setAutoRoutingRoutes).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.setAutoRoutingRoutes).mock.calls[0][0].custom_models).toEqual({})
  })

  it('lists every non-lane profile as a worker, lane workers first', async () => {
    await renderCard()
    const laneWorkers = within(screen.getByTestId('auto-workers-lane'))
      .getAllByTestId(/^auto-route-/).map(el => el.dataset.testid)
    expect(laneWorkers).toEqual(['auto-route-developer', 'auto-route-reviewer', 'auto-route-planner'])
    const others = within(await screen.findByTestId('auto-workers-other'))
      .getAllByTestId(/^auto-route-/).map(el => el.dataset.testid)
    expect(others).toEqual(['auto-route-code_supervisor', 'auto-route-workflow_scout'])
    expect(screen.getAllByTestId('auto-route-fix_supervisor')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Remove workflow_scout' })).not.toBeInTheDocument()
  })

  it('adds and removes a route for a profile this server does not have', async () => {
    await renderCard()
    fireEvent.change(screen.getByLabelText('New worker profile name'), { target: { value: 'tester' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByTestId('auto-route-tester')).toHaveTextContent('No profile on this server')
    fireEvent.click(screen.getByRole('button', { name: 'Remove tester' }))
    expect(screen.queryByTestId('auto-route-tester')).not.toBeInTheDocument()
  })

  it('hides the add option and sends no custom_models to a server without them', async () => {
    const { custom_models: _omit, ...older } = structuredClone(ROUTES)
    vi.mocked(api.getAutoRoutingRoutes).mockResolvedValue(older as never)
    await renderCard()
    expect(openMenu('fix_supervisor', 'model').queryByText('Add a model…')).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    pickCli('probe_supervisor', 'codex')
    fireEvent.click(screen.getByTestId('auto-routing-save'))
    await waitFor(() => expect(api.setAutoRoutingRoutes).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.setAutoRoutingRoutes).mock.calls[0][0]).not.toHaveProperty('custom_models')
  })

  it('shows the server error and keeps the edits when saving fails', async () => {
    vi.mocked(api.setAutoRoutingRoutes).mockRejectedValue(Object.assign(new Error('400'), { detail: 'lanes: unknown lane' }))
    await renderCard()
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
