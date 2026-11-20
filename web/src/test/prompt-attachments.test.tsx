import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptAttachments } from '../components/PromptAttachments'

// Preview state must not carry a removed image onto a document occupying its row.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('prompt attachment previews', () => {
  it('revokes object URLs and never shows document bodies as image previews', () => {
    const create = vi.fn().mockReturnValue('blob:fixture')
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
    const image = new File(['fixture'], 'report.png', { type: 'image/png', lastModified: 1 })
    const document = new File(['fixture'], 'report.png', { type: 'text/plain', lastModified: 1 })
    const props = { disabled: false, onAdd: vi.fn(), onRemove: vi.fn() }
    const view = render(<PromptAttachments {...props} files={[image]} />)
    expect(screen.getByAltText('Preview of report.png')).toBeInTheDocument()
    view.rerender(<PromptAttachments {...props} files={[document]} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:fixture')
    view.rerender(<PromptAttachments {...props} files={[image]} />)
    view.unmount()
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  it('offers multiple selection, removal, and disables editing while creating', () => {
    const file = new File(['fixture'], 'report.pdf', { type: 'application/pdf' })
    const onAdd = vi.fn(), onRemove = vi.fn()
    const view = render(<PromptAttachments files={[file]} disabled={false} onAdd={onAdd} onRemove={onRemove} />)
    fireEvent.change(screen.getByLabelText('Attach files to first prompt'), { target: { files: [file] } })
    expect(onAdd).toHaveBeenCalledWith([file])
    fireEvent.click(screen.getByLabelText('Remove attachment report.pdf'))
    expect(onRemove).toHaveBeenCalledWith(0)
    view.rerender(<PromptAttachments files={[file]} disabled onAdd={onAdd} onRemove={onRemove} />)
    expect(screen.getByLabelText('Attach files to first prompt')).toBeDisabled()
    expect(screen.getByLabelText('Remove attachment report.pdf')).toBeDisabled()
  })
})
