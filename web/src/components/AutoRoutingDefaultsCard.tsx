import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { api, AutoRoute, AutoRoutingRoutes, ProviderInfo } from '../api'
import { useStore } from '../store'
import { CustomSelect } from './CustomSelect'

const LANE_ORDER = ['probe_supervisor', 'fix_supervisor', 'feature_supervisor', 'architect_supervisor']
const LANE_LABELS: Record<string, string> = {
  probe_supervisor: 'Probe',
  fix_supervisor: 'Fix',
  feature_supervisor: 'Feature',
  architect_supervisor: 'Architect',
}
const BUILT_IN_WORKERS = ['developer', 'reviewer', 'planner']
const PROFILE_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/

type Routes = Record<string, AutoRoute>

function orderedLanes(names: string[]): string[] {
  return [...LANE_ORDER.filter(n => names.includes(n)), ...names.filter(n => !LANE_ORDER.includes(n))]
}

/** Keep only entries that pick a CLI; a model without a CLI means nothing. */
function compact(routes: Routes): Routes {
  const out: Routes = {}
  for (const [name, route] of Object.entries(routes)) {
    if (!route.provider) continue
    const model = route.model?.trim()
    out[name] = model ? { provider: route.provider, model } : { provider: route.provider }
  }
  return out
}

function modelInvalid(route: AutoRoute | undefined): boolean {
  const model = route?.model?.trim()
  return Boolean(model) && !MODEL_ID.test(model as string)
}

