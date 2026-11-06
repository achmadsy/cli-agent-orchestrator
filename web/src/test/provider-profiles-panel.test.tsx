import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderProfilesPanel } from '../components/ProviderProfilesPanel'
import { api } from '../api'

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listProviderProfiles: vi.fn(),
      listProviders: vi.fn(),
      listProviderProfileCapabilities: vi.fn(),
    },
  }
})

vi.mock('../store', () => ({
  useStore: () => ({ showSnackbar: vi.fn() }),
}))

describe('ProviderProfilesPanel', () => {
  beforeEach(() => {
    vi.mocked(api.listProviderProfiles).mockResolvedValue([])
    vi.mocked(api.listProviders).mockResolvedValue([
      { name: 'claude_code', binary: 'claude', installed: true },
      { name: 'codex', binary: 'codex', installed: true },
    ])
    vi.mocked(api.listProviderProfileCapabilities).mockResolvedValue({
      claude_code: { supported: true, profile_mode: 'isolated_home', auth_lifecycle: true, quota: true, resume: true },
      codex: { supported: false, profile_mode: 'unsupported', auth_lifecycle: false, quota: true, resume: false, unavailable_reason: 'Codex isolation test reason.' },
    })
  })

  it('labels each form value and explains default account behavior', async () => {
    render(<ProviderProfilesPanel />)

    expect(await screen.findByLabelText('Provider CLI')).toBeInTheDocument()
    expect(screen.getByLabelText('Account profile ID')).toBeInTheDocument()
    expect(screen.getByLabelText('Display name')).toBeInTheDocument()
    expect(screen.getByText('Use as default account for this provider')).toBeInTheDocument()
    expect(screen.queryByText(/unpinned/i)).not.toBeInTheDocument()
  })

  it('keeps unsupported providers visible with a concrete explanation', async () => {
    render(<ProviderProfilesPanel />)

    const select = await screen.findByLabelText('Provider CLI')
    const codex = Array.from((select as HTMLSelectElement).options).find(option => option.value === 'codex')
    expect(codex?.textContent).toContain('account isolation unavailable')
    fireEvent.change(select, { target: { value: 'codex' } })
    expect(await screen.findByText(/Codex isolation test reason/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add account profile' })).toBeDisabled()
  })
})
