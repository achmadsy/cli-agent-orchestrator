import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxPanel } from '../components/InboxPanel'
import { api, type InboxMessage } from '../api'

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    api: { ...actual.api, getInboxMessages: vi.fn(), sendInboxMessage: vi.fn() },
  }
})

const rows: InboxMessage[] = [
  {
    id: '1',
    sender_id: 'ui',
    receiver_id: 'worker99',
    message: 'typed from quick-send',
    status: 'delivered',
    channel: 'direct',
    created_at: '2026-11-18T07:00:00',
  },
  {
    id: '2',
    sender_id: 'sup12345',
    receiver_id: 'worker99',
    message: 'queued by the supervisor',
    status: 'pending',
    channel: 'queued',
    created_at: '2026-11-18T07:01:00',
  },
  {
    id: '3',
    sender_id: 'worker99',
    receiver_id: 'sup12345',
    message: 'reply from this agent',
    status: 'delivered',
    channel: 'queued',
    created_at: '2026-11-18T07:02:00',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom has no layout, so scrollIntoView is missing.
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(api.getInboxMessages).mockResolvedValue(rows)
})
afterEach(cleanup)

describe('InboxPanel', () => {
  it('requests the latest history including sent messages', async () => {
    render(<InboxPanel terminalId="worker99" onClose={() => {}} />)
    await screen.findByText('typed from quick-send')

    expect(api.getInboxMessages).toHaveBeenCalledWith('worker99', 50, undefined, {
      latest: true,
      includeSent: true,
      includeHistory: true,
    })
  })

  it('shows channel badges, full sender labels and outgoing messages', async () => {
    render(<InboxPanel terminalId="worker99" onClose={() => {}} />)
    await screen.findByText('typed from quick-send')

    expect(screen.getByText('from ui')).toBeInTheDocument()
    expect(screen.getByText('from sup12345')).toBeInTheDocument()
    expect(screen.getByText('to sup12345')).toBeInTheDocument()
    expect(screen.getByText('reply from this agent')).toBeInTheDocument()
    expect(screen.getAllByText('Direct')).toHaveLength(1)
    expect(screen.getAllByText('Queued')).toHaveLength(2)
  })

  it('shows original identities and correct direction for recovered history', async () => {
    vi.mocked(api.getInboxMessages).mockResolvedValue(rows.map(row => ({
      ...row,
      history_terminal_id: 'worker99',
    })))
    render(<InboxPanel terminalId="new00000" onClose={() => {}} />)
    await screen.findByText('typed from quick-send')

    expect(screen.getByText('from ui')).toBeInTheDocument()
    expect(screen.getByText('from sup12345')).toBeInTheDocument()
    expect(screen.getByText('to sup12345')).toBeInTheDocument()
    expect(screen.getAllByText('History from worker99 (not requeued)')).toHaveLength(3)
    expect(api.sendInboxMessage).not.toHaveBeenCalled()
  })

  it('labels the send box as a queue', async () => {
    render(<InboxPanel terminalId="worker99" onClose={() => {}} />)
    await screen.findByText('typed from quick-send')

    expect(
      screen.getByPlaceholderText('Queue a message (delivered when the agent is idle)...')
    ).toBeInTheDocument()
  })
})
