import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../api'
import { CodeGraphPanel } from '../components/CodeGraphPanel'

const overview = {
  nodes: [{ node_id: 'node-a', online: true }, { node_id: 'node-b', online: false }],
  projects: [{ node_id: 'node-a', logical_project: 'repo-id', native_project: 'native-repo', display_name: 'example/repo', online: true, available: true, branch: 'main', head_sha: '123456789', dirty: true, indexed_at: '2026-11-18T18:37:41Z', node_count: 100, edge_count: 240, stale: true, commits_since_index: 3 }],
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CodeGraphPanel', () => {
  it('shows actual index metadata and searches only on submission', async () => {
    vi.spyOn(api, 'getCodeGraphProjects').mockResolvedValue(overview)
    const search = vi.spyOn(api, 'searchCodeGraph').mockResolvedValue({ matches: [{ source_node: 'node-a', branch: 'main', qualified_name: 'repo.run', kind: 'Function', file_path: 'src/run.py', lines: '2-4' }], partial: false, node_errors: [] })
    render(<CodeGraphPanel />)
    expect(await screen.findByText('Behind HEAD')).toBeInTheDocument()
    expect(screen.getByText('3 newer commits')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
    expect(screen.getByTitle('2026-11-18T18:37:41Z')).toHaveAttribute('datetime', '2026-11-18T18:37:41Z')
    expect(search).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Symbol query'), { target: { value: 'run' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('repo.run')).toBeInTheDocument()
    expect(search).toHaveBeenCalledWith('repo-id', 'run', undefined)
  })

  it('shows unknown legacy metadata instead of inventing a fresh timestamp', async () => {
    vi.spyOn(api, 'getCodeGraphProjects').mockResolvedValue({ ...overview, projects: [{ ...overview.projects[0], indexed_at: null, node_count: null, edge_count: null, stale: null, commits_since_index: null }] })
    render(<CodeGraphPanel />)
    expect(await screen.findAllByText('Unknown')).toHaveLength(4)
  })

  it('explains the disabled feature', async () => {
    vi.spyOn(api, 'getCodeGraphProjects').mockRejectedValue({ status: 404 })
    render(<CodeGraphPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Code graph is disabled')
  })

  it('filters to an offline node with no indexes', async () => {
    vi.spyOn(api, 'getCodeGraphProjects').mockResolvedValue(overview)
    render(<CodeGraphPanel />)
    await screen.findByText('Behind HEAD')
    fireEvent.click(screen.getByLabelText('Code graph node'))
    fireEvent.click(screen.getByRole('button', { name: 'node-b (Offline)' }))
    expect(screen.getByText(/No code indexes registered on this node/)).toBeInTheDocument()
  })

  it('discards an old symbol response after the query changes', async () => {
    vi.spyOn(api, 'getCodeGraphProjects').mockResolvedValue(overview)
    let release!: (v: any) => void
    vi.spyOn(api, 'searchCodeGraph').mockReturnValue(new Promise(resolve => { release = resolve }))
    render(<CodeGraphPanel />)
    await screen.findByText('Behind HEAD')
    fireEvent.change(screen.getByLabelText('Symbol query'), { target: { value: 'old' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.change(screen.getByLabelText('Symbol query'), { target: { value: 'new' } })
    release({ matches: [{ source_node: 'node-a', qualified_name: 'stale.symbol', file_path: 'old.py', lines: '' }], partial: false, node_errors: [] })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search' })).not.toBeDisabled())
    expect(screen.queryByText('stale.symbol')).not.toBeInTheDocument()
  })
})
