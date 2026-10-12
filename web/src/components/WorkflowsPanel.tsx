import { useEffect, useState } from 'react'
import { FileCode2, FilePlus2, Pencil, Play, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { RunList } from './workflow/RunList'
import { RunDetail } from './workflow/RunDetail'
import { WorkflowEditorModal } from './workflow/WorkflowEditorModal'
import { PreRunModal } from './workflow/PreRunModal'
import { ErrorBoundary } from './ErrorBoundary'
import type { WorkflowTier } from '../api'

interface EditorState {
  mode: 'create' | 'edit'
  tier: WorkflowTier
  name?: string
}

export function WorkflowsPanel() {
  const specs = useStore(s => s.workflowSpecs)
  const specsLoading = useStore(s => s.workflowSpecsLoading)
  const specsError = useStore(s => s.workflowSpecsError)
  const fetchWorkflowSpecs = useStore(s => s.fetchWorkflowSpecs)
  const deleteWorkflowSpec = useStore(s => s.deleteWorkflowSpec)
  const runs = useStore(s => s.workflowRuns)
  const selectedRun = useStore(s => s.selectedRun)
  const fetchWorkflowRuns = useStore(s => s.fetchWorkflowRuns)
  const selectWorkflowRun = useStore(s => s.selectWorkflowRun)
  const showSnackbar = useStore(s => s.showSnackbar)

  const [runsLoading, setRunsLoading] = useState(true)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [runWorkflow, setRunWorkflow] = useState<string | null>(null)

  useEffect(() => {
    fetchWorkflowSpecs()
  }, [fetchWorkflowSpecs])

  useEffect(() => {
    let cancelled = false
    setRunsLoading(true)
    const load = async () => {
      const message = await fetchWorkflowRuns()
      if (!cancelled) setRunsError(message)
    }
    load().finally(() => { if (!cancelled) setRunsLoading(false) })
    const interval = setInterval(load, 10000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [fetchWorkflowRuns])

  const removeSpec = async (name: string) => {
    if (!window.confirm(`Delete workflow '${name}'? Existing run history remains.`)) return
    try {
      await deleteWorkflowSpec(name)
    } catch (e: any) {
      showSnackbar({ type: 'error', message: e?.detail || e?.message || 'Failed to delete workflow' })
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div><h2 className="text-sm font-semibold text-gray-200">Workflow Library</h2><p className="text-xs text-gray-500">Create, edit, validate, and launch workflows on this node.</p></div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditor({ mode: 'create', tier: 'yaml' })} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500"><FilePlus2 size={14} />New Workflow</button>
            <button onClick={() => setEditor({ mode: 'create', tier: 'python' })} className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs font-medium text-gray-200 hover:border-emerald-700"><FileCode2 size={14} />Add Script</button>
          </div>
        </div>
        {specsLoading && specs.length === 0 && <p className="text-xs text-gray-500">Loading workflows…</p>}
        {specsError && <p role="alert" className="text-xs text-red-400">{specsError}</p>}
        {!specsLoading && specs.length === 0 && !specsError && <p className="text-xs text-gray-500">No workflows authored on this node.</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {specs.map(spec => {
            const tier: WorkflowTier = spec.tier ?? (spec.mode === 'script' ? 'python' : 'yaml')
            return <article key={spec.name} className="rounded-lg border border-gray-700/60 bg-gray-950/40 p-3">
              <div className="flex items-start gap-2"><FileCode2 size={15} className={tier === 'python' ? 'text-blue-400' : 'text-amber-400'} /><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-gray-200">{spec.name}</h3><p className="text-[11px] uppercase text-gray-600">{tier}{spec.step_count != null ? ` · ${spec.step_count} steps` : ''}</p></div></div>
              {spec.description && <p className="mt-2 line-clamp-2 text-xs text-gray-500">{spec.description}</p>}
              <div className="mt-3 flex gap-1.5">
                <button onClick={() => setRunWorkflow(spec.name)} className="flex items-center gap-1 rounded bg-emerald-700/80 px-2 py-1 text-xs text-white hover:bg-emerald-600"><Play size={12} />Run</button>
                <button onClick={() => setEditor({ mode: 'edit', tier, name: spec.name })} className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:text-white"><Pencil size={12} />Edit</button>
                <button onClick={() => removeSpec(spec.name)} className="ml-auto rounded p-1 text-gray-600 hover:text-red-400" aria-label={`Delete ${spec.name}`}><Trash2 size={13} /></button>
              </div>
            </article>
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[20rem_1fr] gap-4">
        <aside className="rounded-xl border border-gray-800 bg-gray-900/40 p-3 h-fit"><h2 className="text-sm font-semibold text-gray-300 mb-2">Workflow Runs</h2><RunList runs={runs} selectedRunId={selectedRun?.run_id ?? null} loading={runsLoading} error={runsError} onSelect={selectWorkflowRun} /></aside>
        <section className="min-w-0">{selectedRun ? <ErrorBoundary><RunDetail run={selectedRun} allRuns={runs} /></ErrorBoundary> : <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center text-sm text-gray-500">Select a run to inspect its timeline, playback, and diagnostics.</div>}</section>
      </div>

      {editor && <WorkflowEditorModal open mode={editor.mode} tier={editor.tier} name={editor.name} onClose={() => setEditor(null)} onSaved={() => fetchWorkflowSpecs()} />}
      {runWorkflow && <PreRunModal open workflowName={runWorkflow} onClose={() => setRunWorkflow(null)} onStarted={() => {}} />}
    </div>
  )
}
