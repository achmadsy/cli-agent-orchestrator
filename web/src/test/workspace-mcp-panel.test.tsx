import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceMcpPanel } from '../components/WorkspaceMcpPanel'
import { api, WorkspaceMcpInstance } from '../api'

const INSTANCE: WorkspaceMcpInstance = {
  id: 'wmcp-abcdef12',
  folder_path: '/home/ubuntu/workspace/repo-a',
  agentic: true,
  port: 8787,
  state_dir: '/home/ubuntu/.local/share/workspace-mcp/instances/wmcp-abcdef12',
  tmux_socket: 'wmcp-abcdef12',
  tmux_session: 'wmcp-abcdef12',
  status: 'running',
  tunnel_url: 'https://my-slug.trycloudflare.com',
  admin_password: 'secret-password',
  created_at: '2026-10-17T00:00:00Z',
  error: null,
}

describe('WorkspaceMcpPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const mockList = (rows: WorkspaceMcpInstance[]) => vi.spyOn(api, 'listWorkspaceMcps').mockResolvedValue(rows)

  it('renders empty state when no instances', async () => {
    mockList([])
    render(<WorkspaceMcpPanel />)
    await waitFor(() => {
      expect(screen.getByText(/No workspace MCP instances running/)).toBeInTheDocument()
    })
  })

  it('renders instances with tunnel URL and status', async () => {
    mockList([INSTANCE])
    render(<WorkspaceMcpPanel />)
    await waitFor(() => {
      expect(screen.getByText('/home/ubuntu/workspace/repo-a')).toBeInTheDocument()
    })
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('https://my-slug.trycloudflare.com')).toBeInTheDocument()
  })

  it('spawns a workspace MCP from the form', async () => {
    mockList([])
    const create = vi.spyOn(api, 'createWorkspaceMcp').mockResolvedValue(INSTANCE)
    render(<WorkspaceMcpPanel />)
    const input = await screen.findByLabelText('Folder path')
    fireEvent.change(input, { target: { value: '/home/ubuntu/workspace/repo-a' } })
    const button = screen.getByRole('button', { name: /Spawn Workspace MCP/ })
    fireEvent.click(button)
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith('/home/ubuntu/workspace/repo-a', true)
    })
  })

  it('stops an instance after window.confirm', async () => {
    mockList([INSTANCE])
    const del = vi.spyOn(api, 'deleteWorkspaceMcp').mockResolvedValue({ ...INSTANCE, status: 'stopped' })
    render(<WorkspaceMcpPanel />)
    const stopButton = await screen.findByLabelText('Stop wmcp-abcdef12')
    fireEvent.click(stopButton)
    await waitFor(() => {
      expect(del).toHaveBeenCalledWith('wmcp-abcdef12')
    })
    expect(window.confirm).toHaveBeenCalled()
  })

  it('hides and shows the admin password', async () => {
    mockList([INSTANCE])
    render(<WorkspaceMcpPanel />)
    const showButton = await screen.findByLabelText(/Show password/)
    expect(screen.queryByText('secret-password')).not.toBeInTheDocument()
    fireEvent.click(showButton)
    expect(screen.getByText('secret-password')).toBeInTheDocument()
  })
})
