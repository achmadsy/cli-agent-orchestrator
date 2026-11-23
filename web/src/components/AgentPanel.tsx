import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { api, AgentProfileInfo, ProviderInfo, ProviderProfile, ProviderRole, RoleProviderPolicy, RoleProviderProfilePolicy, RuntimeFailure } from '../api'
import { Bot, Play, Trash2, ChevronRight, Terminal as TermIcon, Monitor, Package, FolderOpen, Tag, Search, Mail, Plus, LogOut, Send, FileText, X, AlertTriangle, Repeat } from 'lucide-react'
import { TerminalView } from './TerminalView'
import { DirectoryPickerDialog } from './DirectoryPickerDialog'
import { ConfirmModal } from './ConfirmModal'
import { InboxPanel } from './InboxPanel'
import { CustomSelect, SelectOption } from './CustomSelect'
import { cliChoiceValue, cliOptions, parseCliChoice } from '../cliChoices'
import { TerminalMeta } from '../api'
import { StatusBadge } from './StatusBadge'
import { OutputViewer } from './OutputViewer'
import type { TerminalLink } from '../terminalLink'
import { encodeAttachments, validateAttachments } from '../attachments'
import { PromptAttachments } from './PromptAttachments'
import { NativeQuestionCard } from './NativeQuestionCard'

export const FALLBACK_PROVIDERS = ['kiro_cli', 'claude_code', 'q_cli', 'codex', 'gemini_cli', 'hermes', 'kimi_cli', 'copilot_cli', 'opencode_cli', 'cursor_cli', 'grok_cli']

// Virtual picker value for "Auto (Jev)". The colon cannot appear in a real
// profile name, and this value is never sent to the server as agent_profile:
// the server picks the real lane profile.
export const AUTO_PROFILE = 'auto:jev'

const SOURCE_LABELS: Record<string, string> = {
  'built-in': 'Built-in',
  'local': 'Local',
  'kiro': 'Kiro',
  'q_cli': 'Q CLI',
  'opencode_cli': 'OpenCode',
}

