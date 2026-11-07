import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, RefreshCw, TerminalSquare } from 'lucide-react'
import { api } from '../api'
import { LegacyTerminalView } from './LegacyTerminalView'
import type { TerminalViewProps } from './TerminalView'
import '../workspace.generated.css'
import './terminal-workspace.css'

export function TerminalWorkspace({ terminalId, provider, agentProfile, onClose }: TerminalViewProps) {
  const [viewer, setViewer] = useState<{ url: string; viewer_id: string } | null>(null)
  const [classic, setClassic] = useState(false)
  const [failure, setFailure] = useState('')
  const [expired, setExpired] = useState(false)
  const [ready, setReady] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (classic) return
    let cancelled = false
    let viewerId: string | undefined
    setViewer(null)
    setExpired(false)
    setReady(false)
    setLoadFailed(false)
    api.launchTerminalWorkspace(terminalId).then(result => {
      viewerId = result.viewer_id
      if (cancelled) { void api.revokeTerminalWorkspace(viewerId).catch(() => {}); return }
      setViewer(result)
    }).catch(error => {
      if (cancelled) return
      setFailure(error.detail || 'Terminal workspace is unavailable. Using the classic terminal.')
      setClassic(true)
    })
    return () => {
      cancelled = true
      if (viewerId) void api.revokeTerminalWorkspace(viewerId).catch(() => {})
    }
  }, [terminalId, classic, attempt])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return
      if (event.data?.type === 'cao:terminal-expired') setExpired(true)
      if (event.data?.type === 'cao:terminal-ready') setReady(true)
      if (event.data?.type === 'cao:terminal-load-failed') setLoadFailed(true)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  useEffect(() => {
    if (!viewer || classic || ready || expired || loadFailed) return
    // Also covers a stalled document request or a bootstrap that never executes.
    const timer = window.setTimeout(() => setLoadFailed(true), 30000)
    return () => window.clearTimeout(timer)
  }, [viewer, classic, ready, expired, loadFailed])

  if (classic) return createPortal(<>
    <LegacyTerminalView terminalId={terminalId} provider={provider} agentProfile={agentProfile} onClose={onClose} />
    {failure && <div className="terminal-fallback-note" role="status">
      <span>{failure}</span><button onClick={() => setFailure('')} aria-label="Dismiss fallback notice">Dismiss</button>
    </div>}
  </>, document.body)

  // Escape dashboard layout/stacking rules; this dialog owns the viewport.
  return createPortal(<section className="terminal-workspace" role="dialog" aria-modal="true" aria-label="Agent terminal workspace">
    <header className="terminal-workspace-header">
      <button ref={closeButton} onClick={onClose} className="workspace-back" aria-label="Back to CAO; agent keeps running">
        <ArrowLeft size={18} /><span>CAO</span>
      </button>
      <div className="workspace-identity">
        <strong>{agentProfile || 'Agent terminal'}</strong>
        <span>{provider || 'tmux'} <span aria-hidden="true">·</span> {terminalId}</span>
      </div>
      <button onClick={() => setClassic(true)} className="workspace-classic" aria-label="Classic terminal" title="Use classic terminal for raw TUI access">
        <TerminalSquare size={17} /><span>Classic terminal</span>
      </button>
    </header>
    {expired ? <div className="workspace-state" role="status">
      <h2>Viewer expired</h2>
      <p>Your agent is still running. Reconnect to authorize a new viewer.</p>
      <button onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />Reconnect</button>
    </div> : loadFailed ? <div className="workspace-state" role="status">
      <h2>Terminal could not finish loading</h2>
      <p>Your agent is still running. Retry loading the viewer or use Classic terminal. No input will be resent.</p>
      <button onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />Try again</button>
    </div> : viewer ? <>
      {!ready && <div className="workspace-state" role="status"><p>Loading terminal controls…</p></div>}
      <iframe ref={frame} src={viewer.url} title="CAO tmux terminal" className="workspace-frame" hidden={!ready} />
    </> : <div className="workspace-state" role="status"><p>Opening terminal workspace…</p><small>Your agent keeps running when you close this view.</small></div>}
  </section>, document.body)
}
