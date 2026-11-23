import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPanel } from '../components/AgentPanel'

const mocks = vi.hoisted(() => ({ statuses: { abcd1234: 'WAITING_USER_ANSWER' } as Record<string, string> }))
vi.mock('../store', () => ({ useStore: () => ({
  sessions: [{ id: 'cao-fixture', name: 'cao-fixture', status: 'active' }],
  activeSession: 'cao-fixture', activeSessionDetail: { name: 'cao-fixture', terminals: [{ id: 'abcd1234', provider: 'claude_code', agent_profile: 'probe_supervisor' }] },
  terminalStatuses: mocks.statuses, setTerminalStatus: vi.fn(), fetchSessions: vi.fn(), selectSession: vi.fn(), createSession: vi.fn(), createAutoSession: vi.fn(), deleteSession: vi.fn(), showSnackbar: vi.fn(),
}) }))
vi.mock('../api', async original => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, api: { ...actual.api,
    listProviders: vi.fn().mockResolvedValue([]), listProviderProfiles: vi.fn().mockResolvedValue([]), listProfiles: vi.fn().mockResolvedValue([]), getAutoRoutingStatus: vi.fn().mockResolvedValue({enabled:false}),
    getTerminal: vi.fn().mockResolvedValue({status:'waiting_user_answer'}), getTerminalWorkingDirectory: vi.fn().mockResolvedValue({working_directory:'/fixture'}),
    getNativeQuestion: vi.fn().mockResolvedValue({question:{revision:'a'.repeat(64),header:'Choice',text:'Which package?',options:[{number:1,label:'First package',description:'Fixture only'}],allows_text:true}}),
  } }
})
afterEach(cleanup)
it('shows the question for uppercase store status instead of normal task input', async () => {
  render(<AgentPanel />)
  expect(await screen.findByText('Which package?')).toBeInTheDocument()
  expect(screen.queryByText('Message agent...')).not.toBeInTheDocument()
  expect(screen.getByRole('button', {name:'Send answer'})).toBeDisabled()
})
