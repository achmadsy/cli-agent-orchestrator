import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHistoryPanel } from '../components/AgentHistoryPanel'
import { agentHistoryApi, type AgentHistoryRecord } from '../api'

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, agentHistoryApi: { list: vi.fn(), detail: vi.fn(), resume: vi.fn() } }
})
vi.mock('../store', () => ({ useStore: { getState: () => ({ fetchSessions: vi.fn().mockResolvedValue(undefined) }) } }))
const record: AgentHistoryRecord = {
  terminal_id: 'old', session_name: 'cao-reboot', name: 'developer', provider: 'claude_code',
  source_node: 'fixture', origin: 'a'.repeat(32), version: 2, replica: false,
  synced_at: null, last_active: null, recorded_at: '', runtime_state: 'disconnected',
  last_known_status: null, resume_available: true, resume_state: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(agentHistoryApi.list).mockResolvedValue({ records: [record], total: 1, offset: 0 })
  vi.mocked(agentHistoryApi.detail).mockResolvedValue({ version: 2, output: 'Assistant: saved', output_source: 'recording', output_truncated: true,
    inbox: [{ id: 1, sender_id: 'human', receiver_id: 'old', message: 'old pending task', status: 'pending', channel: 'queued', created_at: '' }], inbox_truncated: false })
})
afterEach(cleanup)

describe('durable agent history', () => {
  it('is collapsed, read-only, and labels pending messages without delivering', async () => {
    render(<AgentHistoryPanel />)
    const button = await screen.findByRole('button', { name: /cao-reboot/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(agentHistoryApi.detail).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(await screen.findByText('Assistant: saved')).toBeInTheDocument()
    expect(screen.getByText('old pending task')).toBeInTheDocument()
    expect(screen.getByText(/Pending entries shown here will not be delivered/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(agentHistoryApi.resume).not.toHaveBeenCalled()
  })

  it('never offers remote snapshot resume', async () => {
    vi.mocked(agentHistoryApi.list).mockResolvedValue({ records: [{ ...record, replica: true, runtime_state: 'offline_snapshot', resume_available: false, synced_at: '2026-11-25T00:00:00Z' }], total: 1, offset: 0 })
    render(<AgentHistoryPanel />)
    expect(await screen.findByText('Remote snapshot')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume conversation/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Last synced/)).toBeInTheDocument()
  })

  it('requires confirmation and guards double submissions', async () => {
    let resolve!: (v: { terminal_id: string; session_name: string; task_replayed: boolean }) => void
    vi.mocked(agentHistoryApi.resume).mockReturnValue(new Promise(r => { resolve = r }))
    render(<AgentHistoryPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Resume conversation' }))
    const dialog = screen.getByRole('dialog', { name: 'Resume this conversation?' })
    expect(agentHistoryApi.resume).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    const confirm = within(dialog).getByRole('button', { name: 'Resume conversation' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(agentHistoryApi.resume).toHaveBeenCalledTimes(1)
    resolve({ terminal_id: 'new', session_name: 'cao-new', task_replayed: false })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText(/No task or pending messages were replayed/)).toBeInTheDocument()
  })
})
