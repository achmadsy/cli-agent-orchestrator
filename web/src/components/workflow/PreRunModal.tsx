import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Play, X } from 'lucide-react'
import { api, ProviderInfo, ProviderProfile, ProviderRole, RoleProviderPolicy, RoleProviderProfilePolicy, WorkflowInputDecl, WorkflowSpecSummary } from '../../api'
import { useStore } from '../../store'
import { CustomSelect } from '../CustomSelect'

interface Props {
  open: boolean
  workflowName: string
  onClose: () => void
  onStarted: (runId: string) => void
}

type ProviderMode = 'defaults' | 'same' | 'roles'
const ROLES: ProviderRole[] = ['supervisor', 'developer', 'reviewer']
const inputClass = 'w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-emerald-600'

function parseInput(name: string, decl: WorkflowInputDecl, raw: string): unknown {
  if (raw === '') {
    if (decl.default !== undefined) return decl.default
    if (decl.required) throw new Error(`Input '${name}' is required`)
    return undefined
  }
  if (decl.type === 'int') {
    if (!/^-?\d+$/.test(raw)) throw new Error(`Input '${name}' must be an integer`)
    return Number.parseInt(raw, 10)
  }
  if (decl.type === 'float') {
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`Input '${name}' must be a number`)
    return value
  }
  if (decl.type === 'bool') return raw === 'true'
  return raw
}

