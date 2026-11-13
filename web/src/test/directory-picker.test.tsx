import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryPickerDialog } from '../components/DirectoryPickerDialog'
import { api, type BrowseDirectoriesResponse } from '../api'

vi.mock('../api', () => ({ api: { browseDirectories: vi.fn() } }))
const listing = (path = '/home/fixture'): BrowseDirectoriesResponse => ({
  current_path: path, parent_path: '/home', home_path: '/home/fixture', source_node: 'fixture-node',
  ancestors: [{ name: 'home', path: '/home' }, { name: 'fixture', path }],
  directories: [{ name: 'project', path: '/home/fixture/project' }], next_offset: null,
})

beforeEach(() => vi.mocked(api.browseDirectories).mockReset())
afterEach(cleanup)

describe('DirectoryPickerDialog', () => {
  it('navigates and confirms without spawning; shows server source', async () => {
    vi.mocked(api.browseDirectories).mockImplementation(async path => listing(path))
    const select = vi.fn(), close = vi.fn()
    render(<DirectoryPickerDialog onSelect={select} onClose={close} />)
    expect(await screen.findByText('Folders on fixture-node. Not your browser device.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'project' }))
    await waitFor(() => expect(screen.getByLabelText('Folder path')).toHaveValue('/home/fixture/project'))
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(select).toHaveBeenCalledExactlyOnceWith('/home/fixture/project')
    expect(close).toHaveBeenCalledOnce()
  })

  it('cancel/Escape preserves caller state and restores focus', async () => {
    vi.mocked(api.browseDirectories).mockResolvedValue(listing())
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    const select = vi.fn(), close = vi.fn()
    const view = render(<DirectoryPickerDialog initialPath="/old" onSelect={select} onClose={close} />)
    await screen.findByText('project')
    expect(button.hasAttribute('inert')).toBe(true)
    fireEvent.keyDown(screen.getByLabelText('Folder path'), { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    expect(select).not.toHaveBeenCalled()
    view.unmount()
    expect(document.activeElement).toBe(button)
    expect(button.hasAttribute('inert')).toBe(false)
    button.remove()
  })

  it('path Enter navigates and filter Enter never confirms', async () => {
    vi.mocked(api.browseDirectories).mockImplementation(async path => listing(path))
    const select = vi.fn()
    render(<DirectoryPickerDialog onSelect={select} onClose={vi.fn()} />)
    await screen.findByText('project')
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/home/other' } })
    fireEvent.submit(screen.getByLabelText('Folder path').closest('form')!)
    await waitFor(() => expect(api.browseDirectories).toHaveBeenCalledWith('/home/other', { query: '', offset: 0 }))
    fireEvent.keyDown(screen.getByLabelText('Filter folders'), { key: 'Enter' })
    expect(select).not.toHaveBeenCalled()
  })

  it('initial invalid path falls back explicitly, without changing form value', async () => {
    vi.mocked(api.browseDirectories).mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(listing())
    const select = vi.fn()
    render(<DirectoryPickerDialog initialPath="/missing" onSelect={select} onClose={vi.fn()} />)
    expect(await screen.findByText(/entered folder could not be opened/)).toBeTruthy()
    expect(select).not.toHaveBeenCalled()
    expect(api.browseDirectories).toHaveBeenLastCalledWith()
  })

  it('disables confirmation for errors and supports retry', async () => {
    vi.mocked(api.browseDirectories).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(listing())
    render(<DirectoryPickerDialog onSelect={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('project')
    expect(screen.getByRole('button', { name: 'Use this folder' })).not.toBeDisabled()
  })

  it('ignores slow old requests and distinguishes no filter matches', async () => {
    let resolveOld!: (value: BrowseDirectoriesResponse) => void
    vi.mocked(api.browseDirectories).mockResolvedValueOnce(listing())
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({ ...listing('/home/new'), directories: [] })
    render(<DirectoryPickerDialog onSelect={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('project')
    fireEvent.change(screen.getByLabelText('Filter folders'), { target: { value: 'slow' } })
    fireEvent.change(screen.getByLabelText('Filter folders'), { target: { value: 'new' } })
    expect(await screen.findByText('No folders match this filter.')).toBeTruthy()
    await act(async () => resolveOld(listing('/home/stale')))
    expect(screen.getByLabelText('Folder path')).toHaveValue('/home/new')
  })

  it('does not confirm a typed but unnavigated path', async () => {
    vi.mocked(api.browseDirectories).mockResolvedValue(listing())
    const select = vi.fn()
    render(<DirectoryPickerDialog onSelect={select} onClose={vi.fn()} />)
    await screen.findByText('project')
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/unverified' } })
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(select).not.toHaveBeenCalled()
  })

  it('traps focus and pages without losing loaded folders', async () => {
    vi.mocked(api.browseDirectories).mockResolvedValueOnce({ ...listing(), next_offset: 1 })
      .mockResolvedValueOnce({ ...listing(), directories: [{ name: 'second', path: '/home/fixture/second' }] })
    render(<DirectoryPickerDialog onSelect={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('project')
    const confirm = screen.getByRole('button', { name: 'Use this folder' })
    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close folder chooser' }))
    fireEvent.click(screen.getByRole('button', { name: 'Load more folders' }))
    await screen.findByText('second')
    expect(screen.getByText('project')).toBeTruthy()
  })
})
