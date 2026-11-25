import { useEffect, useRef, useState } from 'react'
import { agentHistoryApi, type AgentHistoryDetail, type AgentHistoryRecord, type ApiError } from '../api'
import { ConfirmModal } from './ConfirmModal'
import { OutputContent } from './OutputContent'
import { stripAnsi } from './OutputViewer'
import { useStore } from '../store'

const keyFor = (r: AgentHistoryRecord) => `${r.source_node}/${r.origin}/${r.terminal_id}`
const stateLabel = (r: AgentHistoryRecord) => r.replica ? 'Remote snapshot' : r.runtime_state === 'live' ? 'Live runtime' : r.runtime_state === 'unverified' ? 'Presence unverified' : 'Disconnected'

export function AgentHistoryPanel() {
  const [records, setRecords] = useState<AgentHistoryRecord[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [content, setContent] = useState<AgentHistoryDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [pending, setPending] = useState<AgentHistoryRecord | null>(null)
  const [resuming, setResuming] = useState(false)
  const [notice, setNotice] = useState('')
  const resumeLock = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    let active = true
    const load = () => agentHistoryApi.list(offset).then(result => {
      if (!active) return
      setRecords(result.records); setTotal(result.total); setError(''); setLoading(false)
    }).catch(() => { if (active) { setError('History could not be loaded. Refresh to try again.'); setLoading(false) } })
    void load()
    const timer = setInterval(load, 15000)
    return () => { active = false; clearInterval(timer) }
  }, [offset, notice])

  const open = async (record: AgentHistoryRecord) => {
    const key = keyFor(record)
    const current = ++generation.current
    setExpanded(expanded === key ? null : key); setContent(null); setDetailError('')
    if (expanded === key) return
    try {
      const result = await agentHistoryApi.detail(record)
      if (generation.current === current) setContent(result)
    } catch {
      if (generation.current === current) setDetailError('Snapshot could not be loaded. Close and reopen to try again.')
    }
  }

  const resume = async () => {
    if (!pending || resumeLock.current) return
    resumeLock.current = true; setResuming(true)
    try {
      const result = await agentHistoryApi.resume(pending)
      setNotice(`Opened ${result.session_name}. No task or pending messages were replayed.`)
      await useStore.getState().fetchSessions()
    } catch (err) {
      setNotice((err as ApiError).detail || 'Resume outcome uncertain. Inspect sessions and history; do not retry automatically.')
    } finally {
      setPending(null); setResuming(false); resumeLock.current = false
    }
  }

  return <section aria-label="Agent history" className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-5 space-y-4">
    <div>
      <h3 className="text-sm font-semibold text-gray-200">Agent history</h3>
      <p className="text-xs text-gray-400 mt-1">Saved snapshots survive runtime loss. Remote snapshots remain readable when their node is offline; they are never live status.</p>
    </div>
    {notice && <p role="status" className="text-sm text-amber-200">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {loading && <p className="text-sm text-gray-400">Loading history…</p>}
    {!loading && !error && records.length === 0 && <p className="text-sm text-gray-400">No saved agents yet. History appears after an agent is created or an existing agent is observed.</p>}
    <div className="divide-y divide-gray-700/60">
      {records.map(record => <div key={keyFor(record)} className="py-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <button type="button" aria-expanded={expanded === keyFor(record)} onClick={() => void open(record)} className="text-left min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 rounded px-1">
            <span className="text-sm text-gray-200 break-all">{record.session_name} / {record.name}</span>
            <span className="block text-xs text-gray-400 mt-1 break-all">{record.source_node} · {record.provider} · {record.terminal_id}</span>
            <span className="block text-xs text-gray-400 mt-1">{stateLabel(record)}{record.last_known_status ? ` · Last observed: ${record.last_known_status.toLowerCase()}` : ''}</span>
            {record.synced_at && <span className="block text-xs text-gray-500 mt-1">Last synced: {new Date(record.synced_at).toLocaleString()}</span>}
          </button>
          {record.resume_available && <button type="button" disabled={resuming} onClick={() => setPending(record)} className="text-xs px-3 py-2 rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-700 disabled:opacity-50">Resume conversation</button>}
          {record.resume_state && <span className="text-xs text-amber-300 break-all">Resume requested: {record.resume_state === 'launching' ? 'inspect sessions before any retry' : record.resume_state}</span>}
        </div>
        {expanded === keyFor(record) && <div className="mt-4 space-y-3 text-sm">
          {detailError ? <p role="alert" className="text-red-300">{detailError}</p> : !content ? <p className="text-gray-400">Loading snapshot…</p> : <>
            <h4 className="text-gray-300">Saved output</h4>
            <p className="text-xs text-gray-500">Source: {content.output_source}. {content.output_truncated ? 'Partial output; only a bounded snapshot is retained.' : 'Last successful capture.'}</p>
            <div className="max-h-96 overflow-auto break-words bg-gray-950 p-3 rounded-lg text-xs text-gray-300"><OutputContent text={stripAnsi(content.output) || 'No output was captured before the runtime stopped.'} /></div>
            <h4 className="text-gray-300">Saved Inbox</h4>
            {content.inbox_truncated && <p className="text-xs text-amber-300">Partial history: up to 100 entries, with up to 4,096 UTF-8 bytes per entry.</p>}
            {!content.inbox.length && <p className="text-xs text-gray-400">No Inbox entries were saved.</p>}
            {content.inbox.map(message => <div key={`${message.id}/${message.sender_id}/${message.receiver_id}/${message.created_at}`} className="border-l-2 border-gray-600 pl-3">
              <p className="text-xs text-gray-500 break-all">{message.sender_id} → {message.receiver_id} · Recorded as {message.status}</p>
              <p className="text-xs text-gray-300 whitespace-pre-wrap break-words mt-1">{message.message}</p>
            </div>)}
            <p className="text-xs text-gray-500">Read-only history. Pending entries shown here will not be delivered.</p>
          </>}
        </div>}
      </div>)}
    </div>
    {total > 50 && <div className="flex items-center gap-4 text-xs text-gray-400">
      <button type="button" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 50)); setExpanded(null) }} className="disabled:opacity-40">Previous</button>
      <span>{offset + 1}–{Math.min(offset + 50, total)} of {total}</span>
      <button type="button" disabled={offset + 50 >= total} onClick={() => { setOffset(offset + 50); setExpanded(null) }} className="disabled:opacity-40">Next</button>
    </div>}
    <ConfirmModal open={!!pending} title="Resume this conversation?" variant="warning" confirmLabel="Resume conversation" loading={resuming} loadingLabel="Opening conversation…"
      message="This opens a new runtime using the saved native conversation on this node. It does not replay the task, repeat interrupted commands, or transfer pending messages. Check the conversation before giving new instructions."
      details={pending ? [{ label: 'Session', value: pending.session_name }, { label: 'Agent', value: pending.terminal_id }] : []}
      onCancel={() => { if (!resuming) setPending(null) }} onConfirm={() => void resume()} />
  </section>
}
