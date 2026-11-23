import { useState, useEffect, useRef, useMemo } from 'react'
import { OutputContent } from './OutputContent'
import { api } from '../api'
import { X, RefreshCw, Copy, Check, FileText, Loader2 } from 'lucide-react'

// Removes terminal control sequences: CSI (including private modes such as
// `?2004h` and kitty keyboard `>5u` / `<u`), OSC titles and hyperlinks,
// charset selection (`(B`) and other single-character escapes.
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78DEHMc]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

interface OutputViewerProps {
  terminalId: string
  onClose: () => void
}

export function OutputViewer({ terminalId, onClose }: OutputViewerProps) {
  const [mode, setMode] = useState<'last' | 'full'>('last')
  const [output, setOutput] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(false)
  const [presentation, setPresentation] = useState<'readable' | 'raw'>('readable')
  const outputRef = useRef<HTMLDivElement>(null)
  const requestGeneration = useRef(0)

  const fetchOutput = async (m: 'last' | 'full') => {
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(false)
    setNotice('')
    try {
      const data = await api.getTerminalDisplayOutput(terminalId, m)
      if (generation !== requestGeneration.current) return
      setOutput(data.output || '')
      setNotice(data.source === 'scrollback'
        ? `Rendered scrollback only — this provider may not retain the complete conversation.${data.limited_reason === 'replay_budget' ? ' Recording replay exceeded the time limit; showing available scrollback instead.' : ''}`
        : data.source === 'recording'
          ? `Recorded terminal history — earlier screens are included when retained. Redraws, historical resizes, and text never emitted by the CLI may be incomplete.${data.truncated ? ' Earlier content was truncated.' : ''}${data.limited_reason === 'replay_budget' ? ' Replay time limit reached; showing a smaller recent recording tail.' : ''}`
          : data.source === 'rendered_response'
            ? 'Rendered terminal response — original text is unavailable for this provider.'
            : data.truncated ? 'Showing the available transcript tail; earlier content was truncated.' : '')
    } catch {
      if (generation !== requestGeneration.current) return
      setOutput('')
      setError(true)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    fetchOutput(mode)
    return () => { requestGeneration.current++ }
  }, [mode, terminalId])

  // Full history opens at the newest turn; Last Response opens at its start.
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = mode === 'full' ? outputRef.current.scrollHeight : 0
      outputRef.current.scrollLeft = 0
    }
  }, [output, mode, presentation, loading])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleCopy = async () => {
    const clean = stripAnsi(output)
    try {
      await navigator.clipboard.writeText(clean)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard API may not be available
    }
  }

  const handleRefresh = () => {
    fetchOutput(mode)
  }

  const cleanOutput = useMemo(() => stripAnsi(output), [output])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div role="dialog" aria-modal="true" aria-label="Terminal Output" className="relative bg-gray-900 border border-gray-700/50 rounded-2xl shadow-2xl w-full max-w-[1200px] mx-2 sm:mx-4 overflow-hidden flex flex-col" style={{ maxHeight: '90dvh' }}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-4 border-b border-gray-700/30 shrink-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
            <FileText size={16} className="text-emerald-400 shrink-0" />
            <span className="text-sm font-semibold text-white">Terminal Output</span>
            <span className="text-xs text-gray-400 font-mono bg-gray-800 px-2 py-0.5 rounded">{terminalId}</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Copy button */}
            <button
              onClick={handleCopy}
              disabled={!cleanOutput}
              className="p-1.5 text-gray-400 hover:text-white disabled:opacity-30 transition-colors rounded"
              title="Copy to clipboard"
            >
              {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
            </button>
            {copied && <span className="text-xs text-emerald-400">Copied!</span>}
            {/* Refresh button */}
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="p-1.5 text-gray-400 hover:text-white disabled:opacity-30 transition-colors rounded"
              title="Refresh output"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            {/* Close button */}
            <button
              onClick={onClose}
              className="p-1.5 text-gray-500 hover:text-white transition-colors rounded"
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tab Toggle */}
        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3 border-b border-gray-700/30 shrink-0">
          <button
            onClick={() => setMode('last')}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              mode === 'last'
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            }`}
          >
            Last Response
          </button>
          <button
            onClick={() => setMode('full')}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              mode === 'full'
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            }`}
          >
            Full Output
          </button>
          <div role="group" aria-label="Output format" className="flex items-center gap-1 sm:ml-auto rounded-lg bg-gray-950 p-1">
            {(['readable', 'raw'] as const).map(format => (
              <button
                key={format}
                aria-pressed={presentation === format}
                onClick={() => setPresentation(format)}
                className={`rounded px-3 py-1 text-xs transition-colors ${presentation === format ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
              >
                {format === 'readable' ? 'Readable' : 'Raw text'}
              </button>
            ))}
          </div>
        </div>

        {notice && <p role="status" className="px-6 pt-3 text-xs text-amber-300">{notice}</p>}
        {/* Presentation changes never resize the live terminal. */}
        <div className="flex-1 min-w-0 overflow-hidden px-2 sm:px-4 py-3" style={{ minHeight: 0 }}>
          {loading ? (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <Loader2 size={24} className="animate-spin text-gray-500" />
            </div>
          ) : cleanOutput ? (
            <div
              ref={outputRef}
              aria-label="Terminal output text"
              role="region"
              tabIndex={0}
              className="bg-gray-950 rounded-lg p-4 sm:p-6 text-sm text-gray-300 overflow-auto"
              style={{ maxHeight: 'calc(90dvh - 230px)' }}
            >
              {presentation === 'raw'
                ? <pre className="font-mono whitespace-pre">{cleanOutput}</pre>
                : <OutputContent text={cleanOutput} boldRoleLabels={mode === 'full'} />}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <p role={error ? 'alert' : undefined} className="text-gray-500 text-sm">
                {error ? 'Could not load output. Try refreshing.' : 'No output available'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
