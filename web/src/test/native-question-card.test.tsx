import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, NativeQuestion } from '../api'
import { NativeQuestionCard } from '../components/NativeQuestionCard'

vi.mock('../api', () => ({ api: { getNativeQuestion: vi.fn(), answerNativeQuestion: vi.fn() } }))
const question: NativeQuestion = {
  revision: 'a'.repeat(64), header: 'File APK', text: 'APK mana yang ingin diperiksa?',
  options: [{ number: 1, label: 'Google Activator', description: 'Google-Activator-v1.1-release.apk' }, { number: 2, label: 'Magisk', description: 'Specify a version.' }], allows_text: true,
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getNativeQuestion).mockResolvedValue({ question, fallback: null })
  vi.mocked(api.answerNativeQuestion).mockResolvedValue({ success: true, message: 'Answer sent.' })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('NativeQuestionCard', () => {
  it('shows the question and descriptions with no default choice or automatic answer', async () => {
    render(<NativeQuestionCard terminalId="e5f6a0a6" />)
    await screen.findByText(question.text)
    expect(screen.getByText(question.options[0].description)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
    expect(screen.getAllByRole('radio').every(r => !(r as HTMLInputElement).checked)).toBe(true)
    expect(api.answerNativeQuestion).not.toHaveBeenCalled()
  })
  it('sends only the explicit option with its revision and prevents duplicate submits', async () => {
    let finish!: () => void
    vi.mocked(api.answerNativeQuestion).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ success: true, message: 'Sent' }) }))
    render(<NativeQuestionCard terminalId="e5f6a0a6" />)
    fireEvent.click(await screen.findByRole('radio', { name: /Magisk/ }))
    const button = screen.getByRole('button', { name: 'Send answer' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(api.answerNativeQuestion).toHaveBeenCalledTimes(1)
    expect(api.answerNativeQuestion).toHaveBeenCalledWith('e5f6a0a6', { revision: question.revision, option: 2 })
    await act(async () => { finish() })
    expect(await screen.findByText('Answer sent to the terminal.')).toBeInTheDocument()
  })
  it('sends custom text only after selection and explicit submit', async () => {
    render(<NativeQuestionCard terminalId="e5f6a0a6" />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Write an answer' }))
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Magisk v29.0' } })
    expect(api.answerNativeQuestion).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() => expect(api.answerNativeQuestion).toHaveBeenCalledWith('e5f6a0a6', { revision: question.revision, text: 'Magisk v29.0' }))
  })
  it('clears selection when a newer question arrives', async () => {
    vi.useFakeTimers()
    render(<NativeQuestionCard terminalId="e5f6a0a6" />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('radio', { name: /Magisk/ }))
    vi.mocked(api.getNativeQuestion).mockResolvedValue({ question: { ...question, revision: 'b'.repeat(64), text: 'New question?' }, fallback: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByText('New question?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
  })
  it('shows conflicts and never retries an answer automatically', async () => {
    vi.mocked(api.answerNativeQuestion).mockRejectedValue(Object.assign(new Error('409'), { detail: 'The question changed. Refresh before answering.' }))
    render(<NativeQuestionCard terminalId="e5f6a0a6" />)
    fireEvent.click(await screen.findByRole('radio', { name: /Magisk/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The question changed.')
    expect(api.answerNativeQuestion).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument()
  })
  it('provides terminal fallback for unsupported dialogs and read errors', async () => {
    vi.mocked(api.getNativeQuestion).mockResolvedValue({ question: null, fallback: 'Open Terminal' })
    render(<NativeQuestionCard terminalId="e5f6a0a6" />)
    expect(await screen.findByText(/This dialog cannot be answered here safely/)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })
})
