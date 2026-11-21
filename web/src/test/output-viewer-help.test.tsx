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
    api: { ...actual.api, getTerminalDisplayOutput: vi.fn(), getTerminalOutput: vi.fn(), getTerminalScrollback: vi.fn() },
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
    vi.mocked(api.getTerminalDisplayOutput).mockReset()
    vi.mocked(api.getTerminalOutput).mockReset()
    vi.mocked(api.getTerminalScrollback).mockReset()
  })

  it('loads the original full conversation instead of the latest viewport or raw stream', async () => {
    vi.mocked(api.getTerminalDisplayOutput).mockImplementation(async (_id, mode) => ({
      output: mode === 'last' ? 'last answer' : 'User: first question\nAssistant: first answer\nUser: second question\nAssistant: last answer',
      mode, source: 'transcript', truncated: false,
    }))
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    expect(await screen.findByText('last answer')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Full Output' }))
    expect(await screen.findByText(/first question/)).toHaveTextContent('last answer')
    expect(api.getTerminalDisplayOutput).toHaveBeenCalledWith('abcd1234', 'full')
    expect(api.getTerminalScrollback).not.toHaveBeenCalled()
    expect(api.getTerminalOutput).not.toHaveBeenCalled()
  })

  it('preserves wide table columns in both modes without resizing the terminal', async () => {
    const table = '| Source | ' + 'Wide column '.repeat(40) + '|\n| BMKG | Free |'
    vi.mocked(api.getTerminalDisplayOutput).mockResolvedValue({
      output: table, mode: 'last', source: 'transcript', truncated: false,
    })
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    await screen.findByLabelText('Terminal output text')
    for (const mode of ['Last Response', 'Full Output']) {
      fireEvent.click(screen.getByRole('button', { name: mode }))
      await waitFor(() => expect(screen.getByLabelText('Terminal output text').textContent).toBe(table))
      const output = screen.getByLabelText('Terminal output text')
      expect(output).toHaveClass('overflow-auto')
      expect(output.querySelector('pre')).toHaveClass('output-terminal-table')
      fireEvent.click(screen.getByRole('button', { name: 'Raw text' }))
      expect(output.querySelector('pre')).toHaveClass('whitespace-pre')
      expect(output.textContent).toBe(table)
      fireEvent.click(screen.getByRole('button', { name: 'Readable' }))
    }
  })

  it('renders Markdown headings, emphasis and tables in both history modes while keeping raw copy', async () => {
    const markdown = '### Pager 3\n\n**Heavy rain** near the coast.\n\n| Source | Coverage |\n| --- | --- |\n| BMKG | Indonesia |\n\n```text\n**literal**\n  column A    column B\n```'
    vi.mocked(api.getTerminalDisplayOutput).mockResolvedValue({
      output: markdown, mode: 'last', source: 'transcript', truncated: false,
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    for (const mode of ['Last Response', 'Full Output']) {
      fireEvent.click(screen.getByRole('button', { name: mode }))
      expect(await screen.findByRole('heading', { level: 3, name: 'Pager 3' })).toBeInTheDocument()
      expect(screen.getByText('Heavy rain').tagName).toBe('STRONG')
      expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument()
      expect(screen.getByRole('cell', { name: 'Indonesia' })).toBeInTheDocument()
      const code = screen.getByText(/\*\*literal\*\*/)
      expect(code.tagName).toBe('CODE')
      expect(code.textContent).toContain('  column A    column B')
      fireEvent.click(screen.getByRole('button', { name: 'Raw text' }))
      expect(screen.getByLabelText('Terminal output text').textContent).toBe(markdown)
      expect(screen.queryByRole('heading', { name: 'Pager 3' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Readable' }))
    }
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    expect(writeText).toHaveBeenCalledWith(markdown)
  })

  it('keeps unformatted terminal spacing and box tables literal in readable mode', async () => {
    const output = 'PID     CPU     COMMAND\n123     0.1     worker\n\n┌────────┬────────┐\n│ **A**  │ ### B  │\n└────────┴────────┘'
    vi.mocked(api.getTerminalDisplayOutput).mockResolvedValue({
      output, mode: 'last', source: 'recording', truncated: false,
    })
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    const content = await screen.findByLabelText('Terminal output text')
    expect(content.querySelector('.output-plain')?.textContent).toContain('PID     CPU     COMMAND\n123     0.1     worker')
    expect(screen.getByLabelText('Terminal table').textContent).toContain('│ **A**  │ ### B  │')
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Raw text' }))
    expect(content.textContent).toBe(output)
  })

  it('does not execute HTML, activate unsafe links or fetch embedded images', async () => {
    vi.mocked(api.getTerminalDisplayOutput).mockResolvedValue({
      output: '### Safe\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![remote](https://example.invalid/tracker.png)\n\n[docs](https://example.com/docs)',
      mode: 'last', source: 'transcript', truncated: false,
    })
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    const output = await screen.findByLabelText('Terminal output text')
    expect(output.querySelector('script')).toBeNull()
    expect(output.querySelector('img')).toBeNull()
    expect(screen.queryByRole('link', { name: 'unsafe' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('labels incomplete scrollback rather than claiming it is full history', async () => {
    vi.mocked(api.getTerminalDisplayOutput).mockResolvedValue({
      output: 'current viewport', mode: 'full', source: 'scrollback', truncated: true,
    })
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    expect(await screen.findByRole('status')).toHaveTextContent('Rendered scrollback only')
  })

  it('labels recording and historical-resize limits explicitly', async () => {
    vi.mocked(api.getTerminalDisplayOutput).mockResolvedValue({
      output: 'earlier answer\nlatest answer', mode: 'full', source: 'recording', truncated: true,
    })
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    expect(await screen.findByRole('status')).toHaveTextContent('Recorded terminal history')
    expect(screen.getByRole('status')).toHaveTextContent('historical resizes')
    expect(screen.getByRole('status')).toHaveTextContent('Earlier content was truncated')
  })

  it.each(['recording', 'scrollback'] as const)('explains replay limits for %s instead of silently losing history', async source => {
    vi.mocked(api.getTerminalDisplayOutput).mockResolvedValue({
      output: 'latest answer', mode: 'full', source, truncated: true, limited_reason: 'replay_budget',
    })
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent(source === 'recording'
      ? 'Replay time limit reached; showing a smaller recent recording tail.'
      : 'Recording replay exceeded the time limit; showing available scrollback instead.')
  })

  it('does not let a slow Last Response overwrite Full Output', async () => {
    let resolveLast!: (value: Awaited<ReturnType<typeof api.getTerminalDisplayOutput>>) => void
    vi.mocked(api.getTerminalDisplayOutput).mockImplementation((_id, mode) => mode === 'last'
      ? new Promise(resolve => { resolveLast = resolve })
      : Promise.resolve({ output: 'full conversation', mode, source: 'transcript', truncated: false }))
    render(<OutputViewer terminalId="abcd1234" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Full Output' }))
    expect(await screen.findByText('full conversation')).toBeInTheDocument()
    await act(async () => { resolveLast({ output: 'stale response', mode: 'last', source: 'transcript', truncated: false }) })
    expect(screen.getByText('full conversation')).toBeInTheDocument()
    expect(screen.queryByText('stale response')).not.toBeInTheDocument()
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