/** Settings card for the default CLI/model of each Auto (Jev) lane and worker. */
export function AutoRoutingDefaultsCard() {
  const { showSnackbar } = useStore()
  const [saved, setSaved] = useState<AutoRoutingRoutes | null>(null)
  const [lanes, setLanes] = useState<Routes>({})
  const [workers, setWorkers] = useState<Routes>({})
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [newWorker, setNewWorker] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const adopt = (data: AutoRoutingRoutes) => {
    setSaved(data)
    setLanes(data.lanes)
    setWorkers(data.workers)
  }

  useEffect(() => {
    api.getAutoRoutingRoutes()
      .then(data => {
        // An older server answers with something else (or nothing); show the
        // "not offered" note instead of rendering half a form.
        if (!data || !Array.isArray(data.lane_names)) { setLoadFailed(true); return }
        adopt({ ...data, lanes: data.lanes ?? {}, workers: data.workers ?? {}, fallback_provider: data.fallback_provider ?? '' })
      })
      .catch(() => setLoadFailed(true))
    api.listProviders().then(setProviders).catch(() => {})
  }, [])

  if (loadFailed) {
    return (
      <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-5" data-testid="auto-routing-defaults">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-2">Auto (Jev) defaults</h3>
        <p className="text-xs text-gray-500">This server does not offer Auto (Jev) defaults, or they could not be loaded.</p>
      </div>
    )
  }
  if (!saved) return null

  const workerNames = [
    ...BUILT_IN_WORKERS,
    ...Object.keys(workers).filter(n => !BUILT_IN_WORKERS.includes(n)).sort(),
  ]
  const dirty =
    JSON.stringify(compact(lanes)) !== JSON.stringify(compact(saved.lanes)) ||
    JSON.stringify(compact(workers)) !== JSON.stringify(compact(saved.workers))
  const invalid = [...Object.values(lanes), ...Object.values(workers)].some(modelInvalid)

  const providerOptions = (emptyLabel: string, current?: string) => [
    { value: '', label: emptyLabel },
    ...providers.map(p => ({
      value: p.name,
      label: p.name.replace(/_/g, ' '),
      sublabel: !p.installed ? 'Not installed' : undefined,
      disabled: !p.installed && p.name !== current,
    })),
  ]

  const update = (setter: (fn: (prev: Routes) => Routes) => void, name: string, patch: AutoRoute) =>
    setter(prev => ({ ...prev, [name]: { ...prev[name], ...patch } }))

  const row = (
    name: string,
    label: string,
    routes: Routes,
    setter: (fn: (prev: Routes) => Routes) => void,
    emptyLabel: string,
    removable: boolean,
  ) => {
    const route = routes[name] || {}
    const bad = modelInvalid(route)
    return (
      <div key={name} className="flex flex-wrap items-center gap-2 bg-gray-900/50 border border-gray-700/30 rounded-lg px-3 py-2.5" data-testid={`auto-route-${name}`}>
        <div className="w-36 shrink-0">
          <div className="text-sm text-gray-300">{label}</div>
          <div className="text-[10px] text-gray-500 font-mono truncate" title={name}>{name}</div>
        </div>
        <div className="flex-1 min-w-[150px]">
          <CustomSelect
            ariaLabel={`${name} CLI`}
            value={route.provider || ''}
            // A model is written for one CLI, so a CLI change clears it.
            onChange={value => update(setter, name, { provider: value || undefined, model: undefined })}
            options={providerOptions(emptyLabel, route.provider)}
          />
        </div>
        <input
          type="text"
          aria-label={`${name} model`}
          value={route.model || ''}
          disabled={!route.provider || busy}
          onChange={e => update(setter, name, { model: e.target.value })}
          placeholder={route.provider ? "CLI's default model" : 'Pick a CLI first'}
          className={`flex-1 min-w-[150px] bg-gray-900 border text-gray-200 text-sm rounded-lg px-3 py-2 font-mono focus:outline-none disabled:opacity-50 ${
            bad ? 'border-red-500' : 'border-gray-700 focus:border-emerald-500'
          }`}
        />
        {removable && (
          <button
            onClick={() => setter(prev => { const next = { ...prev }; delete next[name]; return next })}
            disabled={busy}
            className="text-gray-500 hover:text-red-400 transition-colors shrink-0 disabled:opacity-40"
            aria-label={`Remove ${name}`}
            title="Remove worker route"
          >
            <X size={14} />
          </button>
        )}
      </div>
    )
  }

  const trimmedWorker = newWorker.trim()
  const canAddWorker = PROFILE_NAME.test(trimmedWorker) && !workerNames.includes(trimmedWorker)
  const addWorker = () => {
    if (!canAddWorker) return
    setWorkers(prev => ({ ...prev, [trimmedWorker]: {} }))
    setNewWorker('')
  }

  const save = async () => {
    setBusy(true)
    try {
      adopt(await api.setAutoRoutingRoutes({ lanes: compact(lanes), workers: compact(workers) }))
      showSnackbar({ type: 'success', message: 'Auto (Jev) defaults saved' })
    } catch (e: any) {
      showSnackbar({ type: 'error', message: e.detail || e.message || 'Failed to save Auto (Jev) defaults' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-5" data-testid="auto-routing-defaults">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">Auto (Jev) defaults</h3>
      <p className="text-xs text-gray-500 mb-4">
        The CLI and model each Auto (Jev) supervisor and its workers start with. A CLI picked in the
        Spawn form wins over these. Saved changes apply to the next Auto session; running sessions keep
        the routes they started with. Leave the model empty to use the CLI's own default.
      </p>
      {!saved.enabled && (
        <p className="text-xs text-amber-400/80 mb-4" data-testid="auto-routing-off">
          Auto routing is off on this server (settings.json auto_routing.enabled). These defaults apply once it is on.
        </p>
      )}

      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Lane supervisors</div>
      <div className="space-y-2 mb-5">
        {orderedLanes(saved.lane_names).map(name =>
          row(name, LANE_LABELS[name] || name, lanes, setLanes, `Default (${saved.fallback_provider.replace(/_/g, ' ')})`, false),
        )}
      </div>

      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Delegated workers</div>
      <div className="space-y-2 mb-3">
        {workerNames.map(name => row(name, name, workers, setWorkers, "Supervisor's CLI", !BUILT_IN_WORKERS.includes(name)))}
      </div>
      <div className="flex gap-2 mb-5">
        <input
          type="text"
          value={newWorker}
          onChange={e => setNewWorker(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addWorker()}
          placeholder="Another worker profile name"
          aria-label="New worker profile name"
          className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2.5 font-mono focus:border-emerald-500 focus:outline-none"
        />
        <button
          onClick={addWorker}
          disabled={!canAddWorker || busy}
          className="flex items-center gap-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-4 py-2.5 rounded-lg transition-colors"
        >
          <Plus size={14} /> Add
        </button>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!dirty || invalid || busy}
          data-testid="auto-routing-save"
          className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm px-4 py-2.5 rounded-lg transition-colors"
        >
          {busy ? 'Saving...' : 'Save defaults'}
        </button>
        <button
          onClick={() => adopt(saved)}
          disabled={!dirty || busy}
          className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-4 py-2.5 rounded-lg transition-colors"
        >
          Discard changes
        </button>
        {invalid && <span className="text-xs text-red-400">A model may only use letters, digits, and . _ : / -</span>}
      </div>
    </div>
  )
}
