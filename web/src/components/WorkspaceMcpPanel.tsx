import { useState, useEffect, useCallback, useRef } from 'react'
import {
  api,
  ApiError,
  BrowseDirectoriesResponse,
  WorkspaceMcpInstance,
} from '../api'
import { useStore } from '../store'
import { Copy, Eye, EyeOff, FolderTree, Loader2, Plus, RefreshCw, StopCircle } from 'lucide-react'

/**
 * Panel for managing workspace-backed MCP servers (Quick Tunnel instances).
 */

const STATUS_STYLE: Record<WorkspaceMcpInstance['status'], string> = {
  running: 'bg-emerald-900/50 text-emerald-300 border-emerald-800',
  starting: 'bg-yellow-900/40 text-yellow-300 border-yellow-800',
  stopped: 'bg-gray-800 text-gray-400 border-gray-700',
  failed: 'bg-red-900/50 text-red-300 border-red-800',
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // clipboard may be denied in insecure contexts; ignore
        }
      }}
      aria-label={label}
      title={label}
      className="text-gray-400 hover:text-white shrink-0"
    >
      {copied ? <span className="text-emerald-400 text-xs">Copied!</span> : <Copy size={14} />}
    </button>
  )
}

function InstanceRow({ instance, onStop, busy }: { instance: WorkspaceMcpInstance; onStop: (id: string) => void; busy: boolean }) {
  const [showPassword, setShowPassword] = useState(false)
  return (
    <li key={instance.id} className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-mono text-sm break-all">{instance.folder_path}</p>
          <p className="text-xs text-gray-500">
            {instance.id} · port {instance.port} · {instance.agentic ? 'agentic' : 'read-only'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`px-2 py-0.5 rounded border text-xs uppercase ${STATUS_STYLE[instance.status]}`}>
            {instance.status}
          </span>
          <button
            onClick={() => onStop(instance.id)}
            disabled={busy}
            className="text-red-400 hover:text-red-300 disabled:opacity-50"
            title={`Stop ${instance.id}`}
            aria-label={`Stop ${instance.id}`}
          >
            <StopCircle size={16} />
          </button>
        </div>
      </div>
      {instance.error && (
        <p role="alert" className="text-xs text-red-300">{instance.error}</p>
      )}
      {instance.tunnel_url && (
        <div className="flex items-center gap-2 text-xs">
          <a
            href={instance.tunnel_url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:text-blue-300 break-all"
          >
            {instance.tunnel_url}
          </a>
          <CopyButton text={instance.tunnel_url} label="Copy tunnel URL" />
        </div>
      )}
      {instance.admin_password && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">Password:</span>
          <span className="font-mono break-all">
            {showPassword ? instance.admin_password : '•'.repeat(instance.admin_password.length)}
          </span>
          <button
            onClick={() => setShowPassword(p => !p)}
            className="text-gray-400 hover:text-white shrink-0"
            title={showPassword ? 'Hide password' : 'Show password'}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <CopyButton text={instance.admin_password} label="Copy admin password" />
        </div>
      )}
    </li>
  )
}

function DirectoryBrowser({ onSelect }: { onSelect: (path: string) => void }) {
  const [browse, setBrowse] = useState<BrowseDirectoriesResponse | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  const openBrowser = async () => {
    setOpen(true)
    setError('')
    try {
      setBrowse(await api.browseDirectories())
    } catch (e) {
      setError((e as ApiError).detail || 'Failed to browse directories')
    }
  }

  const navigate = async (path: string) => {
    setError('')
    try {
      setBrowse(await api.browseDirectories(path))
    } catch (e) {
      setError((e as ApiError).detail || 'Failed to browse directories')
    }
  }

  if (!open) {
    return (
      <button
        onClick={openBrowser}
        className="text-xs text-gray-400 hover:text-white flex items-center gap-1.5"
        title="Browse folders"
        aria-label="Browse folders"
        type="button"
      >
        <FolderTree size={14} /> Browse
      </button>
    )
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-950 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-gray-400 truncate">{browse?.current_path}</span>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-gray-400 hover:text-white shrink-0"
          aria-label="Close browser"
        >
          Close
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {browse && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {browse.parent_path && (
            <button
              onClick={() => navigate(browse.parent_path!)}
              className="px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700"
              type="button"
            >
              ↑ Up
            </button>
          )}
          <button
            onClick={() => onSelect(browse.current_path)}
            className="px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500"
            type="button"
          >
            Use this folder
          </button>
        </div>
      )}
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {browse?.directories.map(d => (
          <button
            key={d.path}
            onClick={() => navigate(d.path)}
            className="block w-full text-left px-2 py-1 rounded text-xs text-gray-300 hover:bg-gray-800 font-mono"
            type="button"
          >
            📁 {d.name}
          </button>
        ))}
      </div>
    </div>
  )
}

