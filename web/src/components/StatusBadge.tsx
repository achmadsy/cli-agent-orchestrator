// StatusBadge — terminal status pill for the web dashboard.
//
// STATUS_CONFIG / UNKNOWN_CONFIG are generated from the shared design-token SSOT
// (design-tokens/status.json + tokens.json) via `node design-tokens/gen.mjs`.
// Do not hand-edit the status taxonomy here — edit the JSON and regenerate.
import { STATUS_CONFIG, UNKNOWN_CONFIG } from '../status.generated'

export { STATUS_CONFIG }

type TerminalStatus = 'IDLE' | 'PROCESSING' | 'COMPLETED' | 'WAITING_USER_ANSWER' | 'ERROR' | string | null

export function StatusBadge({ status, monitoring }: {
  status: TerminalStatus
  monitoring?: { reason: string; observed_status?: string } | null
}) {
  const normalized = status ? status.toUpperCase() : null
  const config = (normalized && STATUS_CONFIG[normalized]) || UNKNOWN_CONFIG

  const badge = (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${config.bgClass}`}>
      <span className={`w-2 h-2 rounded-full ${config.dotClass} ${config.pulse ? 'animate-pulse' : ''}`} />
      <span className={`text-xs font-medium ${config.textClass}`}>{config.label}</span>
    </span>
  )
  if (normalized && normalized !== 'UNKNOWN' && STATUS_CONFIG[normalized]) return badge
  const reasons: Record<string, string> = {
    reconnecting: 'Output monitoring is reconnecting.',
    observation_unavailable: 'Output monitoring could not be attached safely.',
    awaiting_output: 'Monitoring is attached; waiting for recognizable agent output.',
    live_output: 'Output was received, but the agent state has not been recognized yet.',
    snapshot_only: 'A viewport was observed, but it is not fresh execution or delivery evidence.',
    snapshot_unavailable: 'Monitoring is attached; a safe viewport status could not be established. Waiting for output.',
  }
  return (
    <details className="relative inline-block">
      <summary className="cursor-pointer list-none rounded-full focus-visible:outline focus-visible:outline-2" aria-label="Unknown status: show explanation">{badge}</summary>
      <div className="absolute left-0 top-full z-20 mt-2 w-64 max-w-[80vw] rounded-lg border border-neutral-600 bg-neutral-900 p-3 text-xs text-neutral-200 shadow-lg">
        <p>CAO has not established the agent state. Unknown does not mean the agent exited.</p>
        <p className="mt-2">{reasons[monitoring?.reason ?? ''] ?? 'No reliable output observation is available yet.'}</p>
        {monitoring?.reason === 'snapshot_only' && monitoring.observed_status && <p className="mt-2">Observed viewport: {monitoring.observed_status}. Automation remains unconfirmed.</p>}
      </div>
    </details>
  )
}
