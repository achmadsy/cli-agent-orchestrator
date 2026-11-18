import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputViewer, stripAnsi } from '../components/OutputViewer'
import { HelpHint } from '../components/HelpHint'
import { FlowsHelp, WorkflowsHelp } from '../components/FeatureHelp'
import { api } from '../api'

vi.mock('../api', async importOriginal => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    api: { ...actual.api, getTerminalOutput: vi.fn(), getTerminalScrollback: vi.fn() },
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('stripAnsi', () => {
  it('removes the TUI control sequences seen in raw terminal output', () => {
    const raw =
      '\x1b(B\x1b[?2004h\x1b[<u\x1b[>5u\x1b[>4;2m\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l\r\n' +
      'hi3rdtest\r\n\x1b[?25h\x1b[?25l\r\n\x1b[38;5;174m✻\x1b[39m Crunched for 5s\r\n' +
      '\x1b]0;claude\x07\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b=\x1b>❯ test hi again!'
    expect(stripAnsi(raw)).toBe('\r\nhi3rdtest\r\n\r\n✻ Crunched for 5s\r\nlink❯ test hi again!')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('a [bracket] (paren) 100%\n\ttabbed')).toBe('a [bracket] (paren) 100%\n\ttabbed')
  })
})

describe('OutputViewer', () => {
  beforeEach(() => {
    vi.mocked(api.getTerminalOutput).mockReset()
    vi.mocked(api.getTerminalScrollback).mockReset()
  })

  it('shows the rendered scrollback for Full Output, not the raw stream', async () => {
    vi.mocked(api.getTerminalOutput).mockResolvedValue({ output: 'last answer', mode: 'last' })
    vi.mocked(api.getTerminalScrollback).mockResolvedValue({ screen: 'hi3rdtest\n❯ test hi again!', ansi: false })

    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    expect(await screen.findByText('last answer')).toBeInTheDocument()
    expect(api.getTerminalOutput).toHaveBeenCalledWith('abcd1234', 'last')

    fireEvent.click(screen.getByRole('button', { name: 'Full Output' }))

    await waitFor(() => expect(screen.getByText(/hi3rdtest/)).toBeInTheDocument())
    expect(api.getTerminalScrollback).toHaveBeenCalledWith('abcd1234')
    expect(api.getTerminalOutput).not.toHaveBeenCalledWith('abcd1234', 'full')
  })
})

describe('HelpHint', () => {
  it('opens on hover and closes after the pointer leaves', () => {
    vi.useFakeTimers()
    render(<HelpHint label="What are flows?"><p>help body</p></HelpHint>)
    const trigger = screen.getByRole('button', { name: 'What are flows?' })

    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('help body')

    fireEvent.mouseLeave(trigger)
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('stays open while the pointer moves from the icon onto the panel', () => {
    vi.useFakeTimers()
    render(<HelpHint label="What are flows?"><p>help body</p></HelpHint>)
    const trigger = screen.getByRole('button', { name: 'What are flows?' })

    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(trigger)
    fireEvent.mouseEnter(screen.getByRole('tooltip'))
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
  })

  it('pins open on click and closes on Escape', () => {
    vi.useFakeTimers()
    render(<HelpHint label="What are workflows?"><p>help body</p></HelpHint>)
    const trigger = screen.getByRole('button', { name: 'What are workflows?' })

    fireEvent.click(trigger)
    fireEvent.mouseLeave(trigger)
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes when clicking outside a pinned panel', () => {
    render(<div><HelpHint label="What are flows?"><p>help body</p></HelpHint><span>outside</span></div>)
    fireEvent.click(screen.getByRole('button', { name: 'What are flows?' }))
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByText('outside'))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('feature help content', () => {
  it('explains flows with a schedule example', () => {
    render(<FlowsHelp />)
    expect(screen.getByText('What is a flow?')).toBeInTheDocument()
    expect(screen.getByText(/cao schedule add/)).toBeInTheDocument()
  })

  it('explains workflows with a step example and the n8n comparison', () => {
    render(<WorkflowsHelp />)
    expect(screen.getByText('What is a workflow?')).toBeInTheDocument()
    expect(screen.getByText(/run_step\("claude_code", "researcher"/)).toBeInTheDocument()
    expect(screen.getByText('Compared with n8n')).toBeInTheDocument()
  })
})