export function WorkspaceMcpPanel() {
  const { showSnackbar } = useStore()

  const [instances, setInstances] = useState<WorkspaceMcpInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [folderPath, setFolderPath] = useState('')
  const [agentic, setAgentic] = useState(true)
  const [spawnBusy, setSpawnBusy] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const browseRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setInstances(await api.listWorkspaceMcps())
    } catch (e) {
      showSnackbar({ type: 'error', message: (e as ApiError).detail || 'Failed to load workspace MCP instances' })
    } finally {
      setLoading(false)
    }
  }, [showSnackbar])

  useEffect(() => {
    load()
  }, [load])

  // Poll while any instance is "starting" so the status badge moves to running
  // as soon as the tunnel handshake completes.
  useEffect(() => {
    if (!instances.some(i => i.status === 'starting')) return
    const timer = setTimeout(load, 3000)
    return () => clearTimeout(timer)
  }, [instances, load])

  const handleSpawn = async () => {
    const target = folderPath.trim()
    if (!target) return
    setSpawnBusy(true)
    try {
      const instance = await api.createWorkspaceMcp(target, agentic)
      showSnackbar({
        type: 'success',
        message: instance.tunnel_url
          ? `Started ${instance.id} — ${instance.tunnel_url}`
          : `Started ${instance.id} (waiting for tunnel)`,
      })
      setFolderPath('')
      // POST returns the generated password once. Keep that row in component
      // state instead of immediately replacing it with credential-free GET data.
      setInstances(prev => [instance, ...prev.filter(item => item.id !== instance.id)])
    } catch (e) {
      showSnackbar({ type: 'error', message: (e as ApiError).detail || 'Failed to spawn workspace MCP' })
    } finally {
      setSpawnBusy(false)
    }
  }

  const handleStop = async (id: string) => {
    if (!window.confirm(`Stop workspace MCP instance '${id}'?`)) return
    setStopBusy(true)
    try {
      await api.deleteWorkspaceMcp(id)
      showSnackbar({ type: 'success', message: `Stopped '${id}'` })
      await load()
    } catch (e) {
      showSnackbar({ type: 'error', message: (e as ApiError).detail || `Failed to stop '${id}'` })
    } finally {
      setStopBusy(false)
    }
  }

  return (
    <div className="space-y-6" ref={browseRef}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <FolderTree size={18} /> Workspace MCP
        </h2>
        <button
          onClick={load}
          className="text-sm text-gray-400 hover:text-white flex items-center gap-1.5"
          title="Reload"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Spawn form */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-200">Spawn a workspace MCP</h3>
        <input
          value={folderPath}
          onChange={e => setFolderPath(e.target.value)}
          placeholder="/home/ubuntu/workspace/my-project"
          aria-label="Folder path"
          className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm text-gray-200 font-mono"
        />
        <DirectoryBrowser onSelect={setFolderPath} />
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={agentic}
            onChange={e => setAgentic(e.target.checked)}
            aria-label="Agentic mode"
          />
          Agentic mode (execute commands, git write, network via sandbox)
        </label>
        <button
          onClick={handleSpawn}
          disabled={spawnBusy || !folderPath.trim()}
          className="px-3 py-2 rounded text-sm bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 flex items-center gap-1.5"
        >
          {spawnBusy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          {spawnBusy ? 'Starting…' : 'Spawn Workspace MCP'}
        </button>
      </div>

      {/* Instances */}
      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : instances.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No workspace MCP instances running. Select a folder above to start an isolated, sandboxed
          MCP server accessible by Claude or remote agents.
        </p>
      ) : (
        <ul className="space-y-2">
          {instances.map(instance => (
            <InstanceRow key={instance.id} instance={instance} onStop={handleStop} busy={stopBusy} />
          ))}
        </ul>
      )}
    </div>
  )
}
