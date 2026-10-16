import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Loader2, LogOut, Plus, RefreshCw, ShieldCheck, Star, Trash2 } from 'lucide-react'
import { api, ProviderInfo, ProviderProfile, ProviderProfileCapabilities } from '../api'
import { useStore } from '../store'
import { ConfirmModal } from './ConfirmModal'

const inputClass = 'w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-emerald-600'

export function ProviderProfilesPanel() {
  const { showSnackbar } = useStore()
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [capabilities, setCapabilities] = useState<Record<string, ProviderProfileCapabilities>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState('claude_code')
  const [makeDefault, setMakeDefault] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProviderProfile | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [listedProfiles, listedProviders, listedCapabilities] = await Promise.all([
        api.listProviderProfiles(),
        api.listProviders(),
        api.listProviderProfileCapabilities(),
      ])
      setProfiles(listedProfiles)
      setProviders(listedProviders)
      setCapabilities(listedCapabilities)
    } catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Failed to load provider profiles' }) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const selectedCapability = capabilities[provider]
  const supportedProviders = useMemo(
    () => providers.filter(item => capabilities[item.name]?.supported),
    [providers, capabilities],
  )

  useEffect(() => {
    if (supportedProviders.length > 0 && !supportedProviders.some(item => item.name === provider)) {
      setProvider(supportedProviders[0].name)
    }
  }, [provider, supportedProviders])

  const create = async () => {
    if (!id.trim() || !label.trim() || !selectedCapability?.supported) return
    setBusy('create')
    try {
      await api.createProviderProfile({
        id: id.trim(),
        label: label.trim(),
        provider,
        login_method: selectedCapability.profile_mode,
        settings: {},
        is_default: makeDefault,
      })
      setId(''); setLabel(''); setMakeDefault(false)
      showSnackbar({ type: 'success', message: 'Provider profile created' })
      await load()
    } catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Create failed' }) }
    finally { setBusy(null) }
  }

  const check = async (profile: ProviderProfile) => {
    setBusy(`check:${profile.id}`)
    try { await api.checkProviderProfileAuth(profile.id); await load() }
    catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Auth check failed' }) }
    finally { setBusy(null) }
  }

  const login = async (profile: ProviderProfile) => {
    setBusy(`login:${profile.id}`)
    try {
      const terminal = await api.loginProviderProfile(profile.id)
      showSnackbar({ type: 'info', message: `Login terminal ${terminal.id} opened. Complete sign-in from Agents.` })
    } catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Login terminal failed' }) }
    finally { setBusy(null) }
  }

  const logout = async (profile: ProviderProfile) => {
    setBusy(`logout:${profile.id}`)
    try {
      await api.logoutProviderProfile(profile.id)
      showSnackbar({ type: 'success', message: 'Provider profile logged out' })
      await load()
    } catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Logout failed' }) }
    finally { setBusy(null) }
  }

  const setDefault = async (profile: ProviderProfile) => {
    setBusy(`default:${profile.id}`)
    try { await api.updateProviderProfile(profile.id, { is_default: true }); await load() }
    catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Update failed' }) }
    finally { setBusy(null) }
  }

  const remove = async () => {
    if (!pendingDelete) return
    setBusy(`delete:${pendingDelete.id}`)
    try {
      await api.deleteProviderProfile(pendingDelete.id, true)
      showSnackbar({ type: 'success', message: 'Provider profile deleted' })
      setPendingDelete(null)
      await load()
    } catch (e: any) { showSnackbar({ type: 'error', message: e.detail || e.message || 'Delete failed' }) }
    finally { setBusy(null) }
  }

  return <div className="space-y-6">
    <section className="rounded-xl border border-gray-700/50 bg-gray-800/60 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-300">New Provider Profile</h2>
      <p className="mt-2 text-xs text-gray-500">Profiles appear for every provider. Creation stays disabled until CAO verifies credential isolation for that CLI. Tokens never enter this form.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <select aria-label="Provider" className={inputClass} value={provider} onChange={event => setProvider(event.target.value)}>
          {providers.map(item => <option key={item.name} value={item.name} disabled={!capabilities[item.name]?.supported}>{item.name}{capabilities[item.name]?.supported ? '' : ' (unavailable)'}</option>)}
        </select>
        <input aria-label="Profile ID" className={inputClass} value={id} onChange={event => setId(event.target.value)} placeholder="claude-code-profile1" />
        <input aria-label="Display label" className={inputClass} value={label} onChange={event => setLabel(event.target.value)} placeholder="Work account" />
      </div>
      <p className="mt-2 text-xs text-gray-500">Isolation: {selectedCapability?.profile_mode ?? 'unavailable'}</p>
      <label className="mt-3 flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)} />Use for unpinned {provider} launches</label>
      <button onClick={create} disabled={busy !== null || !id.trim() || !label.trim() || !selectedCapability?.supported} className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-50"><Plus size={14} />Create profile</button>
    </section>

    <section className="rounded-xl border border-gray-700/50 bg-gray-800/60 p-5">
      <div className="flex items-center justify-between"><h2 className="text-sm font-semibold uppercase tracking-wide text-gray-300">Provider Profiles</h2><button onClick={load} className="text-gray-400 hover:text-white" aria-label="Refresh"><RefreshCw size={15} /></button></div>
      {loading ? <div className="py-10 text-center text-sm text-gray-500"><Loader2 className="mx-auto animate-spin" size={18} /></div> : profiles.length === 0 ? <p className="py-10 text-center text-sm text-gray-500">No managed profiles. Providers use legacy CLI configuration.</p> : <div className="mt-4 space-y-3">{profiles.map(profile => {
        const capability = capabilities[profile.provider]
        return <article key={profile.id} className="rounded-lg border border-gray-700 bg-gray-950/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-medium text-white">{profile.label}{profile.is_default && <Star size={13} className="fill-amber-400 text-amber-400" />}</div><div className="mt-1 font-mono text-xs text-gray-500">{profile.id} · {profile.provider}</div></div><span className={`rounded-full px-2 py-1 text-xs ${profile.auth_state === 'authenticated' ? 'bg-emerald-950 text-emerald-300' : 'bg-gray-800 text-gray-400'}`}>{profile.auth_state}</span></div>
          {profile.auth_detail && <p className="mt-2 text-xs text-gray-500">{profile.auth_detail}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {capability?.auth_lifecycle && <><button onClick={() => check(profile)} disabled={busy !== null} className="flex items-center gap-1.5 rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"><ShieldCheck size={13} />Check login</button><button onClick={() => login(profile)} disabled={busy !== null} title="Open isolated provider login terminal" className="flex items-center gap-1.5 rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"><KeyRound size={13} />Login</button><button onClick={() => logout(profile)} disabled={busy !== null} className="flex items-center gap-1.5 rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"><LogOut size={13} />Logout</button></>}
            <button onClick={() => setDefault(profile)} disabled={busy !== null || profile.is_default} className="flex items-center gap-1.5 rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"><Star size={13} />Make default</button>
            <button onClick={() => setPendingDelete(profile)} disabled={busy !== null} className="ml-auto flex items-center gap-1.5 rounded bg-red-950/50 px-3 py-1.5 text-xs text-red-300"><Trash2 size={13} />Delete</button>
          </div>
        </article>
      })}</div>}
    </section>

    <ConfirmModal open={pendingDelete !== null} title="Delete provider profile" message="This removes CAO-managed settings and login for this profile. Active references block deletion." confirmationText={pendingDelete?.id} confirmLabel="Delete profile" loading={busy?.startsWith('delete:')} onConfirm={remove} onCancel={() => setPendingDelete(null)} />
  </div>
}
