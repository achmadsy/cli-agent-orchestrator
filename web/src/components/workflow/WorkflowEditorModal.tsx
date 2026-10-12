import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FileCode2, Loader2, X } from 'lucide-react'
import { api, ApiError, WorkflowSource, WorkflowTier, WorkflowValidationResponse } from '../../api'
import { useStore } from '../../store'

interface Props {
  open: boolean
  mode: 'create' | 'edit'
  tier: WorkflowTier
  name?: string
  onClose: () => void
  onSaved: (name: string) => void
}

const inputClass = 'w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-emerald-600'

function starter(name: string, tier: WorkflowTier): string {
  if (tier === 'python') {
    return `from cao_workflow import get_inputs, step\n\nINPUTS = {\n    "task": {"type": "string", "required": True},\n}\n\ninputs = get_inputs()\nresult = step(\n    "claude_code",\n    "developer",\n    f"Implement: {inputs['task']}",\n    step_id="implement",\n    recovery="manual",\n)\n`
  }
  return `name: ${name || 'new-workflow'}\ndescription: New workflow\nmode: sequential\ninputs:\n  task:\n    type: string\n    required: true\nsteps:\n  - id: implement\n    provider: claude_code\n    agent: developer\n    prompt: "Implement: {{workflow.inputs.task}}"\n`
}

export function WorkflowEditorModal({ open, mode, tier, name = '', onClose, onSaved }: Props) {
  const saveWorkflowSource = useStore(s => s.saveWorkflowSource)
  const acquireNavLock = useStore(s => s.acquireNavLock)
  const releaseNavLock = useStore(s => s.releaseNavLock)
  const [workflowName, setWorkflowName] = useState(name)
  const [content, setContent] = useState('')
  const [initial, setInitial] = useState('')
  const [validation, setValidation] = useState<WorkflowValidationResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveGuard = useRef(false)
  const validationGeneration = useRef(0)

  useEffect(() => {
    if (!saving) return
    acquireNavLock()
    return () => releaseNavLock()
  }, [saving, acquireNavLock, releaseNavLock])

  useEffect(() => {
    if (!open) return
    setWorkflowName(name)
    setError(null)
    setValidation(null)
    if (mode === 'create') {
      const value = starter(name, tier)
      setContent(value)
      setInitial(value)
      setLoading(false)
      return
    }
    setLoading(true)
    api.getWorkflowSource(name)
      .then(source => {
        setWorkflowName(source.name)
        setContent(source.content)
        setInitial(source.content)
      })
      .catch((e: ApiError) => setError(e.detail || e.message || 'Failed to load workflow source'))
      .finally(() => setLoading(false))
  }, [open, mode, name, tier])

  const dirty = content !== initial || (mode === 'create' && workflowName !== name)

  useEffect(() => {
    if (!open || loading || !workflowName.trim() || !content.trim()) {
      setValidation(null)
      return
    }
    const generation = ++validationGeneration.current
    const timer = setTimeout(() => {
      api.validateWorkflowContent({ name: workflowName.trim(), tier, content })
        .then(result => {
          if (validationGeneration.current === generation) setValidation(result)
        })
        .catch((e: ApiError) => {
          if (validationGeneration.current === generation) {
            setValidation({ status: 'fail', errors: [e.detail || e.message || 'Validation failed'] })
          }
        })
    }, 350)
    return () => clearTimeout(timer)
  }, [open, loading, workflowName, tier, content])

  const close = () => {
    if (saving) return
    if (dirty && !window.confirm('Discard unsaved workflow changes?')) return
    onClose()
  }

  const findings = useMemo(() => validation?.findings ?? [], [validation])
  const valid = validation != null && validation.status !== 'fail'

  const save = async () => {
    if (saveGuard.current || !workflowName.trim() || !content.trim()) return
    saveGuard.current = true
    setSaving(true)
    setError(null)
    try {
      const source: WorkflowSource = { name: workflowName.trim(), tier, content }
      const checked = await api.validateWorkflowContent(source)
      setValidation(checked)
      if (checked.status === 'fail') {
        setError('Validation failed. Fix source before saving.')
        return
      }
      await saveWorkflowSource(source, mode === 'create')
      setInitial(content)
      onSaved(source.name)
      onClose()
    } catch (e: any) {
      const err = e as ApiError
      setError(err.detail || err.message || 'Failed to save workflow')
    } finally {
      saveGuard.current = false
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-label={mode === 'create' ? 'Create workflow' : 'Edit workflow'}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="relative w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        <header className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <FileCode2 size={19} className="text-emerald-400" />
          <div className="flex-1">
            <h3 className="text-base font-semibold text-white">{mode === 'create' ? `New ${tier === 'python' ? 'Python script' : 'workflow'}` : `Edit ${name}`}</h3>
            <p className="text-xs text-gray-500">{tier === 'python' ? 'Python' : 'YAML'} source · saving never starts a run</p>
          </div>
          <button onClick={close} disabled={saving} aria-label="Close"><X size={17} className="text-gray-500 hover:text-white" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Workflow name</label>
            <input className={inputClass} value={workflowName} disabled={mode === 'edit'} onChange={e => setWorkflowName(e.target.value)} aria-label="Workflow name" />
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-gray-500"><Loader2 size={15} className="animate-spin" /> Loading source…</div>
          ) : (
            <textarea
              className={`${inputClass} font-mono text-xs leading-relaxed min-h-[420px] ${validation?.status === 'fail' ? '!border-red-500' : ''}`}
              value={content}
              onChange={e => { setContent(e.target.value); setError(null) }}
              spellCheck={false}
              aria-label="Workflow source"
            />
          )}

          {validation && (
            <div className={`rounded-lg border p-3 text-xs ${valid ? 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300' : 'border-red-700/50 bg-red-950/30 text-red-300'}`}>
              <div className="font-medium mb-1">{valid ? 'Source valid' : 'Validation failed'}</div>
              {validation.errors.map((message, index) => <div key={`e-${index}`}>{message}</div>)}
              {findings.map((finding, index) => (
                <div key={`f-${index}`} className="font-mono">
                  {finding.line ? `Line ${finding.line}${finding.column ? `:${finding.column}` : ''}: ` : ''}{finding.message}
                </div>
              ))}
            </div>
          )}
          {error && <div role="alert" className="flex gap-2 rounded-lg border border-red-700/50 bg-red-950/30 p-3 text-xs text-red-300"><AlertTriangle size={14} />{error}</div>}
        </div>

        <footer className="flex justify-end gap-3 px-5 py-4 border-t border-gray-800 bg-gray-950/30">
          <button onClick={close} disabled={saving} className="px-4 py-2 text-sm rounded-lg bg-gray-800 text-gray-300 disabled:opacity-50">Cancel</button>
          <button onClick={save} disabled={saving || loading || !workflowName.trim() || !content.trim() || validation?.status === 'fail'} className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">
            {saving && <Loader2 size={14} className="animate-spin" />}{saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save changes'}
          </button>
        </footer>
      </div>
    </div>
  )
}
