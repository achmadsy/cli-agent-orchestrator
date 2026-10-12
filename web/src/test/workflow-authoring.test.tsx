import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useStore } from '../store'
import { WorkflowEditorModal } from '../components/workflow/WorkflowEditorModal'
import { PreRunModal } from '../components/workflow/PreRunModal'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

beforeEach(() => {
  useStore.setState({ snackbar: null, navLockCount: 0 })
  vi.spyOn(api, 'validateWorkflowContent').mockResolvedValue({ status: 'pass', errors: [] })
})

describe('WorkflowEditorModal', () => {
  it('creates a YAML starter with the supported input reference', () => {
    render(<WorkflowEditorModal open mode="create" tier="yaml" onClose={() => {}} onSaved={() => {}} />)
    expect((screen.getByLabelText('Workflow source') as HTMLTextAreaElement).value).toContain('{{workflow.inputs.task}}')
  })

  it('validates and creates YAML without starting a run', async () => {
    const create = vi.spyOn(api, 'createWorkflow').mockResolvedValue({ name: 'demo' })
    const submit = vi.spyOn(api, 'submitWorkflowRun')
    vi.spyOn(api, 'listWorkflows').mockResolvedValue([])
    const onSaved = vi.fn()
    render(<WorkflowEditorModal open mode="create" tier="yaml" onClose={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'demo' } })
    fireEvent.change(screen.getByLabelText('Workflow source'), { target: { value: 'name: demo\nmode: sequential\nsteps: []\n' } })
    await waitFor(() => expect(api.validateWorkflowContent).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'demo', tier: 'yaml' })))
    expect(submit).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalledWith('demo')
  })

  it('creates a Python starter with an explicit recovery policy', () => {
    render(<WorkflowEditorModal open mode="create" tier="python" onClose={() => {}} onSaved={() => {}} />)
    expect((screen.getByLabelText('Workflow source') as HTMLTextAreaElement).value).toContain('recovery="manual"')
  })

  it('shows line-anchored Python lint findings', async () => {
    vi.mocked(api.validateWorkflowContent).mockResolvedValue({
      status: 'fail', errors: [], findings: [{ line: 4, column: 2, message: 'bad step', rule_id: 'syntax' }],
    })
    render(<WorkflowEditorModal open mode="create" tier="python" onClose={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'script' } })
    await waitFor(() => expect(screen.getByText(/Line 4:2: bad step/)).toBeInTheDocument())
  })
})

describe('PreRunModal provider modes', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getWorkflow').mockResolvedValue({
      name: 'demo',
      inputs: { count: { type: 'int', required: true } },
      steps: [
        { id: 'build', provider: 'claude_code', agent: 'developer' },
        { id: 'review', provider: 'claude_code', agent: 'reviewer' },
      ],
    })
    vi.spyOn(api, 'listProviders').mockResolvedValue([
      { name: 'claude_code', binary: 'claude', installed: true },
      { name: 'codex', binary: 'codex', installed: true },
    ])
    vi.spyOn(api, 'listWorkflowRuns').mockResolvedValue([])
    vi.spyOn(api, 'inspectWorkflowRun').mockResolvedValue({ run_id: 'r1', workflow_name: 'demo', state: 'running', started_at: '', tier: 'yaml', steps: [] })
    vi.spyOn(api, 'getWorkflowRunEvents').mockResolvedValue({ events: [], gaps: [], next_after_seq: null })
  })

  it('workflow defaults omits role providers', async () => {
    const submit = vi.spyOn(api, 'submitWorkflowRun').mockResolvedValue({ run_id: 'r1', state: 'running' })
    render(<PreRunModal open workflowName="demo" onClose={() => {}} onStarted={() => {}} />)
    await waitFor(() => expect(screen.getByText('Provider impact')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/count/i), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith('demo', { count: 3 }, undefined, {}))
  })

  it('same CLI applies all recognized roles', async () => {
    const submit = vi.spyOn(api, 'submitWorkflowRun').mockResolvedValue({ run_id: 'r1', state: 'running' })
    render(<PreRunModal open workflowName="demo" onClose={() => {}} onStarted={() => {}} />)
    await waitFor(() => expect(screen.getByText('Same CLI for roles')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Same CLI for roles'))
    fireEvent.change(screen.getByLabelText(/count/i), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
    await waitFor(() => expect(submit).toHaveBeenCalledWith('demo', { count: 3 }, undefined, {
      supervisor: 'claude_code', developer: 'claude_code', reviewer: 'claude_code',
    }))
  })
})
