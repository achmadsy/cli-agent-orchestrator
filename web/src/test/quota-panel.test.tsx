import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuotaPanel } from '../components/QuotaPanel'
import { api, ProviderProfile, ProviderQuota } from '../api'

const snackbar = vi.fn()
vi.mock('../store', () => ({ useStore: () => ({ showSnackbar: snackbar }) }))
vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api: { ...actual.api, listProviderProfiles: vi.fn(), getProviderQuotaOverview: vi.fn(), previewQuotaReset: vi.fn(), confirmQuotaReset: vi.fn(), getQuotaResetOperation: vi.fn(), getQuotaResetDetails: vi.fn() } }
})
const profile = { id: 'codex-work', label: 'Work Codex', provider: 'codex', auth_state: 'authenticated' } as ProviderProfile
const reset = { status: 'supported', remaining_count: 2, can_reset: true, disabled_reason: '', details: [] }
const quota: ProviderQuota = { profile_id: profile.id, status: 'ok', stale: false, can_manage_resets: true, reset_allowance: reset, quotas: [{ key: 'weekly', name: 'Weekly Fable', used: 75, total: 100, remaining: 25 }] }

beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear()
  vi.mocked(api.listProviderProfiles).mockResolvedValue([profile])
  vi.mocked(api.getProviderQuotaOverview).mockResolvedValue([quota])
  vi.mocked(api.previewQuotaReset).mockResolvedValue({ intent_id: 'a'.repeat(32), account_display: profile.label, provider: 'codex', cost: 1, effect: 'Reset eligible windows', expires_at: new Date(Date.now() + 120000).toISOString(), allowance: reset })
  vi.mocked(api.confirmQuotaReset).mockResolvedValue({ operation_id: 'a'.repeat(32), status: 'succeeded', quota_refresh: 'succeeded' })
})

describe('QuotaPanel reset controls', () => {
  it('shows remaining usage and allowances separately; manual refresh forces a read', async () => {
    render(<QuotaPanel />)
    expect(await screen.findByText('25% remaining')).toBeInTheDocument()
    expect(screen.getByText('Resets left:')).toHaveTextContent('Resets left: 2')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.getProviderQuotaOverview).toHaveBeenLastCalledWith(true))
  })

  it('cancel consumes nothing; explicit confirmation submits once', async () => {
    render(<QuotaPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reset limits' }))
    const dialog = await screen.findByRole('dialog', { name: 'Use one account reset?' })
    expect(within(dialog).getByText(/cannot be undone/)).toHaveTextContent('Work Codex')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(api.confirmQuotaReset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reset limits' }))
    const next = await screen.findByRole('dialog')
    const confirm = within(next).getByRole('button', { name: 'Use one reset' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    await waitFor(() => expect(api.confirmQuotaReset).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Reset succeeded.')).toBeInTheDocument()
  })

  it('unknown allowance is not zero and read viewers have no reset action', async () => {
    vi.mocked(api.getProviderQuotaOverview).mockResolvedValue([{ ...quota, can_manage_resets: false, reset_allowance: { ...reset, remaining_count: null, can_reset: false } }])
    render(<QuotaPanel />)
    expect(await screen.findByText('Resets left:')).toHaveTextContent('Unknown')
    expect(screen.queryByRole('button', { name: 'Reset limits' })).not.toBeInTheDocument()
  })

  it('disables positive-count resets when unusable or stale', async () => {
    vi.mocked(api.getProviderQuotaOverview).mockResolvedValue([{ ...quota, stale: true, reset_allowance: { ...reset, can_reset: false, disabled_reason: 'Cooldown active' } }])
    render(<QuotaPanel />)
    expect(await screen.findByRole('button', { name: 'Reset limits' })).toBeDisabled()
    expect(api.previewQuotaReset).not.toHaveBeenCalled()
  })

  it('recovers an unresolved operation on remount without consuming again', async () => {
    sessionStorage.setItem(`cao.quota.reset.${profile.id}`, 'b'.repeat(32))
    vi.mocked(api.getQuotaResetOperation).mockResolvedValue({ operation_id: 'b'.repeat(32), status: 'submitted', reason: 'Outcome unconfirmed', quota_refresh: 'not_attempted' })
    render(<QuotaPanel />)
    expect(await screen.findByText('Outcome unconfirmed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset limits' })).toBeDisabled()
    expect(api.confirmQuotaReset).not.toHaveBeenCalled()
  })

  it('lost confirmation response reads status and never retries consumption', async () => {
    vi.mocked(api.confirmQuotaReset).mockRejectedValue(new Error('Disconnected'))
    vi.mocked(api.getQuotaResetOperation).mockResolvedValue({ operation_id: 'a'.repeat(32), status: 'unknown', reason: 'Outcome unknown; do not retry', quota_refresh: 'not_attempted' })
    render(<QuotaPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reset limits' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Use one reset' }))
    expect(await screen.findByText('Outcome unknown; do not retry')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset limits' })).toBeDisabled()
    expect(api.confirmQuotaReset).toHaveBeenCalledTimes(1)
    expect(api.getQuotaResetOperation).toHaveBeenCalledWith(profile.id, 'a'.repeat(32))
  })
})
