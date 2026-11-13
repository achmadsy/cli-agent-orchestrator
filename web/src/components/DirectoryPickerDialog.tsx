import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ChevronRight, Folder, Home, Loader2, Search, X } from 'lucide-react'
import { api, type ApiError, type BrowseDirectoriesResponse } from '../api'

type Props = {
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
  sourceKey?: string
}

const control = 'min-h-11 rounded-lg border border-gray-700 px-3 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#87B6FA]'

/** Browses only the serving CAO node. No file contents or browser-local picker. */
export function DirectoryPickerDialog({ initialPath = '', onSelect, onClose,
  sourceKey = `${location.host}${import.meta.env.BASE_URL}` }: Props) {
  const titleId = useId()
  const sourceId = useId()
  const root = useRef<HTMLDivElement>(null)
  const pathInput = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const callbacks = useRef({ onClose, onSelect })
  callbacks.current = { onClose, onSelect }
  const [browse, setBrowse] = useState<BrowseDirectoriesResponse | null>(null)
  const [path, setPath] = useState(initialPath)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const retry = useRef<() => void>(() => {})
  const activePath = useRef<string | undefined>(initialPath.trim() || undefined)

  async function navigate(destination?: string, query = '', offset = 0, fallback = false) {
    const request = ++generation.current
    activePath.current = destination
    setLoading(true)
    setError('')
    if (!offset) setBrowse(null)
    retry.current = () => { void navigate(destination, query, offset, fallback) }
    try {
      let result: BrowseDirectoriesResponse
      try {
        result = await api.browseDirectories(destination, { query, offset })
      } catch (e) {
        if (!fallback || !destination || request !== generation.current) throw e
        result = await api.browseDirectories()
        if (request === generation.current) setNotice('The entered folder could not be opened. Showing home; your form is unchanged.')
      }
      if (request !== generation.current) return
      setBrowse(previous => offset && previous?.current_path === result.current_path
        ? { ...result, directories: [...previous.directories, ...result.directories] } : result)
      activePath.current = result.current_path
      setPath(result.current_path)
    } catch (e) {
      if (request !== generation.current) return
      setError((e as ApiError).detail || 'Could not open this folder. Check the path or connection, then retry.')
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }

  function open(destination?: string) {
    setFilter('')
    setNotice('')
    void navigate(destination)
  }

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const container = root.current!
    const siblings = Array.from(document.body.children).filter(el => el !== container) as HTMLElement[]
    const oldInert = siblings.map(el => el.hasAttribute('inert'))
    siblings.forEach(el => el.setAttribute('inert', ''))
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    pathInput.current?.focus()
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        callbacks.current.onClose()
      } else if (event.key === 'Tab') {
        const focusable = Array.from(container.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (!first) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    function focusin(event: FocusEvent) {
      if (!container.contains(event.target as Node)) pathInput.current?.focus()
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('focusin', focusin)
    return () => {
      ++generation.current
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('focusin', focusin)
      siblings.forEach((el, i) => { if (!oldInert[i]) el.removeAttribute('inert') })
      document.body.style.overflow = oldOverflow
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    setFilter('')
    setNotice('')
    void navigate(initialPath.trim() || undefined, '', 0, true)
    return () => { ++generation.current }
    // A changed node/source must invalidate every pending response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])

  function changeFilter(value: string) {
    setFilter(value)
    // Each query remains single-directory; the backend filters across all pages.
    void navigate(activePath.current, value)
  }

  return createPortal(
    <div ref={root} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-2 sm:p-6"
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={sourceId}
        className="flex h-[calc(100dvh-1rem)] max-h-[760px] w-full min-w-0 max-w-[700px] flex-col overflow-hidden rounded-xl border border-gray-700 bg-[#111827] text-gray-200 shadow-2xl sm:h-[min(680px,90dvh)]">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-700 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">Choose working folder</h2>
            <p id={sourceId} className="mt-1 break-all text-xs text-gray-400">Folders on {browse?.source_node || sourceKey}. Not your browser device.</p>
          </div>
          <button type="button" aria-label="Close folder chooser" className={`${control} shrink-0 border-transparent px-2`} onClick={() => callbacks.current.onClose()}><X size={18} /></button>
        </header>
        <div className="shrink-0 space-y-3 border-b border-gray-700 p-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" aria-label="Up one folder" title="Up one folder" className={`${control} px-3`} disabled={!browse?.parent_path || loading} onClick={() => open(browse?.parent_path || undefined)}><ArrowUp size={17} /></button>
            <button type="button" aria-label="Home folder" title="Home folder" className={`${control} px-3`} onClick={() => open(browse?.home_path || undefined)}><Home size={17} /></button>
            <nav aria-label="Folder breadcrumbs" className="flex min-w-0 flex-1 items-center overflow-x-auto text-sm">
              {(browse?.ancestors || []).map((item, index, all) => <span key={item.path} className="flex shrink-0 items-center">
                {index > 0 && <ChevronRight size={14} className="text-gray-600" />}
                <button type="button" title={item.path} aria-current={index === all.length - 1 ? 'location' : undefined} disabled={loading}
                  onClick={() => open(item.path)} className="min-h-11 max-w-40 truncate rounded px-2 text-gray-400 hover:bg-gray-800 aria-[current=location]:text-gray-100">{item.name}</button>
              </span>)}
            </nav>
          </div>
          <form className="flex min-w-0 gap-2" onSubmit={event => { event.preventDefault(); open(path.trim() || undefined) }}>
            <input ref={pathInput} aria-label="Folder path" value={path} onChange={event => setPath(event.target.value)} spellCheck={false} autoComplete="off"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-700 bg-[#0B1220] px-3 font-mono text-sm text-gray-200 focus:border-[#87B6FA] focus:outline-none" />
            <button type="submit" className={control}>Go</button>
          </form>
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input aria-label="Filter folders" placeholder="Filter folders…" value={filter} onChange={event => changeFilter(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }}
              className="min-h-11 w-full rounded-lg border border-gray-700 bg-[#0B1220] pl-9 pr-3 text-sm focus:border-[#87B6FA] focus:outline-none" />
          </div>
        </div>
        {notice && <p role="status" className="shrink-0 border-b border-gray-700 px-5 py-2 text-xs text-amber-200">{notice}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#0B1220] p-2" aria-busy={loading}>
          {error ? <div role="alert" className="space-y-4 p-4 text-sm text-red-200"><p>{error}</p><button type="button" className={control} onClick={() => retry.current()}>Retry</button></div>
            : loading && !browse ? <div role="status" className="flex items-center gap-2 p-4 text-sm text-gray-400"><Loader2 size={16} className="animate-spin motion-reduce:animate-none" />Opening folder…</div>
              : browse && <>
                <ul aria-label="Folders" onKeyDown={event => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
                  const index = rows.indexOf(document.activeElement as HTMLButtonElement)
                  event.preventDefault()
                  rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
                }}>
                  {browse.directories.map(item => <li key={`${item.name}:${item.path}`}>
                    <button type="button" disabled={loading} title={item.path} onClick={() => open(item.path)}
                      className="group flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-[#181E28] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#87B6FA] disabled:opacity-40">
                      <Folder size={19} className="shrink-0 text-[#87B6FA]" /><span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{item.name}</span><ChevronRight size={16} className="shrink-0 text-gray-600 group-hover:text-gray-300" />
                    </button>
                  </li>)}
                </ul>
                {browse.directories.length === 0 && <p role="status" className="p-4 text-sm text-gray-500">{filter ? 'No folders match this filter.' : 'No visible subfolders. You can choose this folder.'}</p>}
                {browse.next_offset != null && <button type="button" className={`${control} m-2`} disabled={loading} onClick={() => void navigate(browse.current_path, filter, browse.next_offset!)}>{loading ? 'Loading…' : 'Load more folders'}</button>}
              </>}
        </div>
        <footer className="shrink-0 border-t border-gray-700 bg-[#111827] px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-5">
          <p className="mb-3 text-xs text-gray-400">Current folder<span className="mt-1 block max-h-14 overflow-auto break-all font-mono text-gray-200">{!loading && !error ? browse?.current_path || '—' : 'Choose a valid folder to continue'}</span></p>
          <div className="flex justify-end gap-2">
            <button type="button" className={control} onClick={() => callbacks.current.onClose()}>Cancel</button>
            <button type="button" disabled={loading || !!error || !browse || path.trim() !== browse.current_path}
              className="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => { if (browse && !loading && !error && path.trim() === browse.current_path) { callbacks.current.onSelect(browse.current_path); callbacks.current.onClose() } }}>Use this folder</button>
          </div>
        </footer>
      </section>
    </div>, document.body,
  )
}
