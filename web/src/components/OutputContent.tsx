import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './OutputContent.css'

const remarkPlugins = [remarkGfm]
const hasMarkdown = (text: string) => /(^ {0,3}(?:#{1,6}\s|`{3,}|~{3,}|[-*+]\s|\d+[.)]\s|>\s)|\*\*|__|`[^`\n]+`|\[[^\]\n]+\]\(|\|[^\n]*\n\s*\|?\s*:?-{3,})/m.test(text)

// Terminal-drawn tables are already laid out, unlike Markdown pipe tables.
// Keep those rows literal, including in mixed prose/table responses. Never
// reinterpret a fenced code block or join lines to guess missing cell content.
export function outputSections(text: string): { text: string; terminal: boolean }[] {
  const lines = text.split('\n')
  const sections: { text: string; terminal: boolean }[] = []
  let pending: string[] = []
  let fence: { character: string; length: number } | undefined
  const flush = () => {
    if (pending.length) sections.push({ text: pending.join('\n'), terminal: false })
    pending = []
  }
  const pipeRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
  const borderRow = (line: string) => /^\s*(?:[┌┐└┘├┤┬┴┼┏┓┗┛┣┫┳┻╋╭╮╰╯│┃].*|\+(?:[-=]+\+)+)\s*$/.test(line)
  const delimiterRow = (line: string) => {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    return cells.length > 1 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell))
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      pending.push(line)
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      continue
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length }
      pending.push(line)
      continue
    }
    // A real Markdown header + delimiter + body stays with the Markdown parser.
    if (line.includes('|') && delimiterRow(lines[index + 1] || '')) {
      pending.push(line, lines[++index])
      while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) pending.push(lines[++index])
      continue
    }
    if (borderRow(line) || pipeRow(line)) {
      flush()
      const table = [line]
      while (index + 1 < lines.length && (borderRow(lines[index + 1]) || pipeRow(lines[index + 1]))) table.push(lines[++index])
      sections.push({ text: table.join('\n'), terminal: true })
    } else {
      pending.push(line)
    }
  }
  flush()
  return sections
}

export const OutputContent = memo(function OutputContent({ text }: { text: string }) {
  return (
    <div className="output-readable">
      {outputSections(text).map((section, index) => section.terminal
        ? <pre key={index} className="output-terminal-table" aria-label="Terminal table" tabIndex={0}>{section.text}</pre>
        : !hasMarkdown(section.text)
          ? <pre key={index} className="output-plain">{section.text}</pre>
          : <ReactMarkdown
            key={index}
            remarkPlugins={remarkPlugins}
            skipHtml
            components={{
              // No raw HTML, embedded media, or automatic external requests.
              img: ({ alt }) => <span className="output-image-label">[Image: {alt || 'image'}]</span>,
              a: ({ children, href }) => href
                ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>
                : <span>{children}</span>,
              table: ({ children }) => <div className="output-table-scroll" role="region" aria-label="Output table" tabIndex={0}><table>{children}</table></div>,
              pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
            }}
          >{section.text}</ReactMarkdown>)}
    </div>
  )
})
