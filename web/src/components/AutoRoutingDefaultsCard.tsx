import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { api, AgentProfileInfo, AutoRoute, AutoRoutingRoutes, ProviderInfo, ProviderProfile } from '../api'
import { useStore } from '../store'
import { cliChoiceValue, cliOptions, parseCliChoice } from '../cliChoices'
import { CustomSelect, SelectOption } from './CustomSelect'

const LANE_ORDER = ['probe_supervisor', 'fix_supervisor', 'feature_supervisor', 'architect_supervisor']
const LANE_LABELS: Record<string, string> = {
  probe_supervisor: 'Probe',
  fix_supervisor: 'Fix',
  feature_supervisor: 'Feature',
  architect_supervisor: 'Architect',
}
/** The profiles the lane supervisor prompts hand work to (agent_store/*_supervisor.md). */
const LANE_WORKERS = ['developer', 'reviewer', 'planner']
const PROFILE_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/
/** Matches settings_service.MAX_CUSTOM_MODELS. */
const MAX_CUSTOM_MODELS = 50
/** Menu value of "Add a model…". A model ID can never contain a space, so it cannot collide. */
const ADD_MODEL = ' add'

type Routes = Record<string, AutoRoute>
type Models = Record<string, string[]>
type Setter = (fn: (prev: Routes) => Routes) => void

function orderedLanes(names: string[]): string[] {
  return [...LANE_ORDER.filter(n => names.includes(n)), ...names.filter(n => !LANE_ORDER.includes(n))]
}

/** Keep only entries that pick a CLI; a model or account without a CLI means nothing. */
function compact(routes: Routes): Routes {
  const out: Routes = {}
  for (const [name, route] of Object.entries(routes)) {
    if (!route.provider) continue
    const model = route.model?.trim()
    out[name] = {
      provider: route.provider,
      ...(model ? { model } : {}),
      ...(route.provider_profile ? { provider_profile: route.provider_profile } : {}),
    }
  }
  return out
}

function compactModels(models: Models): Models {
  const out: Models = {}
  for (const [provider, list] of Object.entries(models)) if (list.length) out[provider] = list
  return out
}

const cliLabel = (provider: string) => provider.replace(/_/g, ' ')