export function PreRunModal({ open, workflowName, onClose, onStarted }: Props) {
  const submitWorkflowRun = useStore(s => s.submitWorkflowRun)
  const acquireNavLock = useStore(s => s.acquireNavLock)
  const releaseNavLock = useStore(s => s.releaseNavLock)
  const [spec, setSpec] = useState<WorkflowSpecSummary | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfile[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [runId, setRunId] = useState('')
  const [mode, setMode] = useState<ProviderMode>('defaults')
  const [sameProvider, setSameProvider] = useState('')
  const [roleProviders, setRoleProviders] = useState<RoleProviderPolicy>({})
  const [roleProviderProfiles, setRoleProviderProfiles] = useState<RoleProviderProfilePolicy>({})
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitGuard = useRef(false)

  useEffect(() => {
    if (!submitting) return
    acquireNavLock()
    return () => releaseNavLock()
  }, [submitting, acquireNavLock, releaseNavLock])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    setValues({})
    setRunId('')
    setMode('defaults')
    setRoleProviders({})
    setRoleProviderProfiles({})
    Promise.all([api.getWorkflow(workflowName), api.listProviders(), api.listProviderProfiles()])
      .then(([workflow, listed, profiles]) => {
        setSpec(workflow)
        setProviders(listed)
        setProviderProfiles(profiles)
        const first = listed.find(p => p.installed)?.name ?? ''
        setSameProvider(first)
      })
      .catch((e: any) => setError(e?.detail || e?.message || 'Failed to load workflow'))
      .finally(() => setLoading(false))
  }, [open, workflowName])

  const installed = providers.filter(p => p.installed)
  const options = installed.map(p => ({ value: p.name, label: p.name }))
  const policy = useMemo<RoleProviderPolicy>(() => {
    if (mode === 'defaults') return {}
    if (mode === 'same') {
      if (!sameProvider) return {}
      return { supervisor: sameProvider, developer: sameProvider, reviewer: sameProvider }
    }
    return Object.fromEntries(Object.entries(roleProviders).filter(([, value]) => Boolean(value))) as RoleProviderPolicy
  }, [mode, sameProvider, roleProviders])

  // Per-role effective provider drives account filtering: a role with no
  // selected CLI uses either the shared CLI (same mode) or its authored
  // provider. Only authenticated profiles are selectable — switching
  // accounts mid-run is the operator's explicit choice and never inferred.
  const resolvedRoleProvider = (role: ProviderRole): string => {
    if (policy[role]) return policy[role] as string
    if (mode === 'same') return sameProvider
    const step = (spec?.steps ?? []).find(
      s => s.agent === role || (role === 'supervisor' && s.agent === 'code_supervisor'),
    )
    return step?.provider ?? ''
  }
  const profilePolicy = useMemo<RoleProviderProfilePolicy>(() => {
    if (Object.keys(policy).length === 0 && mode !== 'roles') return {}
    return Object.fromEntries(
      Object.entries(roleProviderProfiles).filter(([, value]) => Boolean(value)),
    ) as RoleProviderProfilePolicy
  }, [mode, policy, roleProviderProfiles])

  const impacts = useMemo(() => {
    const steps = spec?.steps ?? []
    return steps.map(step => {
      const role = ROLES.find(candidate => step.agent === candidate || (candidate === 'supervisor' && step.agent === 'code_supervisor'))
      const effective = role ? policy[role] : undefined
      const account = role ? (profilePolicy[role] ?? undefined) : undefined
      const accountLabel = account
        ? (providerProfiles.find(p => p.id === account)?.label ?? account)
        : undefined
      return { ...step, role, effective: effective ?? step.provider, account: accountLabel }
    })
  }, [spec, policy, profilePolicy, providerProfiles])

  const submit = async () => {
    if (submitGuard.current || !spec) return
    submitGuard.current = true
    setSubmitting(true)
    setError(null)
    try {
      const inputs: Record<string, unknown> = {}
      for (const [name, decl] of Object.entries(spec.inputs ?? {})) {
        const value = parseInput(name, decl, values[name] ?? '')
        if (value !== undefined) inputs[name] = value
      }
      const result = await submitWorkflowRun(
        workflowName,
        inputs,
        runId.trim() || undefined,
        policy,
        Object.keys(profilePolicy).length > 0 ? profilePolicy : undefined,
      )
      onStarted(result.run_id)
      onClose()
    } catch (e: any) {
      setError(e?.detail || e?.message || 'Failed to start workflow')
    } finally {
      submitGuard.current = false
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center" role="dialog" aria-label="Run workflow">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={submitting ? undefined : onClose} />
      <div className="relative w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        <header className="flex items-center gap-3 px-5 py-4 border-b border-gray-800">
          <Play size={18} className="text-emerald-400" />
          <div className="flex-1"><h3 className="font-semibold text-white">Run {workflowName}</h3><p className="text-xs text-gray-500">Configure inputs and CLI routing before launch</p></div>
          <button onClick={submitting ? undefined : onClose} aria-label="Close"><X size={17} className="text-gray-500 hover:text-white" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {loading && <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" />Loading workflow…</div>}
          {spec && !loading && (
            <>
              <section className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Inputs</h4>
                {Object.keys(spec.inputs ?? {}).length === 0 && <p className="text-xs text-gray-500">No declared inputs.</p>}
                {Object.entries(spec.inputs ?? {}).map(([name, decl]) => (
                  <div key={name}>
                    <label className="block text-xs text-gray-400 mb-1">{name}{decl.required && decl.default === undefined ? <span className="text-red-400"> *</span> : null} <span className="text-gray-600">({decl.type})</span></label>
                    {decl.type === 'bool' ? (
                      <select aria-label={name} className={inputClass} value={values[name] ?? (decl.default === true ? 'true' : decl.default === false ? 'false' : '')} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}>
                        {!decl.required && <option value="">Use default</option>}<option value="true">true</option><option value="false">false</option>
                      </select>
                    ) : (
                      <input aria-label={name} className={inputClass} value={values[name] ?? ''} placeholder={decl.default !== undefined ? `Default: ${String(decl.default)}` : ''} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} />
                    )}
                  </div>
                ))}
                <div><label className="block text-xs text-gray-400 mb-1">Run ID <span className="text-gray-600">(optional)</span></label><input className={inputClass} value={runId} onChange={e => setRunId(e.target.value)} placeholder="Auto-generated" /></div>
              </section>

              <section className="space-y-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Agent CLIs</h4>
                {([
                  ['defaults', 'Workflow defaults', 'Use provider authored for each step.'],
                  ['same', 'Same CLI for roles', 'Override Supervisor, Developer, and Reviewer.'],
                  ['roles', 'Customize by role', 'Choose each recognized role separately.'],
                ] as const).map(([value, label, help]) => (
                  <label key={value} className={`block rounded-lg border p-3 cursor-pointer ${mode === value ? 'border-emerald-600 bg-emerald-950/20' : 'border-gray-700 bg-gray-950/30'}`}>
                    <span className="flex items-start gap-2"><input type="radio" name="provider-mode" checked={mode === value} onChange={() => setMode(value)} className="mt-1" /><span><span className="block text-sm text-gray-200">{label}</span><span className="block text-xs text-gray-500">{help}</span></span></span>
                  </label>
                ))}
                {mode === 'same' && (
                  <>
                    <CustomSelect value={sameProvider} onChange={value => { setSameProvider(value); setRoleProviderProfiles({}) }} options={options} placeholder="Select installed CLI" />
                    {sameProvider && providerProfiles.some(p => p.provider === sameProvider) && (
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">Shared account</label>
                        <CustomSelect
                          ariaLabel="Shared account"
                          value={roleProviderProfiles.supervisor ?? ''}
                          onChange={value => setRoleProviderProfiles(value ? { supervisor: value, developer: value, reviewer: value } : {})}
                          options={[{ value: '', label: 'Default account' }, ...providerProfiles.filter(p => p.provider === sameProvider).map(p => ({ value: p.id, label: p.label, sublabel: `${p.id} · ${p.auth_state}`, disabled: p.auth_state !== 'authenticated' }))]}
                          placeholder="Default account"
                        />
                      </div>
                    )}
                  </>
                )}
                {mode === 'roles' && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {ROLES.map(role => {
                      const roleProvider = resolvedRoleProvider(role)
                      const roleAccounts = providerProfiles.filter(p => p.provider === roleProvider)
                      return (
                        <div key={role}>
                          <label className="block text-xs capitalize text-gray-400 mb-1">{role}</label>
                          <CustomSelect
                            value={roleProviders[role] ?? ''}
                            onChange={value => {
                              setRoleProviders(current => ({ ...current, [role]: value || undefined }))
                              // A profile bound to the previous provider's account
                              // is invalid there — drop it when the CLI changes.
                              setRoleProviderProfiles(current => {
                                if (!current[role]) return current
                                const next = { ...current }
                                delete next[role]
                                return next
                              })
                            }}
                            options={[{ value: '', label: 'Workflow default' }, ...options]}
                            placeholder="Workflow default"
                          />
                          {roleAccounts.length > 0 && (
                            <div className="mt-1">
                              <label className="block text-[11px] text-gray-500 mb-1">Account</label>
                              <CustomSelect
                                ariaLabel={`Account for ${role}`}
                                value={roleProviderProfiles[role] ?? ''}
                                onChange={value => setRoleProviderProfiles(current => ({ ...current, [role]: value || undefined }))}
                                options={[{ value: '', label: 'Default account' }, ...roleAccounts.map(p => ({ value: p.id, label: p.label, sublabel: `${p.id} · ${p.auth_state}`, disabled: p.auth_state !== 'authenticated' }))]}
                                placeholder="Default account"
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {impacts.length > 0 && <section><h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">Provider impact</h4><div className="space-y-1">{impacts.map(step => <div key={step.id} className="flex justify-between rounded bg-gray-950/40 px-3 py-2 text-xs"><span className="text-gray-300">{step.id} <span className="text-gray-600">· {step.agent}</span></span><span className={step.effective !== step.provider ? 'text-emerald-400' : 'text-gray-500'}>{step.provider}{step.effective !== step.provider ? ` → ${step.effective}` : ''}{step.account ? <span className="text-gray-500"> on {step.account}</span> : null}</span></div>)}</div></section>}
            </>
          )}
          {error && <div role="alert" className="flex gap-2 rounded-lg border border-red-700/50 bg-red-950/30 p-3 text-xs text-red-300"><AlertTriangle size={14} />{error}</div>}
        </div>

        <footer className="flex justify-end gap-3 px-5 py-4 border-t border-gray-800 bg-gray-950/30"><button onClick={onClose} disabled={submitting} className="px-4 py-2 text-sm rounded-lg bg-gray-800 text-gray-300">Cancel</button><button onClick={submit} disabled={submitting || loading || !spec || (mode === 'same' && !sameProvider)} className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">{submitting && <Loader2 size={14} className="animate-spin" />}{submitting ? 'Starting…' : 'Start run'}</button></footer>
      </div>
    </div>
  )
}
