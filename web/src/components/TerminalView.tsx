import { TerminalWorkspace } from './TerminalWorkspace'

export interface TerminalViewProps {
  terminalId: string
  provider?: string
  agentProfile?: string | null
  onClose: () => void
}

/** Preserve existing entrypoints and close semantics for agents/workflow views. */
export function TerminalView(props: TerminalViewProps) {
  return <TerminalWorkspace key={props.terminalId} {...props} />
}
