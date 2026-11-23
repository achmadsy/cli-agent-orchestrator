import { useEffect, useRef, useState } from 'react'
import { api, ApiError, NativeQuestion } from '../api'

export function NativeQuestionCard({ terminalId }: { terminalId: string }) {
  const [question, setQuestion] = useState<NativeQuestion | null>(null)
  const [loading, setLoading] = useState(true)
  const [choice, setChoice] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sending, setSending] = useState(false)
  const busy = useRef(false)
  const held = useRef(false)
  const epoch = useRef(0)
  const revision = useRef<string | null>(null)
  const refresh = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    let active = true
    let fetching = false
    epoch.current += 1
    held.current = false
    revision.current = null
    setQuestion(null)
    setChoice('')
    setText('')
    setError('')
    setNotice('')
    setLoading(true)
    const load = async () => {
      if (fetching || busy.current || held.current) return
      fetching = true
      const generation = epoch.current
      try {
        const result = await api.getNativeQuestion(terminalId)
        if (!active || busy.current || held.current || generation !== epoch.current) return
        const next = result.question?.revision ?? null
        if (next !== revision.current) {
          setChoice('')
          setText('')
          revision.current = next
        }
        setQuestion(result.question)
        setError('')
      } catch {
        if (active && !held.current && generation === epoch.current) {
          revision.current = null
          setQuestion(null)
          setChoice('')
          setError('Could not refresh the question. Use Open Terminal to check the prompt.')
        }
      } finally {
        fetching = false
        if (active) setLoading(false)
      }
    }
    refresh.current = load
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [terminalId])

  async function send() {
    if (busy.current || !question || !choice || (choice === 'text' && !text.trim())) return
    const current = question
    busy.current = true
    held.current = true
    epoch.current += 1
    setSending(true)
    setError('')
    setNotice('')
    try {
      await api.answerNativeQuestion(terminalId, {
        revision: current.revision,
        ...(choice === 'text' ? { text } : { option: Number(choice) }),
      })
      setNotice('Answer sent to the terminal.')
    } catch (err) {
      const failure = err as ApiError
      setError(failure.detail ?? 'Answer could not be confirmed. Check Open Terminal before retrying.')
    } finally {
      // Never automatically retry a write, including an uncertain timeout.
      revision.current = null
      setQuestion(null)
      setChoice('')
      setText('')
      busy.current = false
      setSending(false)
    }
  }

  return (
    <section aria-label="Agent question" className="mt-3 border-l-2 border-amber-400 bg-gray-900/60 rounded-r-lg p-3 sm:p-4">
      <div className="text-sm font-medium text-amber-300">Answer needed</div>
      {notice && <p role="status" className="mt-2 text-sm text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
      {loading ? <p role="status" className="mt-2 text-sm text-gray-400">Reading the active question…</p> : question ? (
        <form onSubmit={e => { e.preventDefault(); void send() }}>
          <fieldset disabled={sending} className="mt-2 min-w-0">
            <legend className="text-sm text-gray-100 whitespace-pre-wrap break-words max-w-prose">{question.text}</legend>
            <div className="mt-3 space-y-2">
              {question.options.map(option => (
                <label key={option.number} className={`flex items-start gap-3 p-2.5 rounded-md border cursor-pointer ${choice === String(option.number) ? 'border-emerald-500 bg-emerald-950/30' : 'border-gray-700 hover:border-gray-500'}`}>
                  <input type="radio" name={`question-${terminalId}`} value={option.number} checked={choice === String(option.number)} onChange={e => setChoice(e.target.value)} className="mt-1 accent-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400" />
                  <span className="min-w-0 break-words"><span className="block text-sm text-gray-100">{option.label}</span>{option.description && <span className="block mt-1 text-xs text-gray-400 whitespace-pre-wrap">{option.description}</span>}</span>
                </label>
              ))}
              {question.allows_text && <div className={`p-2.5 rounded-md border ${choice === 'text' ? 'border-emerald-500' : 'border-gray-700'}`}>
                <label className="flex items-center gap-3 text-sm text-gray-100 cursor-pointer"><input type="radio" name={`question-${terminalId}`} value="text" checked={choice === 'text'} onChange={() => setChoice('text')} className="accent-emerald-500" />Write an answer</label>
                {choice === 'text' && <input aria-label="Your answer" value={text} onChange={e => setText(e.target.value)} maxLength={2000} className="mt-2 w-full bg-gray-800 border border-gray-600 rounded-md px-3 py-2 text-sm text-gray-100 focus:border-emerald-400 focus:outline-none" />}
              </div>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="submit" disabled={!choice || (choice === 'text' && !text.trim())} className="px-3 py-2 rounded-md bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400">{sending ? 'Sending…' : 'Send answer'}</button>
              <span className="text-xs text-gray-500">Only the current question can be answered.</span>
            </div>
          </fieldset>
        </form>
      ) : <p className="mt-2 text-sm text-gray-400">{notice ? 'Waiting for the agent to continue.' : 'Open Terminal to answer this prompt. This dialog cannot be answered here safely.'}</p>}
      {!question && !loading && <button type="button" disabled={sending} onClick={() => { held.current = false; setNotice(''); void refresh.current() }} className="mt-2 text-xs text-gray-300 underline underline-offset-2 focus-visible:outline focus-visible:outline-emerald-400">Refresh question</button>}
    </section>
  )
}
