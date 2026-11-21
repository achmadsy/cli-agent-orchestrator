import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OutputContent, outputSections } from '../components/OutputContent'

afterEach(cleanup)

describe('OutputContent', () => {
  it.each([
    '| Name | Value |\n| --- | --- |\n| **Radar** | 42 |',
    'Name | Value\n--- | ---\n**Radar** | 42',
    '| Name | Value |\n| :--- | ---: |\n| **Radar** | 42 |',
  ])('renders valid GFM tables rather than fixed terminal columns: %s', text => {
    render(<OutputContent text={text} />)
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Radar' }).querySelector('strong')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'Output table' })).toHaveAttribute('tabindex', '0')
  })

  it.each(['```', '~~~~'])('keeps table and heading syntax inside %s fences literal', fence => {
    const code = '### not a heading\n| A | B |\n| --- | --- |\n| **literal** | 1 |\n┌───────┐\n│ value │\n└───────┘'
    render(<OutputContent text={`${fence}text\n${code}\n${fence}`} />)
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(document.querySelector('pre code')?.textContent).toBe(code + '\n')
  })

  it('does not close a fence on a shorter backtick run', () => {
    const text = '````text\n```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n````'
    expect(outputSections(text)).toEqual([{ text, terminal: false }])
    render(<OutputContent text={text} />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('keeps ASCII and Unicode terminal tables literal between Markdown sections', () => {
    const text = '### Answer\n\n+---------+---------+\n| **raw** | value   |\n+---------+---------+\n\n**Summary**\n\n┌─────────┬─────────┐\n│ ### raw │ value   │\n└─────────┴─────────┘'
    render(<OutputContent text={text} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Answer' })).toBeInTheDocument()
    expect(screen.getByText('Summary').tagName).toBe('STRONG')
    const tables = screen.getAllByLabelText('Terminal table')
    expect(tables).toHaveLength(2)
    expect(tables[0].textContent).toContain('| **raw** | value   |')
    expect(tables[1].textContent).toContain('│ ### raw │ value   │')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
