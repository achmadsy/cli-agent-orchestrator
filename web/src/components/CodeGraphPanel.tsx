import { FormEvent, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, Search } from 'lucide-react'
import { api, ApiError, CodeGraphOverview, CodeGraphSearchResult } from '../api'
import { CustomSelect } from './CustomSelect'

export function CodeGraphPanel() {
  const [overview, setOverview] = useState<CodeGraphOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [project, setProject] = useState('')
  const [node, setNode] = useState('')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [results, setResults] = useState<CodeGraphSearchResult | null>(null)
  const seq = useRef(0)
  const loadSeq = useRef(0)

  const load = async () => {
    const id = ++loadSeq.current
    setLoading(true)
    setError('')
    try {
      const data = await api.getCodeGraphProjects()
      if (id !== loadSeq.current) return
      setOverview(data)
      setProject(current => data.projects.some(p => p.logical_project === current) ? current : data.projects[0]?.logical_project ?? '')
    } catch (e) {
      if (id !== loadSeq.current) return
      setError((e as ApiError).status === 404 ? 'Code graph is disabled on this server. Enable Fleet Codebase Memory to view indexes.' : 'Could not load code indexes. Check the server connection and retry.')
    } finally { if (id === loadSeq.current) setLoading(false) }
  }

  useEffect(() => {
    load()
    return () => { loadSeq.current++; seq.current++ }
  }, [])
  useEffect(() => { seq.current++; setResults(null); setSearchError(''); setSearching(false) }, [project, node, query])

  const search = async (e: FormEvent) => {
    e.preventDefault()
    if (!project || !query.trim()) return
    const id = ++seq.current
    setSearching(true)
    setSearchError('')
    setResults(null)
    try {
      const data = await api.searchCodeGraph(project, query.trim(), node || undefined)
      if (id === seq.current) setResults(data)
    } catch {
      if (id === seq.current) setSearchError('Symbol search failed. Check node availability and try again.')
    } finally { if (id === seq.current) setSearching(false) }
  }

  const choices = [...new Map(overview?.projects.map(p => [p.logical_project, { value: p.logical_project, label: p.display_name }]) ?? []).values()]
  const shown = overview?.projects.filter(p => !node || p.node_id === node) ?? []
  const count = (value: number | null) => value == null ? 'Unknown' : value.toLocaleString()

  return <section className="space-y-6">
    <header className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold text-gray-100">Code graph</h2>
        <p className="text-sm text-gray-400 mt-1 max-w-3xl">Repository indexes across your fleet. Memory → Graph shows relationships between memories, not source code.</p>
      </div>
      <button onClick={load} disabled={loading} className="flex items-center gap-2 text-sm text-gray-200 border border-gray-600 rounded-lg px-3 py-2 disabled:opacity-50"><RefreshCw size={14} /> Refresh</button>
    </header>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {loading && <p role="status" className="text-gray-400 text-sm">Loading code indexes…</p>}
    {overview && <>
      <p className="text-xs text-gray-400">Latest reported snapshot; fleet heartbeats update it automatically. Refresh rereads saved reports without scanning repositories.</p>
      {overview.nodes.length > 0 && <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-400" aria-label="Fleet reports">
        {overview.nodes.map(n => <li key={n.node_id}>{n.node_id}: {n.online ? 'Online' : 'Offline'} — {n.last_seen_at ? <>last reported <time dateTime={n.last_seen_at}>{new Date(n.last_seen_at).toLocaleString()}</time></> : 'report time unknown'}</li>)}
      </ul>}
      <CustomSelect value={node} onChange={setNode} ariaLabel="Code graph node" className="w-64" options={[
        { value: '', label: 'All nodes' },
        ...overview.nodes.map(n => ({ value: n.node_id, label: `${n.node_id} (${n.online ? 'Online' : 'Offline'})` })),
      ]} />
      {shown.length === 0 ? <p className="text-gray-400 text-sm py-6">No code indexes registered{node ? ' on this node' : ''}. Waiting for fleet reports if this server just started. A permitted agent query can index its repository automatically; this page never starts indexing.</p> :
        <div className="overflow-x-auto border border-gray-700 rounded-lg">
          <table className="w-full text-sm text-left">
            <caption className="sr-only">Code indexes by repository and fleet node</caption>
            <thead className="bg-gray-800 text-gray-300"><tr>{['Repository / node', 'Branch', 'Indexed', 'Freshness', 'Nodes', 'Edges'].map(h => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-gray-700 text-gray-200">{shown.map(p => <tr key={`${p.node_id}:${p.native_project}`}>
              <td className="px-4 py-3"><div className="break-words max-w-sm">{p.display_name}</div><div className="text-xs text-gray-400 mt-1">{p.node_id} — {p.online ? 'Online' : 'Offline'}{!p.available ? ' / Repository unavailable' : ''}</div><div className="text-xs text-gray-400 mt-1 break-all">{p.native_project}</div></td>
              <td className="px-4 py-3 whitespace-nowrap">{p.branch || 'Unknown'}<div className="text-xs text-gray-400">{p.head_sha?.slice(0, 8)}{p.dirty ? ' (uncommitted changes)' : ''}</div></td>
              <td className="px-4 py-3 whitespace-nowrap">{p.indexed_at ? <time dateTime={p.indexed_at} title={p.indexed_at}>{new Date(p.indexed_at).toLocaleString()}</time> : 'Unknown'}</td>
              <td className="px-4 py-3"><span className="inline-flex items-center gap-1">{p.stale === true && <AlertTriangle size={14} className="text-amber-400" />}{p.stale == null ? 'Unknown' : p.stale ? 'Behind HEAD' : 'Current at HEAD'}</span>{p.commits_since_index != null && <div className="text-xs text-gray-400">{p.commits_since_index} newer commits</div>}</td>
              <td className="px-4 py-3 tabular-nums">{count(p.node_count)}</td><td className="px-4 py-3 tabular-nums">{count(p.edge_count)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      <p className="text-xs text-gray-400">Freshness compares Git history with the actual index time; uncommitted edits are reported separately. Older nodes may show unknown metadata until upgraded.</p>
      <div className="space-y-3">
        <h3 className="text-base font-medium text-gray-200">Find a symbol</h3>
        <form onSubmit={search} className="flex gap-3 flex-wrap items-center">
          <CustomSelect value={project} onChange={setProject} options={choices} ariaLabel="Symbol repository" placeholder="Select repository" className="w-80 max-w-full" />
          <input aria-label="Symbol query" value={query} onChange={e => setQuery(e.target.value)} placeholder="Function, class, or symbol name" maxLength={500} className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-100 w-80 max-w-full" />
          <button disabled={searching || !project || !query.trim()} className="flex items-center gap-2 bg-emerald-600 text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"><Search size={14} />{searching ? 'Searching…' : 'Search'}</button>
        </form>
        <p className="text-xs text-gray-400">Read-only search of existing indexes. Agent queries with write permission can queue a stale index for refresh.</p>
        {searchError && <p role="alert" className="text-red-300 text-sm">{searchError}</p>}
        {results?.partial && <p role="status" className="text-amber-300 text-sm">Partial results: {results.node_errors.map(e => e.source_node).join(', ')} unavailable.</p>}
        {results && results.matches.length === 0 && <p className="text-sm text-gray-400">No symbols found in the available indexes.</p>}
        {results && results.matches.length > 0 && <ul className="divide-y divide-gray-700 border border-gray-700 rounded-lg">{results.matches.map((m, i) => <li key={`${m.source_node}:${m.qualified_name}:${i}`} className="p-3 text-sm">
          <div className="text-gray-100 break-all">{m.qualified_name}</div><div className="text-gray-400 text-xs mt-1 break-all">{m.source_node} / {m.branch || 'Unknown branch'} — {m.kind} — {m.file_path}:{m.lines}</div>
        </li>)}</ul>}
      </div>
    </>}
  </section>
}
