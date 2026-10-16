import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { api, ProviderProfile, ProviderQuota } from '../api'
import { useStore } from '../store'

function formatReset(value?: string | null) {
  if (!value) return 'Unknown reset'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown reset' : `Resets ${date.toLocaleString()}`
}

export function QuotaPanel() {
  const { showSnackbar } = useStore()
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [quotas, setQuotas] = useState<ProviderQuota[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const [listed, overview] = await Promise.all([api.listProviderProfiles(), api.getProviderQuotaOverview()])
      setProfiles(listed); setQuotas(overview)
    } catch (e: any) { showSnackbar({ type: 'error', message: e.message || 'Failed to load quota' }) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load()
    const timer = window.setInterval(() => load(), 300000)
    return () => window.clearInterval(timer)
  }, [])

  const byId = useMemo(() => new Map(quotas.map(item => [item.profile_id, item])), [quotas])

  return <div className="space-y-5">
    <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold text-white">Provider Quota</h2><p className="mt-1 text-xs text-gray-500">Read-only usage for every provider profile. Unsupported adapters remain visible as unavailable. Results cache for five minutes.</p></div><button onClick={() => load()} disabled={loading} className="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-300 disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh</button></div>
    {loading && profiles.length === 0 ? <div className="py-16 text-center text-gray-500"><Loader2 className="mx-auto animate-spin" /></div> : profiles.length === 0 ? <div className="rounded-xl border border-dashed border-gray-700 p-12 text-center text-sm text-gray-500">Create a provider profile first.</div> : <div className="grid gap-4 lg:grid-cols-2">{profiles.map(profile => {
      const quota = byId.get(profile.id)
      return <section key={profile.id} className="rounded-xl border border-gray-700/60 bg-gray-800/60 p-5">
        <div className="flex items-start justify-between"><div><h3 className="font-medium text-white">{profile.label}</h3><p className="font-mono text-xs text-gray-500">{profile.id}</p></div><div className="flex gap-2">{quota?.stale && <span className="rounded bg-amber-950 px-2 py-1 text-xs text-amber-300">stale</span>}<span className="rounded bg-gray-900 px-2 py-1 text-xs text-gray-400">{quota?.status ?? profile.auth_state}</span></div></div>
        {quota?.quotas?.length ? <div className="mt-5 space-y-4">{quota.quotas.map(row => <div key={row.key}><div className="mb-1 flex justify-between text-xs"><span className="text-gray-300">{row.name}</span><span className="text-gray-500">{Math.round(row.remaining)}% remaining</span></div><div className="h-2 overflow-hidden rounded-full bg-gray-950"><div className={`h-full rounded-full ${row.remaining <= 10 ? 'bg-red-500' : row.remaining <= 25 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.max(0, Math.min(100, row.remaining))}%` }} /></div><div className="mt-1 text-[11px] text-gray-600">{formatReset(row.reset_at)}</div></div>)}</div> : <div className="mt-5 flex gap-2 rounded-lg border border-gray-700 bg-gray-950/40 p-3 text-xs text-gray-500"><AlertTriangle size={14} className="shrink-0" />{quota?.status === 'unavailable' ? `Quota adapter unavailable for ${profile.provider}.` : profile.auth_detail || 'Sign in or re-check this profile to load quota.'}</div>}
      </section>
    })}</div>}
  </div>
}
