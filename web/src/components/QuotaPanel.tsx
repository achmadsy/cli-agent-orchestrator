import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { api, ProviderProfile, ProviderQuota, QuotaResetPreview, QuotaResetOperation, ResetAllowance } from '../api'
import { useStore } from '../store'
import { ConfirmModal } from './ConfirmModal'

function dateText(value?: string | null) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

export function QuotaPanel() {
  const { showSnackbar } = useStore()
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [quotas, setQuotas] = useState<ProviderQuota[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ profile: ProviderProfile; data: QuotaResetPreview } | null>(null)
  const [details, setDetails] = useState<Record<string, ResetAllowance>>({})
  const [operations, setOperations] = useState<Record<string, QuotaResetOperation>>({})
  const active = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)

  const load = async (force = false) => {
    const request = ++generation.current
    setLoading(true)
    try {
      const listed = await api.listProviderProfiles()
      const overview = await api.getProviderQuotaOverview(force)
      if (mounted.current && request === generation.current) {
        setProfiles(listed); setQuotas(overview)
        setDetails({})
        const recovered: Record<string, QuotaResetOperation> = {}
        for (const profile of listed) {
          let id: string | null = null
          try { id = sessionStorage.getItem(`cao.quota.reset.${profile.id}`) } catch { /* no storage */ }
          if (id) {
            try {
              const result = await api.getQuotaResetOperation(profile.id, id)
              recovered[profile.id] = result.status === 'preview'
                ? { ...result, status: 'unknown', reason: 'Confirmation may still be running. Do not retry; check reset status.' }
                : result
            } catch { recovered[profile.id] = { operation_id: id, status: 'unknown', reason: 'Reset outcome unavailable. Do not retry; check reset status.', quota_refresh: 'not_attempted' } }
          }
        }
        if (mounted.current && request === generation.current) setOperations(current => ({ ...current, ...recovered }))
      }
    } catch (e: any) {
      if (mounted.current && request === generation.current) showSnackbar({ type: 'error', message: e.message || 'Failed to load quota' })
    } finally { if (mounted.current && request === generation.current) setLoading(false) }
  }

  useEffect(() => {
    mounted.current = true
    void load()
    const timer = window.setInterval(() => { if (!active.current) void load() }, 300000)
    return () => { mounted.current = false; generation.current++; window.clearInterval(timer) }
  }, [])

  const byId = useMemo(() => new Map(quotas.map(item => [item.profile_id, item])), [quotas])

  const startPreview = async (profile: ProviderProfile) => {
    if (active.current) return
    active.current = true; setBusy(profile.id); generation.current++
    try {
      const data = await api.previewQuotaReset(profile.id)
      if (mounted.current) setPreview({ profile, data })
    } catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Fresh reset eligibility unavailable' }) }
    finally { active.current = false; setBusy(null); setLoading(false) }
  }

  const submit = async () => {
    if (!preview || active.current) return
    const { profile, data } = preview
    if (new Date(data.expires_at).getTime() <= Date.now()) {
      setPreview(null); showSnackbar({ type: 'error', message: 'Reset preview expired. Request a new preview.' }); return
    }
    active.current = true; setBusy(profile.id); generation.current++
    // Persist only opaque recovery IDs in tab-local storage before confirming.
    // Never persist allowance contents, account credentials or provider tokens.
    try { sessionStorage.setItem(`cao.quota.reset.${profile.id}`, data.intent_id) } catch { /* server still owns the operation */ }
    let operation: QuotaResetOperation
    try {
      operation = await api.confirmQuotaReset(profile.id, data.intent_id)
    } catch {
      try { operation = await api.getQuotaResetOperation(profile.id, data.intent_id) }
      catch { operation = { operation_id: data.intent_id, status: 'unknown', reason: 'Outcome unavailable. Do not retry; check reset status.', quota_refresh: 'not_attempted' } }
    }
    if (operation.status === 'preview') {
      // A disconnected request could still be running preflight. Never infer
      // non-submission from a preview snapshot while that worker may continue.
      operation = { ...operation, status: 'unknown', reason: 'Confirmation outcome unavailable. Do not retry; check reset status.' }
    }
    setOperations(current => ({ ...current, [profile.id]: operation }))
    setPreview(null)
    if (operation.status === 'succeeded' || operation.status === 'rejected') {
      try { sessionStorage.removeItem(`cao.quota.reset.${profile.id}`) } catch { /* no storage */ }
    }
    active.current = false; setBusy(null)
    if (operation.status === 'succeeded') showSnackbar({ type: 'success', message: operation.quota_refresh === 'failed' ? 'Reset succeeded; quota refresh failed. Use Refresh later.' : 'Reset succeeded.' })
    else showSnackbar({ type: 'error', message: operation.reason || 'Reset not confirmed. Do not retry.' })
    await load(true)
  }

  const checkStatus = async (profileId: string, id?: string | null) => {
    let operationId = id
    if (!operationId) { try { operationId = sessionStorage.getItem(`cao.quota.reset.${profileId}`) } catch { /* unavailable */ } }
    if (!operationId) return
    try {
      const result = await api.getQuotaResetOperation(profileId, operationId)
      setOperations(current => ({ ...current, [profileId]: result.status === 'preview'
        ? { ...result, status: 'unknown', reason: 'Confirmation may still be running. Do not retry; check reset status.' }
        : result }))
    } catch { showSnackbar({ type: 'error', message: 'Reset status unavailable; do not resubmit an unconfirmed reset.' }) }
  }

  const viewDetails = async (profileId: string) => {
    if (active.current) return
    active.current = true
    setBusy(profileId)
    try { const result = await api.getQuotaResetDetails(profileId); setDetails(current => ({ ...current, [profileId]: result })) }
    catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Reset details unavailable' }) }
    finally { active.current = false; setBusy(null) }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-white">Provider Quota</h2><p className="mt-1 text-xs text-gray-400">Usage and manual reset allowances for named CLI accounts. Automatic reads cache for five minutes.</p></div><button onClick={() => void load(true)} disabled={loading || busy !== null} className="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-300 disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh</button></div>
    {loading && profiles.length === 0 ? <div className="py-16 text-center text-gray-400"><Loader2 className="mx-auto animate-spin" /></div> : profiles.length === 0 ? <div className="rounded-xl border border-dashed border-gray-700 p-12 text-center text-sm text-gray-400">Create a provider profile first.</div> : <div className="grid gap-4 lg:grid-cols-2">{profiles.map(profile => {
      const quota = byId.get(profile.id)
      const reset = quota?.reset_allowance
      const operation = operations[profile.id]
      const blocked = operation?.status === 'unknown' || operation?.status === 'submitted' || Boolean(quota?.reset_operation_id)
      const disabled = !reset?.can_reset || quota?.stale || quota?.status !== 'ok' || loading || busy !== null || blocked
      return <section key={profile.id} aria-label={`${profile.label} quota`} className="rounded-xl border border-gray-700/60 bg-gray-800/60 p-5">
        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="break-words font-medium text-white">{profile.label}</h3><p className="break-all font-mono text-xs text-gray-400">{profile.id}</p></div><div className="flex gap-2">{quota?.stale && <span className="rounded bg-amber-950 px-2 py-1 text-xs text-amber-300">stale</span>}<span className="rounded bg-gray-900 px-2 py-1 text-xs text-gray-400">{quota?.status ?? profile.auth_state}</span></div></div>
        {quota?.quotas?.length ? <div className="mt-5 space-y-4">{quota.quotas.map(row => <div key={row.key}><div className="mb-1 flex justify-between gap-2 text-xs"><span className="text-gray-300">{row.name}</span><span className="text-gray-400">{Math.round(row.remaining)}% remaining</span></div><div className="h-2 overflow-hidden rounded-full bg-gray-950"><div className={`h-full rounded-full ${row.remaining <= 10 ? 'bg-red-500' : row.remaining <= 25 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.max(0, Math.min(100, row.remaining))}%` }} /></div><div className="mt-1 text-[11px] text-gray-400">Automatic renewal: {dateText(row.reset_at)}</div></div>)}</div> : <div className="mt-5 flex gap-2 rounded-lg border border-gray-700 bg-gray-950/40 p-3 text-xs text-gray-400"><AlertTriangle size={14} className="shrink-0" />{quota?.status === 'unavailable' ? `Quota adapter unavailable for ${profile.provider}.` : profile.auth_detail || 'Sign in or re-check this profile to load quota.'}</div>}
        <div className="mt-5 border-t border-gray-700 pt-4 text-sm text-gray-300">
          <div className="flex flex-wrap items-center justify-between gap-3"><span>Resets left: <strong>{reset?.remaining_count ?? 'Unknown'}</strong></span><div className="flex gap-2">
            {reset?.status === 'supported' && <button onClick={() => void viewDetails(profile.id)} disabled={busy !== null} className="rounded-lg bg-gray-900 px-3 py-2 text-xs disabled:opacity-50">Details</button>}
            {quota?.can_manage_resets && reset?.status === 'supported' && <button onClick={() => void startPreview(profile)} disabled={disabled} className="rounded-lg border border-amber-700 px-3 py-2 text-xs text-amber-200 disabled:cursor-not-allowed disabled:opacity-50">Reset limits</button>}
          </div></div>
          {(!reset?.can_reset || blocked || quota?.stale) && <p className="mt-2 text-xs text-gray-400">{blocked ? 'Reset outcome unconfirmed. Do not retry; verify provider-side outcome.' : quota?.stale ? 'Refresh quota before resetting.' : reset?.disabled_reason || 'Manual reset information unavailable for this account.'}</p>}
          {operation && <p role="status" className="mt-2 text-xs text-gray-300">{operation.status === 'succeeded' ? 'Reset succeeded.' : operation.reason || `Reset ${operation.status}.`}</p>}
          {(blocked || operation) && <button onClick={() => void checkStatus(profile.id, operation?.operation_id || quota?.reset_operation_id)} className="mt-2 text-xs text-blue-300 underline">Check reset status</button>}
          {details[profile.id] && <div className="mt-3 space-y-2 text-xs text-gray-300"><p>Cooldown until: {dateText(details[profile.id].cooldown_until)}</p>{details[profile.id].details.map((item, index) => <div key={index} className="rounded-lg bg-gray-950/50 p-3"><p>{item.label}: {item.remaining_count ?? item.status ?? 'Unknown'}{item.total_count != null ? ` / ${item.total_count}` : ''}</p><p>Use by: {dateText(item.expires_at)}</p>{item.clears?.length ? <p>Refills: {item.clears.join(', ')}</p> : null}{item.disabled_reason && <p>{item.disabled_reason}</p>}</div>)}</div>}
        </div>
      </section>
    })}</div>}
    <ConfirmModal open={preview !== null} title="Use one account reset?" message={preview ? `${preview.data.effect}. This spends one reset for ${preview.data.account_display} and cannot be undone.` : ''} details={preview ? [{ label: 'Account', value: preview.data.account_display }, { label: 'Resets left', value: String(preview.data.allowance.remaining_count ?? 'Unknown') }, { label: 'Confirm before', value: dateText(preview.data.expires_at) }] : []} confirmLabel="Use one reset" loadingLabel="Resetting..." loading={busy === preview?.profile.id} onConfirm={() => void submit()} onCancel={() => { if (!active.current) setPreview(null) }} />
  </div>
}
