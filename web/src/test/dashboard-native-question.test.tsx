import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useStore } from '../store'
import { DashboardHome } from '../components/DashboardHome'

vi.mock('../api', async original => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, api: { ...actual.api,
    listProfiles: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue({ name: 'cao-apk-test', terminals: [{ id: 'e5f6a0a6', provider: 'claude_code', agent_profile: 'probe_supervisor', created_at: '2026-11-23T16:50:00Z', last_active: '2026-11-23T16:56:00Z' }] }),
    getTerminalStatus: vi.fn().mockResolvedValue('waiting_user_answer'),
    getNativeQuestion: vi.fn().mockResolvedValue({ question: { revision: 'a'.repeat(64), header: 'File APK', text: 'Which APK should be checked?', options: [{ number: 1, label: 'Fixture APK', description: 'Fixture only; no live input.' }], allows_text: true }, fallback: null }),
    answerNativeQuestion: vi.fn().mockResolvedValue({ success: true, message: 'Answer sent.' }),
    sendInput: vi.fn(),
  } }
})

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({ sessions: [{ id: 'cao-apk-test', name: 'cao-apk-test', status: 'active' }], terminalStatuses: {} })
  vi.mocked(api.getTerminalStatus).mockResolvedValue('waiting_user_answer')
  vi.mocked(api.getNativeQuestion).mockResolvedValue({ question: { revision: 'a'.repeat(64), header: 'File APK', text: 'Which APK should be checked?', options: [{ number: 1, label: 'Fixture APK', description: 'Fixture only; no live input.' }], allows_text: true }, fallback: null })
})
afterEach(() => { cleanup(); useStore.setState({ sessions: [], terminalStatuses: {} }) })

it('shows the question on default Home cards using the real uppercase-normalizing store', async () => {
  render(<DashboardHome onNavigate={vi.fn()} />)
  const toggle = await screen.findByRole('button', { name: /Answer needed/ })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  fireEvent.click(toggle)
  expect(await screen.findByText('Which APK should be checked?')).toBeVisible()
  expect(screen.getByRole('button', { name: /^Terminal$/ })).toBeInTheDocument()
  expect(screen.getAllByText('probe_supervisor').length).toBeGreaterThan(0)
  expect(screen.getByText('e5f6a0a6')).toBeInTheDocument()
  expect(screen.queryByText('Message agent...')).not.toBeInTheDocument()
  expect(useStore.getState().terminalStatuses.e5f6a0a6).toBe('WAITING_USER_ANSWER')
  expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
  expect(api.answerNativeQuestion).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: /Fixture APK/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
  await waitFor(() => expect(api.answerNativeQuestion).toHaveBeenCalledWith('e5f6a0a6', { revision: 'a'.repeat(64), option: 1 }))
  expect(api.sendInput).not.toHaveBeenCalled()
})

it('retains terminal fallback instead of generic message input for unsupported waiting dialogs', async () => {
  vi.mocked(api.getNativeQuestion).mockResolvedValue({ question: null, fallback: 'Open Terminal' })
  render(<DashboardHome onNavigate={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /Answer needed/ }))
  expect(await screen.findByText(/This dialog cannot be answered here safely/)).toBeVisible()
  expect(screen.queryByText('Message agent...')).not.toBeInTheDocument()
  expect(screen.queryByRole('radio')).not.toBeInTheDocument()
})

it('keeps ordinary messaging for agents that are not waiting for an answer', async () => {
  vi.mocked(api.getTerminalStatus).mockResolvedValue('completed')
  render(<DashboardHome onNavigate={vi.fn()} />)
  await waitFor(() => expect(useStore.getState().terminalStatuses.e5f6a0a6).toBe('COMPLETED'))
  expect(screen.getByText('Message agent...')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument()
  expect(api.getNativeQuestion).not.toHaveBeenCalled()
})