export function AgentPanel({ terminalLink = null, onTerminalLinkConsumed }: {
  terminalLink?: TerminalLink | null
  onTerminalLinkConsumed?: () => void
} = {}) {
  const { sessions, fetchSessions, activeSession, activeSessionDetail, selectSession, createSession, createAutoSession, deleteSession, terminalStatuses, setTerminalStatus } = useStore()
  const [monitoring, setMonitoring] = useState<Record<string, { reason: string; observed_status?: string } | null>>({})
  const [provider, setProvider] = useState('kiro_cli')
  const [profile, setProfile] = useState('')
  const [creating, setCreating] = useState(false)
  // Synchronous in-flight lock: prevents a second submit (rapid double-click or
  // Enter in the form inputs, which bypass the button's disabled state) from
  // firing before the `creating` state re-renders and creating a duplicate session.
  const creatingRef = useRef(false)
  const [liveTerminal, setLiveTerminal] = useState<{ id: string; provider?: string; agentProfile?: string | null } | null>(null)
  const [profiles, setProfiles] = useState<AgentProfileInfo[]>([])
  const [loadingProfiles, setLoadingProfiles] = useState(true)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfile[]>([])
  // The account always comes from the same menu pick as its CLI (see
  // cliChoices.ts), so a CLI change can never leave a foreign account behind.
  const [providerProfile, setProviderProfile] = useState('')
  const [addProviderProfile, setAddProviderProfile] = useState('')

  useEffect(() => {
    api.listProviders()
      .then(p => {
        setProviders(p)
        // Default to first installed provider. This replaces any earlier pick,
        // so drop that pick's account too; it may belong to another CLI.
        const firstInstalled = p.find(prov => prov.installed)
        if (firstInstalled) {
          setProvider(firstInstalled.name)
          setProviderProfile('')
        }
      })
      .catch(() => {})
    api.listProviderProfiles().then(setProviderProfiles).catch(() => {})
  }, [])
  const [pendingClose, setPendingClose] = useState<TerminalMeta | null>(null)
  const [closingTerminal, setClosingTerminal] = useState<string | null>(null)
  const [sessionSearch, setSessionSearch] = useState('')
  const [inboxTerminalId, setInboxTerminalId] = useState<string | null>(null)
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false)
  const [sessionName, setSessionName] = useState('')
  const [terminalWorkDirs, setTerminalWorkDirs] = useState<Record<string, string | null>>({})
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [addProvider, setAddProvider] = useState('kiro_cli')
  const [addProfile, setAddProfile] = useState('')
  const [addWorkDir, setAddWorkDir] = useState('')
  const [addingAgent, setAddingAgent] = useState(false)
  const [pendingExit, setPendingExit] = useState<TerminalMeta | null>(null)
  const [exitingTerminal, setExitingTerminal] = useState<string | null>(null)
  const [sendInputOpen, setSendInputOpen] = useState<Record<string, boolean>>({})
  const [sendInputValues, setSendInputValues] = useState<Record<string, string>>({})
  const [sendingInput, setSendingInput] = useState<string | null>(null)
  const { showSnackbar } = useStore()
  const [outputTerminalId, setOutputTerminalId] = useState<string | null>(null)
  const [showSpawnModal, setShowSpawnModal] = useState(false)
  const [selectedProfileRole, setSelectedProfileRole] = useState<string | undefined>()
  const [delegatedMode, setDelegatedMode] = useState<'defaults' | 'same' | 'roles'>('defaults')
  const [delegatedProvider, setDelegatedProvider] = useState('')
  const [delegatedRoles, setDelegatedRoles] = useState<RoleProviderPolicy>({})
  // Per-role account profiles (role_provider_profiles). An entry is only
  // meaningful when its role's selected provider supports profiles, so a
  // provider change resets that role's account; filtering below is by the
  // role's current provider, never a global assumption.
  const [delegatedProfiles, setDelegatedProfiles] = useState<RoleProviderProfilePolicy>({})
  // #runtime: structured provider failures, keyed by terminal id. Server
  // classification — React never regex-parses terminal text.
  const [runtimeFailures, setRuntimeFailures] = useState<Record<string, RuntimeFailure | null>>({})
  const [switchTarget, setSwitchTarget] = useState<{ terminalId: string; provider: string } | null>(null)
  const [switchProfileId, setSwitchProfileId] = useState('')
  const [switchNote, setSwitchNote] = useState('')
  const [switching, setSwitching] = useState(false)
  const [autoRoutingEnabled, setAutoRoutingEnabled] = useState(false)
  const [firstPrompt, setFirstPrompt] = useState('')
  const [promptFiles, setPromptFiles] = useState<File[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const spawnGeneration = useRef(0)
  useEffect(() => { return () => { spawnGeneration.current++ } }, [])
  const addPromptFiles = (added: File[]) => {
    if (creatingRef.current || !added.length) return
    const next = [...promptFiles, ...added]
    const error = validateAttachments(next)
    setAttachmentError(error)
    if (!error) setPromptFiles(next)
  }
  // Auto (Jev) keeps its own provider choice. '' means "use the lane default
  // from Settings", so the form only overrides Settings when the user picks a CLI.
  const [autoProvider, setAutoProvider] = useState('')
  const isAuto = profile === AUTO_PROFILE
  const spawnProvider = isAuto ? autoProvider : provider
  const spawnChoice = cliChoiceValue(spawnProvider, providerProfile)
  const addChoice = cliChoiceValue(addProvider, addProviderProfile)
  const providerList = providers.length > 0
    ? providers
    : FALLBACK_PROVIDERS.map(n => ({ name: n, binary: '', installed: true }))

  // Auto and manual launches keep separate CLI picks; an account picked for
  // one must not follow the user to the other.
  useEffect(() => {
    setProviderProfile('')
  }, [isAuto])

  useEffect(() => {
    api.getAutoRoutingStatus()
      .then(s => setAutoRoutingEnabled(Boolean(s?.enabled)))
      .catch(() => setAutoRoutingEnabled(false))
  }, [])

  const handleDeleteTerminal = async () => {
    if (!pendingClose) return
    const id = pendingClose.id
    setClosingTerminal(id)
    try {
      await api.deleteTerminal(id)
      if (liveTerminal?.id === id) setLiveTerminal(null)
      if (activeSession) await selectSession(activeSession)
      showSnackbar({ type: 'success', message: `Terminal ${id} closed — tmux window killed` })
    } catch (e: any) {
      showSnackbar({
        type: 'error',
        message: e.detail || e.message || `Failed to close terminal ${id}`,
      })
    }
    setClosingTerminal(null)
    setPendingClose(null)
  }

  const handleExitTerminal = async () => {
    if (!pendingExit) return
    const id = pendingExit.id
    setExitingTerminal(id)
    try {
      await api.exitTerminal(id)
      if (activeSession) await selectSession(activeSession)
      showSnackbar({ type: 'success', message: `Graceful exit sent to terminal ${id}` })
    } catch {
      showSnackbar({ type: 'error', message: `Failed to send exit to terminal ${id}` })
    }
    setExitingTerminal(null)
    setPendingExit(null)
  }

  const handleSendInput = async (terminalId: string) => {
    const message = (sendInputValues[terminalId] || '').trim()
    if (!message) return
    setSendingInput(terminalId)
    try {
      await api.sendInput(terminalId, message)
      setSendInputValues(prev => ({ ...prev, [terminalId]: '' }))
      showSnackbar({ type: 'success', message: `Message sent to terminal ${terminalId} (logged in its Inbox)` })
    } catch {
      showSnackbar({ type: 'error', message: `Failed to send message to terminal ${terminalId}` })
    }
    setSendingInput(null)
  }

  useEffect(() => {
    api.listProfiles()
      .then(p => { setProfiles(p); setLoadingProfiles(false) })
      .catch(() => setLoadingProfiles(false))
  }, [])

  useEffect(() => {
    if (!profile || profile === AUTO_PROFILE) {
      setSelectedProfileRole(undefined)
      return
    }
    let cancelled = false
    api.getProfile(profile)
      .then(detail => { if (!cancelled) setSelectedProfileRole(detail.role) })
      .catch(() => { if (!cancelled) setSelectedProfileRole(undefined) })
    return () => { cancelled = true }
  }, [profile])

  useEffect(() => {
    if (activeSession) {
      selectSession(activeSession)
      const interval = setInterval(() => selectSession(activeSession), 5000)
      return () => clearInterval(interval)
    }
  }, [activeSession])

  // Poll one authoritative full projection per visible terminal. Both coarse
  // status and structured runtime failure come from the same server response;
  // React never interprets provider output.
  useEffect(() => {
    const terminalIds = activeSessionDetail?.terminals.map(t => t.id) ?? []
    const visible = new Set(terminalIds)
    setRuntimeFailures(previous => Object.fromEntries(
      Object.entries(previous).filter(([id]) => visible.has(id)),
    ))
    setMonitoring(previous => Object.fromEntries(
      Object.entries(previous).filter(([id]) => visible.has(id)),
    ))
    if (terminalIds.length === 0) return

    let cancelled = false
    const inFlight = new Set<string>()
    const fetchProjections = () => {
      terminalIds.forEach(id => {
        if (inFlight.has(id)) return
        inFlight.add(id)
        api.getTerminal(id)
          .then(terminal => {
            if (cancelled) return
            if (terminal.status) setTerminalStatus(id, terminal.status)
            setMonitoring(previous => ({ ...previous, [id]: terminal.monitoring ?? null }))
            setRuntimeFailures(previous => ({
              ...previous,
              [id]: terminal.runtime_failure ?? null,
            }))
          })
          .catch(() => {
            // Preserve last successful projection across transient read errors.
          })
          .finally(() => { inFlight.delete(id) })
      })
    }

    fetchProjections()
    const interval = setInterval(fetchProjections, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeSessionDetail?.terminals.map(t => t.id).join(',')])

  const resetSpawnForm = () => {
    spawnGeneration.current++
    setPromptFiles([])
    setAttachmentError(null)
    setProfile('')
    setWorkingDirectory('')
    setSessionName('')
    setDelegatedProfiles({})
    setFirstPrompt('')
    setAutoProvider('')
  }

  const handleCreateAuto = async () => {
    if (creatingRef.current || !firstPrompt.trim()) return
    creatingRef.current = true
    setCreating(true)
    const generation = spawnGeneration.current
    try {
      const attachments = promptFiles.length ? await encodeAttachments(promptFiles) : undefined
      if (generation !== spawnGeneration.current) return
      const result = await createAutoSession({
        initial_message: firstPrompt,
        ...(attachments ? { attachments } : {}),
        // Omitted provider = the server uses the lane default from Settings.
        ...(autoProvider ? { provider: autoProvider } : {}),
        ...(autoProvider && providerProfile ? { provider_profile: providerProfile } : {}),
        ...(sessionName.trim() ? { session_name: sessionName.trim() } : {}),
        ...(workingDirectory.trim() ? { working_directory: workingDirectory.trim() } : {}),
      })
      // On failure the store already showed the error; keep the modal and the
      // typed prompt so the user can retry or switch to a manual profile.
      if (result && generation === spawnGeneration.current) {
        setShowSpawnModal(false)
        resetSpawnForm()
      }
    } catch (error) {
      if (generation === spawnGeneration.current) setAttachmentError(error instanceof Error ? error.message : 'Could not prepare attachments.')
    } finally {
      setCreating(false)
      creatingRef.current = false
    }
  }

  const handleCreate = async () => {
    if (isAuto) return handleCreateAuto()
    if (creatingRef.current || !profile.trim()) return
    creatingRef.current = true
    setCreating(true)
    try {
      let roleProviders: RoleProviderPolicy | undefined
      if (delegatedMode === 'same' && delegatedProvider) {
        roleProviders = {
          supervisor: delegatedProvider,
          developer: delegatedProvider,
          reviewer: delegatedProvider,
        }
      } else if (delegatedMode === 'roles') {
        roleProviders = Object.fromEntries(
          Object.entries(delegatedRoles).filter(([, value]) => Boolean(value)),
        ) as RoleProviderPolicy
      }
      let roleProviderProfiles: RoleProviderProfilePolicy | undefined
      if (delegatedMode === 'same' && delegatedProvider) {
        const shared = delegatedProfiles.supervisor
        roleProviderProfiles = shared ? { supervisor: shared, developer: shared, reviewer: shared } : undefined
      } else if (delegatedMode === 'roles') {
        roleProviderProfiles = Object.fromEntries(
          Object.entries(delegatedProfiles).filter(([, value]) => Boolean(value)),
        ) as RoleProviderProfilePolicy
      }
      await createSession(
        provider,
        profile.trim(),
        workingDirectory.trim() || undefined,
        sessionName.trim() || undefined,
        roleProviders,
        providerProfile || undefined,
        roleProviderProfiles,
      )
      setShowSpawnModal(false)
      resetSpawnForm()
    } finally {
      setCreating(false)
      creatingRef.current = false
    }
  }

  const handleSwitchAccount = async () => {
    if (!switchTarget || !switchProfileId || switching) return
    setSwitching(true)
    try {
      const result = await api.switchProviderProfile(
        switchTarget.terminalId,
        switchProfileId,
        switchNote.trim() || undefined,
      )
      showSnackbar({
        type: 'success',
        message:
          result.status === 'switched'
            ? `Switched to account ${switchProfileId} — successor ${result.successor_id} created; predecessor retained`
            : `Successor ${result.successor_id} created but its first message was not delivered — check the new terminal`,
      })
      setSwitchTarget(null)
      setSwitchNote('')
      setSwitchProfileId('')
      if (activeSession) await selectSession(activeSession)
    } catch (e: any) {
      showSnackbar({ type: 'error', message: e.detail || e.message || 'Failed to switch account' })
    }
    setSwitching(false)
  }

  const [terminalLinkError, setTerminalLinkError] = useState<string | null>(null)
  const linkGeneration = useRef(0)
  const cancelTerminalLink = () => {
    linkGeneration.current++
    onTerminalLinkConsumed?.()
  }
  const openTerminal = (terminalId: string, provider?: string, agentProfile?: string | null) => {
    cancelTerminalLink()
    setLiveTerminal({ id: terminalId, provider, agentProfile })
  }

  useEffect(() => {
    if (!terminalLink) return
    const generation = ++linkGeneration.current
    const current = () => generation === linkGeneration.current
    setTerminalLinkError(null)
    if (terminalLink.error) {
      setTerminalLinkError(terminalLink.error)
      onTerminalLinkConsumed?.()
      return
    }
    const { session, terminalId } = terminalLink.request!
    api.getSession(session).then(async detail => {
      if (!current()) return
      const terminal = detail.terminals.find(t => t.id === terminalId && t.tmux_session === session)
      if (!terminal) throw new Error('This terminal is no longer in the requested session.')
      await selectSession(session)
      if (!current()) return
      // Reuse exactly the same viewer as the Open Terminal button. Consume
      // before opening, so refreshes/close never re-run this navigation request.
      openTerminal(terminal.id, terminal.provider, terminal.agent_profile)
    }).catch(() => {
      if (!current()) return
      setTerminalLinkError('Cannot open the requested terminal. It may be unavailable or you may need to sign in. Choose an agent below.')
      onTerminalLinkConsumed?.()
    })
    return () => { if (current()) linkGeneration.current++ }
  }, [terminalLink, onTerminalLinkConsumed, selectSession])

  // Fetch working directories for terminals in session detail
  useEffect(() => {
    if (!activeSessionDetail?.terminals.length) return
    activeSessionDetail.terminals.forEach(t => {
      if (terminalWorkDirs[t.id] === undefined) {
        api.getWorkingDirectory(t.id)
          .then(res => setTerminalWorkDirs(prev => ({ ...prev, [t.id]: res.working_directory })))
          .catch(() => setTerminalWorkDirs(prev => ({ ...prev, [t.id]: null })))
      }
    })
  }, [activeSessionDetail?.terminals.map(t => t.id).join(',')])

  const handleAddAgent = async () => {
    if (!addProfile.trim() || !activeSession) return
    setAddingAgent(true)
    try {
      await api.addTerminalToSession(activeSession, addProvider, addProfile.trim(), addWorkDir.trim() || undefined, addProviderProfile || undefined)
      showSnackbar({ type: 'success', message: 'Agent added to session' })
      setShowAddAgent(false)
      setAddProfile('')
      setAddWorkDir('')
      if (activeSession) await selectSession(activeSession)
    } catch (e: any) {
      showSnackbar({ type: 'error', message: e.message || 'Failed to add agent' })
    }
    setAddingAgent(false)
  }

  // Group profiles by source
  const profilesBySource = profiles.reduce<Record<string, AgentProfileInfo[]>>((acc, p) => {
    const key = p.source || 'unknown'
    if (!acc[key]) acc[key] = []
    acc[key].push(p)
    return acc
  }, {})

  return (
    <div className="space-y-6">
      {terminalLink && !terminalLinkError && (
        <div role="status" className="flex items-center gap-3 text-sm text-gray-300">
          Opening terminal… <button type="button" onClick={cancelTerminalLink}>Cancel</button>
        </div>
      )}
      {terminalLinkError && <div role="alert" className="text-sm text-red-300">{terminalLinkError}</div>}
      {/* Sessions List */}
      <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Sessions ({sessions.length})
          </h3>
          <div className="flex items-center gap-2">
            {sessions.length > 3 && (
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type="text"
                  value={sessionSearch}
                  onChange={e => setSessionSearch(e.target.value)}
                  placeholder="Filter sessions..."
                  className="bg-gray-900 border border-gray-700 text-gray-200 text-xs rounded-lg pl-8 pr-3 py-1.5 w-48 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            )}
            <button
              onClick={() => setShowSpawnModal(true)}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              <Plus size={14} />
              Spawn Agent
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          A session is a workspace where agents collaborate. Each session can have multiple agents that communicate via messages. Click a session to see its agents.
        </p>
        {sessions.length === 0 ? (
          <p className="text-gray-500 text-sm">No active sessions. Spawn an agent above to create one.</p>
        ) : (
          <div className="space-y-2">
            {sessions.filter(s => !sessionSearch || s.id.includes(sessionSearch) || s.name.includes(sessionSearch)).map(s => (
              <div
                key={s.id}
                className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors ${
                  activeSession === s.id ? 'bg-emerald-900/30 border border-emerald-700/50' : 'bg-gray-900/50 border border-gray-700/30 hover:bg-gray-800/80'
                }`}
                onClick={() => { cancelTerminalLink(); selectSession(activeSession === s.id ? null : s.id) }}
              >
                <div className="flex items-center gap-3">
                  <Bot size={16} className="text-emerald-400" />
                  <span className="text-sm text-gray-200 font-mono">{s.id}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${s.status === 'active' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-gray-700 text-gray-400'}`}>
                    {s.status}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={e => { e.stopPropagation(); deleteSession(s.id) }}
                    className="p-1.5 text-gray-500 hover:text-red-400 transition-colors rounded"
                    title="Delete session"
                  >
                    <Trash2 size={14} />
                  </button>
                  <ChevronRight size={14} className={`text-gray-500 transition-transform ${activeSession === s.id ? 'rotate-90' : ''}`} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Session Detail */}
      {activeSessionDetail && (
        <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
              Terminals in {activeSession}
            </h3>
            <button
              onClick={() => setShowAddAgent(!showAddAgent)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-emerald-400 bg-gray-900/50 hover:bg-gray-900 border border-gray-700/50 hover:border-emerald-700/50 rounded-lg transition-colors"
              title="Add another agent to this session so they can collaborate"
            >
              <Plus size={14} />
              Add Agent
            </button>
          </div>

          {/* Add Agent Inline Form */}
          {showAddAgent && (
            <div className="mb-4 p-4 bg-gray-900/70 border border-gray-700/50 rounded-lg space-y-3">
              <p className="text-xs text-gray-500">
                Add another agent to this session. Agents in the same session can send messages to each other and coordinate on tasks. A supervisor can delegate work to agents you add here.
              </p>
              <div className="flex gap-3 items-end flex-wrap">
                <div className="min-w-[180px]">
                  <label className="block text-xs text-gray-500 mb-1">Provider</label>
                  <CustomSelect
                    ariaLabel="Add agent CLI"
                    value={addChoice}
                    onChange={value => {
                      const choice = parseCliChoice(value)
                      setAddProvider(choice.provider)
                      setAddProviderProfile(choice.account ?? '')
                    }}
                    placeholder="Select provider..."
                    options={cliOptions(providerList, providerProfiles, { current: addChoice })}
                  />
                </div>
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-xs text-gray-500 mb-1">Agent Profile</label>
                  {profiles.length > 0 ? (
                    <CustomSelect
                      value={addProfile}
                      onChange={setAddProfile}
                      placeholder="Select a profile..."
                      options={profiles.map(p => ({
                        value: p.name,
                        label: p.name,
                        sublabel: p.description || undefined,
                        group: SOURCE_LABELS[p.source] || p.source,
                      }))}
                    />
                  ) : (
                    <input
                      type="text"
                      value={addProfile}
                      onChange={e => setAddProfile(e.target.value)}
                      placeholder="e.g. developer, reviewer"
                      className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2.5 focus:border-emerald-500 focus:outline-none"
                    />
                  )}
                </div>
                <button
                  onClick={handleAddAgent}
                  disabled={!addProfile.trim() || addingAgent}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  <Plus size={14} />
                  {addingAgent ? 'Adding...' : 'Add'}
                </button>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Working Directory</label>
                <div className="relative">
                  <FolderOpen size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input
                    type="text"
                    value={addWorkDir}
                    onChange={e => setAddWorkDir(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddAgent()}
                    placeholder="/path/to/project (optional)"
                    className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm font-mono rounded-lg pl-9 pr-3 py-2 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            {activeSessionDetail.terminals.map(t => (
              <div key={t.id} className="bg-gray-900/50 border border-gray-700/30 rounded-lg p-3 space-y-2">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <TermIcon size={14} className="text-gray-400 shrink-0" />
                    <span className="text-sm font-mono text-gray-300">{t.id}</span>
                    <StatusBadge status={terminalStatuses[t.id] || null} monitoring={monitoring[t.id]} />
                    <span className="text-xs text-gray-500">{t.provider}</span>
                    {t.agent_profile && <span className="text-xs text-emerald-400">{t.agent_profile}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 [&>button]:min-h-11">
                    <button
                      onClick={() => setInboxTerminalId(t.id)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded-lg transition-colors"
                      title="View inbox"
                    >
                      <Mail size={14} />
                      Inbox
                    </button>
                    <button
                      onClick={() => openTerminal(t.id, t.provider, t.agent_profile)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-colors"
                      title="Open live terminal"
                    >
                      <Monitor size={14} />
                      Open Terminal
                    </button>
                    <button
                      onClick={() => setOutputTerminalId(t.id)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded-lg transition-colors"
                      title="View output"
                    >
                      <FileText size={14} />
                      Output
                    </button>
                    <button
                      onClick={() => setPendingExit(t as TerminalMeta)}
                      disabled={exitingTerminal === t.id}
                      className="flex items-center gap-2 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors"
                      title="Graceful exit"
                    >
                      <LogOut size={14} />
                      {exitingTerminal === t.id ? 'Exiting...' : 'Graceful Exit'}
                    </button>
                    <button
                      onClick={() => setPendingClose(t as TerminalMeta)}
                      disabled={closingTerminal === t.id}
                      className="flex items-center gap-2 px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors"
                      title="Close terminal"
                    >
                      <Trash2 size={14} />
                      {closingTerminal === t.id ? 'Closing...' : 'Close'}
                    </button>
                  </div>
                </div>
                {/* #runtime: provider-classified failure banner. Server-owned
                    classification; no terminal text parsing here. */}
                {runtimeFailures[t.id] && (
                  <div className="flex items-start gap-2 bg-red-900/30 border border-red-800/50 rounded-lg px-3 py-2">
                    <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-red-300">
                        {runtimeFailures[t.id]!.kind === 'rate_limited' ? 'Rate limited'
                          : runtimeFailures[t.id]!.kind === 'quota_exhausted' ? 'Quota exhausted'
                          : runtimeFailures[t.id]!.kind === 'auth_expired' ? 'Authentication expired'
                          : 'Provider error'}
                        {runtimeFailures[t.id]!.reset_at && (
                          <span className="text-red-400/70 font-normal"> · resets {runtimeFailures[t.id]!.reset_at}</span>
                        )}
                      </div>
                      <div className="text-xs text-red-400/80 break-words mt-0.5">{runtimeFailures[t.id]!.message}</div>
                    </div>
                    <button
                      onClick={() => {
                        setSwitchTarget({ terminalId: t.id, provider: t.provider })
                        setSwitchProfileId('')
                        setSwitchNote('')
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-red-700/60 hover:bg-red-600 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors shrink-0"
                      title="Continue on another authenticated account"
                    >
                      <Repeat size={12} />
                      Switch account
                    </button>
                  </div>
                )}
                {/* Working Directory Display */}
                {terminalWorkDirs[t.id] && (
                  <div className="flex items-center gap-1.5" title={terminalWorkDirs[t.id]!}>
                    <FolderOpen size={12} className="text-gray-600 shrink-0" />
                    <span className="text-xs font-mono text-gray-500 truncate max-w-[400px]">{terminalWorkDirs[t.id]}</span>
                  </div>
                )}
                {/* Quick Send Input */}
                {terminalStatuses[t.id]?.toUpperCase() === 'WAITING_USER_ANSWER' ? (
                  <NativeQuestionCard key={t.id} terminalId={t.id} />
                ) : !sendInputOpen[t.id] ? (
                  <button
                    onClick={() => setSendInputOpen(prev => ({ ...prev, [t.id]: true }))}
                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Message agent...
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={sendInputValues[t.id] || ''}
                      onChange={e => setSendInputValues(prev => ({ ...prev, [t.id]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleSendInput(t.id) }}
                      placeholder="Send directly to the terminal..."
                      className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 text-sm font-mono rounded-lg px-3 py-1.5 focus:border-emerald-500 focus:outline-none"
                      autoFocus
                    />
                    <button
                      onClick={() => handleSendInput(t.id)}
                      disabled={sendingInput === t.id || !(sendInputValues[t.id] || '').trim()}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      <Send size={12} />
                      {sendingInput === t.id ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inbox Panel */}
      {inboxTerminalId && (
        <InboxPanel terminalId={inboxTerminalId} onClose={() => setInboxTerminalId(null)} />
      )}

      {/* Live Terminal */}
      {liveTerminal && (
        <TerminalView
          terminalId={liveTerminal.id}
          provider={liveTerminal.provider}
          agentProfile={liveTerminal.agentProfile}
          onClose={() => setLiveTerminal(null)}
        />
      )}

      {/* Output Viewer Modal */}
      {outputTerminalId && (
        <OutputViewer
          terminalId={outputTerminalId}
          onClose={() => setOutputTerminalId(null)}
        />
      )}

      {/* Switch Account Modal (#runtime) */}
      {switchTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !switching && setSwitchTarget(null)} />
          <div className="relative bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl shadow-black/50 w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
              <div>
                <h3 className="text-base font-semibold text-gray-200">Switch account</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Creates a successor agent on the new account in this same session. The current terminal stays open for inspection until you close it.
                </p>
              </div>
              <button
                onClick={() => !switching && setSwitchTarget(null)}
                className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors rounded-lg hover:bg-gray-700/50"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {(() => {
                const options = providerProfiles.filter(p => p.provider === switchTarget.provider)
                if (options.length === 0) {
                  return (
                    <p className="text-xs text-amber-400">
                      No other {switchTarget.provider} account profiles exist. Add and authenticate one in Provider Profiles first.
                    </p>
                  )
                }
                return (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Target account</label>
                    <CustomSelect
                      value={switchProfileId}
                      onChange={setSwitchProfileId}
                      placeholder="Select account..."
                      options={options.map(p => ({
                        value: p.id,
                        label: p.label,
                        sublabel: p.id + ' · ' + p.auth_state,
                        disabled: p.auth_state !== 'authenticated',
                      }))}
                    />
                  </div>
                )
              })()}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Continuation note <span className="text-gray-600">(optional)</span></label>
                <textarea
                  value={switchNote}
                  onChange={e => setSwitchNote(e.target.value)}
                  placeholder="What should the successor know to continue? (bounded context handoff — no transcript or credentials are copied)"
                  rows={3}
                  maxLength={400}
                  className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs rounded-lg px-3 py-2 focus:border-emerald-500 focus:outline-none resize-none"
                />
              </div>
              <p className="text-[11px] text-gray-600">
                This is a context handoff, not a conversation resume: the successor starts fresh with a short summary of the failure plus your note. Automatic account rotation never happens.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-700/50">
              <button
                onClick={() => !switching && setSwitchTarget(null)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSwitchAccount}
                disabled={!switchProfileId || switching}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
              >
                <Repeat size={14} />
                {switching ? 'Switching...' : 'Switch account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Confirmation Modal */}
      <ConfirmModal
        open={!!pendingClose}
        title="Close Terminal"
        message="This will kill the tmux window and terminate the agent process. This action cannot be undone."
        details={pendingClose ? [
          { label: 'Terminal ID', value: pendingClose.id },
          { label: 'Provider', value: pendingClose.provider },
          { label: 'Profile', value: pendingClose.agent_profile || 'none' },
          { label: 'Session', value: pendingClose.tmux_session },
        ] : []}
        confirmLabel="Close Terminal"
        variant="danger"
        loading={!!closingTerminal}
        onConfirm={handleDeleteTerminal}
        onCancel={() => setPendingClose(null)}
      />

      {/* Graceful Exit Confirmation Modal */}
      <ConfirmModal
        open={!!pendingExit}
        title="Graceful Exit"
        message="This will send the provider-specific exit command (e.g., /exit). The agent will shut down gracefully."
        details={pendingExit ? [
          { label: 'Terminal ID', value: pendingExit.id },
          { label: 'Provider', value: pendingExit.provider },
          { label: 'Profile', value: pendingExit.agent_profile || 'none' },
          { label: 'Session', value: pendingExit.tmux_session },
        ] : []}
        confirmLabel="Send Exit"
        variant="warning"
        loading={!!exitingTerminal}
        onConfirm={handleExitTerminal}
        onCancel={() => setPendingExit(null)}
      />

      {showSpawnModal && showDirectoryPicker && <DirectoryPickerDialog
        initialPath={workingDirectory}
        onSelect={setWorkingDirectory}
        onClose={() => setShowDirectoryPicker(false)}
      />}

      {/* Spawn Agent Modal */}
      {showSpawnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!creatingRef.current) { setShowSpawnModal(false); resetSpawnForm() } }} />
          <div className="relative bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl shadow-black/50 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            {/* Modal header */}
            <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
              <div>
                <h3 className="text-base font-semibold text-gray-200">Spawn Agent</h3>
                <p className="text-xs text-gray-500 mt-1">
                  Launch a new AI agent in its own isolated tmux session.
                </p>
              </div>
              <button
                onClick={() => { if (!creatingRef.current) { setShowSpawnModal(false); resetSpawnForm() } }}
                className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors rounded-lg hover:bg-gray-700/50"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal body */}
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Provider</label>
                <CustomSelect
                  ariaLabel="Spawn CLI"
                  value={spawnChoice}
                  onChange={value => {
                    const choice = parseCliChoice(value)
                    if (isAuto) setAutoProvider(choice.provider)
                    else setProvider(choice.provider)
                    setProviderProfile(choice.account ?? '')
                  }}
                  placeholder="Select provider..."
                  options={[
                    ...(isAuto ? [{
                      value: '',
                      label: 'Default (from Settings)',
                      sublabel: "Each lane's CLI from Settings › Auto (Jev) defaults",
                    }] : []),
                    ...cliOptions(providerList, providerProfiles, { current: spawnChoice }),
                  ]}
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Agent Profile</label>
                {loadingProfiles ? (
                  <div className="bg-gray-900 border border-gray-700 text-gray-500 text-sm rounded-lg px-3 py-2.5">Loading profiles...</div>
                ) : profiles.length > 0 ? (
                  <CustomSelect
                    value={profile}
                    onChange={setProfile}
                    placeholder="Select a profile..."
                    options={[
                      ...(autoRoutingEnabled ? [{
                        value: AUTO_PROFILE,
                        label: 'Auto (Jev)',
                        sublabel: 'Jev reads the first prompt and picks the probe, fix, feature, or architect supervisor',
                        group: 'Auto',
                      }] : []),
                      ...profiles.map(p => ({
                        value: p.name,
                        label: p.name,
                        sublabel: p.description || undefined,
                        group: SOURCE_LABELS[p.source] || p.source,
                      })),
                    ]}
                  />
                ) : (
                  <input
                    type="text"
                    value={profile}
                    onChange={e => setProfile(e.target.value)}
                    placeholder="e.g. developer, reviewer"
                    className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2.5 focus:border-emerald-500 focus:outline-none"
                  />
                )}
              </div>

              {isAuto && (
                <div>
                  <label htmlFor="spawn-first-prompt" className="block text-xs text-gray-500 mb-1">First prompt</label>
                  <textarea
                    disabled={creating}
                    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault() }}
                    onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); addPromptFiles(Array.from(event.dataTransfer.files)) } }}
                    onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); addPromptFiles(Array.from(event.clipboardData.files)) } }}
                    id="spawn-first-prompt"
                    value={firstPrompt}
                    onChange={e => setFirstPrompt(e.target.value)}
                    rows={4}
                    placeholder="Describe the task. Jev uses it to choose the supervisor lane."
                    className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2.5 focus:border-emerald-500 focus:outline-none resize-y"
                  />
                  <p className="mt-1 text-[11px] text-gray-600">Task text is sent to Jev through 9router for classification, then delivered with attachments to the chosen supervisor as its first message.</p>
                  <PromptAttachments files={promptFiles} disabled={creating} onAdd={addPromptFiles} onRemove={index => { setPromptFiles(files => files.filter((_, i) => i !== index)); setAttachmentError(null) }} />
                  {attachmentError && <p role="alert" className="mt-2 text-xs text-red-400">{attachmentError}</p>}
                </div>
              )}

              <div>
                <label htmlFor="spawn-session-name" className="block text-xs text-gray-500 mb-1">Session Name <span className="text-gray-600">(optional)</span></label>
                <div className="relative">
                  <Tag size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input
                    id="spawn-session-name"
                    type="text"
                    value={sessionName}
                    onChange={e => setSessionName(e.target.value.replace(/\s/g, ''))}
                    onKeyDown={e => {
                      if (e.key === ' ') e.preventDefault()
                      else if (e.key === 'Enter') handleCreate()
                    }}
                    placeholder="my-session (or a random id like cao-a1b2c3d4)"
                    className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded-lg pl-9 pr-3 py-2.5 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="spawn-working-directory" className="block text-xs text-gray-500 mb-1">Working Directory <span className="text-gray-600">(optional)</span></label>
                <div className="flex flex-wrap gap-2">
                  <div className="relative min-w-0 flex-1 basis-48">
                    <FolderOpen size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input
                      id="spawn-working-directory"
                      type="text"
                      value={workingDirectory}
                      onChange={e => setWorkingDirectory(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && !showDirectoryPicker && handleCreate()}
                      placeholder="/path/to/project (defaults to home)"
                      className="min-h-11 w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm font-mono rounded-lg pl-9 pr-3 py-2.5 focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                  <button type="button" onClick={() => setShowDirectoryPicker(true)} className="min-h-11 rounded-lg border border-gray-700 px-3 text-sm text-gray-300 hover:bg-gray-700">Browse folders</button>
                </div>
              </div>

              {!isAuto && (selectedProfileRole === 'supervisor' || profile === 'code_supervisor') && (
                <details className="rounded-lg border border-gray-700/50 bg-gray-900/50 p-3">
                  <summary className="cursor-pointer text-xs font-medium text-gray-300">Delegated agent CLIs</summary>
                  <p className="mt-2 text-xs text-gray-500">Automatically route Developer and Reviewer agents without relying on supervisor prompts.</p>
                  <div className="mt-3 space-y-2">
                    {([
                      ['defaults', 'Inherit/profile defaults'],
                      ['same', 'Same CLI for all roles'],
                      ['roles', 'Customize by role'],
                    ] as const).map(([value, label]) => (
                      <label key={value} className="flex items-center gap-2 text-xs text-gray-300">
                        <input type="radio" name="delegated-mode" checked={delegatedMode === value} onChange={() => setDelegatedMode(value)} />{label}
                      </label>
                    ))}
                    {delegatedMode === 'same' && (
                      <>
                        <CustomSelect
                          ariaLabel="Delegated CLI for all roles"
                          value={cliChoiceValue(delegatedProvider, delegatedProfiles.supervisor)}
                          onChange={value => {
                            // The CLI and its account come from one pick, so an
                            // account from the old CLI never survives a change.
                            const choice = parseCliChoice(value)
                            setDelegatedProvider(choice.provider)
                            setDelegatedProfiles(choice.account
                              ? { supervisor: choice.account, developer: choice.account, reviewer: choice.account }
                              : {})
                          }}
                          placeholder="Select installed CLI"
                          options={cliOptions(providers, providerProfiles, {
                            current: cliChoiceValue(delegatedProvider, delegatedProfiles.supervisor),
                          })}
                        />
                      </>
                    )}
                    {delegatedMode === 'roles' && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {(['supervisor', 'developer', 'reviewer'] as ProviderRole[]).map(role => {
                          const roleChoice = cliChoiceValue(delegatedRoles[role], delegatedProfiles[role])
                          return (
                            <div key={role}>
                              <label className="block mb-1 text-[11px] capitalize text-gray-500">{role}</label>
                              <CustomSelect
                                ariaLabel={`Delegated CLI for ${role}`}
                                value={roleChoice}
                                onChange={value => {
                                  // One pick sets the role's CLI and account together.
                                  const choice = value ? parseCliChoice(value) : { provider: '', account: undefined }
                                  setDelegatedRoles(current => ({ ...current, [role]: choice.provider || undefined }))
                                  setDelegatedProfiles(current => ({ ...current, [role]: choice.account }))
                                }}
                                placeholder="Default"
                                options={[{ value: '', label: 'Default' }, ...cliOptions(providers, providerProfiles, { current: roleChoice })]}
                              />
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </details>
              )}

              {/* Quick-pick profiles */}
              {profiles.length > 0 && (
                <div>
                  <label className="block text-xs text-gray-500 mb-2">Quick pick</label>
                  <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
                    {profiles.slice(0, 12).map(p => (
                      <button
                        key={`${p.source}-${p.name}`}
                        onClick={() => setProfile(p.name)}
                        className={`text-left px-2.5 py-2 rounded-lg border text-xs transition-all ${
                          profile === p.name
                            ? 'bg-emerald-900/30 border-emerald-700/50 text-emerald-300'
                            : 'bg-gray-900/50 border-gray-700/30 hover:bg-gray-800/80 text-gray-300'
                        }`}
                      >
                        <span className="font-medium">{p.name}</span>
                        <span className="text-[10px] text-gray-600 ml-1.5">{SOURCE_LABELS[p.source] || p.source}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-700/50">
              <button
                onClick={() => { if (!creatingRef.current) { setShowSpawnModal(false); resetSpawnForm() } }}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={(isAuto ? !firstPrompt.trim() : !profile.trim()) || creating}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
              >
                <Play size={14} />
                {creating ? (isAuto ? 'Routing...' : 'Spawning...') : 'Spawn Agent'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