/** Settings card for the default CLI/model of each Auto (Jev) lane and worker. */
export function AutoRoutingDefaultsCard() {
  const { showSnackbar } = useStore()
  const [saved, setSaved] = useState<AutoRoutingRoutes | null>(null)
  const [lanes, setLanes] = useState<Routes>({})
  const [workers, setWorkers] = useState<Routes>({})
  const [customModels, setCustomModels] = useState<Models>({})
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [accounts, setAccounts] = useState<ProviderProfile[]>([])
  const [profiles, setProfiles] = useState<AgentProfileInfo[]>([])
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [newWorker, setNewWorker] = useState('')
  // The row whose "Add a model…" field is open, and what is typed in it.
  const [adding, setAdding] = useState<string | null>(null)
  const [newModel, setNewModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const adopt = (data: AutoRoutingRoutes) => {
    setSaved(data)
    setLanes(data.lanes)
    setWorkers(data.workers)
    setCustomModels(data.custom_models ?? {})
    setAdding(null)
  }

  useEffect(() => {
    api.getAutoRoutingRoutes()
      .then(data => {
        // An older server answers with something else (or nothing); show the
        // "not offered" note instead of rendering half a form.
        if (!data || !Array.isArray(data.lane_names)) { setLoadFailed(true); return }
        adopt({
          ...data,
          lanes: data.lanes ?? {},
          workers: data.workers ?? {},
          fallback_provider: data.fallback_provider ?? '',
          builtin_models: data.builtin_models ?? {},
        })
      })
      .catch(() => setLoadFailed(true))
    api.listProviders().then(setProviders).catch(() => {})
    api.listProviderProfiles().then(setAccounts).catch(() => {})
    api.listProfiles()
      .then(list => { setProfiles(list); setProfilesLoaded(true) })
      .catch(() => {})
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

  // A server from before added models existed has no custom_models key and
  // rejects one in the PUT body, so the add option is hidden there.
  const supportsCustomModels = saved.custom_models !== undefined
  const descriptions = new Map(profiles.map(p => [p.name, p.description]))
  const otherProfiles = [...new Set(profiles.map(p => p.name))]
    .filter(n => !saved.lane_names.includes(n) && !LANE_WORKERS.includes(n))
    .sort()
  // Saved routes for names this server has no profile for (typed in by hand,
  // or a profile that lives on another Fleet node).
  const extraWorkers = Object.keys(workers)
    .filter(n => !LANE_WORKERS.includes(n) && !otherProfiles.includes(n))
    .sort()
  const workerNames = [...LANE_WORKERS, ...otherProfiles, ...extraWorkers]

  const dirty =
    JSON.stringify(compact(lanes)) !== JSON.stringify(compact(saved.lanes)) ||
    JSON.stringify(compact(workers)) !== JSON.stringify(compact(saved.workers)) ||
    JSON.stringify(compactModels(customModels)) !== JSON.stringify(compactModels(saved.custom_models ?? {}))

  const providerOptions = (emptyLabel: string, current: string): SelectOption[] => [
    { value: '', label: emptyLabel },
    ...cliOptions(providers, accounts, { current }),
  ]

  const modelOptions = (route: AutoRoute): SelectOption[] => {
    if (!route.provider) return [{ value: '', label: 'Pick a CLI first' }]
    const builtin = saved.builtin_models[route.provider] || []
    const added = (customModels[route.provider] || []).filter(m => !builtin.includes(m))
    const options: SelectOption[] = [{ value: '', label: "CLI's default model" }]
    // A saved model that is in neither list (for example one removed from
    // "Added models") still shows, so the row never looks empty by mistake.
    if (route.model && !builtin.includes(route.model) && !added.includes(route.model)) {
      options.push({ value: route.model, label: route.model, group: 'Saved' })
    }
    options.push(...builtin.map(m => ({ value: m, label: m, group: 'Built-in' })))
    options.push(...added.map(m => ({ value: m, label: m, group: 'Added by you' })))
    if (supportsCustomModels) {
      options.push({ value: ADD_MODEL, label: 'Add a model…', sublabel: 'For a model this list does not have yet', group: 'Not listed?' })
    }
    return options
  }

  const update = (setter: Setter, name: string, patch: AutoRoute) =>
    setter(prev => ({ ...prev, [name]: { ...prev[name], ...patch } }))

  const trimmedModel = newModel.trim()
  const modelIdBad = trimmedModel !== '' && !MODEL_ID.test(trimmedModel)

  const addModel = (name: string, provider: string, setter: Setter) => {
    if (!trimmedModel || modelIdBad) return
    const builtin = saved.builtin_models[provider] || []
    const list = customModels[provider] || []
    if (!builtin.includes(trimmedModel) && !list.includes(trimmedModel)) {
      if (list.length >= MAX_CUSTOM_MODELS) {
        showSnackbar({ type: 'error', message: `At most ${MAX_CUSTOM_MODELS} added models per CLI` })
        return
      }
      setCustomModels(prev => ({ ...prev, [provider]: [...(prev[provider] || []), trimmedModel] }))
    }
    update(setter, name, { model: trimmedModel })
    setAdding(null)
    setNewModel('')
  }

  const removeModel = (provider: string, model: string) =>
    setCustomModels(prev => ({ ...prev, [provider]: (prev[provider] || []).filter(m => m !== model) }))

  const row = (
    name: string,
    label: string,
    sub: string,
    routes: Routes,
    setter: Setter,
    emptyLabel: string,
    removable: boolean,
  ) => {
    const route = routes[name] || {}
    return (
      <div key={name} className="flex flex-wrap items-center gap-2 bg-gray-900/50 border border-gray-700/30 rounded-lg px-3 py-2.5" data-testid={`auto-route-${name}`}>
        <div className="w-36 shrink-0" title={descriptions.get(name) || name}>
          <div className="text-sm text-gray-300 truncate">{label}</div>
          {/* Lanes show their profile name under the label; workers show the profile description. */}
          <div className={`text-[10px] text-gray-500 truncate ${sub === name ? 'font-mono' : ''}`}>{sub}</div>
        </div>
        <div className="flex-1 min-w-[150px]">
          <CustomSelect
            ariaLabel={`${name} CLI`}
            value={cliChoiceValue(route.provider, route.provider_profile)}
            onChange={value => {
              const choice = parseCliChoice(value)
              // A model is written for one CLI, so it is cleared only when the
              // CLI changes; switching between accounts of one CLI keeps it.
              const sameCli = Boolean(choice.provider) && choice.provider === route.provider
              update(setter, name, {
                provider: choice.provider || undefined,
                provider_profile: choice.account,
                model: sameCli ? route.model : undefined,
              })
              if (adding === name && !sameCli) setAdding(null)
            }}
            options={providerOptions(emptyLabel, cliChoiceValue(route.provider, route.provider_profile))}
          />
        </div>
        <div className="flex-1 min-w-[150px]">
          <CustomSelect
            ariaLabel={`${name} model`}
            value={route.model || ''}
            disabled={!route.provider || busy}
            onChange={value => {
              if (value === ADD_MODEL) { setAdding(name); setNewModel(''); return }
              update(setter, name, { model: value || undefined })
            }}
            options={modelOptions(route)}
          />
        </div>
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
        {adding === name && route.provider && (
          <div className="basis-full flex flex-wrap items-center gap-2 pt-1">
            <input
              type="text"
              autoFocus
              aria-label={`New model for ${name}`}
              value={newModel}
              onChange={e => setNewModel(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') addModel(name, route.provider as string, setter)
                if (e.key === 'Escape') setAdding(null)
              }}
              placeholder={`Model ID as ${cliLabel(route.provider)} --model takes it`}
              className={`flex-1 min-w-[200px] bg-gray-900 border text-gray-200 text-sm rounded-lg px-3 py-2 font-mono focus:outline-none ${
                modelIdBad ? 'border-red-500' : 'border-gray-700 focus:border-emerald-500'
              }`}
            />
            <button
              onClick={() => addModel(name, route.provider as string, setter)}
              disabled={!trimmedModel || modelIdBad}
              className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm px-3 py-2 rounded-lg transition-colors"
            >
              Add model
            </button>
            <button onClick={() => setAdding(null)} className="text-gray-400 hover:text-gray-200 text-sm px-2 py-2">
              Cancel
            </button>
            {modelIdBad && (
              <span className="basis-full text-xs text-red-400">
                A model ID may only use letters, digits, and . _ : / - (at most 128 characters)
              </span>
            )}
          </div>
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
      adopt(await api.setAutoRoutingRoutes({
        lanes: compact(lanes),
        workers: compact(workers),
        ...(supportsCustomModels ? { custom_models: compactModels(customModels) } : {}),
      }))
      showSnackbar({ type: 'success', message: 'Auto (Jev) defaults saved' })
    } catch (e: any) {
      showSnackbar({ type: 'error', message: e.detail || e.message || 'Failed to save Auto (Jev) defaults' })
    } finally {
      setBusy(false)
    }
  }

  const workerRow = (name: string, removable: boolean) =>
    row(
      name,
      name,
      descriptions.get(name) || (removable && profilesLoaded ? 'No profile on this server' : ''),
      workers,
      setWorkers,
      "Supervisor's CLI",
      removable,
    )
  const addedModels = Object.entries(customModels).flatMap(([provider, list]) => list.map(model => ({ provider, model })))

  return (
    <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-5" data-testid="auto-routing-defaults">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-4">Auto (Jev) defaults</h3>
      <p className="text-xs text-gray-500 mb-4">
        The CLI and model each Auto (Jev) supervisor and its workers start with. A CLI picked in the
        Spawn form wins over these. Saved changes apply to the next Auto session; running sessions keep
        the routes they started with. "CLI's default model" lets the CLI pick its own model.
      </p>
      {!saved.enabled && (
        <p className="text-xs text-amber-400/80 mb-4" data-testid="auto-routing-off">
          Auto routing is off on this server (settings.json auto_routing.enabled). These defaults apply once it is on.
        </p>
      )}

      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Lane supervisors</div>
      <div className="space-y-2 mb-5">
        {orderedLanes(saved.lane_names).map(name =>
          row(name, LANE_LABELS[name] || name, name, lanes, setLanes, `Default (${cliLabel(saved.fallback_provider)})`, false),
        )}
      </div>

      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Delegated workers</div>
      <p className="text-xs text-gray-500 mb-3">
        The lane supervisors hand work to developer, reviewer, and planner. A route for another profile
        applies only when a supervisor is asked to delegate to that profile. Workers without a CLI here
        run on the supervisor's CLI.
      </p>
      <div className="text-[10px] text-gray-500 mb-2">Used by the lanes</div>
      <div className="space-y-2 mb-4" data-testid="auto-workers-lane">
        {LANE_WORKERS.map(name => workerRow(name, false))}
      </div>
      {(otherProfiles.length > 0 || extraWorkers.length > 0) && (
        <>
          <div className="text-[10px] text-gray-500 mb-2">Other profiles</div>
          <div className="space-y-2 mb-3" data-testid="auto-workers-other">
            {otherProfiles.map(name => workerRow(name, false))}
            {extraWorkers.map(name => workerRow(name, true))}
          </div>
        </>
      )}
      <div className="flex gap-2 mb-5">
        <input
          type="text"
          value={newWorker}
          onChange={e => setNewWorker(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addWorker()}
          placeholder="A profile not listed here, e.g. one on another node"
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

      {addedModels.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">Added models</div>
          <div className="flex flex-wrap gap-2 mb-5" data-testid="auto-routing-added-models">
            {addedModels.map(({ provider, model }) => (
              <span key={`${provider}/${model}`} className="flex items-center gap-1.5 bg-gray-900 border border-gray-700 rounded-lg pl-2.5 pr-1.5 py-1 text-xs">
                <span className="text-gray-500">{cliLabel(provider)}</span>
                <span className="font-mono text-gray-300">{model}</span>
                <button
                  onClick={() => removeModel(provider, model)}
                  disabled={busy}
                  className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-40"
                  aria-label={`Remove model ${model} from ${provider}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!dirty || busy}
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
      </div>
    </div>
  )
}
