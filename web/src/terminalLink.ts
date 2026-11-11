export interface TerminalLinkRequest {
  session: string
  terminalId: string
}

export type TerminalLink = { request: TerminalLinkRequest; error?: never } | { error: string; request?: never }

// This is navigation metadata, never authority to launch an arbitrary pane.
// The authenticated session response and normal viewer launch validate it again.
export function readTerminalLink(search = location.search): TerminalLink | null {
  const query = new URLSearchParams(search)
  if (!query.has('terminal_session') && !query.has('terminal_id')) return null
  const session = query.get('terminal_session') ?? ''
  const terminalId = query.get('terminal_id') ?? ''
  if (query.getAll('terminal_session').length !== 1 || query.getAll('terminal_id').length !== 1
    || session.length > 100 || terminalId.length > 100
    || !/^[A-Za-z0-9._-]+$/.test(session) || !/^[A-Za-z0-9_-]+$/.test(terminalId)) {
    return { error: 'Invalid terminal link. Choose the agent from this node instead.' }
  }
  return { request: { session, terminalId } }
}

export function stripTerminalLink() {
  const url = new URL(location.href)
  url.searchParams.delete('terminal_session')
  url.searchParams.delete('terminal_id')
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
}
