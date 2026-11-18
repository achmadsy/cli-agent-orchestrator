import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp } from 'lucide-react'

const PANEL_WIDTH = 448
const GAP = 6
const EDGE = 8
const CLOSE_DELAY_MS = 150

interface HelpHintProps {
  /** Accessible name for the trigger, e.g. "What are flows?". */
  label: string
  children: ReactNode
}

interface PanelPosition {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

/**
 * A "?" icon that shows help content on hover or keyboard focus. Clicking or
 * tapping pins it open (touch screens have no hover); clicking again, clicking
 * elsewhere or pressing Escape closes it. The panel is portaled with fixed
 * positioning, like CustomSelect's menu, so a scroll container can't clip it.
 */
export function HelpHint({ label, children }: HelpHintProps) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<PanelPosition>({ left: 0, width: PANEL_WIDTH, top: 0, maxHeight: 400 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const hovered = useRef(false)
  const id = useId()

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const show = () => {
    cancelClose()
    setOpen(true)
  }
  // A short delay lets the pointer cross the gap from the icon to the panel.
  const hideSoon = () => {
    if (pinned) return
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }
  const close = () => {
    cancelClose()
    setPinned(false)
    setOpen(false)
  }

  useEffect(() => cancelClose, [])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const width = Math.min(PANEL_WIDTH, window.innerWidth - EDGE * 2)
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE))
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE
    const spaceAbove = rect.top - GAP - EDGE
    setPos(spaceBelow >= 240 || spaceBelow >= spaceAbove
      ? { left, width, top: rect.bottom + GAP, maxHeight: Math.max(spaceBelow, 120) }
      : { left, width, bottom: window.innerHeight - rect.top + GAP, maxHeight: spaceAbove })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return
      close()
    }
    // A fixed panel doesn't follow its icon when the page scrolls, so close
    // instead. Scrolling inside the panel itself is fine. The instanceof guard
    // matters for resize events, whose target is window and not a Node.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const enter = () => {
    hovered.current = true
    show()
  }
  const leave = () => {
    hovered.current = false
    hideSoon()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={() => { if (!hovered.current) hideSoon() }}
        onClick={() => {
          if (pinned) {
            close()
          } else {
            setPinned(true)
            show()
          }
        }}
        className={`inline-flex items-center justify-center rounded-full p-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
          open ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300'
        }`}
      >
        <CircleHelp size={14} />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          id={id}
          role="tooltip"
          onMouseEnter={enter}
          onMouseLeave={leave}
          style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
          className="z-[80] overflow-y-auto rounded-xl border border-gray-700 bg-gray-900 p-4 text-left text-xs normal-case leading-relaxed tracking-normal text-gray-300 shadow-2xl shadow-black/50"
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  )
}
